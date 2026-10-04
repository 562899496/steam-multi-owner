/*
 * 一次性核对：把**已发布的仓库**全新 clone 下来，确认它确实能当扩展加载。
 * 这条是 INSTALL.md 里对用户的承诺（"也可以直接选仓库根目录"），必须验证过才算数。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, CdpSession, httpGetJson, waitForTarget } from './cdp.mjs';

const REPO = 'https://github.com/562899496/steam-multi-owner.git';
const tmp = mkdtempSync(join(tmpdir(), 'smo-clone-'));
const clone = join(tmp, 'steam-multi-owner');

try {
  console.log('1) 全新 clone 已发布的仓库…');
  execFileSync('git', ['clone', '--depth', '1', REPO, clone], { stdio: 'inherit' });

  const entries = readdirSync(clone).sort();
  const hasManifest = entries.includes('manifest.json');
  const hasNodeModules = entries.includes('node_modules');
  const hasInstallDirs = entries.some((e) => e.startsWith('dsh-install'));
  const hasDist = entries.includes('dist');
  console.log('   顶层内容: ' + entries.join(' '));
  console.log('   manifest.json: ' + hasManifest + ' / node_modules: ' + hasNodeModules +
    ' / dsh-install-*: ' + hasInstallDirs + ' / dist: ' + hasDist + '（后两者都该是 false）');
  if (!hasManifest) throw new Error('clone 下来没有 manifest.json');
  if (hasNodeModules || hasInstallDirs) throw new Error('clone 里混入了依赖或构建产物');

  const zip = join(clone, 'dist');
  const zipName = readdirSync(zip).find((f) => f.endsWith('.zip'));
  console.log('2) dist 里的安装包: ' + zipName + '（' + Math.round(statSync(join(zip, zipName)).size / 1024) + ' KB）');

  console.log('3) 让 Chrome 直接加载 clone 出来的仓库根目录…');
  const chromePath = process.env.SMO_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const port = 9477;
  const chrome = await launchChrome({ port, chromePath, extraArgs: ['--enable-unsafe-extension-debugging'] });
  try {
    const version = await httpGetJson('http://127.0.0.1:' + port + '/json/version');
    const browser = await CdpSession.open(version.webSocketDebuggerUrl);
    await browser.send('Target.setDiscoverTargets', { discover: true });
    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: clone });
    if (!extId) throw new Error('Chrome 没返回扩展 id');
    const sw = await waitForTarget(port, (t) => t.type === 'service_worker' && t.url.includes(extId), 15000);
    const swSession = await CdpSession.open(sw.webSocketDebuggerUrl);
    await swSession.enableRuntime();
    await new Promise((r) => setTimeout(r, 800));
    const info = await swSession.evaluate(`(() => {
      const m = chrome.runtime.getManifest();
      return { name: m.name, version: m.version, perms: m.permissions.join('+') };
    })()`);
    console.log('   ✔ 加载成功：' + info.name + ' v' + info.version + '（权限: ' + info.perms + '）');
    swSession.close();
    browser.close();
  } finally {
    await chrome.close();
  }
  console.log('\n结论：clone 下来的仓库根目录可以被 Chrome 直接加载，INSTALL.md 里的说法成立。');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
