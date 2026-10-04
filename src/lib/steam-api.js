/*
 * Steam Multi-Owner :: steam-api.js
 * IO 层：只做 HTTP，不碰 chrome.* / DOM。所有请求函数都接收 fetchImpl，便于在 Node 里测试。
 * 数据源优先级（每个账号可用的方式）：
 *   1. Steam Web API  IPlayerService/GetOwnedGames  需要 API key，他人档案需公开「游戏详情」
 *   2. steamcommunity 游戏列表 XML                   不需要 key，档案需公开
 *   3. dynamicstore/userdata（当前浏览器登录会话）     不需要 key，不需要公开，只能拿当前登录账号
 *   4. account/licenses HTML（当前浏览器登录会话）     不需要 key，兜底
 */
(function (root) {
  'use strict';

  var API_ROOT = 'https://api.steampowered.com';
  var STORE_ROOT = 'https://store.steampowered.com';
  var COMMUNITY_ROOT = 'https://steamcommunity.com';
  var UA = 'SteamMultiOwner/1.0 (+local ownership checker)';

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function text(res) {
    return res.text();
  }

  function requestInit(extra) {
    var init = {
      method: 'GET',
      // 必须显式禁掉 HTTP 缓存：换账号后浏览器可能把上一个账号的 /account/ 或
      // dynamicstore 响应从缓存里给你，于是"抓到的库属于别的号"——真机上就是这么翻车的。
      cache: 'no-store',
      headers: { Accept: 'application/json, text/javascript, text/html, */*', 'Cache-Control': 'no-cache' },
    };
    if (extra) for (var k in extra) init[k] = extra[k];
    return init;
  }

  /** 再加一道保险：给 URL 挂一个每次都不同的查询参数，绕开任何中间层缓存。 */
  function withBust(url) {
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return url + sep + '_=' + Date.now() + Math.floor(Math.random() * 1000);
  }

  function HttpError(message, status, body) {
    var err = new Error(message);
    err.name = 'HttpError';
    err.status = status;
    if (body) err.body = String(body).slice(0, 500);
    return err;
  }

  /* ------------------------------------------------------------------ *
   * 1. Steam Web API
   * ------------------------------------------------------------------ */

  async function resolveVanity(fetchImpl, apiKey, vanity) {
    var url = API_ROOT + '/ISteamUser/ResolveVanityURL/v1/?key=' + encodeURIComponent(apiKey) +
      '&vanityurl=' + encodeURIComponent(vanity);
    var res = await fetchImpl(withBust(url), requestInit());
    if (res.status === 401 || res.status === 403) {
      throw HttpError('API key 无效或无权限（HTTP ' + res.status + '）—— 请检查设置页里的 key', res.status);
    }
    if (!res.ok) throw HttpError('ResolveVanityURL HTTP ' + res.status, res.status);
    var json = await res.json();
    var r = json && json.response;
    if (!r || r.success !== 1 || !r.steamid) {
      throw new Error('找不到该自定义 ID：' + vanity + (r && r.message ? '（' + r.message + '）' : ''));
    }
    return String(r.steamid);
  }

  async function getOwnedGames(fetchImpl, apiKey, steamId64) {
    var url = API_ROOT + '/IPlayerService/GetOwnedGames/v1/?key=' + encodeURIComponent(apiKey) +
      '&steamid=' + encodeURIComponent(steamId64) +
      '&include_appinfo=1&include_played_free_games=1&skip_unvetted_apps=0&format=json';
    var res = await fetchImpl(withBust(url), requestInit());
    var body = await text(res);
    if (res.status === 401 || res.status === 403) {
      throw HttpError('API key 无效或无权限（HTTP ' + res.status + '）', res.status, body);
    }
    if (res.status === 429) throw HttpError('请求过于频繁（HTTP 429），稍后再试', 429, body);
    if (!res.ok) throw HttpError('GetOwnedGames HTTP ' + res.status, res.status, body);
    var json;
    try { json = JSON.parse(body); } catch (e) { throw HttpError('返回内容不是 JSON', res.status, body); }
    var lib = root.SteamOwnerCore.fromGetOwnedGames(json);
    // response 为空对象 = 档案「游戏详情」非公开
    var raw = json && json.response;
    var isPrivate = !raw || Object.keys(raw).length === 0;
    lib.privateProfile = isPrivate;
    if (isPrivate) {
      lib.note = '档案的「游戏详情」未公开，API 拿不到游戏列表（可改用公开档案或「登录会话导入」）';
    }
    return lib;
  }

  /* ------------------------------------------------------------------ *
   * 2. steamcommunity 游戏列表 XML（无需 API key）
   * ------------------------------------------------------------------ */

  function communityGamesUrl(key) {
    var core = root.SteamOwnerCore;
    var parsed = core.parseAccountKey(key);
    var base;
    if (parsed && parsed.steamId64) base = COMMUNITY_ROOT + '/profiles/' + parsed.steamId64;
    else if (parsed && parsed.vanity) base = COMMUNITY_ROOT + '/id/' + encodeURIComponent(parsed.vanity);
    else return null;
    return base + '/games?tab=all&xml=1&l=schinese';
  }

  /**
   * **实时**查"这个账号有没有这一款游戏"（只查一个 appid，用 appids_filter）。
   * 用于把"当前登录账号"的结论从快照升级成实时 —— 快照可能过期，这个不会。
   * 返回 { owns: true|false|null, uncertain: bool, reason? }
   *   owns=true   明确拥有
   *   owns=false  明确没有（返回了 games 数组但不含该 appid）
   *   owns=null   无法判断（档案受限/令牌失效等）——绝不当成"没有"
   */
  async function getOwnedGamesForApp(fetchImpl, apiKey, steamId64, appid) {
    var id = root.SteamOwnerCore.parseAppId(appid);
    if (!id) throw new Error('不是有效的 AppID：' + appid);
    var url = API_ROOT + '/IPlayerService/GetOwnedGames/v1/?key=' + encodeURIComponent(apiKey) +
      '&steamid=' + encodeURIComponent(steamId64) +
      '&include_appinfo=0&include_played_free_games=1&skip_unvetted_apps=0' +
      '&appids_filter[0]=' + id + '&format=json';
    var res = await fetchImpl(withBust(url), requestInit());
    var body = await text(res);
    if (res.status === 401 || res.status === 403) {
      return { owns: null, uncertain: true, reason: 'API key / 会话令牌无效或已过期（HTTP ' + res.status + '）' };
    }
    if (res.status === 429) return { owns: null, uncertain: true, reason: '请求过于频繁（HTTP 429），稍后再试' };
    if (!res.ok) return { owns: null, uncertain: true, reason: 'GetOwnedGames HTTP ' + res.status };
    var json = null;
    try { json = JSON.parse(body); } catch (e) {
      return { owns: null, uncertain: true, reason: '返回内容不是 JSON' };
    }
    var r = json && json.response;
    if (!r || (!Array.isArray(r.games) && typeof r.game_count !== 'number')) {
      // 空 response：可能是"没有这款"，也可能是"档案不让看" —— 区分不了，所以不下结论
      return { owns: null, uncertain: true, reason: '接口没有返回该游戏的信息（可能未拥有，也可能档案受限）' };
    }
    var games = Array.isArray(r.games) ? r.games : [];
    var owns = games.some(function (g) { return Number(g && g.appid) === id; });
    return { owns: owns, uncertain: false, appid: id };
  }

  /**
   * 商店自己的"当前登录账号有没有这款游戏"接口。
   * 只用浏览器 cookie，**不需要 token / API key** —— 所以它是实时校验最省事的兜底。
   * 真机验证：未登录时返回 {"<appid>":{"success":false}}。
   */
  async function getAppUserDetails(fetchImpl, appid) {
    var id = root.SteamOwnerCore.parseAppId(appid);
    if (!id) throw new Error('不是有效的 AppID：' + appid);
    var url = STORE_ROOT + '/api/appuserdetails?appids=' + id;
    var res = await fetchImpl(withBust(url), requestInit({ credentials: 'include' }));
    if (!res.ok) return { owns: null, uncertain: true, reason: 'appuserdetails HTTP ' + res.status };
    var body = await text(res);
    var json = null;
    try { json = JSON.parse(body); } catch (e) {
      return { owns: null, uncertain: true, reason: 'appuserdetails 返回的不是 JSON（可能被登录页拦截）' };
    }
    var entry = json && json[String(id)];
    if (!entry || !entry.success || !entry.data) {
      return { owns: null, uncertain: true, reason: 'appuserdetails 未返回该游戏（success=false，通常是没登录）' };
    }
    var d = entry.data;
    if (typeof d.owns === 'boolean') return { owns: d.owns, uncertain: false, appid: id, source: 'appuserdetails' };
    if (typeof d.has_license === 'boolean') return { owns: d.has_license, uncertain: false, appid: id, source: 'appuserdetails' };
    return { owns: null, uncertain: true, reason: 'appuserdetails 返回结构里没有 owns/has_license 字段' };
  }

  async function getCommunityGames(fetchImpl, key) {
    var url = communityGamesUrl(key);
    if (!url) throw new Error('账号标识无法识别：' + key);
    var res = await fetchImpl(withBust(url), requestInit({ credentials: 'omit', redirect: 'manual' }));
    var body = await text(res);
    // 真机验证：这个接口现在**需要登录**了 —— 未登录会 302 到 /login/
    if (res.status >= 300 && res.status < 400) {
      throw new Error('社区游戏列表接口现在要求登录 Steam（HTTP ' + res.status + ' 跳转登录页）。' +
        '请先在浏览器登录该账号，改用「导入当前登录的号」，或配置 API key。');
    }
    if (!res.ok) throw HttpError('社区游戏列表 HTTP ' + res.status, res.status, body);
    var lib = root.SteamOwnerCore.fromCommunityGamesXml(body);
    if (!lib) {
      if (/This profile is private|该个人资料属于私人|private/i.test(body)) {
        throw new Error('该档案为私密，社区游戏列表不可读');
      }
      if (/<gamesList/.test(body) === false && /<error>/.test(body)) {
        throw new Error('Steam 返回错误：' + (/<error>([\s\S]*?)<\/error>/.exec(body) || [, '未知'])[1]);
      }
      throw new Error('未解析到游戏列表（档案可能未公开或没有游戏）');
    }
    if (lib.empty) lib.note = '解析成功但游戏数为 0（档案可能未公开游戏详情）';
    return lib;
  }

  /* ------------------------------------------------------------------ *
   * 3/4. 当前浏览器登录会话（多账号玩家的救命稻草：不需要 key、不需要公开）
   * ------------------------------------------------------------------ */

  async function getDynamicStoreUserData(fetchImpl) {
    var url = STORE_ROOT + '/dynamicstore/userdata/';
    var res = await fetchImpl(withBust(url), requestInit({ credentials: 'include' }));
    var body = await text(res);
    if (!res.ok) throw HttpError('dynamicstore HTTP ' + res.status, res.status, body);
    var json;
    try { json = JSON.parse(body); } catch (e) {
      throw new Error('未检测到已登录的 Steam 会话（请在浏览器里登录 store.steampowered.com 后重试）');
    }
    var lib = root.SteamOwnerCore.fromDynamicStore(json);
    if (!lib) throw new Error('返回内容里没有 rgOwnedApps，无法确定库内容');
    // 顺手看看这个响应里有没有会话 token —— 有的话就能去调 GetOwnedGames 拿准确的游戏列表
    var t = /"webapi_token"\s*:\s*"([^"]+)"/.exec(body) || /&quot;webapi_token&quot;\s*:\s*&quot;([^&"]+)&quot;/.exec(body);
    if (t) lib.webapiToken = decodeHtmlEntities(t[1]);
    return lib;
  }

  async function getLicensesHtml(fetchImpl) {
    var url = STORE_ROOT + '/account/licenses/';
    var res = await fetchImpl(withBust(url), requestInit({ credentials: 'include' }));
    var body = await text(res);
    if (!res.ok) throw HttpError('licenses HTTP ' + res.status, res.status, body);
    var lib = root.SteamOwnerCore.fromLicensesHtml(body);
    if (!lib) throw new Error('未检测到已登录的 Steam 会话或页面结构已变化');
    return lib;
  }

  /** 当前登录账号的昵称（用于自动命名），失败返回 null。 */
  async function getCurrentPersonaName(fetchImpl) {
    try {
      var res = await fetchImpl(withBust(STORE_ROOT + '/account/'), requestInit({ credentials: 'include' }));
      var body = await text(res);
      return parsePersonaName(body);
    } catch (e) {
      return null;
    }
  }

  function parsePersonaName(html) {
    if (typeof html !== 'string') return null;
    var m = /g_strAccountName\s*=\s*"([^"]+)"/.exec(html) ||
      /<span class="account_name">([^<]+)<\/span>/.exec(html) ||
      /"persona_name"\s*:\s*"([^"]+)"/.exec(html);
    return m ? m[1].trim() : null;
  }

  function decodeHtmlEntities(str) {
    return String(str)
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  /**
   * 从任意商店页面的 HTML 里抠出"当前登录会话"自带的凭据：
   *   · webapi_token —— 登录后页面里的会话令牌，可以直接当 Web API 的 key 用（只对当前账号有效）
   *   · steamid      —— 当前登录账号的 SteamID64
   * 这样登录态导入也能走 IPlayerService/GetOwnedGames，
   * 拿到的是**只含游戏本体**的准确列表（等于 Steam 档案里的"游戏数"），还带游戏名。
   *
   * 三种形态都要认（真机上很可能就栽在第三种）：
   *   1. 普通 JSON：        "webapi_token":"abc"
   *   2. 属性里的 JSON：    data-store_user_config="{...}"
   *   3. **HTML 转义过的**： &quot;webapi_token&quot;:&quot;abc&quot;   ← 之前没处理，直接漏掉
   */
  function parseSessionContext(html) {
    var out = { token: null, steamId64: null, persona: null, loggedIn: null, signals: [] };
    if (typeof html !== 'string' || !html) return out;
    out.persona = parsePersonaName(html);

    var candidates = [];
    // 属性名各版本不一：data-store_user_config / data-store-user-config / data-userinfo …
    // 所以前缀吃任意字符，只要求中间出现 user_config | user-config | userinfo。
    var attrRe = /data-[a-z0-9_-]*(?:user[_-]?config|userinfo)[a-z0-9_-]*\s*=\s*"([^"]*)"/gi;
    var m;
    while ((m = attrRe.exec(html)) !== null) {
      candidates.push(m[1]);
      out.signals.push('属性命中：' + m[0].slice(0, 40));
    }

    // 兜底 1：普通 JSON 形态
    var rawToken = /"webapi_token"\s*:\s*"([^"]+)"/.exec(html);
    if (rawToken) { out.token = rawToken[1]; out.signals.push('裸 JSON 命中 webapi_token'); }
    var rawId = /"steamid"\s*:\s*"?(\d{17})"?/.exec(html);
    if (rawId) { out.steamId64 = rawId[1]; out.signals.push('裸 JSON 命中 steamid'); }

    // 兜底 2：被 HTML 转义过的形态（&quot;webapi_token&quot;:&quot;xxx&quot;）
    if (!out.token) {
      var escToken = /&quot;webapi_token&quot;\s*:\s*&quot;([^&"]+)&quot;/.exec(html);
      if (escToken) { out.token = decodeHtmlEntities(escToken[1]); out.signals.push('转义 JSON 命中 webapi_token'); }
    }
    if (!out.steamId64) {
      var escId = /&quot;steamid&quot;\s*:\s*(?:&quot;)?(\d{17})/.exec(html);
      if (escId) { out.steamId64 = escId[1]; out.signals.push('转义 JSON 命中 steamid'); }
    }

    for (var i = 0; i < candidates.length; i++) {
      var decoded = decodeHtmlEntities(candidates[i]);
      var json = null;
      try { json = JSON.parse(decoded); } catch (e) { continue; }
      if (json && typeof json === 'object') {
        if (!out.token && json.webapi_token) { out.token = String(json.webapi_token); out.signals.push('属性 JSON 命中 webapi_token'); }
        if (!out.steamId64 && json.steamid) { out.steamId64 = String(json.steamid); out.signals.push('属性 JSON 命中 steamid'); }
        if (!out.persona && (json.persona_name || json.account_name)) {
          out.persona = String(json.persona_name || json.account_name);
          out.signals.push('属性 JSON 命中昵称');
        }
        // data-userinfo 里的 logged_in 是判断"到底登没登录"最可靠的依据
        //（真机验证：未登录时 store 页面会明确给 logged_in:false，而 dynamicstore 仍然返回 200 + 空数组）
        if (out.loggedIn === null && typeof json.logged_in === 'boolean') {
          out.loggedIn = json.logged_in;
          out.signals.push('logged_in=' + json.logged_in);
        }
      }
    }
    // 转义形态的 logged_in（页面里 data-userinfo 就是这种写法）
    if (out.loggedIn === null) {
      if (/&quot;logged_in&quot;\s*:\s*true/.test(html)) { out.loggedIn = true; out.signals.push('转义 logged_in=true'); }
      else if (/&quot;logged_in&quot;\s*:\s*false/.test(html)) { out.loggedIn = false; out.signals.push('转义 logged_in=false'); }
    }
    if (!out.token && !out.steamId64) out.signals.push('三种形态都没命中：页面里可能确实没有这些字段');
    return out;
  }

  /** 取当前登录会话的凭据（token / steamid / 昵称）。拿不到就返回空壳，不抛错。 */
  async function getSessionContext(fetchImpl) {
    var best = { token: null, steamId64: null, persona: null, loggedIn: null, signals: [] };
    var urls = [STORE_ROOT + '/account/', STORE_ROOT + '/'];
    for (var i = 0; i < urls.length; i++) {
      try {
        var res = await fetchImpl(withBust(urls[i]), requestInit({ credentials: 'include' }));
        if (!res.ok) { best.signals.push(urls[i] + ' HTTP ' + res.status); continue; }
        var html = await text(res);
        var parsed = parseSessionContext(html);
        best.token = best.token || parsed.token;
        best.steamId64 = best.steamId64 || parsed.steamId64;
        best.persona = best.persona || parsed.persona;
        for (var s = 0; s < parsed.signals.length; s++) best.signals.push(parsed.signals[s]);
        // logged_in 要取"最明确"的那个值：true 优先，其次 false
        if (parsed.loggedIn === true) best.loggedIn = true;
        else if (parsed.loggedIn === false && best.loggedIn !== true) best.loggedIn = false;
        if (best.token && best.steamId64) break;
      } catch (e) { best.signals.push(urls[i] + ' 失败：' + (e && e.message)); }
    }
    return best;
  }

  /**
   * 用商店详情接口判断一批 appid 的"类型"（game / dlc / tool / demo / music / video…），顺便拿名字。
   * 为什么需要它：许可证列表只有 appid，没有类型；要显示"游戏数"就得知道哪些是游戏本体。
   * 分批请求（默认 40 个一批、批间隔 350ms），单批失败不影响其它批次。
   */
  async function classifyAppTypes(fetchImpl, appids, options) {
    var opts = options || {};
    var delayMs = opts.delayMs == null ? 350 : opts.delayMs;
    var types = {};
    var names = {};
    var failures = 0;
    var unresolved = [];
    var list = [];
    for (var i = 0; i < (appids || []).length; i++) {
      var id = Number(appids[i]);
      if (id > 0) list.push(id);
    }
    // ★ 真机验证：商店的 appdetails **不支持逗号批量**（appids=440,570 会返回 HTTP 400），
    // 所以只能一个一个查。这决定了它不能用来给几百个条目做分类（太慢），
    // 只适合"查一个 appid 是不是游戏本体"这种小用途。
    for (var k = 0; k < list.length; k++) {
      var one = list[k];
      var url = STORE_ROOT + '/api/appdetails?appids=' + one + '&filters=basic&l=schinese';
      try {
        var res = await fetchImpl(withBust(url), requestInit());
        if (!res.ok) throw HttpError('appdetails HTTP ' + res.status, res.status);
        var json = await res.json();
        var entry = json && json[String(one)];
        if (entry && entry.success && entry.data) {
          types[one] = entry.data.type || 'unknown';
          if (entry.data.name) names[one] = entry.data.name;
        } else if (entry && entry.success === false) {
          // 真机验证：像 228980 这种商店不公开的条目会返回 success:false。
          // 它既不是失败也不是游戏，单独记下来，别混进"游戏"里，也别当成请求失败。
          unresolved.push(one);
        } else {
          failures++;
        }
      } catch (e) {
        failures++;
      }
      if (delayMs) await sleep(delayMs);
    }
    return {
      types: types,
      names: names,
      classified: Object.keys(types).length,
      requested: list.length,
      failures: failures,
      unresolved: unresolved,
    };
  }

  /**
   * 给一个"只有条目列表"的库补上 gameAppids（哪部分是游戏本体）。
   * 超过 maxClassify 就不分类（避免为了一个数字打几百个请求），照实显示"游戏数待识别"。
   */
  async function refineLibraryTypes(fetchImpl, lib, options) {
    var opts = options || {};
    if (!lib || !Array.isArray(lib.appids) || !lib.appids.length) return lib;
    if (Array.isArray(lib.gameAppids)) return lib;
    if (lib.kind === 'games') {
      lib.gameAppids = lib.appids.slice();
      return lib;
    }
    var maxClassify = opts.maxClassify == null ? 30 : opts.maxClassify;
    if (lib.appids.length > maxClassify) {
      // 不能只分类一部分就拿来当游戏数：那会把 71 款游戏报成 12 款（少报和虚报一样糟）。
      // 所以宁可不分类、照实显示"游戏数待识别"。
      lib.classifySkipped = 'too-many';
      return lib;
    }
    var out = await classifyAppTypes(fetchImpl, lib.appids, opts);
    if (out.classified === 0) {
      lib.classifyFailed = out.failures > 0 ? 'requests-failed' : 'no-data';
      return lib;
    }
    if (out.classified < lib.appids.length) {
      // 有任何一个没分类成功，就不给游戏数（同上，避免少报）
      lib.classifyFailed = 'partial';
      lib.classifiedCount = out.classified;
      lib.unresolvedCount = (out.unresolved || []).length;
      return lib;
    }
    var games = [];
    for (var i = 0; i < lib.appids.length; i++) {
      if (out.types[String(lib.appids[i])] === 'game') games.push(lib.appids[i]);
    }
    lib.gameAppids = games;
    lib.names = Object.assign({}, lib.names || {}, out.names);
    lib.classifiedCount = out.classified;
    return lib;
  }

  /** 合并两个来源：以"游戏列表"为准确定游戏数，用"许可证列表"扩大覆盖面（DLC / 工具等）。 */
  function mergeLibraries(gameLib, licenseLib) {
    var games = gameLib.appids.slice();
    var seen = Object.create(null);
    for (var i = 0; i < games.length; i++) seen[games[i]] = 1;
    var appids = games.slice();
    if (licenseLib) {
      for (var j = 0; j < licenseLib.appids.length; j++) {
        var id = licenseLib.appids[j];
        if (!seen[id]) {
          seen[id] = 1;
          appids.push(id);
        }
      }
    }
    return {
      appids: appids,
      gameAppids: games,
      names: Object.assign({}, (licenseLib && licenseLib.names) || {}, gameLib.names || {}),
      gameCount: games.length,
      entryCount: appids.length,
      extraCount: appids.length - games.length,
      wishlist: (licenseLib && licenseLib.wishlist) || gameLib.wishlist || null,
      empty: false,
    };
  }

  /**
   * 登录态导入一个账号的库。
   *
   * 目标：**索引要全（DLC/工具也收进来），但显示的游戏数必须准**。所以：
   *   1. 会话 token + GetOwnedGames  -> 准确的游戏集合（含名字），数字等于 Steam 档案的"游戏数"
   *   2. dynamicstore / 许可证页面    -> 完整的条目集合（含 DLC、原声、工具、家庭共享）
   *   1+2 都有  -> 合并：appids 取并集，gameAppids 用第 1 步的结果（最准）
   *   只有 2    -> 用商店类型分类反推 gameAppids，拿不到就照实说"游戏数待识别"
   */
  async function fetchSessionLibrary(fetchImpl, options) {
    var opts = options || {};
    var attempts = [];
    // 凭据来源优先级：
    //   1. 调用方直接给（来自**你正开着的那个 Steam 页面**的 DOM，最可靠 —— 页面里有什么就能读到什么）
    //   2. 后台自己去请求 /account/ 页面解析
    var ctx = null;
    if (opts.creds && (opts.creds.token || opts.creds.steamId64 || opts.creds.loggedIn === false)) {
      ctx = {
        token: opts.creds.token || null,
        steamId64: opts.creds.steamId64 || null,
        persona: opts.creds.persona || null,
        loggedIn: typeof opts.creds.loggedIn === 'boolean' ? opts.creds.loggedIn : null,
        signals: opts.creds.signals || [],
      };
      attempts.push('会话凭据：来自页面 DOM（' + (ctx.signals.length ? ctx.signals.join('；') : '未说明来源') + '）');
    } else {
      ctx = await getSessionContext(fetchImpl);
    }

    // ★ 没登录就必须直接报错。
    // 真机验证过：未登录时 dynamicstore 仍然返回 HTTP 200 + 空数组，
    // 如果不管它，就会建出一个"0 款游戏"的空账号，看起来像成功了 —— 那是最坏的情况。
    if (ctx.loggedIn === false) {
      var notLogged = new Error('浏览器没有登录 Steam（页面里 logged_in=false）。请先登录 store.steampowered.com 再导入。');
      notLogged.attempts = attempts;
      throw notLogged;
    }

    var gameLib = null;
    if (ctx.token && ctx.steamId64) {
      try {
        var own = await getOwnedGames(fetchImpl, ctx.token, ctx.steamId64);
        if (!own.privateProfile && own.appids.length > 0) gameLib = own;
        else attempts.push('会话 GetOwnedGames：' + (own.note || '返回为空'));
      } catch (e) {
        attempts.push('会话 GetOwnedGames：' + e.message);
      }
    } else {
      attempts.push('会话凭据：没找到 webapi_token / steamid（信号：' + ((ctx.signals && ctx.signals.join('；')) || '无') + '）');
    }

    var licenseLib = null;
    var licenseMethod = null;
    try {
      licenseLib = await getDynamicStoreUserData(fetchImpl);
      licenseMethod = 'session';
    } catch (e) {
      attempts.push('dynamicstore：' + e.message);
      try {
        licenseLib = await getLicensesHtml(fetchImpl);
        licenseMethod = 'session-licenses';
      } catch (e2) {
        attempts.push('许可证页面：' + e2.message);
      }
    }

    // 如果页面里没读到 token，但 dynamicstore 的响应里带了，就补上再试一次
    if (!gameLib && !ctx.token && licenseLib && licenseLib.webapiToken) {
      var fallbackId = ctx.steamId64 || licenseLib.steamId64;
      if (fallbackId) {
        try {
          var own2 = await getOwnedGames(fetchImpl, licenseLib.webapiToken, fallbackId);
          if (!own2.privateProfile && own2.appids.length > 0) {
            gameLib = own2;
            ctx.token = licenseLib.webapiToken;
            ctx.steamId64 = fallbackId;
            attempts.push('会话凭据：改用 dynamicstore 响应里带的 token');
          }
        } catch (e) {
          attempts.push('dynamicstore 里的 token：' + e.message);
        }
      }
    }

    // 身份核对：这份快照到底属于哪个账号？
    // 如果连 SteamID 都读不到，界面必须明说"这个快照无法确认属于哪个号"，
    // 否则会把 A 号的数据悄悄挂到 B 号的记录上（真机上就是这么翻车的）。
    var identity = {
      steamId64: ctx.steamId64 || (licenseLib && licenseLib.steamId64) || null,
      persona: ctx.persona || null,
      verified: !!ctx.steamId64,
      fromPage: !!ctx.steamId64,
      fromData: !!(licenseLib && licenseLib.steamId64),
    };
    if (identity.fromPage && identity.fromData && ctx.steamId64 !== licenseLib.steamId64) {
      identity.conflict = '页面里的 SteamID 与数据里的 steamid 不一致';
    }
    var identityNote = identity.verified
      ? '账号身份来自商店页面：SteamID ' + identity.steamId64
      : '⚠ 没能从商店页面读到 SteamID，无法确认这份快照属于哪个账号（可能抓到了别的号的数据）';

    if (gameLib && licenseLib) {
      var merged = mergeLibraries(gameLib, licenseLib);
      merged.method = 'session-api+' + licenseMethod;
      merged.kind = merged.extraCount > 0 ? 'mixed' : 'games';
      merged.steamId64 = identity.steamId64;
      merged.persona = identity.persona;
      merged.identity = identity;
      merged.sourceNote = '游戏集合来自 GetOwnedGames（准确），并用' +
        (licenseMethod === 'session' ? '动态商店' : '许可证页面') +
        '补入了 ' + merged.extraCount + ' 个 DLC/工具条目。' + identityNote;
      merged.attempts = attempts;
      return merged;
    }

    if (gameLib) {
      return Object.assign(gameLib, {
        method: 'session-api',
        kind: 'games',
        gameAppids: gameLib.appids.slice(),
        steamId64: identity.steamId64,
        persona: identity.persona,
        identity: identity,
        sourceNote: '会话 token 调 GetOwnedGames（只含游戏本体）。' + identityNote,
        attempts: attempts,
      });
    }

    if (licenseLib) {
      var refined = Object.assign(licenseLib, {
        method: licenseMethod,
        kind: 'apps',
        steamId64: identity.steamId64,
        persona: identity.persona,
        identity: identity,
        attempts: attempts,
      });
      // 尽力补上"哪些是游戏本体"，这样界面能显示准确的游戏数而不是 305 项
      try {
        await refineLibraryTypes(fetchImpl, refined, opts);
      } catch (e) {
        attempts.push('类型分类：' + e.message);
      }
      refined.sourceNote = (refined.gameAppids
        ? '来自' + (licenseMethod === 'session' ? '动态商店的许可证列表' : '许可证页面') +
          '，已按商店类型识别出其中的游戏本体'
        : '来自' + (licenseMethod === 'session' ? '动态商店的许可证列表' : '许可证页面') +
          '（这是"拥有的条目"，含 DLC/工具/共享；游戏数还没识别出来）') + '。' + identityNote;
      return refined;
    }

    var err = new Error('登录态导入失败 → ' + attempts.join(' ｜ '));
    err.attempts = attempts;
    throw err;
  }

  /* ------------------------------------------------------------------ *
   * 商店信息（无需 key）
   * ------------------------------------------------------------------ */

  async function getAppName(fetchImpl, appid) {
    var url = STORE_ROOT + '/api/appdetails?appids=' + encodeURIComponent(appid) + '&filters=basic&l=schinese';
    var res = await fetchImpl(url, requestInit());
    if (!res.ok) throw HttpError('appdetails HTTP ' + res.status, res.status);
    var json = await res.json();
    var entry = json && json[String(appid)];
    if (!entry || !entry.success || !entry.data) return null;
    return entry.data.name || null;
  }

  /**
   * 统一入口：抓一个账号的库。
   * account: { steamId64?, vanity?, apiKey? }
   * options: { apiKey?, useSession? }
   * 返回 { appids, names, gameCount, method, steamId64? }
   */
  async function fetchLibrary(fetchImpl, account, options) {
    var opts = options || {};
    var core = root.SteamOwnerCore;
    var key = account.apiKey || opts.apiKey || null;
    var identity = account.steamId64 || account.vanity || null;
    var attempts = [];

    if (opts.useSession) {
      try {
        return await fetchSessionLibrary(fetchImpl);
      } catch (e) {
        attempts.push('登录态：' + e.message);
      }
    }

    if (identity && key) {
      try {
        var id64 = identity;
        if (!/^\d{17}$/.test(identity)) id64 = await resolveVanity(fetchImpl, key, identity);
        var lib = await getOwnedGames(fetchImpl, key, id64);
        if (!lib.privateProfile) {
          return Object.assign(lib, {
            method: 'api',
            kind: 'games',
            steamId64: id64,
            sourceNote: 'Web API GetOwnedGames（只含游戏本体）',
          });
        }
        attempts.push('Web API：' + (lib.note || '档案未公开'));
      } catch (e) { attempts.push('Web API：' + e.message); }
    }

    if (identity) {
      try {
        var com = await getCommunityGames(fetchImpl, identity);
        return Object.assign(com, {
          method: 'community-xml',
          kind: 'games',
          sourceNote: '社区公开档案的游戏列表（只含游戏本体）',
        });
      } catch (e) { attempts.push('社区列表：' + e.message); }
    }

    if (!key && !opts.useSession) attempts.push('未提供 API key（可在设置里填一个共享 key）');
    var err = new Error('抓取失败 → ' + attempts.join(' ｜ '));
    err.attempts = attempts;
    throw err;
  }

  root.SteamApi = {
    API_ROOT: API_ROOT,
    STORE_ROOT: STORE_ROOT,
    COMMUNITY_ROOT: COMMUNITY_ROOT,
    UA: UA,
    sleep: sleep,
    resolveVanity: resolveVanity,
    getOwnedGames: getOwnedGames,
    getOwnedGamesForApp: getOwnedGamesForApp,
    getAppUserDetails: getAppUserDetails,
    getCommunityGames: getCommunityGames,
    getDynamicStoreUserData: getDynamicStoreUserData,
    getLicensesHtml: getLicensesHtml,
    getCurrentPersonaName: getCurrentPersonaName,
    parsePersonaName: parsePersonaName,
    parseSessionContext: parseSessionContext,
    getSessionContext: getSessionContext,
    fetchSessionLibrary: fetchSessionLibrary,
    classifyAppTypes: classifyAppTypes,
    refineLibraryTypes: refineLibraryTypes,
    mergeLibraries: mergeLibraries,
    getAppName: getAppName,
    fetchLibrary: fetchLibrary,
    communityGamesUrl: communityGamesUrl,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SteamApi;
})(typeof globalThis !== 'undefined' ? globalThis : this);
