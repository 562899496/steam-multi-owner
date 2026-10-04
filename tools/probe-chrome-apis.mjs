/* 诊断：扩展上下文里到底有哪些 chrome.* API 可用（尤其 chrome.tabs）。
 * 用法：node tools/probe-chrome-apis.mjs
 */
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, CdpSession, waitForTarget, httpGetJson, listTargets } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.SMO_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9455;

if (!existsSync(CHROME)) {
  console.error('找不到 Chrome');
  process.exit(1);
}

const chrome = await launchChrome({ port: PORT, chromePath: CHROME, extraArgs: ['--enable-unsafe-extension-debugging'] });
try {
  const version = await httpGetJson(`http://127.0.0.1:${PORT}/json/version`);
  const browser = await CdpSession.open(version.webSocketDebuggerUrl);
  await browser.send('Target.setDiscoverTargets', { discover: true });
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: ROOT });
  await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/ui/popup.html` });

  const sw = await waitForTarget(PORT, (t) => t.type === 'service_worker' && t.url.includes('background.js'), 15000);
  const swSession = await CdpSession.open(sw.webSocketDebuggerUrl);
  await swSession.enableRuntime();
  await new Promise((r) => setTimeout(r, 800));

  const inSw = await swSession.evaluate(`({
    hasChrome: typeof chrome,
    apiKeys: Object.keys(chrome).sort().join(','),
    hasTabs: typeof chrome.tabs,
    tabsKeys: chrome.tabs ? Object.keys(chrome.tabs).sort().slice(0, 12).join(',') : null,
    permissions: JSON.stringify(chrome.runtime.getManifest().permissions),
    hostPermissions: JSON.stringify(chrome.runtime.getManifest().host_permissions),
  })`);
  console.log('=== service worker ===');
  for (const [k, v] of Object.entries(inSw)) console.log('  ' + k + '：' + v);

  const targets = await listTargets(PORT);
  const popupInfo = targets.find((t) => t.url.includes('popup.html'));
  if (popupInfo) {
    const pop = await CdpSession.open(popupInfo.webSocketDebuggerUrl);
    await pop.enableRuntime();
    await new Promise((r) => setTimeout(r, 600));
    const inPopup = await pop.evaluate(`({
      hasTabs: typeof chrome.tabs,
      queryWorks: (async () => {
        try { const tabs = await chrome.tabs.query({}); return 'ok:' + tabs.length + ' tabs, urls=' + tabs.map(t => t.url || '(隐藏)').slice(0,3).join(' '); }
        catch (e) { return 'ERR:' + e.message; }
      })(),
    })`);
    console.log('=== popup 页面 ===');
    for (const [k, v] of Object.entries(inPopup)) console.log('  ' + k + '：' + (await Promise.resolve(v)));
    await pop.close();
  }
  swSession.close();
  browser.close();
} finally {
  await chrome.close();
}
