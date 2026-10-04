/*
 * 扩展验证器：
 *   A. 静态检查：manifest 合法、引用的文件都存在、所有 JS 语法正确、HTML 无内联脚本
 *   B. 真机检查：用真实 Chrome 加载扩展，在扩展上下文里跑断言（含多账号核心业务逻辑）
 *   C. 页面检查：拦截网络请求伪造一个 Steam 商店页，验证 content script 真的画出了角标
 *
 * 用法：node tools/verify-extension.mjs [--static-only] [--keep-open]
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchChrome, CdpSession, waitForTarget, listTargets } from './cdp.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.SMO_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra = '') {
  pass++;
  console.log(`  ✔ ${name}${extra ? '  ' + extra : ''}`);
}
function bad(name, err) {
  fail++;
  failures.push(name + ': ' + (err?.message || err));
  console.log(`  ✖ ${name} -> ${err?.message || err}`);
}
async function check(name, fn) {
  try {
    const extra = await fn();
    ok(name, typeof extra === 'string' ? extra : '');
    return true;
  } catch (err) {
    bad(name, err);
    return false;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ============================ A. 静态检查 ============================ */

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

async function staticChecks() {
  console.log('\n[A] 静态检查');

  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  await check('manifest.json 可解析且为 MV3', () => {
    assert(manifest.manifest_version === 3, '必须是 manifest_version 3');
    assert(manifest.name && manifest.version, '缺少 name/version');
    return `${manifest.name} v${manifest.version}`;
  });

  await check('manifest 引用的文件都存在', async () => {
    const refs = [];
    refs.push(manifest.background?.service_worker);
    refs.push(manifest.action?.default_popup);
    refs.push(manifest.options_page);
    for (const cs of manifest.content_scripts || []) refs.push(...(cs.js || []), ...(cs.css || []));
    for (const p of Object.values(manifest.icons || {})) refs.push(p);
    for (const p of Object.values(manifest.action?.default_icon || {})) refs.push(p);
    const missing = refs.filter((r) => !r || !existsSync(join(ROOT, r)));
    assert(missing.length === 0, '缺少文件: ' + missing.join(', '));
    return refs.length + ' 个引用全部存在';
  });

  await check('权限最小化（无 tabs/scripting/<all_urls>）', () => {
    const perms = manifest.permissions || [];
    const forbidden = perms.filter((p) => ['tabs', 'scripting', 'webRequest', 'history', 'cookies'].includes(p));
    assert(forbidden.length === 0, '出现不必要的高危权限: ' + forbidden.join(', '));
    const hosts = manifest.host_permissions || [];
    assert(!hosts.some((h) => h.includes('<all_urls>') || h === '*://*/*'), '不应申请全站权限');
    return perms.join(',') + ' | ' + hosts.length + ' 个域名';
  });

  const allFiles = await walk(ROOT);
  const jsFiles = allFiles.filter((f) => f.endsWith('.js') && !f.includes('node_modules'));

  await check(`所有 JS 语法正确（${jsFiles.length} 个文件）`, async () => {
    const results = await Promise.all(jsFiles.map(async (f) => {
      try {
        await execFileAsync(process.execPath, ['--check', f]);
        return null;
      } catch (e) {
        return `${f.replace(ROOT, '.')}: ${e.stderr || e.message}`;
      }
    }));
    const badOnes = results.filter(Boolean);
    assert(badOnes.length === 0, badOnes.join(' | '));
    return jsFiles.length + ' 个文件通过';
  });

  await check('HTML 里没有内联脚本（MV3 CSP）', async () => {
    // 只检查扩展自己的页面：mobile/ 下是给手机用的离线单文件，必须内联脚本
    // （file:// 下不能用 ES module，也不能外链），不受扩展 CSP 约束。
    const htmls = allFiles.filter((f) => f.endsWith('.html') && !f.includes(`${sep}mobile${sep}`));
    for (const f of htmls) {
      const text = await readFile(f, 'utf8');
      assert(!/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(text),
        f.replace(ROOT, '.') + ' 含内联脚本');
      assert(!/\son[a-z]+\s*=\s*["']/i.test(text), f.replace(ROOT, '.') + ' 含内联事件处理器');
    }
    return htmls.length + ' 个扩展 HTML';
  });

  await check('background 是经典脚本（importScripts 与 manifest 一致）', async () => {
    const bg = await readFile(join(ROOT, manifest.background.service_worker), 'utf8');
    assert(/importScripts\(/.test(bg), 'background 用了 importScripts 但没找到调用');
    assert(!/^\s*import\s/m.test(bg), 'background 不能同时用 ESM import');
    return 'ok';
  });

  await check('content script 依赖的 core.js 在 manifest 中先于 content.js 加载', () => {
    const cs = (manifest.content_scripts || [])[0];
    assert(cs.js.indexOf('src/lib/core.js') < cs.js.indexOf('src/content/content.js'), '加载顺序不对');
    return cs.js.join(' -> ');
  });
}

/* ============================ B. 真机检查 ============================ */

const FAKE_STATE = {
  accounts: [
    { id: 'main', label: '大号', steamId64: '76561198000000001', createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'alt', label: '小号', vanity: 'my-alt', createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'cn', label: '国区号', createdAt: '2024-01-01T00:00:00.000Z' },
  ],
  libraries: {
    // 大号独有的 620 用来测"当前账号已拥有"；440 大号和国区号都有；1245620 只有小号有
    // kind/gameAppids 表示"游戏数已知"（真机上必须靠 GetOwnedGames 或商店类型分类得到）
    main: {
      appids: [440, 620], gameAppids: [440, 620], kind: 'games',
      names: { 440: 'Team Fortress 2', 620: 'Portal 2' }, updatedAt: '2024-01-02T00:00:00.000Z', method: 'session-api',
    },
    // 小号故意留成"只有条目、游戏数未识别"，验证界面不会把它说成"款游戏"
    alt: {
      appids: [570, 1245620], kind: 'apps',
      names: { 1245620: 'ELDEN RING' }, updatedAt: '2024-01-02T00:00:00.000Z', method: 'session',
    },
    cn: {
      appids: [440], gameAppids: [440], kind: 'games',
      names: {}, updatedAt: '2024-01-02T00:00:00.000Z', method: 'community-xml',
    },
  },
  settings: { currentAccountId: 'main', showInlineBadges: true, showPanel: true, hideWhenNoneOwned: false, autoRefreshHours: 0 },
};

async function browserChecks({ keepOpen }) {
  console.log('\n[B] 真机检查（Chrome + 真实扩展）');

  if (!existsSync(CHROME)) {
    bad('找到 Chrome', new Error('未找到 ' + CHROME + '（可用 SMO_CHROME 环境变量指定）'));
    return;
  }

  // 注意：Chrome 正式版已禁用 --load-extension，官方给自动化留的入口是
  // --enable-unsafe-extension-debugging + CDP 的 Extensions.loadUnpacked。
  const chrome = await launchChrome({
    port: 9333,
    chromePath: CHROME,
    extraArgs: ['--enable-unsafe-extension-debugging'],
  });
  console.log(`  · Chrome ${chrome.version.Browser} / CDP :${chrome.port}`);

  let browser = null;
  let session = null;
  try {
    const versionTarget = await import('./cdp.mjs').then((m) => m.httpGetJson(`http://127.0.0.1:${chrome.port}/json/version`));
    browser = await CdpSession.open(versionTarget.webSocketDebuggerUrl);
    await browser.send('Target.setDiscoverTargets', { discover: true });

    let extId = null;
    await check('通过 Extensions.loadUnpacked 加载扩展', async () => {
      const res = await browser.send('Extensions.loadUnpacked', { path: ROOT });
      extId = res.id;
      assert(extId, '没有返回扩展 id');
      return '扩展 ID ' + extId;
    });
    if (!extId) return;

    // 打开扩展页面，逼 MV3 的懒加载 service worker 启动
    await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/ui/options.html` });

    const sw = await waitForTarget(chrome.port, (t) => t.type === 'service_worker' && t.url.includes('background.js'), 15000);
    await check('manifest 合法且 service worker 已注册运行', () => {
      assert(sw, '没有找到 background.js 的 service_worker target（manifest 可能有错）');
      return sw.url;
    });
    if (!sw) return;

    session = await CdpSession.open(sw.webSocketDebuggerUrl);
    await session.enableRuntime();

    await check('service worker 无未捕获异常', () => {
      assert(session.exceptions.length === 0, session.exceptions.join(' | '));
      return '干净启动';
    });

    await check('importScripts 注入的全局对象可用', async () => {
      const core = await session.evaluate('typeof SteamOwnerCore');
      const api = await session.evaluate('typeof SteamApi');
      assert(core === 'object', 'SteamOwnerCore 不可用: ' + core);
      assert(api === 'object', 'SteamApi 不可用: ' + api);
      const fns = await session.evaluate('Object.keys(SteamOwnerCore).length');
      return `core ${fns} 个导出`;
    });

    await check('写入假数据并重建索引', async () => {
      const script = `(async () => {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({
          'smo.accounts': ${JSON.stringify(FAKE_STATE.accounts)},
          'smo.libraries': ${JSON.stringify(FAKE_STATE.libraries)},
          'smo.settings': ${JSON.stringify(FAKE_STATE.settings)}
        });
        return await handlers.rebuildIndex();
      })()`;
      const res = await session.evaluate(script);
      assert(res && res.appCount === 4, '索引应收录 4 款游戏，实际 ' + JSON.stringify(res));
      return '合并后 ' + res.appCount + ' 款';
    });

    await check('status badge 文本已更新', async () => {
      const text = await session.evaluate('chrome.action.getBadgeText({})');
      assert(text === '4', 'badge 应为 "4"，实际 "' + text + '"');
      return 'badge=' + text;
    });

    /* -------- 通过真实消息通道测试（从扩展页面发消息给 SW） -------- */
    const optionsList = await listTargets(chrome.port);
    const optionsInfo = optionsList.find((t) => t.url.includes('options.html'));
    assert(optionsInfo, '打不开设置页');

    const optSession = await CdpSession.open(optionsInfo.webSocketDebuggerUrl);
    await optSession.enableRuntime();
    await optSession.send('Page.enable');
    // 假数据是在页面打开之后写进去的，重新载入让 UI 反映最新状态
    await optSession.send('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 1200));

    await check('设置页无未捕获异常', () => {
      assert(optSession.exceptions.length === 0, optSession.exceptions.join(' | '));
      return '干净加载';
    });

    await check('设置页渲染出 3 个账号', async () => {
      const count = await optSession.evaluate("document.querySelectorAll('#accounts li').length");
      assert(count === 3, '期望 3 个账号行，实际 ' + count);
      const hasButton = await optSession.evaluate("!!document.querySelector('#accounts button[data-sync]')");
      assert(hasButton, '账号行里没有同步按钮');
      return count + ' 行';
    });

    await check('getState 汇总正确（消息通道）', async () => {
      const res = await optSession.evaluate("chrome.runtime.sendMessage({type:'getState'})");
      assert(res && res.ok, 'getState 失败: ' + JSON.stringify(res));
      const s = res.data.summary;
      assert(s.accountCount === 3, 'accountCount=' + s.accountCount);
      assert(s.syncedCount === 3, 'syncedCount=' + s.syncedCount);
      assert(s.uniqueAppCount === 4, 'uniqueAppCount=' + s.uniqueAppCount);
      assert(s.totalGames === 5, 'totalGames=' + s.totalGames);
      return `账号 ${s.accountCount} / 唯一游戏 ${s.uniqueAppCount} / 总条目 ${s.totalGames}`;
    });

    await check('checkAppIds：只有别的账号拥有 -> 警告当前账号别重复买', async () => {
      const res = await optSession.evaluate(
        "chrome.runtime.sendMessage({type:'checkAppIds', payload:{appids:[1245620], currentAccountId:'main'}})");
      assert(res && res.ok, 'checkAppIds 失败: ' + JSON.stringify(res));
      const r = res.data.results[1245620];
      assert(r, '没有返回 1245620');
      assert(r.owned === true, '应该已拥有');
      assert(r.ownedByCurrent === false, '当前账号不该拥有');
      assert(r.ownedByOtherOnly === true, '应该只有其他账号拥有');
      assert(r.badge.tone === 'owned-other', 'tone=' + r.badge.tone);
      assert(r.badge.warn === true, '应该给警告');
      assert(r.others.length === 1 && r.others[0].label === '小号', 'others=' + JSON.stringify(r.others));
      assert(r.name === 'ELDEN RING', '名字应从库里带出来，实际 ' + r.name);
      return r.badge.short;
    });

    await check('checkAppIds：当前账号独有 -> 不算重复购买', async () => {
      const res = await optSession.evaluate(
        "chrome.runtime.sendMessage({type:'checkAppIds', payload:{appids:[620], currentAccountId:'main'}})");
      const r = res.data.results[620];
      assert(r.ownedByCurrent === true, '当前账号应拥有 620');
      assert(r.badge.tone === 'owned-current', 'tone=' + r.badge.tone);
      assert(r.badge.warn === false, '不该警告');
      assert(r.otherCount === 0, '不该有别的账号，otherCount=' + r.otherCount);
      return r.badge.short;
    });

    await check('checkAppIds：当前账号 + 国区号都有 -> owned-both', async () => {
      const res = await optSession.evaluate(
        "chrome.runtime.sendMessage({type:'checkAppIds', payload:{appids:[440], currentAccountId:'main'}})");
      const r = res.data.results[440];
      assert(r.badge.tone === 'owned-both', 'tone=' + r.badge.tone);
      assert(r.ownedByCurrent === true, '当前账号应拥有 440');
      assert(r.otherCount === 1, '国区号也应有，otherCount=' + r.otherCount);
      return r.badge.long;
    });

    await check('checkAppIds：谁都没有 -> none', async () => {
      const res = await optSession.evaluate(
        "chrome.runtime.sendMessage({type:'checkAppIds', payload:{appids:[999999], currentAccountId:'main'}})");
      const r = res.data.results[999999];
      assert(r.owned === false, '不该拥有');
      assert(r.badge.tone === 'none', 'tone=' + r.badge.tone);
      return r.badge.long;
    });

    await check('checkAppIds：支持直接传商店链接', async () => {
      const res = await optSession.evaluate(
        "chrome.runtime.sendMessage({type:'checkAppIds', payload:{appids:['https://store.steampowered.com/app/1245620/ELDEN_RING/'], currentAccountId:'main'}})");
      assert(res.data.results[1245620], '没有解析出 1245620: ' + JSON.stringify(res.data.results));
      return 'URL -> 1245620';
    });

    await check('切换"当前登录账号"会改变结论', async () => {
      await optSession.evaluate("chrome.runtime.sendMessage({type:'setSettings', payload:{patch:{currentAccountId:'alt'}}})");
      const res = await optSession.evaluate(
        "chrome.runtime.sendMessage({type:'checkAppIds', payload:{appids:[1245620]}})");
      const r = res.data.results[1245620];
      assert(r.ownedByCurrent === true, '切到小号后当前账号应拥有');
      assert(r.badge.tone === 'owned-current', 'tone=' + r.badge.tone);
      await optSession.evaluate("chrome.runtime.sendMessage({type:'setSettings', payload:{patch:{currentAccountId:'main'}}})");
      return '当前账号=小号 -> 已拥有';
    });

    await check('exportData 不泄露 API key', async () => {
      await optSession.evaluate("chrome.runtime.sendMessage({type:'setSettings', payload:{patch:{apiKey:'deadbeefdeadbeefdeadbeefdeadbeef'}}})");
      const res = await optSession.evaluate("chrome.runtime.sendMessage({type:'exportData'})");
      assert(res.ok, 'exportData 失败');
      const text = JSON.stringify(res.data);
      assert(!text.includes('deadbeef'), '导出内容里出现了 API key');
      assert(res.data.accounts.length === 3, '应导出 3 个账号');
      return (text.length / 1024).toFixed(1) + ' KB，无密钥';
    });

    await check('removeAccount 会同时清掉快照与索引', async () => {
      await optSession.evaluate("chrome.runtime.sendMessage({type:'removeAccount', payload:{accountId:'cn'}})");
      const res = await optSession.evaluate("chrome.runtime.sendMessage({type:'getState'})");
      assert(res.data.accounts.length === 2, '账号数=' + res.data.accounts.length);
      assert(res.data.summary.uniqueAppCount === 4, '唯一游戏数应仍为 4');
      const check440 = await optSession.evaluate("chrome.runtime.sendMessage({type:'checkAppIds', payload:{appids:[440], currentAccountId:'main'}})"); 
      assert(check440.data.results[440].otherCount === 0, '国区号删掉后 otherCount 应为 0');
      return '删除后索引已重建';
    });

    await check('未同步的账号绝不能被当成"没有这款游戏"', async () => {
      // 加一个只有身份、还没同步库的账号
      const added = await optSession.evaluate(
        "chrome.runtime.sendMessage({type:'addAccount', payload:{label:'还没同步的号', key:'76561198999999999'}})");
      assert(added.ok, 'addAccount 失败: ' + JSON.stringify(added));
      const res = await optSession.evaluate(
        "chrome.runtime.sendMessage({type:'checkAppIds', payload:{appids:[999999], currentAccountId:'main'}})");
      const r = res.data.results[999999];
      assert(res.data.syncedCount === 2, 'syncedCount 应为 2，实际 ' + res.data.syncedCount);
      assert(res.data.accountCount === 3, 'accountCount 应为 3，实际 ' + res.data.accountCount);
      assert(r.badge.incomplete === true, '结论必须标记为不完整');
      assert(/另有 1 个账号未同步/.test(r.badge.long), '必须提示还有账号没同步: ' + r.badge.long);
      return r.badge.long;
    });

    await check('一个账号都没同步时，结论必须是"无法判断"而不是"没有"', async () => {
      await optSession.evaluate("chrome.storage.local.set({'smo.libraries': {}})");
      await optSession.evaluate("chrome.runtime.sendMessage({type:'rebuildIndex'})");
      const res = await optSession.evaluate(
        "chrome.runtime.sendMessage({type:'checkAppIds', payload:{appids:[1245620], currentAccountId:'main'}})");
      const r = res.data.results[1245620];
      assert(r.owned === false, '不该报已拥有');
      assert(r.badge.tone === 'unknown', 'tone 应为 unknown，实际 ' + r.badge.tone);
      assert(/无法判断/.test(r.badge.long), '必须说"无法判断": ' + r.badge.long);
      assert(!/都没有这款游戏/.test(r.badge.long), '不能给出假的安全结论');
      // 恢复现场，后面的 UI 检查要用
      await session.evaluate(`chrome.storage.local.set({'smo.libraries': ${JSON.stringify({
        main: FAKE_STATE.libraries.main,
        alt: FAKE_STATE.libraries.alt,
      })}})`);
      await session.evaluate('handlers.rebuildIndex()');
      return r.badge.long;
    });

    let popSession = null;
    await check('popup 页面可以打开并渲染', async () => {
      const t = await session.send('Target.createTarget', { url: `chrome-extension://${extId}/src/ui/popup.html` });
      const list = await listTargets(chrome.port);
      const info = list.find((x) => x.id === t.targetId);
      assert(info, '打不开 popup');
      const pop = await CdpSession.open(info.webSocketDebuggerUrl);
      await pop.enableRuntime();
      await new Promise((r) => setTimeout(r, 800));
      assert(pop.exceptions.length === 0, 'popup 异常: ' + pop.exceptions.join(' | '));
      const summary = await pop.evaluate("document.getElementById('summary').textContent");
      assert(/个账号/.test(summary), '摘要没渲染: ' + summary);
      const rows = await pop.evaluate("document.querySelectorAll('#accounts li').length");
      assert(rows === 3, 'popup 账号行数=' + rows);
      const cur = await pop.evaluate("document.querySelectorAll('#accounts .tag.me').length");
      assert(cur === 1, '应恰好有 1 个"当前登录"标记，实际 ' + cur);
      // 数量口径：已知游戏数的账号必须显示"款游戏"，未知的必须自认"待识别"，
      // 绝不允许把条目数说成游戏数（真机上出现过 305 被当成游戏数的问题）
      assert(/索引覆盖 4 个 AppID/.test(summary), '摘要应说 AppID 而不是"款游戏": ' + summary);
      const subs = await pop.evaluate("[...document.querySelectorAll('#accounts .sub')].map(s => s.textContent)");
      const mainSub = subs.find((s) => s.includes('76561198000000001'));
      const altSub = subs.find((s) => s.includes('my-alt'));
      assert(mainSub && /2 款游戏/.test(mainSub), '大号应显示游戏数: ' + mainSub);
      assert(altSub && /待识别/.test(altSub), '游戏数未知的账号必须自认待识别: ' + altSub);
      assert(altSub && !/款游戏/.test(altSub), '不许把条目数说成款游戏: ' + altSub);
      popSession = pop;
      return summary.trim();
    });

    await check('popup 有"＋ 添加账号"入口，点开是内联表单', async () => {
      assert(popSession, 'popup 没打开');
      const before = await popSession.evaluate("getComputedStyle(document.getElementById('addForm')).display");
      assert(before === 'none', '表单默认应隐藏，实际 display=' + before);
      await popSession.evaluate("document.getElementById('addToggle').click()");
      const after = await popSession.evaluate("getComputedStyle(document.getElementById('addForm')).display");
      assert(after !== 'none', '点开后表单应可见，实际 display=' + after);
      const hasKey = await popSession.evaluate("!!document.getElementById('newKey')");
      assert(hasKey, '表单缺少 SteamID 输入框');
      // 弹窗里必须说清两种添加方式，这是用户真正会卡住的地方
      const ways = await popSession.evaluate("document.querySelector('.ways').textContent");
      assert(/免 key/.test(ways) && /SteamID/.test(ways), '缺少两种添加方式的说明: ' + ways);
      return '表单可展开，含两种方式说明';
    });

    await check('从 popup 直接添加账号（仅添加）', async () => {
      await popSession.evaluate(`(() => {
        document.getElementById('newLabel').value = '通过弹窗添加的号';
        document.getElementById('newKey').value = 'https://steamcommunity.com/id/added-from-popup/';
      })()`);
      await popSession.evaluate("document.getElementById('addOnly').click()");
      await new Promise((r) => setTimeout(r, 600));
      const rows = await popSession.evaluate("document.querySelectorAll('#accounts li').length");
      assert(rows === 4, '添加后应有 4 行，实际 ' + rows);
      const names = await popSession.evaluate("[...document.querySelectorAll('#accounts .name')].map(n => n.textContent)");
      assert(names.includes('通过弹窗添加的号'), '新账号没进列表: ' + names.join(' | '));
      const status = await popSession.evaluate("document.getElementById('addStatus').textContent");
      assert(/已添加/.test(status), '缺少添加结果提示: ' + status);
      const formCleared = await popSession.evaluate("document.getElementById('newKey').value");
      assert(formCleared === '', '添加成功后应清空表单');
      return names.join(' | ');
    });

    await check('老数据里重复的"（当前登录）"后缀会被自动清掉', async () => {
      // 模拟早期版本写进去的名字
      await session.evaluate(`(async () => {
        const raw = await chrome.storage.local.get('smo.accounts');
        const accounts = raw['smo.accounts'].map((a) => a.id === 'alt'
          ? Object.assign({}, a, { auto: true, label: 'my-alt（当前登录）' }) : a);
        await chrome.storage.local.set({ 'smo.accounts': accounts });
        const changed = await normalizeAutoLabels();
        const after = (await chrome.storage.local.get('smo.accounts'))['smo.accounts'];
        const alt = after.find((a) => a.id === 'alt');
        return { changed, label: alt.label };
      })()`).then((res) => {
        assert(res.changed === true, '应报告已修正');
        assert(res.label === 'my-alt', '后缀没清掉: ' + res.label);
        return 'my-alt（当前登录）→ my-alt';
      });
      // 用户自己起的名字不能被误伤
      const custom = await session.evaluate(`(async () => {
        const raw = await chrome.storage.local.get('smo.accounts');
        const accounts = raw['smo.accounts'].map((a) => a.id === 'alt'
          ? Object.assign({}, a, { label: '我的阿根廷号（当前登录）', auto: false }) : a);
        await chrome.storage.local.set({ 'smo.accounts': accounts });
        await normalizeAutoLabels();
        const after = (await chrome.storage.local.get('smo.accounts'))['smo.accounts'];
        return after.find((a) => a.id === 'alt').label;
      })()`);
      assert(custom === '我的阿根廷号（当前登录）', '手动命名的账号不该被改: ' + custom);
    });

    await check('登录态同步会先核对身份：认不出来就拒绝，绝不拿当前会话的数据覆盖', async () => {
      // 真机事故：同步 A 号时实际抓的是当前登录的 B 号的数据，把 A 的快照覆盖成一样的。
      // 现在必须先核对身份；本机连不上 Steam，所以这里应当被明确拒绝。
      const res = await session.evaluate(`(async () => {
        const raw = await chrome.storage.local.get('smo.accounts');
        const accounts = raw['smo.accounts'].map((a) => a.id === 'alt'
          ? Object.assign({}, a, { auto: true, steamId64: '76561198000000002' }) : a);
        await chrome.storage.local.set({ 'smo.accounts': accounts });
        try {
          const out = await handlers.syncAccount({ accountId: 'alt' });
          return { ok: true, out };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      })()`);
      assert(res.ok === false, '身份认不出来时必须拒绝同步，实际却成功了：' + JSON.stringify(res.out));
      assert(/读不到当前浏览器登录的 SteamID|不是当前浏览器登录的号/.test(res.error),
        '拒绝理由要说清是身份问题: ' + res.error);
      const after = await session.evaluate(`(async () => {
        const raw = await chrome.storage.local.get('smo.libraries');
        return (raw['smo.libraries'].alt || {}).appids ? raw['smo.libraries'].alt.appids.length : null;
      })()`);
      assert(after === 2, '被拒绝的同步不能改动已有快照，实际条目数=' + after);
      return res.error.slice(0, 50) + '…';
    });

    await check('「同步全部」把"不是当前登录的号"归为跳过，而不是失败', async () => {
      // 语义要准：跳过是设计使然（登录态只能刷当前登录的号），不该写成账号错误，
      // 也不该让用户以为工具坏了。
      const res = await session.evaluate(`(async () => {
        const out = (await handlers.syncAll({})).results;
        const raw = await chrome.storage.local.get('smo.accounts');
        const accounts = raw['smo.accounts'];
        return {
          results: out,
          statuses: out.map((r) => r.status),
          skippedLabels: out.filter((r) => r.status === 'skipped').map((r) => r.label),
          altLastError: (accounts.find((a) => a.id === 'alt') || {}).lastError || null,
        };
      })()`);
      assert(Array.isArray(res.results) && res.results.length >= 2, '应逐个账号给出结果: ' + JSON.stringify(res.results));
      assert(res.statuses.every((s) => s === 'ok' || s === 'skipped' || s === 'failed'), '状态只能是 ok/skipped/failed');
      assert(res.skippedLabels.length >= 1, '登录态账号不是当前登录的号时应被跳过，实际: ' + JSON.stringify(res.results));
      const skip = res.results.find((r) => r.status === 'skipped');
      assert(/不是当前浏览器登录的号|读不到当前浏览器登录的 SteamID/.test(skip.message),
        '跳过理由要说清原因: ' + skip.message);
      assert(res.altLastError === null, '跳过不该写成账号的 lastError，实际: ' + res.altLastError);
      return res.results.map((r) => r.label + '=' + r.status).join(' | ');
    });

    await check('popup 打开时无未捕获异常', () => {
      assert(popSession.exceptions.length === 0, popSession.exceptions.join(' | '));
      popSession.close();
      return '干净';
    });

    /* ---------------- C. content script 真机渲染 ---------------- */
    console.log('\n[C] content script 真机渲染（拦截网络伪造 Steam 页面）');
    // 前面的用例改动过存储，这里恢复成确定的初始状态
    await session.evaluate(`(async () => {
      await chrome.storage.local.set({
        'smo.accounts': ${JSON.stringify(FAKE_STATE.accounts.slice(0, 2))},
        'smo.libraries': ${JSON.stringify({ main: FAKE_STATE.libraries.main, alt: FAKE_STATE.libraries.alt })},
        'smo.settings': ${JSON.stringify(FAKE_STATE.settings)}
      });
      return await handlers.rebuildIndex();
    })()`);
    await contentScriptCheck(chrome, extId, session);

    if (keepOpen) {
      console.log('\n  · --keep-open：Chrome 保持运行，端口 ' + chrome.port);
      return;
    }
  } finally {
    if (!keepOpen) await chrome.close();
  }
}

function storePageHtml(appid, name) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${name} on Steam</title></head>
<body class="v6 app">
  <div class="apphub_AppName">${name}</div>
  <div class="glance_ctn"><div class="game_area_purchase">
     <div class="btn_addtocart"><a class="btn_green_steamui btn_medium" href="#">添加至购物车</a></div>
  </div></div>
  <div id="app_id" data-appid="${appid}"></div>
</body></html>`;
}

function wishlistPageHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>愿望单</title></head><body>
  <div class="wishlist_row" data-appid="1245620"><div class="title">ELDEN RING</div></div>
  <div class="wishlist_row" data-appid="620"><div class="title">Portal 2</div></div>
  <div class="wishlist_row" data-appid="440"><div class="title">Team Fortress 2</div></div>
  <div class="wishlist_row" data-appid="999999"><div class="title">Some Game Nobody Owns</div></div>
  </body></html>`;
}

/**
 * 复刻真机上出事的那一页：Steam 自己写着 "already in your Steam library"，
 * 而我们的快照里没有这个 appid —— 面板必须报警，不能默默说"没有"。
 */
function mismatchPageHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Two Point Hospital on Steam</title></head>
<body class="v6 app">
  <!-- 真实商店页会把登录态信息挂在这个元素上，而且 JSON 是被 HTML 转义的 -->
  <div id="application_config"
    data-store_user_config="{&quot;webapi_token&quot;:&quot;PAGE_TOKEN_123&quot;,&quot;logged_in&quot;:true}"
    data-userinfo="{&quot;logged_in&quot;:true,&quot;steamid&quot;:&quot;76561198000000042&quot;,&quot;persona_name&quot;:&quot;example_login&quot;}"></div>
  <div class="apphub_AppName">Two Point Hospital</div>
  <div class="already_in_library_strip">Two Point Hospital is already in your Steam library</div>
  <div class="glance_ctn"><div class="game_area_purchase"><div class="queue_actions_ctn">IN LIBRARY</div></div></div>
</body></html>`;
}

/**
 * 购物车 / 支付页：故意用"React 根容器 + 只有链接能看出 appid"的结构，
 * 因为真机上就是这种结构导致警告条没出现（容器 class 变了、塞进根节点又被重渲染抹掉）。
 * 1245620 只有小号有（应当被警告），620 当前账号自己有（只作为补充信息）。
 */
/**
 * 空购物车 + 「为您推荐」：真机上我把推荐位的链接当成了购物车商品，报了 3 个假警报。
 * 这个页面就是那个场景的复刻 —— 断言：什么都不许提示。
 */
function emptyCartWithRecommendationsHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>您的购物车</title></head>
<body class="v6">
  <div id="application_root">
    <h1>您的购物车</h1>
    <div class="cart_area">您的购物车是空的。</div>
    <div class="recommended">为您推荐
      <div class="cap"><a href="https://store.steampowered.com/app/292030/"><img alt="巫师3"></a></div>
      <div class="cap"><a href="https://store.steampowered.com/app/814380/">SEKIRO: SHADOWS DIE TWICE</a></div>
      <div class="cap"><a href="https://store.steampowered.com/app/489830/">The Elder Scrolls V: Skyrim</a></div>
    </div>
  </div>
</body></html>`;
}

/**
 * 真有商品（在小号库里）+ 推荐位噪声。
 * 断言：只报购物车里那 1 件，并且用**页面上的商品标题**而不是 AppID。
 */
function cartWithOneItemAndNoiseHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>您的购物车</title></head>
<body class="v6">
  <div id="application_root">
    <h1>您的购物车（1 个项目）</h1>
    <div class="cart_item">
      <a href="https://store.steampowered.com/app/1245620/ELDEN_RING/"><img alt="封面"></a>
      <a class="name" href="https://store.steampowered.com/app/1245620/ELDEN_RING/">ELDEN RING</a>
    </div>
    <div class="recommended">为您推荐
      <div class="cap"><a href="https://store.steampowered.com/app/292030/">巫师3</a></div>
      <div class="cap"><a href="https://store.steampowered.com/app/814380/">SEKIRO</a></div>
    </div>
  </div>
</body></html>`;
}

/**
 * 复刻真实购物车（React 渲染、class 名不可知）：
 * 商品行里有"移除"控件，推荐位里没有 —— 靠这个语义信号区分。
 * 同时带上 data-cart_config（Steam 自己放的购物车 JSON）。
 */
function realishCartHtml(opts) {
  const o = opts || {};
  const cfg = o.cartConfig == null ? '[]' : JSON.stringify(o.cartConfig);
  const header = o.count == null ? '' : '<h1>您的购物车（' + o.count + ' 个项目）</h1>';
  const items = (o.items || []).map((it) => `
    <div class="Xy7_cartRow">
      <a href="https://store.steampowered.com/app/${it.appid}/"><img alt="封面"></a>
      <a class="Xy7_title" href="https://store.steampowered.com/app/${it.appid}/">${it.name}</a>
      <span class="Xy7_price">¥ 99.50</span>
      <a href="javascript:RemoveFromCart(${it.appid});">移除</a>
    </div>`).join('');
  const recs = (o.recs || []).map((r) => `
    <div class="Xy7_reco"><a href="https://store.steampowered.com/app/${r.appid}/">${r.name}</a>
      <span class="Xy7_price">¥ 64.00</span></div>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>您的购物车</title></head>
<body class="v6">
  <div id="application_config" data-cart_config="${cfg.replace(/"/g, '&quot;')}"></div>
  <div id="application_root">
    ${header}
    <div class="Xy7_cartBody">${items}${o.emptyText ? '<div class="Xy7_empty">您的购物车是空的。</div>' : ''}</div>
    <div class="Xy7_recoRail">为您推荐${recs}</div>
  </div>
</body></html>`;
}

function cartLikePageHtml(title) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body class="v6">
  <div id="application_root">
    <div class="cart_item"><a href="https://store.steampowered.com/app/1245620/ELDEN_RING/">ELDEN RING</a>
      <span class="price">¥ 198.00</span></div>
    <div class="cart_item"><a href="https://store.steampowered.com/app/620/Portal_2/">Portal 2</a>
      <span class="price">¥ 42.00</span></div>
  </div>
</body></html>`;
}

async function contentScriptCheck(chrome, extId, swSession) {
  const targets = await listTargets(chrome.port);
  const page = targets.find((t) => t.type === 'page' && t.url === 'about:blank') || targets.find((t) => t.type === 'page');
  if (!page) return bad('找到页面 target', new Error('没有可用页面'));

  const session = await CdpSession.open(page.webSocketDebuggerUrl);
  await session.enableRuntime();
  await session.send('Page.enable');

  let served = [];
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*store.steampowered.com*', requestStage: 'Request' }] });
  session.on('Fetch.requestPaused', async (params) => {
    const url = params.request.url;
    let body = null;
    if (url.includes('/app/1245620')) {
      body = storePageHtml(1245620, 'ELDEN RING');
      served.push(url);
    } else if (url.includes('/app/535930')) {
      body = mismatchPageHtml();
      served.push(url);
    } else if (url.includes('/cart/real-rec')) {
      // 只有推荐位有"已拥有"的游戏，购物车真实为空 -> 不许提示
      //（注意：这一条必须排在 /cart/real 之前，否则会被它截走）
      body = realishCartHtml({
        count: 0,
        cartConfig: [],
        emptyText: true,
        recs: [{ appid: 292030, name: '巫师3' }, { appid: 814380, name: 'SEKIRO' }],
      });
      served.push(url);
    } else if (url.includes('/cart/real')) {
      // 真实形态：商品行有"移除"控件，推荐位没有；data-cart_config 也带上
      body = realishCartHtml({
        count: 1,
        cartConfig: [{ appid: 1245620, qty: 1 }],
        items: [{ appid: 1245620, name: 'ELDEN RING' }],
        recs: [{ appid: 292030, name: '巫师3' }, { appid: 814380, name: 'SEKIRO' }],
      });
      served.push(url);
    } else if (url.includes('/cart/unmatched')) {
      // 有商品但一件都认不出来（模拟 Steam 大改版）-> 必须给"软提示"，且不许点名任何游戏
      body = realishCartHtml({ count: 2, cartConfig: [], items: [] });
      served.push(url);
    } else if (url.includes('/cart/empty')) {
      body = emptyCartWithRecommendationsHtml();
      served.push(url);
    } else if (url.includes('/cart/one')) {
      body = cartWithOneItemAndNoiseHtml();
      served.push(url);
    } else if (url.includes('/cart')) {
      body = cartLikePageHtml('您的购物车');
      served.push(url);
    } else if (url.includes('/checkout')) {
      body = cartLikePageHtml('支付');
      served.push(url);
    } else if (url.includes('/wishlist')) {
      body = wishlistPageHtml();
      served.push(url);
    }
    try {
      if (body) {
        await session.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'text/html; charset=utf-8' },
            { name: 'Cache-Control', value: 'no-store' },
          ],
          body: Buffer.from(body, 'utf8').toString('base64'),
        });
      } else {
        await session.send('Fetch.continueRequest', { requestId: params.requestId });
      }
    } catch (e) { /* 请求可能已取消 */ }
  });

  await check('伪造的 Steam 商店页导航成功（Fetch 拦截生效）', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/app/1245620/' });
    await new Promise((r) => setTimeout(r, 1500));
    const url = await session.evaluate('location.href');
    assert(url.includes('/app/1245620'), '导航后 URL 是 ' + url);
    assert(served.length > 0, '拦截没有生效');
    const title = await session.evaluate('document.title');
    return title + ' (' + served.length + ' 次拦截)';
  });

  await check('游戏页出现了多账号面板', async () => {
    let exists = false;
    for (let i = 0; i < 20 && !exists; i++) {
      exists = await session.evaluate("!!document.getElementById('smo-panel-host')");
      if (!exists) await new Promise((r) => setTimeout(r, 250));
    }
    assert(exists, '没有注入 #smo-panel-host（content script 没跑或报错）');
    return '面板已注入';
  });

  await check('面板内容正确指出"小号已拥有、当前账号没有"', async () => {
    const text = await session.evaluate(`(() => {
      const host = document.getElementById('smo-panel-host');
      if (!host) return '';
      const root = host.shadowRoot;
      return root ? root.textContent.replace(/\\s+/g, ' ').trim() : '';
    })()`);
    assert(text.length > 0, '面板是空的');
    assert(text.includes('小号'), '面板里没有出现"小号": ' + text.slice(0, 200));
    assert(/已拥有/.test(text), '面板里没有"已拥有"');
    assert(/不用重复购买/.test(text), '没有给出"不用重复购买"的结论: ' + text.slice(0, 200));
    const verdict = await session.evaluate(`document.getElementById('smo-panel-host').shadowRoot.querySelector('.verdict').textContent.trim()`);
    return verdict;
  });

  await check('面板按账号逐条列出拥有情况', async () => {
    const rows = await session.evaluate(`(() => {
      const root = document.getElementById('smo-panel-host').shadowRoot;
      return [...root.querySelectorAll('li')].map(li => li.textContent.replace(/\\s+/g,' ').trim());
    })()`);
    assert(rows.length === 2, '应列出 2 个账号（国区号已被删除），实际 ' + rows.length);
    const alt = rows.find((r) => r.includes('小号'));
    const main = rows.find((r) => r.includes('大号'));
    assert(alt && alt.includes('已拥有'), '小号那行应显示已拥有: ' + alt);
    assert(main && main.includes('未拥有'), '大号那行应显示未拥有: ' + main);
    return rows.join(' / ');
  });

  await check('列表页（愿望单）逐条注入角标，且不给"谁都没有"的项加噪音', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/wishlist/' });
    await new Promise((r) => setTimeout(r, 1800));
    let count = 0;
    for (let i = 0; i < 20 && count === 0; i++) {
      count = await session.evaluate("document.querySelectorAll('.wishlist_row .smo-badge').length");
      if (count === 0) await new Promise((r) => setTimeout(r, 250));
    }
    assert(count === 3, '应只给 3 个"有人拥有"的条目加角标（谁都没有的不加），实际 ' + count);
    const texts = await session.evaluate("[...document.querySelectorAll('.wishlist_row')].map(r => r.dataset.appid + '=' + (r.querySelector('.smo-badge')?.textContent || '无角标'))");
    assert(texts.some((t) => t.startsWith('1245620=') && t.includes('小号')), 'ELDEN RING 那行应提示小号已拥有: ' + texts.join(' | '));
    assert(texts.some((t) => t.startsWith('620=') && t.includes('当前账号')), 'Portal 2 那行应提示当前账号已有: ' + texts.join(' | '));
    assert(texts.some((t) => t.startsWith('999999=无角标')), '谁都没有的条目不该有角标: ' + texts.join(' | '));
    return texts.join(' | ');
  });

  await check('Steam 说"已拥有"而快照说没有时，面板必须报警（真机事故回归）', async () => {
    // 复刻真机：Two Point Hospital 页面写着 already in your Steam library，
    // 但我们的索引里没有 535930 —— 这时绝不能默默说"都没有"，必须指出快照可能抓错了号。
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/app/535930/' });
    await new Promise((r) => setTimeout(r, 1500));
    let text = '';
    for (let i = 0; i < 20; i++) {
      text = await session.evaluate(`(() => {
        const host = document.getElementById('smo-panel-host');
        return host && host.shadowRoot ? host.shadowRoot.textContent.replace(/\\s+/g, ' ').trim() : '';
      })()`);
      if (/Steam 页面显示当前登录的账号/.test(text)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(/Steam 页面显示当前登录的账号/.test(text),
      '面板没有给出"快照可能抓错账号"的警告，实际内容: ' + text.slice(0, 220));
    assert(/重新抓一次|刷新数据/.test(text), '警告里应给出下一步动作: ' + text.slice(0, 220));
    assert(/你的 \d+ 个账号都没有/.test(text), '原有的结论仍然要给出');
    // 索引里没有 535930 这个名字，但页面上写着 "Two Point Hospital" —— 不能给用户看裸 AppID
    assert(/Two Point Hospital/.test(text), '面板应显示页面上的游戏名: ' + text.slice(0, 200));
    assert(!/AppID 535930/.test(text), '不该退化成只显示 AppID: ' + text.slice(0, 200));
    return '面板已报警 + 显示游戏名（而非 AppID）';
  });

  await check('面板可以收进右边缘，并且"别的号已拥有"时强制展开', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/app/1245620/' });
    await new Promise((r) => setTimeout(r, 2200));
    let snap = null;
    for (let i = 0; i < 20; i++) {
      snap = await session.evaluate(`(() => {
        const host = document.getElementById('smo-panel-host');
        if (!host || !host.shadowRoot) return null;
        const root = host.shadowRoot;
        return {
          two: root.getElementById('tab').hidden,
          wrap: root.getElementById('panel') ? null : null,
          panelHidden: !!root.querySelector('.wrap').hidden,
          tabHidden: root.getElementById('tab').hidden,
          tabText: root.getElementById('tabText').textContent,
          tabClass: root.getElementById('tab').className,
          right: host.style.right,
        };
      })()`);
      if (snap && /别重买/.test(snap.tabText)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(snap, '面板没注入');
    // 1245620 只有小号有 -> 属于"别重买"，必须强制展开
    assert(snap.panelHidden === false, '"别的号已拥有"时面板必须展开，实际被收起了');
    assert(/别重买/.test(snap.tabText), '收起标签应写"别重买"，实际: ' + snap.tabText);
    assert(/tone-owned-other/.test(snap.tabClass), '标签应带警告配色: ' + snap.tabClass);

    // 点标题收起 -> 变成贴边小标签（面板隐藏、贴着右边、标签可见）
    await session.evaluate(`document.getElementById('smo-panel-host').shadowRoot.getElementById('head').click()`);
    await new Promise((r) => setTimeout(r, 200));
    const collapsed = await session.evaluate(`(() => {
      const host = document.getElementById('smo-panel-host');
      const root = host.shadowRoot;
      return { panelHidden: !!root.querySelector('.wrap').hidden, tabHidden: root.getElementById('tab').hidden, right: host.style.right };
    })()`);
    assert(collapsed.panelHidden === true, '收起后面板应隐藏');
    assert(collapsed.tabHidden === false, '收起后应显示贴边小标签');
    assert(collapsed.right === '0px', '收起时应贴着右边缘（right=0），实际 ' + collapsed.right);

    // 点小标签 -> 展开回来
    await session.evaluate(`document.getElementById('smo-panel-host').shadowRoot.getElementById('tab').click()`);
    await new Promise((r) => setTimeout(r, 200));
    const expanded = await session.evaluate(`(() => {
      const host = document.getElementById('smo-panel-host');
      return { panelHidden: !!host.shadowRoot.querySelector('.wrap').hidden, right: host.style.right };
    })()`);
    assert(expanded.panelHidden === false, '点标签应展开面板');
    assert(expanded.right === '14px', '展开后应离开边缘，实际 ' + expanded.right);
    return '展开→贴边（right=0）→点回展开，且警告时强制展开';
  });

  await check('购物车页：统计并警告"其他账号已拥有"的商品（真机没生效的回归）', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/cart/' });
    await new Promise((r) => setTimeout(r, 2000));
    let box = null;
    for (let i = 0; i < 20; i++) {
      box = await session.evaluate(`(() => {
        const el = document.getElementById('smo-cart-warning');
        if (!el) return null;
        return {
          text: el.textContent.replace(/\\s+/g, ' ').trim(),
          parentId: el.parentElement ? el.parentElement.id || el.parentElement.tagName : null,
          insideAppRoot: !!(el.closest && el.closest('#application_root')),
          position: getComputedStyle(el).position,
        };
      })()`);
      if (box) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(box, '购物车页没有出现重复购买警告（这就是真机上没生效的那个 bug）');
    assert(/ELDEN RING/.test(box.text), '警告里应列出 ELDEN RING: ' + box.text);
    assert(/小号/.test(box.text), '警告里应说明是哪个账号拥有: ' + box.text);
    assert(/已经拥有/.test(box.text), '警告标题不对: ' + box.text);
    assert(/Portal 2|本来就已拥有/.test(box.text), '当前账号自己已有的商品应作为补充信息: ' + box.text);
    assert(box.insideAppRoot === false, '警告必须插在 React 根容器之外，否则会被重渲染抹掉');
    assert(box.position === 'sticky', '警告应吸顶，滚动时可见，实际 ' + box.position);
    return box.text.slice(0, 90) + '…';
  });

  await check('购物车是空的时候，绝不把"为您推荐"里的游戏当成购物车商品（真机假警报回归）', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/cart/empty' });
    await new Promise((r) => setTimeout(r, 2500));
    const text = await session.evaluate(`(() => {
      const el = document.getElementById('smo-cart-warning');
      return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
    })()`);
    assert(text === '', '空购物车不该有任何警告，实际出现：' + text);
    return '推荐位里的 巫师3/SEKIRO/Skyrim 全都没有被误报';
  });

  await check('购物车只有 1 件时只报这 1 件，而且用页面上的商品名（不是 AppID）', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/cart/one' });
    await new Promise((r) => setTimeout(r, 2500));
    let text = '';
    for (let i = 0; i < 20; i++) {
      text = await session.evaluate(`(() => {
        const el = document.getElementById('smo-cart-warning');
        return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
      })()`);
      if (text) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(text, '真的有"别的号已拥有"的商品时应当提示，实际没有');
    assert(/1 件商品/.test(text), '应当只报 1 件，实际：' + text);
    assert(/ELDEN RING/.test(text), '应当显示页面上的商品名，实际：' + text);
    assert(!/292030|814380/.test(text), '推荐位的商品不该出现在警告里：' + text);
    assert(!/AppID/.test(text), '不该退化成只显示 AppID：' + text);
    return text.slice(0, 90) + '…';
  });

  await check('真实形态购物车（class 名不可知）：靠"移除"控件认出商品，推荐位一律不算', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/cart/real' });
    await new Promise((r) => setTimeout(r, 2500));
    let info = null;
    for (let i = 0; i < 20; i++) {
      info = await session.evaluate(`(() => {
        const el = document.getElementById('smo-cart-warning');
        return el ? { text: el.textContent.replace(/\\s+/g, ' ').trim(), soft: el.className.includes('smo-soft') } : null;
      })()`);
      if (info) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(info, '真实形态的购物车没有出现警告（这正是"该报的也不报了"那个 bug）');
    assert(!info.soft, '这是有明确商品的场景，不该走软提示');
    assert(/ELDEN RING/.test(info.text), '应列出商品名: ' + info.text);
    assert(!/巫师3|SEKIRO|292030|814380/.test(info.text), '推荐位的游戏绝不能被算进来: ' + info.text);
    return info.text.slice(0, 90) + '…';
  });

  await check('购物车真的空、只有推荐位有已拥有游戏时：一个提示都不许有', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/cart/real-rec' });
    await new Promise((r) => setTimeout(r, 2500));
    const text = await session.evaluate(`(() => {
      const el = document.getElementById('smo-cart-warning');
      return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
    })()`);
    assert(text === '', '空购物车不该有任何提示，实际：' + text);
    return '推荐位的巫师3/SEKIRO 没有被误报';
  });

  await check('有商品但认不出来时：给"软提示"说明情况，且不点名任何游戏', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/cart/unmatched' });
    await new Promise((r) => setTimeout(r, 2500));
    let info = null;
    for (let i = 0; i < 20; i++) {
      info = await session.evaluate(`(() => {
        const el = document.getElementById('smo-cart-warning');
        return el ? { text: el.textContent.replace(/\\s+/g, ' ').trim(), soft: el.className.includes('smo-soft') } : null;
      })()`);
      if (info) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(info, '认不出来时应当明确说明，而不是静默（静默会让人以为工具坏了）');
    assert(info.soft, '应当走软提示样式: ' + JSON.stringify(info));
    assert(/没能识别出具体是哪几件/.test(info.text), '文案应说明没识别出来: ' + info.text);
    assert(!/已拥有/.test(info.text), '软提示里不许对任何游戏下"已拥有"的断言: ' + info.text);
    return info.text.slice(0, 90) + '…';
  });

  await check('支付页：同样给出警告，且措辞更强调"付款前"', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/checkout/' });
    await new Promise((r) => setTimeout(r, 2000));
    let text = '';
    for (let i = 0; i < 20; i++) {
      text = await session.evaluate(`(() => {
        const el = document.getElementById('smo-cart-warning');
        return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
      })()`);
      if (text) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(text, '支付页没有出现警告');
    assert(/付款前先看一眼|已经拥有/.test(text), '支付页措辞不对: ' + text);
    assert(/ELDEN RING/.test(text), '支付页应列出 ELDEN RING: ' + text);
    return text.slice(0, 80) + '…';
  });

  await check('内容脚本能从真实页面 DOM 里读出会话凭据（供后台调 GetOwnedGames）', async () => {
    // 这条路比"后台抓 HTML 再猜结构"可靠得多：页面里有什么就读什么。
    // 假页面故意用 HTML 转义过的属性，模拟真机的形态。
    // 注意：chrome.tabs 只在扩展上下文里有，所以这条要在 service worker 里发消息。
    assert(swSession, '需要 service worker 会话才能给标签页发消息');
    // 先回到带 #application_config 的那一页（上一轮测试把页面导航去了 checkout）
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/app/535930/' });
    await new Promise((r) => setTimeout(r, 1500));
    const res = await swSession.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => /store\\.steampowered\\.com\\/app\\/535930/.test(t.url || ''));
      if (!tab) return { error: '没找到目标标签页', urls: tabs.map((t) => t.url) };
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'smo.sessionCreds' });
        return { r };
      } catch (e) {
        return { error: String(e && e.message ? e.message : e) };
      }
    })()`);
    assert(!res.error, '消息没送到内容脚本: ' + JSON.stringify(res).slice(0, 200));
    const r = res.r;
    assert(r && r.ok, '内容脚本返回失败: ' + JSON.stringify(r).slice(0, 200));
    assert(r.token === 'PAGE_TOKEN_123', '没读出 webapi_token: ' + JSON.stringify(r));
    assert(r.steamId64 === '76561198000000042', '没读出 steamid: ' + JSON.stringify(r));
    assert(r.persona === 'example_login', '没读出昵称: ' + JSON.stringify(r));
    assert(Array.isArray(r.signals) && r.signals.length > 0, '应报告读取来源信号');
    return 'token/steamid/昵称 全部读出（来源：' + r.signals.join('，') + '）';
  });

  await check('面板「刷新数据」必须说出逐账号结果（否则用户以为点了没反应）', async () => {
    await session.send('Page.navigate', { url: 'https://store.steampowered.com/app/1245620/' });
    await new Promise((r) => setTimeout(r, 2500));
    const clicked = await session.evaluate(`(() => {
      const host = document.getElementById('smo-panel-host');
      if (!host || !host.shadowRoot) return 'no-panel';
      const wrap = host.shadowRoot.querySelector('.wrap');
      if (wrap && wrap.hidden) host.shadowRoot.getElementById('tab').click();
      const head = host.shadowRoot.getElementById('head');
      const body = host.shadowRoot.getElementById('body');
      return (head ? head.textContent : '') + '|' + (body ? body.textContent : '');
    })()`);
    assert(clicked !== 'no-panel', '面板没注入');
    assert(/刷新数据/.test(clicked), '面板里应有「刷新数据」按钮: ' + clicked.slice(0, 100));

    await session.evaluate(`document.getElementById('smo-panel-host').shadowRoot.getElementById('refresh').click()`);
    let note = '';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      note = await session.evaluate(`(() => {
        const host = document.getElementById('smo-panel-host');
        if (!host || !host.shadowRoot) return '';
        const el = host.shadowRoot.getElementById('syncNote');
        return el ? el.textContent.trim() : '';
      })()`);
      if (note) break;
    }
    assert(note, '点了刷新却没有任何结果反馈（这正是"我买了游戏但刷新没变化"会踩的坑）');
    // 本机读不到会话、也没有 API key，所以结果里一定会有被跳过/失败的账号，并且要说明原因
    assert(/跳过|失败|已刷新/.test(note), '结果文案不对: ' + note);
    assert(/不是当前浏览器登录的号|读不到当前浏览器登录的 SteamID|没有 API key|档案|失败/.test(note),
      '必须说清为什么没能刷新: ' + note);
    return note.slice(0, 100) + '…';
  });

  await check('真实 Steam 页面（不做任何伪造）上也能正常工作', async () => {
    // 之前这台机器连不上 store.steampowered.com，所以只能靠伪造页面。
    // 现在能连上了：关掉 Fetch 拦截，直接打开真实的商店页，验证真机集成。
    const pageErrors = [];
    session.on('Runtime.exceptionThrown', (p) => {
      const d = p && p.exceptionDetails;
      pageErrors.push((d && d.exception && (d.exception.description || d.exception.value)) || (d && d.text) || '未知异常');
    });
    await session.send('Fetch.disable');
    try {
      await session.send('Page.navigate', { url: 'https://store.steampowered.com/app/440/' });
      let info = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        info = await session.evaluate(`(() => {
          const host = document.getElementById('smo-panel-host');
          return {
            ready: document.readyState,
            url: location.href,
            title: document.title,
            real: !!document.querySelector('#application_config'),
            panel: !!host,
            badges: document.querySelectorAll('.smo-badge').length,
            text: (() => {
              const host = document.getElementById('smo-panel-host');
              if (!host || !host.shadowRoot) return '';
              const wrap = host.shadowRoot.querySelector('.wrap');
              const head = host.shadowRoot.getElementById('head');
              const body = host.shadowRoot.getElementById('body');
              return ((head ? head.textContent : '') + ' ' + (body ? body.textContent : '')).replace(/\\s+/g, ' ').trim().slice(0, 300);
            })(),
          };
        })()`);
        if (info && info.panel) break;
      }
      assert(/store\.steampowered\.com\/app\/440/.test(info.url), '真实页面没打开成功: ' + info.url);
      assert(info.real, '真实页面里应该有 #application_config（我的解析目标）');
      assert(info.panel, '真实 Steam 页面上没有注入面板（readyState=' + info.ready + '，异常：' +
        (pageErrors.slice(0, 3).join(' | ') || '无') + '）');
      assert(!/undefined|NaN/.test(info.text), '面板内容里不该出现 undefined/NaN: ' + info.text);
      // 本机是未登录状态，所以结论必须是"无法判断/未同步"，不能凭空说"没有"
      assert(/账号|未同步|无法判断|还没有/.test(info.text), '面板应给出可读结论: ' + info.text);
      return '真实页面 · 面板正常 · ' + info.text.slice(0, 60);
    } finally {
      await session.send('Fetch.enable', { patterns: [{ urlPattern: '*store.steampowered.com*', requestStage: 'Request' }] });
    }
  });

  session.close();
}

/* ============================== main ============================== */

const args = process.argv.slice(2);
const staticOnly = args.includes('--static-only');
const keepOpen = args.includes('--keep-open');

console.log('Steam 多账号拥有检查 — 验证器');
console.log('项目目录: ' + ROOT);

await staticChecks();
if (!staticOnly) {
  try {
    await browserChecks({ keepOpen });
  } catch (err) {
    bad('浏览器检查整体失败', err);
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败明细:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
