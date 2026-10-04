/* Steam Multi-Owner :: options.js */
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

  function status(id, text, kind) {
    const el = $(id);
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  let state = null;
  let exportCache = null;

  function renderSettings() {
    const s = state.settings;
    $('apiKey').value = s.apiKey || '';
    $('showInlineBadges').checked = !!s.showInlineBadges;
    $('showPanel').checked = !!s.showPanel;
    $('hideWhenNoneOwned').checked = !!s.hideWhenNoneOwned;
    $('autoRefreshHours').value = String(s.autoRefreshHours || 0);
  }

  function renderAccounts() {
    const ul = $('accounts');
    ul.innerHTML = '';
    if (!state.accounts.length) {
      ul.innerHTML = '<li><span class="sub">还没有账号。</span></li>';
      return;
    }
    for (const a of state.accounts) {
      const lib = state.libraries[a.id] || {};
      const isCurrent = a.id === state.settings.currentAccountId;
      const li = document.createElement('li');
      li.title = lib.sourceNote || '';
      li.innerHTML = `
        <span class="grow">
          <span class="name">${esc(Core.accountLabel(a))}</span>
          <span class="sub">
            ${a.steamId64 ? 'SteamID64 ' + esc(a.steamId64) : (a.vanity ? '自定义 ID ' + esc(a.vanity) : '登录态导入')}
            ${a.apiKey ? ' · 独立 key' : ''}
            · ${esc(lib.countText || Core.describeCount(lib.entryCount != null ? lib : null))}
            ${lib.sourceNote ? ' · ' + esc(lib.sourceNote) : (lib.method ? ' · ' + esc(lib.method) : '')}
            ${lib.updatedAt ? ' · ' + new Date(lib.updatedAt).toLocaleString() : ''}
          </span>
          ${lib.kind === 'apps' ? '<span class="sub" style="color:#ffd98a">注：这是"拥有的条目"（含 DLC/工具/共享），不是 Steam 档案里的"游戏数"</span>' : ''}
          ${a.lastError ? `<span class="sub" style="color:#ffb3b3">最近错误：${esc(a.lastError)}</span>` : ''}
        </span>
        ${isCurrent ? '<span class="tag me">当前登录</span>' : '<button class="ghost" data-current="' + esc(a.id) + '">设为当前</button>'}
        <button class="ghost" data-sync="${esc(a.id)}">同步</button>
        <button class="ghost" data-rename="${esc(a.id)}">改名</button>
        <button class="ghost danger" data-remove="${esc(a.id)}">删除</button>`;
      ul.appendChild(li);
    }
    ul.onclick = async (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      if (btn.dataset.sync) {
        btn.disabled = true;
        status('accountStatus', '同步中…');
        const res = await send('syncAccount', { accountId: btn.dataset.sync });
        btn.disabled = false;
        if (!res.ok) return status('accountStatus', '同步失败：' + res.error, 'err');
        status('accountStatus', `完成：${res.data.countText || res.data.gameCount + ' 项'}`, 'ok');
        await refresh();
      } else if (btn.dataset.remove) {
        if (!confirm('删除这个账号的本地快照？不影响 Steam 账号本身。')) return;
        await send('removeAccount', { accountId: btn.dataset.remove });
        await refresh();
      } else if (btn.dataset.rename) {
        const account = state.accounts.find((x) => x.id === btn.dataset.rename);
        const label = prompt('新的备注名', Core.accountLabel(account));
        if (label == null) return;
        await send('updateAccount', { accountId: btn.dataset.rename, patch: { label } });
        await refresh();
      } else if (btn.dataset.current) {
        await send('setSettings', { patch: { currentAccountId: btn.dataset.current } });
        await refresh();
      }
    };
  }

  async function refresh() {
    const res = await send('getState');
    if (!res.ok) return status('accountStatus', '读取失败：' + res.error, 'err');
    state = res.data;
    renderSettings();
    renderAccounts();
    const s = state.summary;
    $('version').textContent = `v${chrome.runtime.getManifest().version} · 索引覆盖 ${s.uniqueAppCount} 个 AppID · ${s.accountCount} 个账号`;
  }

  /* ------------------------------- 添加 ------------------------------- */

  $('importSession').addEventListener('click', async () => {
    const btn = $('importSession');
    btn.disabled = true;
    status('addStatus', '正在读取当前浏览器的 Steam 登录态…');
    const res = await send('importSession', { label: $('sessionLabel').value });
    btn.disabled = false;
    if (!res.ok) return status('addStatus', '导入失败：' + res.error, 'err');
    status('addStatus', `已导入「${res.data.label}」：${res.data.countText || res.data.gameCount + ' 项'}（愿望单 ${res.data.wishlistCount} 项）`, 'ok');
    $('sessionLabel').value = '';
    await refresh();
  });

  async function addAccount(sync) {
    const key = $('newKey').value.trim();
    if (!key) return status('addStatus', '请先填写 SteamID / 自定义 ID / 资料链接', 'err');
    const res = await send('addAccount', {
      label: $('newLabel').value.trim(),
      key,
      apiKey: $('newApiKey').value.trim() || undefined,
    });
    if (!res.ok) return status('addStatus', '添加失败：' + res.error, 'err');
    if (sync) {
      status('addStatus', '已添加，正在同步…');
      const s = await send('syncAccount', { accountId: res.data.accountId });
      if (!s.ok) {
        await refresh();
        return status('addStatus', '已添加，但同步失败：' + s.error, 'err');
      }
      status('addStatus', `已添加并同步 ${s.data.countText || s.data.gameCount + ' 项'}`, 'ok');
    } else {
      status('addStatus', '已添加（未同步）', 'ok');
    }
    $('newLabel').value = '';
    $('newKey').value = '';
    $('newApiKey').value = '';
    await refresh();
  }

  $('addAccount').addEventListener('click', () => addAccount(true));
  $('addAccountOnly').addEventListener('click', () => addAccount(false));

  /* ------------------------------- 设置 ------------------------------- */

  $('saveApiKey').addEventListener('click', async () => {
    const res = await send('setSettings', { patch: { apiKey: $('apiKey').value.trim() } });
    if (!res.ok) return status('accountStatus', '保存失败：' + res.error, 'err');
    status('accountStatus', 'API key 已保存到本机', 'ok');
  });

  async function saveToggle(patch) {
    await send('setSettings', { patch });
    await refresh();
  }
  $('showInlineBadges').addEventListener('change', (e) => saveToggle({ showInlineBadges: e.target.checked }));
  $('showPanel').addEventListener('change', (e) => saveToggle({ showPanel: e.target.checked }));
  $('hideWhenNoneOwned').addEventListener('change', (e) => saveToggle({ hideWhenNoneOwned: e.target.checked }));
  $('autoRefreshHours').addEventListener('change', (e) => saveToggle({ autoRefreshHours: Number(e.target.value) }));

  $('syncAll').addEventListener('click', async () => {
    const btn = $('syncAll');
    btn.disabled = true;
    status('accountStatus', '同步中…');
    const res = await send('syncAll', {});
    btn.disabled = false;
    if (!res.ok) return status('accountStatus', '同步失败：' + res.error, 'err');
    const results = res.data.results || [];
    const ok = results.filter((r) => r.status === 'ok');
    const skipped = results.filter((r) => r.status === 'skipped');
    const failed = results.filter((r) => r.status === 'failed');
    const parts = [];
    if (ok.length) parts.push(`已刷新 ${ok.length} 个：` + ok.map((r) => r.label + ' ' + (r.countText || '')).join('、'));
    // 跳过是设计使然（登录态只能刷当前登录的号），不是错误
    if (skipped.length) parts.push(`跳过 ${skipped.length} 个：` + skipped.map((r) => r.label + '（' + r.message + '）').join('；'));
    if (failed.length) parts.push(`失败 ${failed.length} 个：` + failed.map((r) => r.label + ' → ' + r.message).join('；'));
    status('accountStatus', parts.join('。') || '没有可同步的账号', failed.length ? 'err' : (ok.length ? 'ok' : ''));
    await refresh();
  });

  $('rebuild').addEventListener('click', async () => {
    const res = await send('rebuildIndex', {});
    status('accountStatus', res.ok ? `索引已重建：${res.data.appCount} 款` : '重建失败：' + res.error, res.ok ? 'ok' : 'err');
    await refresh();
  });

  /* ------------------------------- 诊断 ------------------------------- */

  let diagText = '';

  $('diagnose').addEventListener('click', async () => {
    const btn = $('diagnose');
    btn.disabled = true;
    status('diagStatus', '正在逐个数据源读取（可能要约 10 秒）…');
    const appid = $('diagAppid').value.trim();
    const res = await send('diagnose', { appid: appid || undefined });
    btn.disabled = false;
    if (!res.ok) return status('diagStatus', '诊断失败：' + res.error, 'err');
    diagText = res.data.text;
    const box = $('diagBox');
    box.style.display = 'block';
    box.textContent = diagText;
    status('diagStatus', '诊断完成：把这段内容整个复制发给开发者即可定位问题。', 'ok');
  });

  $('copyDiag').addEventListener('click', async () => {
    if (!diagText) return status('diagStatus', '先点「开始诊断」', 'err');
    try {
      await navigator.clipboard.writeText(diagText);
      status('diagStatus', '已复制到剪贴板', 'ok');
    } catch (e) {
      status('diagStatus', '自动复制失败，请手动选中上面的文本复制', 'err');
    }
  });

  /* ------------------------------- 数据 ------------------------------- */

  /**
   * 把导出内容存成文件。
   *
   * 为什么要文件：扩展数据在 chrome.storage 里，DSH 侧读不到，两边只能靠这个 JSON 桥接。
   * 存成固定文件名（steam-multi-owner.json）之后，DSH 里一条命令就能导入：
   *   steam_owner_data  action=import  file=<下载目录>\steam-multi-owner.json
   * 用 Blob + <a download> 触发下载，**不需要 downloads 权限**（少一个权限就少一份顾虑）。
   */
  $('downloadData').addEventListener('click', async () => {
    const res = await send('exportData', {});
    if (!res.ok) return status('dataStatus', '导出失败：' + res.error, 'err');
    const text = JSON.stringify(res.data);
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'steam-multi-owner.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      status('dataStatus', '已下载 steam-multi-owner.json（通常在「下载」文件夹）。' +
        '在 DSH 里执行：steam_owner_data action=import file=<该文件路径>', 'ok');
    } catch (e) {
      status('dataStatus', '下载失败：' + e.message + '（可改用「导出 JSON」再手动保存）', 'err');
    }
  });

  $('exportData').addEventListener('click', async () => {
    const res = await send('exportData', {});
    if (!res.ok) return status('dataStatus', '导出失败：' + res.error, 'err');
    exportCache = JSON.stringify(res.data);
    const box = $('exportBox');
    box.style.display = 'block';
    box.textContent = exportCache;
    status('dataStatus', `已生成 ${(exportCache.length / 1024).toFixed(1)} KB 的导出内容（不含 API key）`, 'ok');
  });

  $('copyExport').addEventListener('click', async () => {
    if (!exportCache) return status('dataStatus', '先点「导出 JSON」', 'err');
    try {
      await navigator.clipboard.writeText(exportCache);
      status('dataStatus', '已复制到剪贴板', 'ok');
    } catch (e) {
      status('dataStatus', '复制失败，请手动复制上面的文本框', 'err');
    }
  });

  $('importData').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const res = await send('importData', { payload, merge: true });
      if (!res.ok) return status('dataStatus', '导入失败：' + res.error, 'err');
      status('dataStatus', `导入完成：${res.data.accounts} 个账号 / ${res.data.appCount} 个 AppID`, 'ok');
      await refresh();
    } catch (e) {
      status('dataStatus', '读取文件失败：' + e.message, 'err');
    }
  });

  refresh();
})();
