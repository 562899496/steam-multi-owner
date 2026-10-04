/*
 * Steam Multi-Owner :: content.js
 * 只做三件事：找出页面上的 appid -> 问后台 -> 画角标/面板。
 * 所有判断都在 core.js / background.js 里，这里保持"薄"。
 */
(function () {
  'use strict';

  if (window.__smoLoaded) return;
  window.__smoLoaded = true;

  const Core = globalThis.SteamOwnerCore;
  const PANEL_ID = 'smo-panel-host';
  const CACHE_TTL = 30 * 1000; // 同一页内的查询缓存

  let settings = { showInlineBadges: true, showPanel: true, hideWhenNoneOwned: false };
  let currentAccountId = '';
  let accountCount = 0;
  let lastState = null;
  const queryCache = new Map(); // appid -> result
  const liveByAppid = new Map(); // appid -> 实时校验结果（当前登录账号，当场问 Steam）
  let decorated = new WeakSet();

  /* ---------------------------- 工具 ---------------------------- */

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { ok: false, error: '没有响应' });
      });
    });
  }

  function throttle(fn, ms) {
    let timer = null;
    let last = 0;
    return function (...args) {
      const now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn.apply(null, args);
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn.apply(null, args);
      }, ms - (now - last));
    };
  }

  function appIdOf(el) {
    if (!el || !el.getAttribute) return null;
    const direct = el.getAttribute('data-appid') || el.getAttribute('data-ds-appid') ||
      el.getAttribute('data-app-id') || el.getAttribute('data-ds-bundleid');
    if (direct && /^\d+$/.test(direct.trim())) return Number(direct.trim());
    const link = el.querySelector ? el.querySelector('a[href*="/app/"]') : null;
    if (link) return Core.parseAppId(link.getAttribute('href'));
    if (el.tagName === 'A') return Core.parseAppId(el.getAttribute('href'));
    return null;
  }

  function pageKind() {
    const p = location.pathname;
    if (/^\/app\/\d+/.test(p)) return 'app';
    if (/\/wishlist/.test(p)) return 'wishlist';
    if (/^\/cart/.test(p)) return 'cart';
    if (/^\/(checkout|purchase)/.test(p)) return 'checkout';
    if (/^\/search/.test(p)) return 'search';
    if (/^\/(sub|bundle|app)\//.test(p)) return 'app';
    return 'list';
  }

  const CONTAINER_SELECTORS = [
    '.wishlist_row',
    '.search_result_row',
    '.cart_item',
    '.store_capsule',
    '.tab_item',
    '.recommendation',
    '.daily_deal',
    '.capsule',
    '.home_page_content .store_capsule_frame',
    '.curator_showcase_item',
  ];

  function collectTargets() {
    const seen = new Set();
    const out = [];
    const selector = CONTAINER_SELECTORS.join(',');
    let nodes = [];
    try { nodes = document.querySelectorAll(selector); } catch (e) { nodes = []; }
    for (const node of nodes) {
      const appid = appIdOf(node);
      if (!appid || seen.has(node)) continue;
      seen.add(node);
      out.push({ node, appid });
      if (out.length >= 300) return out;
    }
    // 兜底：所有带 data-appid 的元素
    for (const node of document.querySelectorAll('[data-appid],[data-ds-appid]')) {
      const appid = appIdOf(node);
      if (!appid || seen.has(node)) continue;
      seen.add(node);
      out.push({ node, appid });
      if (out.length >= 300) break;
    }
    return out;
  }

  /* ---------------------------- 数据 ---------------------------- */

  async function loadState() {
    const res = await send('getState');
    if (!res.ok) return null;
    lastState = res.data;
    settings = Object.assign(settings, res.data.settings || {});
    currentAccountId = res.data.settings.currentAccountId || '';
    accountCount = (res.data.accounts || []).length;
    return res.data;
  }

  async function check(appids, force) {
    const missing = [];
    const result = new Map();
    for (const id of appids) {
      const hit = queryCache.get(id);
      if (hit && !force && Date.now() - hit.at < CACHE_TTL) result.set(id, hit.value);
      else missing.push(id);
    }
    if (missing.length) {
      const res = await send('checkAppIds', { appids: missing, currentAccountId });
      if (res.ok && res.data) {
        for (const [id, value] of Object.entries(res.data.results)) {
          queryCache.set(Number(id), { at: Date.now(), value });
          result.set(Number(id), value);
        }
      }
    }
    return result;
  }

  /* ---------------------------- 画角标 ---------------------------- */

  function badgeEl(result, variant) {
    const span = document.createElement('span');
    const tone = result.badge ? result.badge.tone : 'unknown';
    span.className = 'smo-badge smo-tone-' + tone + (variant ? ' smo-badge-' + variant : '');
    const text = result.badge && result.badge.short ? result.badge.short : '检查中…';
    span.textContent = text;
    span.title = (result.badge && result.badge.long) || '';
    if (result.name) span.title = result.name + ' — ' + span.title;
    return span;
  }

  async function decorateInline() {
    if (!settings.showInlineBadges) return;
    const targets = collectTargets().filter((t) => !decorated.has(t.node));
    if (!targets.length) return;
    const results = await check([...new Set(targets.map((t) => t.appid))]);
    for (const { node, appid } of targets) {
      const result = results.get(appid);
      decorated.add(node);
      if (!result) continue;
      // 没什么可说的（比如谁都没有）就不加角标，避免满屏噪音
      if (!result.badge || !result.badge.short) continue;
      if (settings.hideWhenNoneOwned && !result.owned) continue;
      const badge = badgeEl(result, 'inline');
      const anchor = node.querySelector('.title, .search_name, .wishlist_row_title, .cart_item_name, .name') || node;
      try {
        anchor.appendChild(badge);
      } catch (e) {
        node.appendChild(badge);
      }
    }
  }

  /* ---------------------------- 详情面板 ---------------------------- */

  function panelCss() {
    return `
      :host { all: initial; }
      .wrap {
        font: 13px/1.55 "Motiva Sans", "Microsoft YaHei", Arial, sans-serif;
        color: #c7d5e0; background: linear-gradient(160deg, #1b2838 0%, #16202d 100%);
        border: 1px solid #2a475e; border-radius: 6px; width: 320px;
        box-shadow: 0 8px 28px rgba(0,0,0,.55); overflow: hidden;
      }
      .head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: rgba(0,0,0,.25); cursor: pointer; }
      .head b { font-size: 12px; letter-spacing: .4px; color: #a4d007; font-weight: 600; text-transform: uppercase; }
      .count { margin-left: auto; font-size: 11px; color: #6b8299; }
      .body { padding: 10px 12px 12px; }
      .verdict { font-size: 13px; margin-bottom: 9px; padding: 8px 10px; border-radius: 4px; border-left: 3px solid #2a475e; background: rgba(0,0,0,.2); }
      .tone-owned-current, .tone-owned-both { border-left-color: #a4d007; color: #cdee9a; }
      .tone-owned-other { border-left-color: #e6a919; color: #ffd98a; }
      .tone-none { border-left-color: #6b8299; color: #96a7b5; }
      .tone-unknown { border-left-color: #6b8299; color: #96a7b5; }
      ul { list-style: none; margin: 0 0 10px; padding: 0; }
      li { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; border-bottom: 1px dashed rgba(42,71,94,.6); }
      li:last-child { border-bottom: 0; }
      .who { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .age { font-size: 10px; color: #6b8299; white-space: nowrap; }
      .mark { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: #223b4d; color: #8facc4; }
      .mark.yes { background: #3b5b1e; color: #cdee9a; }
      .mark.no { background: #2a3b4a; color: #7b93a6; }
      .me { color: #66c0f4; }
      .acts { display: flex; gap: 8px; }
      button {
        flex: 1; font: inherit; font-size: 12px; cursor: pointer; padding: 6px 8px; border-radius: 3px;
        border: 0; color: #dbe8f2; background: linear-gradient(to bottom, #67c1f5 0%, #417a9b 100%);
        background: linear-gradient(to bottom, #2a475e 0%, #1b2838 100%); border: 1px solid #2a475e;
      }
      button:hover { background: linear-gradient(to bottom, #3d6c8f 0%, #2a475e 100%); color: #fff; }
      button[disabled] { opacity: .55; cursor: default; }
      .hint { margin-top: 8px; font-size: 11px; color: #6b8299; }
      .collapsed .body { display: none; }

      /* 收进边缘时的小标签：贴住右侧，只显示一个圆点 + 竖排两三个字 */
      .tab {
        display: flex; flex-direction: column; align-items: center; gap: 7px;
        width: 30px; padding: 9px 3px; cursor: pointer;
        border-radius: 6px 0 0 6px; border: 1px solid #2a475e; border-right: 0;
        background: linear-gradient(160deg, #1b2838 0%, #16202d 100%);
        box-shadow: -3px 3px 12px rgba(0,0,0,.5);
        font: 11px/1.2 "Motiva Sans", "Microsoft YaHei", Arial, sans-serif; color: #c7d5e0;
      }
      .tab:hover { background: linear-gradient(160deg, #24384c 0%, #1b2838 100%); }
      .tab .dot { width: 11px; height: 11px; border-radius: 50%; background: #6b8299; flex: 0 0 auto; }
      .tab .txt { writing-mode: vertical-rl; letter-spacing: 1px; white-space: nowrap; }
      .tab.tone-owned-other { border-color: #b5871c; }
      .tab.tone-owned-other .dot { background: #e6a919; }
      .tab.tone-owned-other .txt { color: #ffd98a; }
      .tab.tone-owned-current, .tab.tone-owned-both { border-color: #5c8a1e; }
      .tab.tone-owned-current .dot, .tab.tone-owned-both .dot { background: #a4d007; }
      .tab.tone-owned-current .txt, .tab.tone-owned-both .txt { color: #cdee9a; }
    `;
  }

  function ensurePanel() {
    let host = document.getElementById(PANEL_ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = PANEL_ID;
    host.style.cssText = 'position:fixed;top:74px;right:14px;z-index:2147483000;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = panelCss();
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.id = 'tab';
    tab.hidden = true;
    tab.innerHTML = '<span class="dot"></span><span class="txt" id="tabText">多账号</span>';
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="head" id="head" title="点击收起 / 展开">
        <b>多账号拥有检查</b>
        <span class="count" id="count"></span>
        <span class="fold" id="fold">收起</span>
      </div>
      <div class="body" id="body"></div>`;
    root.appendChild(style);
    root.appendChild(tab);
    root.appendChild(wrap);
    document.documentElement.appendChild(host);

    // 收起 = 缩成贴边小标签；展开 = 完整面板。状态记在 localStorage 里。
    const applyCollapsed = (collapsed) => {
      wrap.hidden = collapsed;
      tab.hidden = !collapsed;
      host.style.right = collapsed ? '0px' : '14px';
      host.style.top = collapsed ? '120px' : '74px';
      try { localStorage.setItem('smo.collapsed', collapsed ? '1' : '0'); } catch (e) {}
    };
    root.getElementById('head').addEventListener('click', () => applyCollapsed(!wrap.hidden));
    tab.addEventListener('click', () => applyCollapsed(false));
    let saved = false;
    try { saved = localStorage.getItem('smo.collapsed') === '1'; } catch (e) {}
    applyCollapsed(saved);
    host.__smoApplyCollapsed = applyCollapsed;
    return host;
  }

  /**
   * Steam 页面自己有没有说"当前登录账号已拥有这款游戏"？
   * 这是对我们本地快照的交叉校验：如果 Steam 说有、我们的索引说没有，
   * 那一定是快照抓错了账号或过期了 —— 必须明确报警，不能默默给错答案。
   * 只认特征很明显的句子，避免误报。
   */
  function steamOwnershipSignal() {
    try {
      const text = (document.body && document.body.innerText) ? document.body.innerText : '';
      if (!text) return false;
      return /is already in your Steam library|已在您的 Steam 库中|已在您的库中|已经在您的 Steam 库中/i.test(text);
    } catch (e) {
      return false;
    }
  }

  function renderPanel(appid, result, state) {
    const host = ensurePanel();
    const root = host.shadowRoot;
    const body = root.getElementById('body');
    const count = root.getElementById('count');
    const accounts = (state && state.accounts) || [];
    count.textContent = accounts.length ? accounts.length + ' 个账号 / ' + (result.name || 'AppID ' + appid) : '未配置账号';

    const rows = accounts.map((a) => {
      const owns = result.owners.some((o) => o.accountId === a.id);
      const isCurrent = a.id === currentAccountId;
      const lib = (state && state.libraries && state.libraries[a.id]) || null;
      const age = lib ? Core.describeAge(lib.updatedAt || lib.fetchedAt) : null;
      return `<li><span class="who${isCurrent ? ' me' : ''}">${escapeHtml(Core.accountLabel(a))}${isCurrent ? ' (当前登录)' : ''}</span>
        <span class="age">${age && !isCurrent ? escapeHtml(age) : ''}</span>
        <span class="mark ${owns ? 'yes' : 'no'}">${owns ? '已拥有' : '未拥有'}</span></li>`;
    }).join('');

    // 实时结论 vs 快照结论，分开摆清楚：
    //   · 当前登录账号 -> 当场问 Steam（liveByAppid），过期不了
    //   · 其他账号     -> 只能靠本地快照，所以标注"多久前抓的"
    const live = liveByAppid.get(appid) || null;
    const domOwned = steamOwnershipSignal();
    let liveLine = '';
    if (domOwned) {
      liveLine = '<div class="verdict tone-owned-current">Steam 页面显示：当前登录账号<b>已经拥有</b>这款游戏（实时）</div>';
    } else if (live && live.loading) {
      liveLine = '<div class="hint">正在实时校验当前登录账号…</div>';
    } else if (live && live.live === true) {
      liveLine = '<div class="verdict tone-owned-current">实时接口查询：当前登录账号<b>已经拥有</b>这款游戏</div>';
    } else if (live && live.live === false) {
      liveLine = '<div class="verdict tone-none">实时接口查询：当前登录账号<b>没有</b>这款游戏</div>';
    } else if (live && live.reason) {
      liveLine = '<div class="hint">当前账号实时校验未得出结论：' + escapeHtml(live.reason) + '</div>';
    }

    // 交叉校验：Steam 说拥有，而我们的索引里没有 -> 快照有问题，明说
    const mismatch = !result.owned && steamOwnershipSignal();
    const warnBox = mismatch
      ? `<div class="verdict tone-owned-other">⚠ Steam 页面显示当前登录的账号**已经拥有**这款游戏，
但本地快照里没有它 —— 这份快照很可能是别的账号的数据，或者已经过期。<br>
请点下面的「刷新数据」重新抓一次（确保浏览器当前登录的就是你要抓的账号）。</div>`
      : '';

    body.innerHTML = `
      ${warnBox}
      ${liveLine}
      <div class="verdict tone-${result.badge ? result.badge.tone : 'unknown'}">${escapeHtml(result.badge ? result.badge.long : '')}</div>
      ${accounts.length ? `<ul>${rows}</ul>` : '<div class="hint">还没有添加任何 Steam 账号。</div>'}
      <div class="acts">
        <button id="refresh">刷新数据</button>
        <button id="manage">管理账号</button>
      </div>
      <div class="hint" id="syncNote"></div>
      <div class="hint">当前账号是实时查的；其他账号只能靠本地快照（上表已标出抓取时间），数据只存在本机。</div>`;

    // 收起状态下的贴边小标签也要能说明结论（绿点=已有，黄点=别的号有，灰点=都没有）
    const tone = result.badge ? result.badge.tone : 'unknown';
    const tab = root.getElementById('tab');
    tab.className = 'tab tone-' + tone;
    root.getElementById('tabText').textContent =
      tone === 'owned-other' ? '别重买' : (tone === 'none' ? '未拥有' : (tone === 'unknown' ? '待同步' : '已拥有'));

    // 「别的号已经拥有」是最值钱的提醒 —— 这种情况强制展开，不沿用上次的收起状态；
    // 其余情况（自己已有 / 谁都没有）沿用用户上次的选择，避免挡住商店页面。
    if (typeof host.__smoApplyCollapsed === 'function') {
      const forceExpand = !!(result.badge && result.badge.warn);
      host.__smoApplyCollapsed(forceExpand ? false : readCollapsedPref());
    }

    root.getElementById('manage').addEventListener('click', () => send('openOptions'));
    root.getElementById('refresh').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = '同步中…';
      const res = await send('syncAll', {});
      await loadState();
      queryCache.clear();
      // 名字也要重算（刷新后索引里可能才有名字）
      const again = await check([appid], true);
      const rawNext = again.get(appid);
      const next = rawNext ? Object.assign({}, rawNext, { name: rawNext.name || pageGameName() || null }) : null;
      btn.disabled = false;
      btn.textContent = '刷新数据';
      if (next) renderPanel(appid, next, lastState);
      // ★ 把逐账号结果说出来：登录态只能刷"当前登录的号"，其余的会被跳过。
      // 不说的话，用户会以为"我明明在别处买了，怎么点了刷新没变" —— 以为工具坏了。
      const note = res.ok && res.data ? syncSummaryText(res.data.results) : ('刷新失败：' + (res.error || '未知错误'));
      const noteEl = root.getElementById('syncNote');
      if (noteEl && note) noteEl.textContent = note;
    });
  }

  /**
   * 把一次同步的逐账号结果说成人话。
   * 为什么必须说：登录态只能刷新"当前登录的号"，其余的会被跳过。
   * 如果点了「刷新数据」却什么都不说，用户会以为工具坏了（"我明明买了，怎么没变"）。
   */
  function syncSummaryText(results) {
    const list = Array.isArray(results) ? results : [];
    const ok = list.filter((r) => r.status === 'ok');
    const skipped = list.filter((r) => r.status === 'skipped');
    const failed = list.filter((r) => r.status === 'failed');
    const parts = [];
    if (ok.length) parts.push('已刷新 ' + ok.length + ' 个：' + ok.map((r) => r.label + ' ' + (r.countText || '')).join('、'));
    if (skipped.length) parts.push('跳过 ' + skipped.length + ' 个：' + skipped.map((r) => r.label + '（' + r.message + '）').join('；'));
    if (failed.length) parts.push('失败 ' + failed.length + ' 个：' + failed.map((r) => r.label + ' → ' + r.message).join('；'));
    return parts.join('。');
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 用户上次把面板收起来了没有（默认展开）。 */
  function readCollapsedPref() {
    try { return localStorage.getItem('smo.collapsed') === '1'; } catch (e) { return false; }
  }

  /**
   * 当前页面的游戏名（从页面 DOM 读）。
   * 索引里没有名字时用它兜底 —— 给用户看 "AppID 292030" 是没用的，
   * 页面上本来就写着这游戏叫什么。
   */
  function pageGameName() {
    try {
      const el = document.querySelector('#appHubAppName, .apphub_AppName, .apphub_AppName_responsive, #appHubAppName_responsive');
      if (el && el.textContent && el.textContent.trim()) return el.textContent.trim().slice(0, 120);
      const t = document.title || '';
      const m = /^(.*?)\s+on\s+Steam/i.exec(t);
      if (m && m[1].trim()) return m[1].trim().slice(0, 120);
      const clean = t.replace(/\s*[·|—-]\s*Steam.*$/i, '').replace(/\s*on\s+Steam.*$/i, '').trim();
      return clean.slice(0, 120);
    } catch (e) {
      return '';
    }
  }

  async function renderAppPanel() {
    const appid = Core.parseAppId(location.pathname);
    if (!appid) return;
    if (!settings.showPanel) return;
    const state = await loadState();
    if (!state) return;
    const results = await check([appid]);
    const raw = results.get(appid);
    if (!raw) return;
    // 名字：本地索引优先，索引里没有就用页面上的游戏名（绝不给用户看裸 AppID）
    const result = Object.assign({}, raw, { name: raw.name || pageGameName() || null });
    if (settings.hideWhenNoneOwned && !result.owned) return;
    await attachLiveCheck(appid);
    renderPanel(appid, result, state);
  }

  /**
   * 问后台"当前登录账号现在有没有这款游戏" —— 这是**实时**结论，不走本地快照。
   * 快照会过期（快照最大的风险），所以当前账号这一条必须实时；其他账号只能靠快照。
   */
  async function attachLiveCheck(appid) {
    liveByAppid.set(appid, { loading: true });
    const res = await send('liveCheckApp', { appid });
    liveByAppid.set(appid, res.ok
      ? res.data
      : { appid, live: null, uncertain: true, reason: res.error || '实时校验失败' });
    return liveByAppid.get(appid);
  }

  /**
   * 购物车结构探测（供设置页「诊断」调用）。
   * 目的：把真实页面上"候选商品行"的样子原样交出来 ——
   * 祖先元素的 class 名、有没有"移除"控件、移除控件长什么样。
   * 有了这些就能精确适配，不用再猜 class 名（我在这上面翻过两次车）。
   */
  function probeCartStructure() {
    const short = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 60);
    const signals = readCartSignals();
    const out = {
      url: location.href,
      kind: pageKind(),
      headerCount: signals.headerCount,
      emptyText: signals.emptyText,
      configIsEmptyArray: signals.configIsEmptyArray,
      configIds: [...signals.configIds].slice(0, 20),
      configRaw: short((document.getElementById('application_config') || {}).getAttribute
        ? document.getElementById('application_config').getAttribute('data-cart_config') : '', 300),
      scopesMatched: {},
      candidates: [],
      removeTextSamples: [],
    };
    for (const sel of CART_SCOPES) {
      let n = 0;
      try { n = document.querySelectorAll(sel).length; } catch (e) { n = -1; }
      if (n > 0) out.scopesMatched[sel] = n;
    }
    // "移除"类控件的文案样本（用来判断我的正则对不对）
    try {
      const re = /移除|删除|Remove/i;
      let seen = 0;
      for (const el of document.querySelectorAll('a, button, span, div')) {
        const t = short(el.textContent, 12);
        if (t && t.length <= 6 && re.test(t)) {
          out.removeTextSamples.push(el.tagName + ':' + t + (el.getAttribute('href') ? ' href=' + short(el.getAttribute('href'), 40) : ''));
          if (++seen >= 6) break;
        }
      }
    } catch (e) { /* 忽略 */ }
    // 每个 /app/ 链接：往上 6 层的 class 名 + 有没有移除控件
    try {
      const links = Array.from(document.querySelectorAll('a[href*="/app/"]')).slice(0, 30);
      for (const a of links) {
        const id = Core.parseAppId(a.getAttribute('href'));
        if (!id) continue;
        const chain = [];
        let cur = a;
        let hops = 0;
        let hasRemove = false;
        let removeAt = -1;
        while (cur && hops < 6) {
          const cls = typeof cur.className === 'string' ? short(cur.className, 50) : '';
          chain.push(cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : '') + (cls ? '.' + cls.split(' ').join('.') : ''));
          if (!hasRemove && rowHasRemoveControl(cur)) { hasRemove = true; removeAt = hops; }
          cur = cur.parentElement;
          hops++;
        }
        out.candidates.push({
          appid: id,
          name: short(a.textContent, 40),
          hasRemoveControl: hasRemove,
          removeAtHop: removeAt,
          ancestors: chain,
        });
      }
    } catch (e) { /* 忽略 */ }
    // 我最终认出了几件
    const collected = collectCartItems();
    out.recognized = [...collected.items.entries()].map(([id, name]) => id + (name ? ':' + name : ''));
    out.recognizedSources = collected.sources;
    return out;
  }

  /* ------------------- 购物车 / 支付页：重复购买警告 ------------------- */

  /**
   * 只在**购物车 / 结算区域**里找商品，绝不全页扫链接。
   *
   * 真机上出过这个错：全页扫 `a[href*="/app/"]` 会把"为您推荐""愿望单"等区域的链接
   * 也当成购物车商品 —— 用户购物车明明是空的，却被告知 3 个游戏"已拥有"。
   * 假警报比不提示更糟（会让人不再信任工具），所以这里宁可找不到就什么都不说。
   */
  /**
   * 购物车商品是怎么认出来的（三个来源，按可靠度排序）：
   *
   * 1. **页面自带的购物车 JSON**：`#application_config` 的 `data-cart_config`
   *    （真机验证：未登录时它是 `[]`，是个 JSON 数组）—— 最准，完全不靠 DOM 结构。
   * 2. **"移除"控件锚定**：购物车每一行都有"移除 / Remove"控件，而"为您推荐"里没有。
   *    真机上前两版都翻过车：先是全页扫 `/app/` 链接 → 空车却报 3 个推荐位的假警报；
   *    后来我把范围收窄成几个老 class → 真实购物车一个都没匹配上，该报的也不报了。
   *    现在改用"这一行有没有移除控件"这个**语义信号**，跟 Steam 改 class 名无关。
   * 3. 老的容器选择器兜底。
   *
   * 三个都拿不到时明确说"没能识别出具体是哪几件"，绝不猜、也绝不误报。
   */
  const CART_SCOPES = [
    '#cart_area', '.cart_area', '#cart_contents', '.cart_contents', '.cart_body',
    '#cart_item_list', '.cart_item_list', '.cart_item', '[id^="cart_item"]',
    '#checkout_area', '.checkout_area', '#checkout_items', '.checkout_item',
    '#order_summary', '.order_summary', '.purchase_area',
  ];

  /** 来源 1：读 `data-cart_config` 里带的 appid（递归找 appid 类字段）。 */
  function cartAppIdsFromConfig() {
    const ids = new Set();
    try {
      const cfg = document.getElementById('application_config');
      if (!cfg) return ids;
      const raw = cfg.getAttribute('data-cart_config');
      if (!raw) return ids;
      const json = JSON.parse(raw.replace(/&quot;/g, '"'));
      const walk = (node, depth) => {
        if (node == null || depth > 8) return;
        if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
        if (typeof node !== 'object') return;
        for (const key of Object.keys(node)) {
          const val = node[key];
          if (/^app_?ids?$/i.test(key)) {
            const list = Array.isArray(val) ? val : [val];
            for (const v of list) { const id = Core.parseAppId(v); if (id) ids.add(id); }
          } else if (/appid/i.test(key) && !/package|sub/i.test(key)) {
            const id = Core.parseAppId(val);
            if (id) ids.add(id);
          }
          walk(val, depth + 1);
        }
      };
      walk(json, 0);
    } catch (e) { /* 解析不了就当没有 */ }
    return ids;
  }

  /** 这一行是购物车商品吗？判据：行内存在"移除"控件（推荐位不会有）。 */
  function rowHasRemoveControl(node) {
    try {
      const html = node.innerHTML || '';
      if (/removefromcart|remove_from_cart|ajaxremove|removeFromCart/i.test(html)) return true;
      const re = /^\s*(移除|删除|Remove)\s*$/i;
      for (const el of node.querySelectorAll('a, button, span, div')) {
        const t = (el.textContent || '').trim();
        if (t && t.length <= 6 && re.test(t)) return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  /** 来源 2：`/app/` 链接 + 向上找"带移除控件的行"（最多爬 6 层）。 */
  function cartItemsFromDomRows() {
    const items = new Map();
    let links = [];
    try { links = Array.from(document.querySelectorAll('a[href*="/app/"]')); } catch (e) { links = []; }
    for (const a of links) {
      const id = Core.parseAppId(a.getAttribute('href'));
      if (!id) continue;
      let cur = a;
      let hops = 0;
      let row = null;
      while (cur && hops < 6) {
        const cls = typeof cur.className === 'string' ? cur.className : '';
        if (/cart_item|cart_item_row|cart-row|checkout_item/i.test(cls) || rowHasRemoveControl(cur)) { row = cur; break; }
        cur = cur.parentElement;
        hops++;
      }
      if (!row) continue; // 不在购物车行里 -> 推荐位之类，忽略
      let name = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (name.length < 2) name = (row.textContent || '').replace(/\s+/g, ' ').trim();
      const prev = items.get(id);
      if (prev === undefined || (!prev && name)) items.set(id, name.slice(0, 80));
    }
    return items;
  }

  /** 来源 3：老的容器选择器兜底。 */
  function cartItemsFromScopes() {
    const items = new Map();
    for (const sel of CART_SCOPES) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
      for (const node of nodes) {
        let links = [];
        try { links = Array.from(node.querySelectorAll('a[href*="/app/"]')); } catch (e) { links = []; }
        if (node.tagName === 'A' && /\/app\//.test(node.getAttribute('href') || '')) links.push(node);
        for (const a of links) {
          const id = Core.parseAppId(a.getAttribute('href'));
          if (!id || items.has(id)) continue;
          let name = (a.textContent || '').replace(/\s+/g, ' ').trim();
          if (name.length < 2) name = (node.textContent || '').replace(/\s+/g, ' ').trim();
          items.set(id, name.slice(0, 80));
        }
        for (const attr of ['data-appid', 'data-ds-appid', 'data-app-id', 'data-featured_appid']) {
          let els = [];
          try { els = Array.from(node.querySelectorAll('[' + attr + ']')); } catch (e) { els = []; }
          for (const el of els) {
            const id = Core.parseAppId(el.getAttribute(attr));
            if (id && !items.has(id)) items.set(id, '');
          }
        }
      }
    }
    return items;
  }

  /**
   * 页面在说"购物车空 / 有几件"吗？
   * 三个信号互相印证：标题里的件数、空车文案、`data-cart_config` 是不是空数组。
   */
  function readCartSignals() {
    const out = { emptyText: false, headerCount: null, configIds: new Set(), configIsEmptyArray: false };
    try {
      const text = (document.body && document.body.innerText) ? document.body.innerText : '';
      out.emptyText = /your cart is empty|您的购物车是空的|购物车中没有|购物车目前是空的|没有物品在您的购物车/i.test(text);
      const m = /您的购物车\s*[（(]\s*(\d+)\s*个?项目|Your cart\s*[（(]\s*(\d+)\s*items?/i.exec(text);
      if (m) out.headerCount = Number(m[1] || m[2] || 0);
    } catch (e) { /* 忽略 */ }
    try {
      const cfg = document.getElementById('application_config');
      const raw = cfg && cfg.getAttribute('data-cart_config');
      if (raw != null) {
        const json = JSON.parse(raw.replace(/&quot;/g, '"'));
        if (Array.isArray(json)) out.configIsEmptyArray = json.length === 0;
        out.configIds = cartAppIdsFromConfig();
      }
    } catch (e) { /* 忽略 */ }
    return out;
  }

  function cartIsEmpty(signals) {
    if (signals.headerCount === 0) return true;
    if (signals.emptyText) return true;
    if (signals.configIsEmptyArray && signals.headerCount == null && !signals.configIds.size) return true;
    return false;
  }

  function collectCartItems() {
    const items = new Map();
    const sources = [];
    const merge = (map, label) => {
      if (!map || !map.size) return;
      for (const [id, name] of map) {
        const prev = items.get(id);
        if (prev === undefined || (!prev && name)) items.set(id, name || '');
      }
      sources.push(label + ' ' + map.size + ' 件');
    };
    const signals = readCartSignals();
    const cfgItems = new Map();
    for (const id of signals.configIds) cfgItems.set(id, '');
    merge(cfgItems, '页面购物车数据');
    merge(cartItemsFromDomRows(), '商品行的移除控件');
    merge(cartItemsFromScopes(), '购物车容器');
    return { items, sources, signals };
  }

  async function renderCartWarning() {
    const kind = pageKind();
    if (kind !== 'cart' && kind !== 'checkout') return;
    const old = document.getElementById('smo-cart-warning');
    if (old) old.remove();

    const { items, signals } = collectCartItems();
    // 空购物车：什么都不说（"为您推荐"里的链接绝不能被算成购物车商品）
    if (cartIsEmpty(signals)) return;

    // 有商品却一件都没认出来：**诚实说明**。静默会让人以为工具坏了，
    // 但绝不能猜（猜错就是假警报，比不提示更糟）。
    if (!items.size) {
      if (!signals.headerCount) return;
      const soft = document.createElement('div');
      soft.id = 'smo-cart-warning';
      soft.className = 'smo-cart-warning smo-soft';
      soft.innerHTML =
        '<b>购物车里有 ' + signals.headerCount + ' 件商品，但我没能识别出具体是哪几件</b>' +
        '<div class="muted">通常意味着 Steam 改版了。可以' +
        '<a href="#" id="smo-cart-resync">重新识别</a>' +
        '；如果一直这样，请在设置页第 5 节跑「诊断」并把结果发我。</div>';
      insertCartBanner(soft);
      bindCartResync();
      return;
    }

    const results = await check([...items.keys()]);
    const risky = [];
    const mine = [];
    for (const [appid, result] of results.entries()) {
      // 名字优先级：本地索引 > 页面上的商品标题 > 只能说 AppID
      const name = result.name || items.get(appid) || '';
      const withName = Object.assign({}, result, { name: name || null });
      if (result.ownedByOtherOnly) risky.push(withName);
      else if (result.ownedByCurrent) mine.push(withName);
    }
    if (!risky.length) return; // 没有风险就不打扰

    const isCheckout = kind === 'checkout';
    const names = risky.map((r) => (r.name || 'AppID ' + r.appid) + ' —— ' + r.others.map((o) => o.label).join('、') + ' 已拥有');
    const box = document.createElement('div');
    box.id = 'smo-cart-warning';
    box.className = 'smo-cart-warning';
    box.innerHTML =
      '<b>⚠ ' + (isCheckout ? '付款前先看一眼：' : '') + risky.length + ' 件商品你的其他账号已经拥有</b>' +
      '<ul>' + names.slice(0, 10).map((n) => '<li>' + escapeHtml(n) + '</li>').join('') +
      (names.length > 10 ? '<li>…还有 ' + (names.length - 10) + ' 件</li>' : '') + '</ul>' +
      (mine.length ? '<div class="muted">另有 ' + mine.length + ' 件当前账号本来就已拥有。</div>' : '') +
      '<div class="muted">结论来自本机快照；如果最近换过账号，点这里' +
      '<a href="#" id="smo-cart-resync">刷新本地快照</a>再判断。</div>';

    insertCartBanner(box);
    bindCartResync();
  }

  /**
   * 警告条插到 Steam 自己的 React 根容器**之前**。
   * 塞进根节点内部会被 React 的重渲染抹掉 —— 这也是真机上"购物车警告不出现"的原因之一。
   */
  function insertCartBanner(box) {
    const rootEl = document.querySelector('#application_root, #react_root, #cart_area, .cart_area, #cart_contents');
    if (rootEl && rootEl.parentNode) rootEl.parentNode.insertBefore(box, rootEl);
    else document.body.insertBefore(box, document.body.firstChild);
  }

  function bindCartResync() {
    const link = document.getElementById('smo-cart-resync');
    if (!link) return;
    link.addEventListener('click', async (ev) => {
      ev.preventDefault();
      link.textContent = '处理中…';
      await send('syncAll', {});
      await loadState();
      queryCache.clear();
      await renderCartWarning();
    });
  }

  /* ---------------------------- 启动 ---------------------------- */

  const rescan = throttle(() => {
    decorateInline().catch(() => {});
    renderCartWarning().catch(() => {});
  }, 400);

  async function boot() {
    await loadState();
    const kind = pageKind();
    if (kind === 'app') await renderAppPanel();
    await decorateInline();
    await renderCartWarning();

    const observer = new MutationObserver(() => rescan());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', rescan, { passive: true });
  }

  /**
   * 从**当前这个页面**里读会话凭据（steamid + webapi_token）。
   *
   * 为什么由内容脚本做、而不是后台去抓 HTML：内容脚本就站在页面里，
   * DOM 上有什么就能读到什么 —— 属性叫什么名字、JSON 有没有被 HTML 转义、
   * 是不是藏在 inline script 里，都不需要猜。后台抓 HTML 的写法一旦页面改版就失效。
   *
   * 拿到之后交给后台去调 IPlayerService/GetOwnedGames（就是小黑盒用的那个接口），
   * 从而得到"只含游戏本体、还带名字"的准确游戏列表。
   */
  function extractSessionCreds() {
    const out = { token: null, steamId64: null, persona: null, signals: [], url: location.href };
    const pick = (json, where) => {
      if (!json || typeof json !== 'object') return;
      if (!out.token && json.webapi_token) { out.token = String(json.webapi_token); out.signals.push(where + '→token'); }
      if (!out.steamId64 && json.steamid) { out.steamId64 = String(json.steamid); out.signals.push(where + '→steamid'); }
      if (!out.persona && (json.persona_name || json.account_name)) {
        out.persona = String(json.persona_name || json.account_name);
        out.signals.push(where + '→昵称');
      }
    };
    const unescape = (s) => String(s)
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    // 1. #application_config 上的所有 data-* 属性（Steam 把登录态信息挂在这里）
    try {
      const cfg = document.getElementById('application_config');
      if (cfg) {
        for (const attr of Array.from(cfg.attributes)) {
          if (!/data-/i.test(attr.name)) continue;
          let parsed = null;
          try { parsed = JSON.parse(unescape(attr.value)); } catch (e) { continue; }
          pick(parsed, attr.name);
        }
        out.signals.push('#application_config 属性：' + Array.from(cfg.attributes).map((a) => a.name).join(','));
      } else {
        out.signals.push('页面上没有 #application_config');
      }
    } catch (e) { /* 忽略 */ }

    // 2. 整页 HTML 里的 inline JSON（含被 HTML 转义的形态）
    try {
      const html = document.documentElement.innerHTML;
      if (!out.token) {
        const m = /"webapi_token"\s*:\s*"([^"]+)"/.exec(html) ||
          /&quot;webapi_token&quot;\s*:\s*&quot;([^&"]+)&quot;/.exec(html);
        if (m) { out.token = unescape(m[1]); out.signals.push('整页 HTML→token'); }
      }
      if (!out.steamId64) {
        const m2 = /"steamid"\s*:\s*"?(\d{17})"?/.exec(html) ||
          /&quot;steamid&quot;\s*:\s*(?:&quot;)?(\d{17})/.exec(html);
        if (m2) { out.steamId64 = m2[1]; out.signals.push('整页 HTML→steamid'); }
      }
      if (!out.persona) {
        const m3 = /g_strAccountName\s*=\s*"([^"]+)"/.exec(html) || /"persona_name"\s*:\s*"([^"]+)"/.exec(html);
        if (m3) { out.persona = m3[1]; out.signals.push('整页 HTML→昵称'); }
      }
    } catch (e) { /* 忽略 */ }

    if (!out.token && !out.steamId64) out.signals.push('三种来源都没读到凭据');
    return out;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'smo.cartProbe') {
      // 购物车结构探测：把"候选商品行长什么样"原样交出去，方便精确适配 Steam 改版，
      // 而不是靠猜 class 名（我在这上面翻过两次车）。
      try { sendResponse(Object.assign({ ok: true }, probeCartStructure())); }
      catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); }
      return false;
    }
    if (message && message.type === 'smo.sessionCreds') {
      // 给 popup/设置页用：从当前页面读登录态凭据，交给后台去调官方接口
      try {
        sendResponse(Object.assign({ ok: true }, extractSessionCreds()));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
      return false;
    }
    if (message && message.type === 'smo.pageSignal') {
      // 给 popup 用：这个页面本身有没有"已拥有"的标志（用来交叉校验快照对不对）
      sendResponse({
        ok: true,
        appid: Core.parseAppId(location.pathname),
        steamSaysOwned: steamOwnershipSignal(),
      });
      return false;
    }
    if (message && message.type === 'smo.refreshPage') {
      queryCache.clear();
      decoratedClear();
      boot().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (message && message.type === 'smo.highlight') {
      const host = document.getElementById(PANEL_ID);
      if (host) host.style.outline = '2px solid #a4d007';
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // WeakSet 不能清空，所以用重新赋值的方式重置"已装饰"集合
  function decoratedClear() {
    decorated = new WeakSet();
    // 移除旧角标
    for (const el of document.querySelectorAll('.smo-badge')) el.remove();
    const warn = document.getElementById('smo-cart-warning');
    if (warn) warn.remove();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot().catch(() => {}));
  } else {
    boot().catch(() => {});
  }
})();
