/*
 * Steam Multi-Owner :: core.js
 * 纯逻辑层：不依赖 chrome.*、不依赖 DOM、不依赖 node:*。
 * 同一份文件被以下三处使用：
 *   1) Chrome 扩展（content script / popup / options / service worker: importScripts）
 *   2) Node CLI 与单元测试（import 后读 globalThis.SteamOwnerCore）
 *   3) 移动端单文件页面（构建时内联）
 * 因此这里只允许：纯函数 + 常量。任何 IO 都放在调用方注入。
 */
(function (root) {
  'use strict';

  var APP_ID_RE = /(?:^|\/)app\/(\d{1,10})(?:[/?#]|$)/i;
  var STEAM64_RE = /^\d{17}$/;
  var VANITY_RE = /^[A-Za-z0-9_-]{2,64}$/;

  /* ------------------------------------------------------------------ *
   * 解析
   * ------------------------------------------------------------------ */

  /** 从任意输入里取出 appid：纯数字、store 链接、app/xxx 片段。 */
  function parseAppId(input) {
    if (input == null) return null;
    var text = String(input).trim();
    if (!text) return null;
    if (/^\d{1,10}$/.test(text)) {
      var n = Number(text);
      return n > 0 ? n : null;
    }
    var m = APP_ID_RE.exec(text);
    if (m) return Number(m[1]);
    // 兜底：URL 里带 ?snr= 之类，或形如 store.steampowered.com/app/440
    m = /(?:^|[^\d])(\d{3,7})(?:[^\d]|$)/.exec(text);
    if (m && /steam/i.test(text)) return Number(m[1]);
    return null;
  }

  /**
   * 解析账号标识。
   * 返回 { steamId64 } 或 { vanity } 或 null。
   */
  function parseAccountKey(input) {
    if (input == null) return null;
    var text = String(input).trim();
    if (!text) return null;
    if (STEAM64_RE.test(text)) return { steamId64: text };
    var m = /steamcommunity\.com\/profiles\/(\d{17})/i.exec(text);
    if (m) return { steamId64: m[1] };
    m = /steamcommunity\.com\/id\/([A-Za-z0-9_-]+)/i.exec(text);
    if (m) return { vanity: m[1] };
    m = /(?:^|\/)(?:id|profiles)\/(\d{17})/.exec(text);
    if (m) return { steamId64: m[1] };
    m = /(?:^|\/)(?:id)\/([A-Za-z0-9_-]+)/.exec(text);
    if (m) return { vanity: m[1] };
    if (VANITY_RE.test(text)) return { vanity: text };
    return null;
  }

  /** 账号在界面上的显示名。 */
  function accountLabel(account) {
    if (!account) return '(未知账号)';
    if (account.label) return account.label;
    if (account.steamId64) return account.steamId64;
    if (account.vanity) return account.vanity;
    return account.id || '(未命名)';
  }

  /* ------------------------------------------------------------------ *
   * 各种数据源 -> 统一的 { appids, names }
   * ------------------------------------------------------------------ */

  /** IPlayerService/GetOwnedGames 的响应体。这里拿到的**就是游戏**，不是许可证条目。 */
  function fromGetOwnedGames(payload) {
    var games = payload && payload.response && payload.response.games;
    var count = payload && payload.response && payload.response.game_count;
    if (!games || !games.length) {
      // 有 game_count 但没 games，或两者都空：空库 / 隐私受限
      return { appids: [], names: {}, gameCount: typeof count === 'number' ? count : 0, entryCount: 0, empty: true };
    }
    var appids = [];
    var names = {};
    for (var i = 0; i < games.length; i++) {
      var g = games[i];
      if (!g || !g.appid) continue;
      var id = Number(g.appid);
      appids.push(id);
      if (g.name) names[id] = String(g.name);
    }
    return {
      appids: appids,
      names: names,
      gameCount: appids.length,
      entryCount: appids.length,
      empty: appids.length === 0,
    };
  }

  /**
   * store.steampowered.com/dynamicstore/userdata/ 的响应体（当前登录会话）。
   * 注意：rgOwnedApps 是**拥有的条目**（含 DLC / 原声 / 工具 / 免费 / 家庭共享），
   * 所以这里只能给出 entryCount；游戏数要靠 GetOwnedGames 或商店类型分类才能知道。
   */
  function fromDynamicStore(payload) {
    if (!payload || typeof payload !== 'object') return null;
    var owned = payload.rgOwnedApps || payload.rgOwnedPackages || null;
    if (!Array.isArray(owned)) return null;
    var appids = [];
    for (var i = 0; i < owned.length; i++) {
      var id = Number(owned[i]);
      if (id > 0) appids.push(id);
    }
    var wishlist = [];
    if (Array.isArray(payload.rgWishlist)) {
      for (var j = 0; j < payload.rgWishlist.length; j++) wishlist.push(Number(payload.rgWishlist[j]));
    }
    return {
      appids: appids,
      names: {},
      entryCount: appids.length,
      wishlist: wishlist,
      steamId64: payload.steamid ? String(payload.steamid) : undefined,
    };
  }

  /** steamcommunity.com/<id>/games?tab=all&xml=1 的响应文本。这里也只有游戏。 */
  function fromCommunityGamesXml(xml) {
    if (typeof xml !== 'string' || xml.indexOf('<gamesList') === -1) return null;
    var appids = [];
    var names = {};
    var re = /<game>([\s\S]*?)<\/game>/g;
    var m;
    while ((m = re.exec(xml)) !== null) {
      var block = m[1];
      var idMatch = /<appID>(\d+)<\/appID>/.exec(block);
      if (!idMatch) continue;
      var id = Number(idMatch[1]);
      appids.push(id);
      var nameMatch = /<name>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/name>/.exec(block);
      if (nameMatch) names[id] = decodeXmlEntities(nameMatch[1].trim());
    }
    return {
      appids: appids,
      names: names,
      gameCount: appids.length,
      entryCount: appids.length,
      empty: appids.length === 0,
    };
  }

  /** store.steampowered.com/account/licenses/ 的 HTML（当前登录会话，兜底）。同样是条目列表。 */
  function fromLicensesHtml(html) {
    if (typeof html !== 'string' || html.length < 200) return null;
    if (/g_steamID\s*=\s*false/.test(html) || /id="login_box"/.test(html)) return null;
    var seen = Object.create(null);
    var appids = [];
    var re = /\/app\/(\d{1,10})/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var id = Number(m[1]);
      if (!seen[id]) {
        seen[id] = 1;
        appids.push(id);
      }
    }
    if (!appids.length) return null;
    return { appids: appids, names: {}, entryCount: appids.length };
  }

  function decodeXmlEntities(text) {
    return String(text)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /* ------------------------------------------------------------------ *
   * 合并索引
   * ------------------------------------------------------------------ */

  /**
   * libraries: [{ accountId, label, appids: number[], names?: {}, updatedAt? }]
   * 返回 { builtAt, owners: { [appid]: [accountId, ...] }, ownersOf, appCount, perAccount }
   * owners 的 value 用数组保存账号 id（账号数量很少，够用且可读）。
   */
  function buildIndex(libraries, now) {
    var owners = Object.create(null);
    var perAccount = Object.create(null);
    var gameSet = Object.create(null);
    var seenGame = Object.create(null);
    var gameCount = 0;
    var gameCountComplete = true;
    var total = 0;
    var list = Array.isArray(libraries) ? libraries : [];
    for (var i = 0; i < list.length; i++) {
      var lib = list[i];
      if (!lib || !lib.accountId) continue;
      var ids = Array.isArray(lib.appids) ? lib.appids : [];
      var uniq = Object.create(null);
      for (var j = 0; j < ids.length; j++) {
        var id = Number(ids[j]);
        if (!(id > 0) || uniq[id]) continue;
        uniq[id] = 1;
        if (!owners[id]) owners[id] = [];
        owners[id].push(lib.accountId);
        total++;
      }
      // 游戏数单独统计：只有确认过"哪些是游戏本体"的账号才计入
      var games = Array.isArray(lib.gameAppids) ? lib.gameAppids : (lib.kind === 'games' ? ids : null);
      var accountGameCount = null;
      if (games) {
        accountGameCount = 0;
        for (var k = 0; k < games.length; k++) {
          var gid = Number(games[k]);
          if (!(gid > 0)) continue;
          if (!seenGame[gid]) {
            seenGame[gid] = 1;
            gameSet[gid] = 1;
            gameCount++;
          }
          accountGameCount++;
        }
      } else {
        gameCountComplete = false;
      }
      perAccount[lib.accountId] = {
        label: lib.label || lib.accountId,
        appCount: Object.keys(uniq).length,
        gameCount: accountGameCount,
        updatedAt: lib.updatedAt || null,
      };
    }
    return {
      builtAt: now || new Date().toISOString(),
      owners: owners,
      appCount: Object.keys(owners).length,
      entryCount: total,
      gameAppCount: gameCountComplete ? gameCount : gameCount,
      gameCountComplete: gameCountComplete,
      perAccount: perAccount,
    };
  }

  /**
   * 查询一个 appid 被哪些账号拥有。
   * accounts: [{ id, label, ... }]（用于把 id 还原成可读信息）
   */
  function queryOwnership(index, appid, accounts) {
    var id = Number(appid);
    var byId = Object.create(null);
    var list = Array.isArray(accounts) ? accounts : [];
    for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i];
    var ownerIds = (index && index.owners && index.owners[id]) || [];
    var owners = [];
    for (var j = 0; j < ownerIds.length; j++) {
      var acc = byId[ownerIds[j]];
      owners.push({
        accountId: ownerIds[j],
        label: acc ? accountLabel(acc) : ownerIds[j],
        account: acc || null,
      });
    }
    return {
      appid: id,
      owned: owners.length > 0,
      owners: owners,
      ownerCount: owners.length,
    };
  }

  /** 一次性查询多个 appid，返回 { [appid]: ownership }。 */
  function queryMany(index, appids, accounts) {
    var out = Object.create(null);
    var list = Array.isArray(appids) ? appids : [];
    for (var i = 0; i < list.length; i++) {
      var id = Number(list[i]);
      if (!(id > 0)) continue;
      if (out[id]) continue;
      out[id] = queryOwnership(index, id, accounts);
    }
    return out;
  }

  /** 找出「除了 currentAccountId 之外还有谁拥有」——购物车防重复购买的核心判断。 */
  function ownedByOthers(index, appid, accounts, currentAccountId) {
    var result = queryOwnership(index, appid, accounts);
    var others = [];
    for (var i = 0; i < result.owners.length; i++) {
      if (result.owners[i].accountId !== currentAccountId) others.push(result.owners[i]);
    }
    return {
      appid: result.appid,
      owned: result.owned,
      ownedByCurrent: result.ownerCount > others.length,
      owners: result.owners,
      others: others,
      ownedByOtherOnly: others.length > 0 && result.ownerCount === others.length,
    };
  }

  /* ------------------------------------------------------------------ *
   * 账号列表工具
   * ------------------------------------------------------------------ */

  function makeAccountId(input, existing) {
    var base = String(input || 'account')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'account';
    var taken = Object.create(null);
    var list = Array.isArray(existing) ? existing : [];
    for (var i = 0; i < list.length; i++) taken[list[i].id] = 1;
    if (!taken[base]) return base;
    var n = 2;
    while (taken[base + '-' + n]) n++;
    return base + '-' + n;
  }

  /** 去重：同一个 steamId64 / vanity 只保留一条。 */
  function dedupeAccounts(accounts) {
    var seen = Object.create(null);
    var out = [];
    var list = Array.isArray(accounts) ? accounts : [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.id) continue;
      var key = a.steamId64 || (a.vanity ? 'vanity:' + a.vanity.toLowerCase() : 'id:' + a.id);
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(a);
    }
    return out;
  }

  /** 汇总统计，UI 顶部展示。 */
  function summarize(index, accounts) {
    var list = Array.isArray(accounts) ? accounts : [];
    var synced = 0;
    var totalGames = 0;      // 所有账号的 AppID 条目之和（含 DLC）
    var totalRealGames = 0;  // 能确认"游戏本体"的那部分之和
    var unknownGameCount = 0;
    for (var i = 0; i < list.length; i++) {
      var per = index && index.perAccount && index.perAccount[list[i].id];
      if (per) {
        synced++;
        totalGames += per.appCount;
        if (per.gameCount == null) unknownGameCount++;
        else totalRealGames += per.gameCount;
      }
    }
    return {
      accountCount: list.length,
      syncedCount: synced,
      uniqueAppCount: index ? index.appCount || 0 : 0,
      gameAppCount: index ? index.gameAppCount || 0 : 0,
      gameCountComplete: index ? !!index.gameCountComplete : false,
      totalGames: totalGames,
      totalRealGames: totalRealGames,
      unknownGameCount: unknownGameCount,
      builtAt: index ? index.builtAt : null,
    };
  }

  /* ------------------------------------------------------------------ *
   * 展示
   * ------------------------------------------------------------------ */

  function describeOwnership(result, options) {
    var opts = options || {};
    var compact = !!opts.compact;
    if (!result || !result.owned) return opts.noneText || '无人拥有';
    var labels = [];
    for (var i = 0; i < result.owners.length; i++) labels.push(result.owners[i].label);
    if (compact) return '✓ ' + labels.join(' / ');
    return '已拥有：' + labels.join('、');
  }

  /**
   * 决定角标长什么样。这是内容脚本唯一的「判断」，抽出来是为了能单测。
   * detail: ownedByOthers() 的结果
   * options: { accountCount, syncedCount, currentAccountId, currentLabel }
   *
   * 重要：「没查到」不等于「没有」。档案私密 / 还没同步的账号必须单独说明，
   * 否则会给用户一个假的安全结论，反而害他重复购买（或以为不用买）。
   */
  function decideBadge(detail, options) {
    var opts = options || {};
    var accountCount = Number(opts.accountCount || 0);
    var syncedCount = opts.syncedCount == null ? accountCount : Number(opts.syncedCount);
    var labels = [];
    for (var i = 0; i < ((detail && detail.owners) || []).length; i++) labels.push(detail.owners[i].label);
    var who = labels.join('、');
    var hasCurrent = !!(detail && detail.ownedByCurrent);
    var otherCount = detail && detail.others ? detail.others.length : 0;
    var unsynced = Math.max(0, accountCount - syncedCount);
    var incomplete = unsynced > 0;

    if (!detail || !detail.owned) {
      if (syncedCount === 0) {
        return {
          tone: 'unknown',
          short: '待同步',
          long: accountCount > 0
            ? '这 ' + accountCount + ' 个账号都还没有同步库，无法判断'
            : '还没有添加任何 Steam 账号',
          warn: false,
          incomplete: true,
          owners: [],
        };
      }
      return {
        tone: 'none',
        short: '',
        long: incomplete
          ? '已同步的 ' + syncedCount + ' 个账号都没有这款游戏；另有 ' + unsynced + ' 个账号未同步，结论不完整'
          : '你的 ' + syncedCount + ' 个账号都没有这款游戏',
        warn: false,
        incomplete: incomplete,
        owners: [],
      };
    }
    if (hasCurrent && otherCount > 0) {
      return { tone: 'owned-both', short: '✓ 已拥有', long: '当前账号和' + otherCount + '个其他账号都拥有（' + who + '）', warn: false, incomplete: incomplete, owners: labels };
    }
    if (hasCurrent) {
      return { tone: 'owned-current', short: '✓ 当前账号已有', long: '当前账号已拥有', warn: false, incomplete: incomplete, owners: labels };
    }
    return {
      tone: 'owned-other',
      short: '⚠ ' + who + ' 已拥有',
      long: '当前账号没有，但 ' + who + ' 已拥有 —— 不用重复购买' + (incomplete ? '（另有 ' + unsynced + ' 个账号未同步）' : ''),
      warn: true,
      incomplete: incomplete,
      owners: labels,
    };
  }

  /**
   * 一个账号"有多少款游戏"。
   * 库记录里可能同时有：
   *   appids      —— 索引用的全部条目（含 DLC / 原声 / 工具 / 家庭共享），判断"有没有"时用它更宽松、不会漏
   *   gameAppids  —— 其中确认是"游戏本体"的那部分（GetOwnedGames 直接给，或按商店类型分类得到）
   * 显示必须以 gameAppids 为准，否则 305 项会被误读成 305 款游戏。
   * 返回 null 表示"游戏数未知"（只有条目列表、还没分类）。
   */
  function gameCountOf(lib) {
    if (!lib) return null;
    if (Array.isArray(lib.gameAppids)) return lib.gameAppids.length;
    if (lib.kind === 'games' && Array.isArray(lib.appids)) return lib.appids.length;
    if (typeof lib.gameCount === 'number') return lib.gameCount;
    return null;
  }

  /** 条目总数（含 DLC 等）。兼容原始记录与摘要对象两种形状。 */
  function entryCountOf(lib) {
    if (!lib) return 0;
    if (Array.isArray(lib.appids)) return lib.appids.length;
    if (typeof lib.entryCount === 'number') return lib.entryCount;
    return 0;
  }

  /**
   * 给人看的数量：以"游戏数"为主，DLC 等作为补充说明。
   *   71 款游戏
   *   71 款游戏（另 234 项 DLC/工具）
   *   305 项（含 DLC/工具，游戏数待识别）   <- 还没分类成功时，照实说
   */
  function describeCount(lib) {
    if (!lib) return '未同步';
    // 兼容两种形状：
    //   原始库记录 { appids, gameAppids, kind }（background 里存的）
    //   摘要对象   { entryCount, gameCount, kind }（getState 发给界面的，不带数组）
    var total = Array.isArray(lib.appids) ? lib.appids.length
      : (typeof lib.entryCount === 'number' ? lib.entryCount : 0);
    var games = null;
    if (Array.isArray(lib.gameAppids)) games = lib.gameAppids.length;
    else if (lib.kind === 'games' && Array.isArray(lib.appids)) games = lib.appids.length;
    else if (typeof lib.gameCount === 'number') games = lib.gameCount;
    if (games == null) {
      return total + ' 项（含 DLC/工具，游戏数待识别）';
    }
    var extras = total - games;
    return games + ' 款游戏' + (extras > 0 ? '（另 ' + extras + ' 项 DLC/工具）' : '');
  }

  /** 索引规模的统一说法。 */
  function describeIndex(index) {
    if (!index) return '0 个 AppID';
    var text = (index.appCount || 0) + ' 个 AppID';
    if (index.gameAppCount) {
      text += '，其中 ' + index.gameAppCount + ' 款游戏' + (index.gameCountComplete ? '' : '（部分账号游戏数未识别）');
    }
    return text;
  }

  /**
   * 快照有多旧 —— 快照最大的风险就是"过期"，所以必须让用户看得见。
   * 返回"刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / 未知时间"。
   */
  function describeAge(iso, now) {
    if (!iso) return '未知时间';
    var t = Date.parse(iso);
    if (isNaN(t)) return '未知时间';
    var nowMs = now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now));
    if (isNaN(nowMs)) nowMs = Date.now();
    var diff = nowMs - t;
    if (diff < 0) diff = 0;
    var min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    var day = Math.floor(hr / 24);
    if (day < 30) return day + ' 天前';
    return Math.floor(day / 30) + ' 个月前';
  }

  /** 顶部摘要那一行，扩展和手机端共用。 */
  function describeSummary(summary) {
    if (!summary) return '';
    return summary.accountCount + ' 个账号（已同步 ' + summary.syncedCount + '） · 索引覆盖 ' +
      (summary.uniqueAppCount || 0) + ' 个 AppID' +
      (summary.gameAppCount ? '，其中 ' + summary.gameAppCount + ' 款游戏' : '');
  }

  /**
   * 决定"这次登录态导入"应该落到哪条账号记录上。
   *
   * 规则（血泪）：**只按 SteamID 认账号**。
   *   · 有 SteamID 且已有记录 -> 更新那一条
   *   · 有 SteamID 但没有记录 -> 新建一条（换号导入时绝不能覆盖别的号）
   *   · 没有 SteamID（页面里读不到）-> 只能退回更新现有的登录态记录，并标记 unverified 让界面报警
   * 之前是"随便找一条 auto 记录覆盖"，于是导入小号时把大号记录里的库换掉了，
   * 面板就会拿错数据、把已拥有的游戏显示成没有。
   *
   * 返回 { account, created, matchedBy: 'steamid' | 'fallback' | 'new', unverified }
   */
  function pickSessionAccount(accounts, steamId64, options) {
    var opts = options || {};
    var list = Array.isArray(accounts) ? accounts : [];
    var id = steamId64 ? String(steamId64) : null;
    if (id) {
      var found = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && String(list[i].steamId64) === id) { found = list[i]; break; }
      }
      if (found) return { account: found, created: false, matchedBy: 'steamid', unverified: false };
      return {
        account: {
          id: makeAccountId(opts.label || id, list),
          label: opts.label || id,
          steamId64: id,
          auto: true,
          createdAt: opts.now || new Date().toISOString(),
        },
        created: true,
        matchedBy: 'new',
        unverified: false,
      };
    }
    var fallback = null;
    for (var j = 0; j < list.length; j++) {
      if (list[j] && list[j].auto === true) { fallback = list[j]; break; }
    }
    return { account: fallback, created: false, matchedBy: 'fallback', unverified: true };
  }

  var Core = {
    APP_ID_RE: APP_ID_RE,
    parseAppId: parseAppId,
    parseAccountKey: parseAccountKey,
    accountLabel: accountLabel,
    fromGetOwnedGames: fromGetOwnedGames,
    fromDynamicStore: fromDynamicStore,
    fromCommunityGamesXml: fromCommunityGamesXml,
    fromLicensesHtml: fromLicensesHtml,
    decodeXmlEntities: decodeXmlEntities,
    buildIndex: buildIndex,
    queryOwnership: queryOwnership,
    queryMany: queryMany,
    ownedByOthers: ownedByOthers,
    makeAccountId: makeAccountId,
    dedupeAccounts: dedupeAccounts,
    summarize: summarize,
    describeOwnership: describeOwnership,
    decideBadge: decideBadge,
    describeCount: describeCount,
    describeIndex: describeIndex,
    describeAge: describeAge,
    describeSummary: describeSummary,
    gameCountOf: gameCountOf,
    entryCountOf: entryCountOf,
    pickSessionAccount: pickSessionAccount,
  };

  root.SteamOwnerCore = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
