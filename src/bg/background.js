/*
 * Steam Multi-Owner :: background.js  (MV3 service worker, 经典脚本)
 * 职责：唯一的「真源」。所有账号、库快照、合并索引都在这里，content script / popup / options 只通过消息读写。
 */
importScripts('/src/lib/core.js', '/src/lib/steam-api.js');

const Core = globalThis.SteamOwnerCore;
const Api = globalThis.SteamApi;

const K = {
  accounts: 'smo.accounts',
  libraries: 'smo.libraries',
  index: 'smo.index',
  settings: 'smo.settings',
  meta: 'smo.meta',
};

const DEFAULT_SETTINGS = {
  apiKey: '',
  currentAccountId: '',
  autoRefreshHours: 0, // 0 = 关闭自动刷新
  showInlineBadges: true,
  showPanel: true,
  hideWhenNoneOwned: false,
};

/* ----------------------------- 存储层 ----------------------------- */

async function readAll() {
  const raw = await chrome.storage.local.get([K.accounts, K.libraries, K.index, K.settings, K.meta]);
  return {
    accounts: raw[K.accounts] || [],
    libraries: raw[K.libraries] || {},
    index: raw[K.index] || null,
    settings: Object.assign({}, DEFAULT_SETTINGS, raw[K.settings] || {}),
    meta: Object.assign({ version: chrome.runtime.getManifest().version }, raw[K.meta] || {}),
  };
}

async function writeAccounts(accounts) {
  await chrome.storage.local.set({ [K.accounts]: accounts });
}

async function writeLibraries(libraries) {
  await chrome.storage.local.set({ [K.libraries]: libraries });
}

async function writeSettings(settings) {
  await chrome.storage.local.set({ [K.settings]: settings });
}

async function rebuildIndex() {
  const state = await readAll();
  const libraries = state.libraries;
  const payload = [];
  for (const account of state.accounts) {
    const lib = libraries[account.id];
    if (!lib) continue;
    payload.push({
      accountId: account.id,
      label: Core.accountLabel(account),
      appids: lib.appids || [],
      // 让索引知道"其中哪些是游戏本体"，这样统计能给出准确的游戏数
      gameAppids: Array.isArray(lib.gameAppids) ? lib.gameAppids : null,
      kind: lib.kind || 'apps',
      updatedAt: lib.updatedAt || null,
    });
  }
  const index = Core.buildIndex(payload);
  const meta = Object.assign({}, state.meta, {
    lastRebuildAt: index.builtAt,
    accountCount: state.accounts.length,
    syncedCount: payload.length,
  });
  await chrome.storage.local.set({ [K.index]: index, [K.meta]: meta });
  await setBadgeText(String(index.appCount || ''));
  return index;
}

async function setBadgeText(t) {
  try {
    await chrome.action.setBadgeText({ text: t || '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#1b2838' });
  } catch (e) { /* SW 早期可能还没有 action */ }
}

/* ----------------------------- 账号同步 ----------------------------- */

async function syncAccount(accountId, options = {}) {
  const state = await readAll();
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('账号不存在：' + accountId);
  const useSession = options.useSession === true || account.auto === true;

  // ★ 登录态刷新只能刷"当前浏览器登录的那个号"。
  // 之前这里不管三七二十一就用当前会话的数据去写目标记录，于是：
  // 同步 A 号时实际抓的是当前登录的 B 号的数据 -> A 的快照被覆盖，
  // 两条记录变成一模一样（还把 B 的 SteamID 写到 A 上）。这是必须拦住的。
  if (useSession && account.auto) {
    const ctx = await Api.getSessionContext(fetch);
    const sessionId = ctx && ctx.steamId64 ? String(ctx.steamId64) : null;
    if (!sessionId) {
      throw sessionSkipError('读不到当前浏览器登录的 SteamID，无法确认要刷新的是哪个号。' +
        '请确认已登录 store.steampowered.com 后重试（或改用 API key 同步）。');
    }
    if (account.steamId64 && String(account.steamId64) !== sessionId) {
      throw sessionSkipError('这个账号（SteamID ' + account.steamId64 + '）不是当前浏览器登录的号' +
        '（现在登录的是 ' + sessionId + '）。登录态刷新只能刷新当前登录的账号；' +
        '要刷新它请先切到该号登录，或改用 API key 同步。');
    }
    if (!account.steamId64) {
      // 老记录没有 SteamID：补上，并且在下面按当前会话处理
      const accounts0 = state.accounts.map((a) => (a.id === account.id ? Object.assign({}, a, { steamId64: sessionId }) : a));
      await writeAccounts(accounts0);
      account.steamId64 = sessionId;
    }
  }

  const lib = await Api.fetchLibrary(fetch, account, {
    apiKey: state.settings.apiKey,
    useSession,
  });

  const libraries = state.libraries;
  libraries[accountId] = {
    appids: lib.appids,
    names: lib.names || {},
    gameAppids: Array.isArray(lib.gameAppids) ? lib.gameAppids : null,
    gameCount: lib.gameAppids ? lib.gameAppids.length : (lib.kind === 'games' ? lib.appids.length : null),
    entryCount: lib.appids.length,
    kind: lib.kind || 'apps',
    method: lib.method,
    sourceNote: lib.sourceNote || null,
    snapshotSteamId64: lib.steamId64 || account.steamId64 || null,
    snapshotPersona: lib.persona || null,
    identityVerified: !!(lib.identity && lib.identity.verified),
    identityConflict: (lib.identity && lib.identity.conflict) || null,
    fetchedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    note: lib.note || null,
    wishlist: lib.wishlist || null,
  };

  const accounts = state.accounts.map((a) =>
    a.id === accountId
      ? Object.assign({}, a, {
          lastSyncAt: libraries[accountId].updatedAt,
          lastMethod: lib.method,
          lastGameCount: lib.appids.length,
          lastError: null,
          steamId64: lib.steamId64 || a.steamId64,
        })
      : a);
  await writeAccounts(accounts);
  await writeLibraries(libraries);
  const index = await rebuildIndex();
  return {
    accountId,
    gameCount: lib.appids.length,
    kind: lib.kind || 'apps',
    method: lib.method,
    countText: Core.describeCount(libraries[accountId]),
    indexAppCount: index.appCount,
  };
}

/**
 * 带错误码的错误：让"因为不是当前登录的号而跳过"和"真的失败"能分开处理。
 * 跳过不是失败 —— 不该写进账号的 lastError，也不该让用户以为工具坏了。
 */
function sessionSkipError(message) {
  const err = new Error(message);
  err.skipped = true;
  return err;
}

async function syncAll(options = {}) {
  const state = await readAll();
  const results = [];
  // 登录态同步只能刷"当前浏览器登录的那个号"。这里只读一次身份，
  // 然后本地判断每个 auto 账号该刷还是该跳过 —— 跳过的不发请求、不写错误。
  let sessionId = null;
  let sessionProblem = null;
  if (state.accounts.some((a) => a.auto)) {
    try {
      const ctx = await Api.getSessionContext(fetch);
      sessionId = ctx && ctx.steamId64 ? String(ctx.steamId64) : null;
      if (!sessionId) sessionProblem = '读不到当前浏览器登录的 SteamID（确认已登录 store.steampowered.com）';
    } catch (e) {
      sessionProblem = e.message;
    }
  }

  for (const account of state.accounts) {
    const label = Core.accountLabel(account);
    if (account.auto) {
      if (!sessionId) {
        results.push({ accountId: account.id, label, status: 'skipped', skipped: true, message: sessionProblem || '无法确认当前登录的账号' });
        continue;
      }
      if (account.steamId64 && String(account.steamId64) !== sessionId) {
        results.push({
          accountId: account.id, label, status: 'skipped', skipped: true,
          message: '不是当前浏览器登录的号（现在登录的是 ' + sessionId + '）—— 想刷新它请先切到该号登录，或给它配 API key',
        });
        continue;
      }
    }
    try {
      const r = await syncAccount(account.id, options);
      results.push({ accountId: account.id, label, status: 'ok', gameCount: r.gameCount, countText: r.countText, method: r.method });
    } catch (err) {
      if (err && err.skipped) {
        results.push({ accountId: account.id, label, status: 'skipped', skipped: true, message: err.message });
        continue;
      }
      results.push({ accountId: account.id, label, status: 'failed', message: err.message });
      const accounts = (await readAll()).accounts.map((a) =>
        a.id === account.id ? Object.assign({}, a, { lastError: err.message, lastSyncAt: new Date().toISOString() }) : a);
      await writeAccounts(accounts);
    }
    if (state.settings.throttleMs !== 0) await Api.sleep(400);
  }
  return results;
}

/**
 * 从"用户正开着的任意 Steam 标签页"里读会话凭据。
 *
 * 这是最可靠的一条路：内容脚本站在页面里，DOM 上有什么就能读到什么 ——
 * 属性叫什么名字、JSON 有没有被 HTML 转义、藏在哪个 inline script 里，都不用猜。
 * 拿到 token 之后就能去调 IPlayerService/GetOwnedGames（小黑盒用的也是这个接口），
 * 得到"只含游戏本体、还带名字"的准确游戏列表。
 */
async function credsFromAnySteamTab() {
  try {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.filter((t) => t && t.id && /^https:\/\/(store|www)\.steampowered\.com\//.test(t.url || ''));
    for (const tab of hit) {
      const res = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'smo.sessionCreds' }, (r) => {
          resolve(chrome.runtime.lastError ? null : r);
        });
      });
      if (res && res.ok && res.token && res.steamId64) return res;
    }
  } catch (e) { /* 忽略：拿不到就走原来的抓取路线 */ }
  return null;
}

/** 用当前浏览器的 Steam 登录态导入一个账号（不需要 API key、不需要公开档案）。 */
async function importSession(label, creds) {
  const state = await readAll();
  // 优先走会话 token + GetOwnedGames（只含游戏本体，数字等于 Steam 的"游戏数"），
  // 拿不到才退到许可证条目列表 —— 后者数字会明显偏大，所以必须把 kind 一起记下来。
  // 凭据来源：调用方给的 > 用户打开的 Steam 标签页里读到的 > 后台自己抓页面解析
  const useCreds = creds || (await credsFromAnySteamTab()) || undefined;
  const lib = await Api.fetchSessionLibrary(fetch, { creds: useCreds });
  const persona = lib.persona || null;
  const fetchedSteamId = lib.steamId64 || null;
  // 备注名里不再带"（当前登录）"——界面已经用标签标出当前账号了，
  // 打在名字里会变成"xxx（当前登录）（当前登录）"这种重复。
  const display = label && label.trim() ? label.trim() : (persona || '当前登录的号');

  // ★ 必须按 SteamID 认账号，绝不能"随便找一条自动记录覆盖上去"。
  // 之前就是这里出的血：你原来那条记录没有 SteamID，于是导入别的号时，
  // 新号的库被写进了旧号的记录里，结果面板拿错数据、显示"没有这款游戏"。
  const picked = Core.pickSessionAccount(state.accounts, fetchedSteamId, { label: display });
  let account = picked.account;
  const created = picked.created;
  const unverified = picked.unverified;

  const accounts = state.accounts.slice();
  if (created) {
    accounts.push(account);
  } else if (account) {
    const idx = accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) {
      accounts[idx] = Object.assign({}, accounts[idx], {
        // 只在用户显式给了名字时才改备注名，否则保留原有名字
        label: label && label.trim() ? label.trim() : accounts[idx].label,
        steamId64: fetchedSteamId || accounts[idx].steamId64,
        auto: true,
      });
      account = accounts[idx];
    }
  } else {
    // 没有 SteamID 又没有可更新的登录态记录：新建一条并标记为"身份未确认"
    account = {
      id: Core.makeAccountId(display, accounts),
      label: display,
      auto: true,
      createdAt: new Date().toISOString(),
    };
    accounts.push(account);
  }

  const libraries = state.libraries;
  libraries[account.id] = {
    appids: lib.appids,
    names: lib.names || {},
    gameAppids: Array.isArray(lib.gameAppids) ? lib.gameAppids : null,
    gameCount: lib.gameAppids ? lib.gameAppids.length : (lib.kind === 'games' ? lib.appids.length : null),
    entryCount: lib.appids.length,
    kind: lib.kind || 'apps',
    method: lib.method || 'session',
    sourceNote: lib.sourceNote || null,
    // 把"这份快照属于谁、什么时候抓的"一起存下来，界面才能对人说明白
    snapshotSteamId64: fetchedSteamId || null,
    snapshotPersona: persona,
    identityVerified: !!(lib.identity && lib.identity.verified),
    identityConflict: (lib.identity && lib.identity.conflict) || null,
    fetchedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    wishlist: lib.wishlist || null,
  };
  const settings = Object.assign({}, state.settings, { currentAccountId: account.id });

  // 顺手清理历史脏数据：老版本可能留下没有 SteamID 的登录态记录，它们最容易挂着别人的库
  const legacyUnknown = accounts.filter((a) => a.auto && !a.steamId64 && a.id !== account.id).length;

  await writeAccounts(accounts);
  await writeLibraries(libraries);
  await writeSettings(settings);
  const index = await rebuildIndex();
  return {
    accountId: account.id,
    label: Core.accountLabel(account),
    gameCount: lib.appids.length,
    kind: lib.kind || 'apps',
    method: lib.method || 'session',
    sourceNote: lib.sourceNote || null,
    countText: Core.describeCount(libraries[account.id]),
    wishlistCount: (lib.wishlist || []).length,
    indexAppCount: index.appCount,
    persona,
    created,
    unverified,
    // 身份信息交给界面照实显示：抓的是哪个号、有没有确认、有没有冲突
    steamId64: fetchedSteamId,
    identityVerified: !!(lib.identity && lib.identity.verified),
    identityConflict: (lib.identity && lib.identity.conflict) || null,
    legacyUnknownCount: legacyUnknown,
    accountCount: accounts.length,
  };
}

/* ----------------------------- 消息处理 ----------------------------- */

const handlers = {
  async getState() {
    const state = await readAll();
    const index = state.index || Core.buildIndex([]);
    const summary = Core.summarize(index, state.accounts);
    const libraries = {};
    for (const id of Object.keys(state.libraries)) {
      const lib = state.libraries[id];
      libraries[id] = {
        // 用 Core 的判定，别自己写条件：kind 可能是 'games' / 'mixed' / 'apps'，
        // 只有 mixed 也有 gameAppids（游戏数已知 + 含 DLC），漏掉它就会误显示"待识别"
        gameCount: Core.gameCountOf(lib),
        entryCount: Core.entryCountOf(lib),
        kind: lib.kind || 'apps',
        updatedAt: lib.updatedAt,
        method: lib.method,
        sourceNote: lib.sourceNote || null,
        note: lib.note,
        countText: Core.describeCount(lib),
      };
    }
    return {
      accounts: state.accounts,
      settings: state.settings,
      summary,
      libraries,
      indexBuiltAt: index.builtAt,
    };
  },

  /**
   * 诊断：把每个数据源的真实返回摊开，用来定位"为什么抓到的库不对"。
   * 输出是可以直接复制发出去的纯文本 + 结构化数据。
   */
  async diagnose({ appid }) {
    const lines = [];
    const data = { version: chrome.runtime.getManifest().version, when: new Date().toISOString(), sources: {} };
    const put = (text) => lines.push(text);
    const target = appid ? Core.parseAppId(appid) : null;

    put('扩展版本：v' + data.version);
    put('时间：' + data.when);
    put('目标 AppID：' + (target || '（未提供）'));
    put('');

    // 0. 从用户打开的 Steam 标签页 DOM 里读凭据（最可靠的一条路）
    let tabCreds = null;
    try {
      tabCreds = await credsFromAnySteamTab();
      data.sources.tabCreds = tabCreds
        ? { token: tabCreds.token ? '有' : '没有', steamId64: tabCreds.steamId64 || null, persona: tabCreds.persona || null, signals: tabCreds.signals }
        : null;
      put('[0] 从打开的 Steam 标签页读凭据：' + (tabCreds
        ? (tabCreds.token ? '读到 token' : '⚠ 页面里没有 token') + (tabCreds.steamId64 ? '，SteamID ' + tabCreds.steamId64 : '，⚠ 没有 steamid') +
          '（来源：' + (tabCreds.signals || []).join('；') + '）'
        : '⚠ 没有找到已打开的 Steam 标签页（打开一个 store.steampowered.com 页面再诊断会更准）'));
    } catch (e) {
      data.sources.tabCreds = { error: e.message };
      put('[0] 从打开的 Steam 标签页读凭据：失败 → ' + e.message);
    }

    // 1. 会话身份（商店页面里读到的 token / steamid / 昵称）
    let ctx = null;
    try {
      ctx = await Api.getSessionContext(fetch);
      if (tabCreds && tabCreds.token && (!ctx.token || !ctx.steamId64)) {
        ctx = { token: ctx.token || tabCreds.token, steamId64: ctx.steamId64 || tabCreds.steamId64, persona: ctx.persona || tabCreds.persona, signals: tabCreds.signals };
      }
      data.sources.identity = { token: ctx.token ? '有' : '没有', steamId64: ctx.steamId64 || null, persona: ctx.persona || null };
      put('[1] 商店页面里的会话身份：' + (ctx.steamId64 ? 'SteamID ' + ctx.steamId64 : '⚠ 没读到 SteamID') +
        '，webapi_token：' + (ctx.token ? '有' : '没有') + (ctx.persona ? '，昵称 ' + ctx.persona : ''));
    } catch (e) {
      data.sources.identity = { error: e.message };
      put('[1] 商店页面里的会话身份：失败 → ' + e.message);
    }

    // 2. dynamicstore 的许可证条目
    try {
      const ds = await Api.getDynamicStoreUserData(fetch);
      data.sources.dynamicStore = {
        count: ds.appids.length,
        steamid: ds.steamId64 || null,
        hasTarget: target ? ds.appids.indexOf(target) >= 0 : null,
        sample: ds.appids.slice(0, 12),
      };
      put('[2] dynamicstore 许可证条目：' + ds.appids.length + ' 项' +
        '，数据里的 steamid：' + (ds.steamId64 || '（没有这个字段）') +
        (target ? '，包含目标 AppID：' + (ds.appids.indexOf(target) >= 0 ? '是' : '否') : '') +
        '，前 12 个：' + ds.appids.slice(0, 12).join(','));
    } catch (e) {
      data.sources.dynamicStore = { error: e.message };
      put('[2] dynamicstore 许可证条目：失败 → ' + e.message);
    }

    // 3. 用会话 token 调 GetOwnedGames（真正的"游戏本体"列表）
    if (ctx && ctx.token && ctx.steamId64) {
      try {
        const own = await Api.getOwnedGames(fetch, ctx.token, ctx.steamId64);
        data.sources.getOwnedGames = {
          privateProfile: !!own.privateProfile,
          count: own.appids.length,
          hasTarget: target ? own.appids.indexOf(target) >= 0 : null,
          sample: own.appids.slice(0, 12),
        };
        put('[3] GetOwnedGames（会话 token）：' + (own.privateProfile ? '⚠ 返回为空（档案游戏详情未公开？）' : own.appids.length + ' 款') +
          (target && !own.privateProfile ? '，包含目标 AppID：' + (own.appids.indexOf(target) >= 0 ? '是' : '否') : '') +
          (own.appids.length ? '，前 12 个：' + own.appids.slice(0, 12).join(',') : ''));
      } catch (e) {
        data.sources.getOwnedGames = { error: e.message };
        put('[3] GetOwnedGames（会话 token）：失败 → ' + e.message);
      }
    } else {
      data.sources.getOwnedGames = { skipped: '没有 token 或 steamid' };
      put('[3] GetOwnedGames（会话 token）：跳过（没拿到 token 或 steamid）');
    }

    // 4. 许可证页面（最后兜底）
    try {
      const lic = await Api.getLicensesHtml(fetch);
      data.sources.licensesPage = {
        count: lic.appids.length,
        hasTarget: target ? lic.appids.indexOf(target) >= 0 : null,
        sample: lic.appids.slice(0, 12),
      };
      put('[4] /account/licenses 页面：' + lic.appids.length + ' 项' +
        (target ? '，包含目标 AppID：' + (lic.appids.indexOf(target) >= 0 ? '是' : '否') : '') +
        '，前 12 个：' + lic.appids.slice(0, 12).join(','));
    } catch (e) {
      data.sources.licensesPage = { error: e.message };
      put('[4] /account/licenses 页面：失败 → ' + e.message);
    }

    // 5. 本地记录（看每条记录挂的是谁的数据）
    const state = await readAll();
    put('');
    put('[5] 本地记录：');
    data.records = state.accounts.map((a) => {
      const lib = state.libraries[a.id];
      const row = {
        id: a.id,
        label: Core.accountLabel(a),
        steamId64: a.steamId64 || null,
        auto: !!a.auto,
        entries: lib ? (lib.appids || []).length : null,
        games: Core.gameCountOf(lib),
        kind: lib ? lib.kind : null,
        method: lib ? lib.method : null,
        snapshotSteamId64: lib ? lib.snapshotSteamId64 || null : null,
        fetchedAt: lib ? lib.fetchedAt || lib.updatedAt || null : null,
        hasTarget: lib && target ? (lib.appids || []).indexOf(target) >= 0 : null,
      };
      put('  · ' + row.label + '：SteamID ' + (row.steamId64 || '（无）') +
        '，条目 ' + (row.entries == null ? '未同步' : row.entries) +
        '，游戏 ' + (row.games == null ? '?' : row.games) +
        (row.snapshotSteamId64 ? '，快照身份 ' + row.snapshotSteamId64 : '') +
        (target && row.entries != null ? '，包含目标：' + (row.hasTarget ? '是' : '否') : ''));
      return row;
    });

    // 6. 本地索引结论
    const index = state.index || Core.buildIndex([]);
    const owners = target && index.owners[target] ? index.owners[target] : [];
    put('');
    put('[6] 本地索引：覆盖 ' + (index.appCount || 0) + ' 个 AppID' +
      (target ? '；目标 AppID 的拥有者：' + (owners.length ? owners.join('、') : '无') : ''));
    data.index = { appCount: index.appCount || 0, gameAppCount: index.gameAppCount || 0, owners };

    // 7. 购物车结构探测（如果你正开着购物车页面）
    try {
      const tabs = await chrome.tabs.query({});
      const cartTab = tabs.find((t) => t && t.id && /store\.steampowered\.com\/(cart|checkout)/.test(t.url || ''));
      if (!cartTab) {
        put('');
        put('[7] 购物车结构：没有打开购物车页面（打开它再诊断，我就能看到真实的行结构）');
        data.sources.cart = { skipped: 'no-cart-tab' };
      } else {
        const probe = await new Promise((resolve) => {
          chrome.tabs.sendMessage(cartTab.id, { type: 'smo.cartProbe' }, (r) => resolve(chrome.runtime.lastError ? null : r));
        });
        put('');
        if (!probe || !probe.ok) {
          put('[7] 购物车结构：探测失败 → ' + ((probe && probe.error) || '内容脚本没有响应，刷新该页面再试'));
          data.sources.cart = { error: (probe && probe.error) || 'no-response' };
        } else {
          put('[7] 购物车结构（' + probe.kind + '）：');
          put('    标题里的件数：' + (probe.headerCount == null ? '（没读到）' : probe.headerCount) +
            '，空车文案：' + (probe.emptyText ? '有' : '无') +
            '，data-cart_config 空数组：' + (probe.configIsEmptyArray ? '是' : '否'));
          put('    data-cart_config 原文：' + (probe.configRaw || '（空）'));
          put('    命中我的容器选择器：' + (Object.keys(probe.scopesMatched || {}).length
            ? JSON.stringify(probe.scopesMatched) : '一个都没有（所以要靠"移除"控件和 config）'));
          put('    "移除"控件样本：' + ((probe.removeTextSamples || []).join(' | ') || '（没找到）'));
          put('    我最终认出：' + ((probe.recognized || []).join('、') || '（一件都没认出）') +
            '，来源：' + ((probe.recognizedSources || []).join('、') || '无'));
          const cands = probe.candidates || [];
          put('    页面上的 /app/ 链接共 ' + cands.length + ' 个（最多列 30 个），带"移除"控件的：');
          for (const c of cands) {
            put('      · ' + c.appid + (c.name ? '（' + c.name + '）' : '') +
              ' 移除控件=' + (c.hasRemoveControl ? '有(第 ' + c.removeAtHop + ' 层)' : '无') +
              ' 祖先链=' + (c.ancestors || []).slice(0, 3).join(' < '));
          }
          data.sources.cart = probe;
        }
      }
    } catch (e) {
      put('[7] 购物车结构：失败 → ' + e.message);
      data.sources.cart = { error: e.message };
    }

    return { text: lines.join('\n'), data };
  },

  /**
   * 实时校验"当前登录账号有没有这一款游戏"。
   *
   * 为什么要它：快照会过期，而"我现在这个号到底有没有"是最高频、也最不能错的问题。
   * 这条路是**当场问 Steam**，不经过本地快照：
   *   凭据来源 = 你打开的 Steam 标签页 DOM（webapi_token 可以直接当 key 用）
   *   接口     = GetOwnedGames + appids_filter，只查这一个 appid
   * 拿不到凭据或接口不给结论时返回 live:null + 原因 —— 绝不当成"没有"。
   */
  async liveCheckApp({ appid }) {
    const id = Core.parseAppId(appid);
    if (!id) throw new Error('不是有效的 AppID：' + appid);
    const creds = await credsFromAnySteamTab();
    const key = (creds && creds.token) || null;
    const steamId = (creds && creds.steamId64) || null;
    const why = [];

    // 路 1：会话 token + GetOwnedGames(appids_filter) —— 最明确的答案
    if (key && steamId) {
      try {
        const r = await Api.getOwnedGamesForApp(fetch, key, steamId, id);
        if (r.owns !== null) {
          return { appid: id, live: r.owns, uncertain: false, steamId64: steamId, source: 'session-api' };
        }
        why.push('会话接口：' + (r.reason || '未给出结论'));
      } catch (e) {
        why.push('会话接口：' + e.message);
      }
    } else {
      why.push('没读到 webapi_token（请保持一个已登录的 store 页面开着）');
    }

    // 路 2：商店自己的 appuserdetails —— 只用 cookie，不需要 token
    try {
      const r2 = await Api.getAppUserDetails(fetch, id);
      if (r2.owns !== null) {
        return { appid: id, live: r2.owns, uncertain: false, steamId64: steamId, source: 'appuserdetails', reason: why.join('；') || null };
      }
      why.push('appuserdetails：' + (r2.reason || '未给出结论'));
    } catch (e) {
      why.push('appuserdetails：' + e.message);
    }

    return { appid: id, live: null, uncertain: true, steamId64: steamId, source: 'none', reason: why.join('；') };
  },

  async checkAppIds({ appids, currentAccountId }) {
    const state = await readAll();
    const index = state.index || Core.buildIndex([]);
    const current = currentAccountId || state.settings.currentAccountId || '';
    // 只有"真的同步到过库"的账号才算数：没同步的账号不能当成"没有这款游戏"
    const syncedCount = state.accounts.filter((a) => state.libraries[a.id]).length;
    const results = {};
    const list = Array.isArray(appids) ? appids : [];
    for (const raw of list) {
      const appid = Core.parseAppId(raw);
      if (!appid) continue;
      const detail = Core.ownedByOthers(index, appid, state.accounts, current);
      const badge = Core.decideBadge(detail, {
        accountCount: state.accounts.length,
        syncedCount,
      });
      let name = null;
      for (const id of Object.keys(state.libraries)) {
        const names = state.libraries[id].names || {};
        if (names[appid]) { name = names[appid]; break; }
      }
      results[appid] = {
        appid,
        name,
        owned: detail.owned,
        ownedByCurrent: detail.ownedByCurrent,
        ownedByOtherOnly: detail.ownedByOtherOnly,
        otherCount: detail.others.length,
        owners: detail.owners.map((o) => ({ accountId: o.accountId, label: o.label })),
        others: detail.others.map((o) => ({ accountId: o.accountId, label: o.label })),
        badge,
      };
    }
    return { results, currentAccountId: current, accountCount: state.accounts.length, syncedCount, indexAppCount: (state.index && state.index.appCount) || 0 };
  },

  async addAccount({ label, key, apiKey, auto }) {
    const state = await readAll();
    const parsed = Core.parseAccountKey(key || '');
    if (!parsed && !auto) throw new Error('请填写 SteamID64 / 自定义 ID / 个人资料链接');
    const display = (label && label.trim()) || (parsed && (parsed.vanity || parsed.steamId64)) || '新账号';
    const account = Object.assign(
      {
        id: Core.makeAccountId(display, state.accounts),
        label: display,
        apiKey: apiKey || undefined,
        auto: auto === true ? true : undefined,
        createdAt: new Date().toISOString(),
      },
      parsed || {},
    );
    const accounts = Core.dedupeAccounts(state.accounts.concat([account]));
    await writeAccounts(accounts);
    if (account.auto) {
      return importSession(display);
    }
    return { accountId: account.id, label: Core.accountLabel(account) };
  },

  async updateAccount({ accountId, patch }) {
    const state = await readAll();
    const accounts = state.accounts.map((a) => {
      if (a.id !== accountId) return a;
      const next = Object.assign({}, a, patch || {});
      if (patch && patch.key !== undefined) {
        const parsed = Core.parseAccountKey(patch.key);
        delete next.key;
        if (parsed) Object.assign(next, parsed);
      }
      return next;
    });
    await writeAccounts(accounts);
    await rebuildIndex();
    return { ok: true };
  },

  async removeAccount({ accountId }) {
    const state = await readAll();
    const accounts = state.accounts.filter((a) => a.id !== accountId);
    const libraries = Object.assign({}, state.libraries);
    delete libraries[accountId];
    const settings = Object.assign({}, state.settings);
    if (settings.currentAccountId === accountId) settings.currentAccountId = '';
    await writeAccounts(accounts);
    await writeLibraries(libraries);
    await writeSettings(settings);
    await rebuildIndex();
    return { ok: true };
  },

  async syncAccount({ accountId, useSession }) {
    return syncAccount(accountId, { useSession });
  },

  async syncAll({ useSession } = {}) {
    return { results: await syncAll({ useSession }) };
  },

  async importSession({ label, accountId, creds }) {
    if (accountId) {
      const r = await syncAccount(accountId, { useSession: true });
      return { accountId: r.accountId, gameCount: r.gameCount, label: accountId };
    }
    return importSession(label, creds);
  },

  async setSettings({ patch }) {
    const state = await readAll();
    const settings = Object.assign({}, state.settings, patch || {});
    await writeSettings(settings);
    await scheduleAlarms(settings);
    return { settings };
  },

  async exportData() {
    const state = await readAll();
    return {
      exportedAt: new Date().toISOString(),
      version: chrome.runtime.getManifest().version,
      accounts: state.accounts,
      libraries: state.libraries,
      settings: Object.assign({}, state.settings, { apiKey: '' }), // 不导出密钥
    };
  },

  async importData({ payload, merge }) {
    if (!payload || !Array.isArray(payload.accounts)) throw new Error('文件格式不对：缺少 accounts');
    const state = await readAll();
    const accounts = merge
      ? Core.dedupeAccounts(state.accounts.concat(payload.accounts))
      : payload.accounts;
    const libraries = merge ? Object.assign({}, state.libraries, payload.libraries || {}) : (payload.libraries || {});
    await writeAccounts(accounts);
    await writeLibraries(libraries);
    const index = await rebuildIndex();
    return { accounts: accounts.length, appCount: index.appCount };
  },

  async rebuildIndex() {
    const index = await rebuildIndex();
    return { appCount: index.appCount };
  },

  async getAppName({ appid }) {
    const id = Core.parseAppId(appid);
    if (!id) throw new Error('不是有效的 AppID');
    const name = await Api.getAppName(fetch, id);
    return { appid: id, name };
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message && message.type];
  if (!handler) {
    sendResponse({ ok: false, error: '未知消息类型：' + (message && message.type) });
    return false;
  }
  Promise.resolve()
    .then(() => handler(message.payload || {}, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err), attempts: err && err.attempts }));
  return true; // 异步
});

/* ----------------------------- 定时刷新 ----------------------------- */

async function scheduleAlarms(settings) {
  try {
    await chrome.alarms.clear('smo.refresh');
    const hours = Number(settings.autoRefreshHours || 0);
    if (hours > 0) {
      await chrome.alarms.create('smo.refresh', { periodInMinutes: Math.max(30, hours * 60) });
    }
  } catch (e) { /* ignore */ }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'smo.refresh') return;
  const state = await readAll();
  const settings = state.settings;
  const now = Date.now();
  const stale = state.accounts.filter((a) => {
    if (a.auto) return true; // 会话导入的账号：靠当前登录态刷新
    const lib = state.libraries[a.id];
    if (!lib || !lib.updatedAt) return true;
    return now - Date.parse(lib.updatedAt) > settings.autoRefreshHours * 3600 * 1000;
  });
  for (const a of stale) {
    try { await syncAccount(a.id, { useSession: !!a.auto }); } catch (e) { /* 记在账号上 */ }
    await Api.sleep(500);
  }
  await rebuildIndex();
});

/* ----------------------------- 一次性数据整理 ----------------------------- */

/**
 * 早期版本把"（当前登录）"写进了登录态导入账号的备注名里，
 * 于是界面上会出现"xxx（当前登录）（当前登录）"。这里把它清掉。
 * 只处理 auto（登录态导入）的账号，用户自己起的名字不动。
 */
function stripAutoSuffix(account) {
  if (!account || !account.auto || typeof account.label !== 'string') return account;
  const cleaned = account.label.replace(/\s*[（(]\s*当前登录\s*[)）]\s*$/, '').trim();
  if (!cleaned || cleaned === account.label) return account;
  return Object.assign({}, account, { label: cleaned });
}

async function normalizeAutoLabels() {
  const state = await readAll();
  const accounts = state.accounts.map(stripAutoSuffix);
  const changed = accounts.some((a, i) => a !== state.accounts[i]);
  if (changed) await writeAccounts(accounts);
  return changed;
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await readAll();
  await writeSettings(state.settings);
  await normalizeAutoLabels();
  await rebuildIndex();
  await scheduleAlarms(state.settings);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await readAll();
  await normalizeAutoLabels();
  await scheduleAlarms(state.settings);
});

// service worker 每次启动都整理一次（幂等，没变化就不写存储）
normalizeAutoLabels().catch(() => {});
