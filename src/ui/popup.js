/* Steam Multi-Owner :: popup.js */
(function () {
  'use strict';
  const Core = globalThis.SteamOwnerCore;
  const $ = (id) => document.getElementById(id);

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res || { ok: false, error: '没有响应' });
      });
    });
  }

  function esc(t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  let state = null;

  function renderSummary() {
    if (!state) return;
    const s = state.summary;
    // 把版本号显出来，这样"更新到底生效没有"一眼就能确认
    try { $('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) { /* 忽略 */ }
    // 索引里可能混了"游戏本体"和"许可证条目"两种来源，所以这里只说 AppID 数量，
    // 不写成"款游戏"——否则会和 Steam 档案里的"游戏数"对不上。
    $('summary').innerHTML =
      `<b>${s.accountCount}</b> 个账号（已同步 <b>${s.syncedCount}</b>） · 索引覆盖 <b>${s.uniqueAppCount}</b> 个 AppID`;
    $('indexHint').textContent = s.builtAt
      ? '索引构建于 ' + new Date(s.builtAt).toLocaleString() + '，缓存只存在本机。'
      : '还没有任何数据，先点上面的「导入当前登录的号」。';
  }

  /** 账号那一行的小字：数量必须带口径（是"款游戏"还是"条目"），否则用户会以为统计错了。 */
  function accountSub(a, lib) {
    const parts = [a.steamId64 ? a.steamId64 : (a.vanity ? a.vanity : '登录会话')];
    // countText 是后台按完整记录算好的，优先用它；没有才自己按摘要对象算
    parts.push(lib && lib.countText ? lib.countText
      : (lib && (lib.entryCount != null || lib.gameCount != null) ? Core.describeCount(lib) : '未同步'));
    if (lib && lib.updatedAt) parts.push(new Date(lib.updatedAt).toLocaleDateString());
    return parts.join(' · ');
  }

  /** 鼠标悬停时能看到"这个数字是从哪来的"。 */
  function sourceTitle(lib) {
    if (!lib) return '';
    const base = lib.sourceNote || lib.method || '';
    return lib.note ? base + ' —— ' + lib.note : base;
  }

  function renderAccounts() {
    const ul = $('accounts');
    ul.innerHTML = '';
    if (!state.accounts.length) {
      ul.innerHTML = '<li><span class="sub">还没有账号。用「导入当前登录的号」可以免 API key 建立第一个账号。</span></li>';
      return;
    }
    for (const a of state.accounts) {
      const lib = state.libraries[a.id] || {};
      const isCurrent = a.id === state.settings.currentAccountId;
      const li = document.createElement('li');
      li.title = sourceTitle(lib);
      li.innerHTML = `
        <span class="grow">
          <span class="name">${esc(Core.accountLabel(a))}</span>
          <span class="sub">${esc(accountSub(a, lib))}</span>
        </span>
        ${isCurrent ? '<span class="tag me">当前登录</span>' : ''}
        ${a.lastError ? '<span class="tag err" title="' + esc(a.lastError) + '">失败</span>'
          // "已同步"只看有没有快照，不看游戏数识别出来没有（否则会误报"未同步"）
          : (lib.entryCount != null ? '<span class="tag ok">已同步</span>' : '<span class="tag warn">未同步</span>')}
        <button data-sync="${esc(a.id)}" class="ghost" title="同步这个账号">⟳</button>`;
      ul.appendChild(li);
    }
    for (const btn of ul.querySelectorAll('button[data-sync]')) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        setStatus('同步中…');
        const res = await send('syncAccount', { accountId: btn.dataset.sync });
        btn.disabled = false;
        if (!res.ok) {
          // "不是当前登录的号"是设计使然，不是故障 —— 提示要能指导下一步
          const isSkip = /不是当前浏览器登录的号|读不到当前浏览器登录的 SteamID/.test(res.error || '');
          return setStatus((isSkip ? '已跳过：' : '同步失败：') + res.error, isSkip ? '' : 'err');
        }
        setStatus(`同步完成：${res.data.countText || res.data.gameCount + ' 项'}`, 'ok');
        await refresh();
      });
    }
  }

  function renderResult(result) {
    const box = $('result');
    if (!result) { box.innerHTML = ''; return; }
    const tone = result.badge ? result.badge.tone : 'unknown';
    const cls = tone === 'owned-other' ? 'other'
      : tone === 'owned-current' ? 'current'
        : tone === 'owned-both' ? 'both' : 'none';
    const rows = (state ? state.accounts : []).map((a) => {
      const owns = result.owners.some((o) => o.accountId === a.id);
      const isCurrent = state && a.id === state.settings.currentAccountId;
      return `<tr><td>${esc(Core.accountLabel(a))}${isCurrent ? ' <span class="tag me">当前</span>' : ''}</td>
        <td class="${owns ? 'yes' : 'no'}">${owns ? '已拥有' : '未拥有'}</td></tr>`;
    }).join('');
    box.innerHTML = `
      <div class="section">
        <div class="card ${cls}">
          <div class="verdict">${esc(result.badge ? result.badge.long : '')}</div>
          <div class="sub" style="color:var(--smo-dim);font-size:11px;margin-bottom:6px">
            ${esc(result.name || '')} AppID ${result.appid}
          </div>
          ${rows ? `<table>${rows}</table>` : ''}
        </div>
      </div>`;
  }

  async function refresh() {
    const res = await send('getState');
    if (!res.ok) return setStatus('读取状态失败：' + res.error, 'err');
    state = res.data;
    renderSummary();
    renderAccounts();
    return state;
  }

  async function doCheck(input) {
    const appid = Core.parseAppId(input);
    if (!appid) return setStatus('这看起来不是有效的 AppID 或商店链接', 'err');
    setStatus('查询中…');
    const res = await send('checkAppIds', { appids: [appid] });
    if (!res.ok) return setStatus('查询失败：' + res.error, 'err');
    const result = res.data.results[appid];
    if (!result) return setStatus('查询失败：没有结果', 'err');
    if (!result.name) {
      const named = await send('getAppName', { appid });
      if (named.ok && named.data.name) result.name = named.data.name;
    }
    renderResult(result);
    if (result.ownedByOtherOnly) setStatus('⚠ 当前账号没有，但其他账号已拥有', 'ok');
    else if (result.ownedByCurrent) setStatus('当前账号已拥有', 'ok');
    else if (res.data.accountCount === 0) setStatus('还没有添加账号', 'err');
    else setStatus('你的账号都没有这款游戏', '');
  }

  async function checkActiveTab(silent) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const appid = tab && tab.url ? Core.parseAppId(tab.url) : null;
    if (!appid) {
      if (!silent) setStatus('当前标签页不是 Steam 商店的游戏页', 'err');
      return;
    }
    $('query').value = String(appid);
    await doCheck(String(appid));
  }

  $('check').addEventListener('click', () => doCheck($('query').value));
  $('query').addEventListener('keydown', (e) => { if (e.key === 'Enter') doCheck($('query').value); });
  $('checkTab').addEventListener('click', () => checkActiveTab(false));
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  /** 问一下当前标签页：Steam 自己说这个游戏"已拥有"吗？（用于交叉校验快照对不对） */
  async function askPageSignal() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id || !tab.url || !/steam(community|powered)?\.com/.test(tab.url)) return null;
      return await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'smo.pageSignal' }, (r) => {
          resolve(chrome.runtime.lastError ? null : r);
        });
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * 问当前标签页要"页面里的登录态凭据"（steamid + webapi_token）。
   * 这是最可靠的一条路：页面 DOM 里有什么就能读到什么，不用去猜页面结构。
   */
  async function askPageCreds() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id || !tab.url || !/steam(community|powered)?\.com/.test(tab.url)) return null;
      return await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'smo.sessionCreds' }, (r) => {
          resolve(chrome.runtime.lastError ? null : r);
        });
      });
    } catch (e) {
      return null;
    }
  }

  $('importSession').addEventListener('click', async () => {
    const btn = $('importSession');
    btn.disabled = true;
    // 先从当前 Steam 页面里读凭据；读到了就交给后台直接调 GetOwnedGames（游戏数最准）
    const creds = await askPageCreds();
    const haveCreds = !!(creds && creds.ok && creds.token && creds.steamId64);
    setStatus(haveCreds
      ? '已从当前页面读到登录凭据，正在调 Steam 接口取游戏列表…'
      : '正在读取当前浏览器的 Steam 登录态…');
    const res = await send('importSession', { creds: haveCreds ? creds : undefined });
    btn.disabled = false;
    if (!res.ok) {
      setStatus('导入失败：' + res.error + '（请确认浏览器里已登录 store.steampowered.com 再试）', 'err');
      return;
    }
    const d = res.data;
    const who = d.steamId64 ? 'SteamID ' + d.steamId64 : '⚠ 没能读到 SteamID';
    let msg = `${d.created ? '已新增' : '已更新'}账号「${d.label}」（${who}）：${d.countText || d.gameCount + ' 项'}`;
    let kind = d.identityVerified ? 'ok' : 'err';

    // 用当前打开的 Steam 页面做交叉校验：两边矛盾就明确报警
    const signal = await askPageSignal();
    if (signal && signal.ok && signal.appid) {
      const chk = await send('checkAppIds', { appids: [signal.appid], currentAccountId: d.accountId });
      const owned = chk.ok && chk.data.results[signal.appid] ? chk.data.results[signal.appid].owned : null;
      if (owned === false && signal.steamSaysOwned) {
        kind = 'err';
        msg += `。⚠ 当前页面（AppID ${signal.appid}）Steam 显示"已拥有"，快照里却没有 —— ` +
          '这份快照很可能是别的账号的或已过期；请确认浏览器登录的就是要抓的号，再重新导入';
      } else if (owned === true) {
        msg += `。当前页面 AppID ${signal.appid} 已在快照里 ✓`;
      } else if (owned === false) {
        msg += `。当前页面 AppID ${signal.appid} 不在快照里（Steam 未显示已拥有，属正常）`;
      }
    }
    if (!d.identityVerified) {
      msg += '。⚠ 这次没读到 SteamID，无法确认快照属于哪个账号';
    }
    if (d.identityConflict) msg += '。⚠ ' + d.identityConflict;
    if (d.legacyUnknownCount) {
      msg += `。另有 ${d.legacyUnknownCount} 个旧记录没有 SteamID（容易挂错数据），建议在设置页删掉后重新导入`;
    }
    setStatus(msg, kind);
    await refresh();
  });

  /** 登录另一个账号：不碰你的账号密码，只打开 Steam 官方登录页，登录完回来导入。 */
  $('loginOther').addEventListener('click', async () => {
    await chrome.tabs.create({ url: 'https://store.steampowered.com/login/' });
    setStatus('已打开 Steam 官方登录页。登录完成后回到这里点「导入当前登录的号」：' +
      '会按 SteamID 新增一条记录，不会覆盖已有的号。', 'ok');
  });

  /* ------------------------- 添加账号（按 SteamID） ------------------------- */

  $('addToggle').addEventListener('click', () => {
    const form = $('addForm');
    form.classList.toggle('open');
    $('addToggle').textContent = form.classList.contains('open') ? '收起' : '＋ 添加账号';
    if (form.classList.contains('open')) $('newKey').focus();
  });

  function addStatus(text, kind) {
    const el = $('addStatus');
    el.textContent = text || '';
    el.style.color = kind === 'err' ? '#ffb3b3' : kind === 'ok' ? '#cdee9a' : '';
  }

  async function addAccount(sync) {
    const key = $('newKey').value.trim();
    if (!key) return addStatus('请先填 SteamID / 自定义 ID / 资料链接', 'err');
    addStatus('添加中…');
    const res = await send('addAccount', {
      label: $('newLabel').value.trim(),
      key,
      apiKey: $('newApiKey').value.trim() || undefined,
    });
    if (!res.ok) return addStatus('添加失败：' + res.error, 'err');
    if (sync) {
      addStatus('已添加，正在同步游戏库…');
      const s = await send('syncAccount', { accountId: res.data.accountId });
      if (!s.ok) {
        await refresh();
        return addStatus('已添加，但同步失败：' + s.error, 'err');
      }
      addStatus(`已添加并同步 ${s.data.gameCount} 款游戏`, 'ok');
    } else {
      addStatus('已添加（还没同步游戏库，可点该账号后面的 ⟳）', 'ok');
    }
    $('newLabel').value = '';
    $('newKey').value = '';
    $('newApiKey').value = '';
    await refresh();
  }

  $('addSync').addEventListener('click', () => addAccount(true));
  $('addOnly').addEventListener('click', () => addAccount(false));

  $('syncAll').addEventListener('click', async () => {
    const btn = $('syncAll');
    btn.disabled = true;
    setStatus('同步中…');
    const res = await send('syncAll', {});
    btn.disabled = false;
    if (!res.ok) return setStatus('同步失败：' + res.error, 'err');
    const results = res.data.results || [];
    const ok = results.filter((r) => r.status === 'ok');
    const skipped = results.filter((r) => r.status === 'skipped');
    const failed = results.filter((r) => r.status === 'failed');
    const parts = [];
    if (ok.length) parts.push(`已刷新 ${ok.length} 个（${ok.map((r) => r.countText || r.gameCount + ' 项').join('、')}）`);
    if (skipped.length) parts.push(`跳过 ${skipped.length} 个：` + skipped.map((r) => r.label + '（' + r.message + '）').join('；'));
    if (failed.length) parts.push(`失败 ${failed.length} 个：` + failed.map((r) => r.label + ' → ' + r.message).join('；'));
    setStatus(parts.join('。') || '没有可同步的账号', failed.length ? 'err' : (ok.length ? 'ok' : ''));
    await refresh();
  });

  refresh().then(() => checkActiveTab(true).catch(() => {}));
})();
