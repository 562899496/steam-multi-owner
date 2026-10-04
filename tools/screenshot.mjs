/*
 * 用真实 Chrome 加载扩展，注入多账号演示数据，把几个关键界面截图到 docs/。
 * 用法：node tools/screenshot.mjs
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, CdpSession, listTargets, waitForTarget, httpGetJson } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const CHROME = process.env.SMO_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9444;

const DLC_EXTRAS = Array.from({ length: 20 }, (_, i) => 900000 + i);

const FAKE_STATE = {
  accounts: [
    { id: 'main', label: '大号（国区主号）', steamId64: '76561198000000001' },
    { id: 'alt', label: '小号（阿根廷）', vanity: 'my-alt' },
    { id: 'cn', label: '第三个号' },
  ],
  libraries: {
    main: {
      appids: [440, 620, 570, 730],
      gameAppids: [440, 620, 570, 730],
      kind: 'games',
      names: { 440: 'Team Fortress 2', 620: 'Portal 2', 570: 'Dota 2', 730: 'Counter-Strike 2' },
      method: 'session-api', updatedAt: '2024-01-02T00:00:00.000Z',
    },
    // 故意做成"3 款游戏 + 20 个 DLC"的形状：界面必须说 3 款游戏，而不是 23 款
    alt: {
      appids: [1245620, 292030, 1091500].concat(DLC_EXTRAS),
      gameAppids: [1245620, 292030, 1091500],
      kind: 'mixed',
      names: { 1245620: 'ELDEN RING', 292030: 'The Witcher 3: Wild Hunt', 1091500: 'Cyberpunk 2077' },
      method: 'session-api+session', updatedAt: '2024-01-02T00:00:00.000Z',
    },
    cn: { appids: [440, 620], gameAppids: [440, 620], kind: 'games', names: {}, method: 'community-xml', updatedAt: '2024-01-02T00:00:00.000Z' },
  },
  settings: { currentAccountId: 'main', showInlineBadges: true, showPanel: true, hideWhenNoneOwned: false },
};

const CART_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>您的购物车</title>
<style>
  body { margin:0; background:#1b2838; color:#c7d5e0; font:14px "Motiva Sans","Microsoft YaHei",Arial,sans-serif; }
  #application_root { padding:24px 30px; max-width:960px; }
  h1 { font-size:22px; color:#fff; margin:0 0 18px; }
  .cart_item { display:flex; align-items:center; gap:14px; padding:12px; border:1px solid #2a475e; border-radius:4px; margin-bottom:10px; background:rgba(0,0,0,.2); }
  .cap { width:140px; height:52px; border-radius:3px; background:linear-gradient(120deg,#243b4d,#3a2a12); }
  .name { flex:1; font-size:16px; color:#fff; }
  .price { color:#a4d007; }
</style></head>
<body><div id="application_root">
  <h1>您的购物车（2 个项目）</h1>
  <div class="cart_item"><div class="cap"></div><a class="name" href="https://store.steampowered.com/app/1245620/ELDEN_RING/">ELDEN RING</a><div class="price">¥ 198.00</div></div>
  <div class="cart_item"><div class="cap"></div><a class="name" href="https://store.steampowered.com/app/620/Portal_2/">Portal 2</a><div class="price">¥ 42.00</div></div>
  <div style="margin-top:16px;color:#8f98a0;font-size:12px">（演示页面：这里本来是 Steam 自己的购物车）</div>
</div></body></html>`;

const STORE_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>ELDEN RING on Steam</title>
<style>
  body { margin:0; background:#1b2838; color:#c7d5e0; font:14px "Motiva Sans","Microsoft YaHei",Arial,sans-serif; }
  .page { padding:28px 34px; max-width:1000px; }
  .crumb { color:#8f98a0; font-size:12px; margin-bottom:8px; }
  .apphub_AppName { font-size:32px; font-weight:600; color:#fff; margin-bottom:6px; }
  .sub { color:#8f98a0; font-size:13px; margin-bottom:22px; }
  .hero { height:260px; border-radius:4px; background:linear-gradient(120deg,#3a2a12 0%,#6b4a12 45%,#2a3b4a 100%); margin-bottom:20px;
          display:flex; align-items:flex-end; padding:18px; }
  .hero span { font-size:13px; color:#e8d7ab; }
  .glance_ctn { max-width:640px; }
  .game_area_purchase { border:1px solid #2a475e; border-radius:4px; padding:16px; background:rgba(0,0,0,.2); }
  .game_area_purchase h3 { margin:0 0 12px; font-size:15px; color:#fff; }
  .btn_addtocart { display:inline-block; padding:9px 18px; border-radius:3px; color:#fff;
    background:linear-gradient(to bottom,#75b022 0%,#588a1b 100%); }
</style></head>
<body class="v6 app"><div class="page">
  <div class="crumb">所有游戏 &gt; 动作 &gt; ELDEN RING</div>
  <div class="apphub_AppName">ELDEN RING</div>
  <div class="sub">FromSoftware · 2022 年 2 月 25 日</div>
  <div class="hero"><span>（演示页面：这里本来是游戏宣传图）</span></div>
  <div class="glance_ctn"><div class="game_area_purchase">
    <h3>购买 ELDEN RING</h3>
    <div class="btn_addtocart">添加至购物车</div>
    <div style="margin-top:12px;color:#8f98a0;font-size:12px">Steam 自己只会告诉你"当前登录账号"有没有这款游戏。</div>
  </div></div>
</div></body></html>`;

const WISHLIST_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>愿望单</title>
<style>
  body { margin:0; background:#1b2838; color:#c7d5e0; font:14px "Motiva Sans","Microsoft YaHei",Arial,sans-serif; }
  .page { padding:28px 34px; max-width:900px; }
  h2 { font-size:22px; color:#fff; margin:0 0 18px; }
  .wishlist_row { display:flex; gap:14px; align-items:center; border-bottom:1px solid #2a475e; padding:14px 0; }
  .cap { width:120px; height:46px; border-radius:3px; background:linear-gradient(120deg,#243b4d,#3a2a12); flex:0 0 auto; }
  .title { font-size:16px; color:#fff; }
  .sub { font-size:12px; color:#8f98a0; }
</style></head>
<body><div class="page"><h2>我的愿望单</h2>
  <div class="wishlist_row" data-appid="1245620"><div class="cap"></div><div><div class="title">ELDEN RING</div><div class="sub">FromSoftware</div></div></div>
  <div class="wishlist_row" data-appid="1091500"><div class="cap"></div><div><div class="title">Cyberpunk 2077</div><div class="sub">CD PROJEKT RED</div></div></div>
  <div class="wishlist_row" data-appid="620"><div class="cap"></div><div><div class="title">Portal 2</div><div class="sub">Valve</div></div></div>
  <div class="wishlist_row" data-appid="999999"><div class="cap"></div><div><div class="title">Nobody Owns This</div><div class="sub">演示用：谁都没有，不加角标</div></div></div>
</div></body></html>`;

function findPageTarget(targets) {
  return targets.find((t) => t.type === 'page' && t.url === 'about:blank') || targets.find((t) => t.type === 'page');
}

async function shoot(session, name, { fullPage = false } = {}) {
  const params = { format: 'png' };
  if (fullPage) params.captureBeyondViewport = true;
  const { data } = await session.send('Page.captureScreenshot', params);
  const file = join(DOCS, name + '.png');
  await writeFile(file, Buffer.from(data, 'base64'));
  console.log('已保存 docs/' + name + '.png');
}

if (!existsSync(CHROME)) {
  console.error('找不到 Chrome：' + CHROME);
  process.exit(1);
}
await mkdir(DOCS, { recursive: true });

const chrome = await launchChrome({ port: PORT, chromePath: CHROME, extraArgs: ['--enable-unsafe-extension-debugging'] });
try {
  const version = await httpGetJson(`http://127.0.0.1:${PORT}/json/version`);
  const browser = await CdpSession.open(version.webSocketDebuggerUrl);
  await browser.send('Target.setDiscoverTargets', { discover: true });
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: ROOT });

  // 唤醒 SW 并注入演示数据
  await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/ui/options.html` });
  const sw = await waitForTarget(PORT, (t) => t.type === 'service_worker' && t.url.includes('background.js'), 15000);
  const swSession = await CdpSession.open(sw.webSocketDebuggerUrl);
  await swSession.enableRuntime();
  // 注意：loadUnpacked 之后 onInstalled 是异步的，它会把当时的 settings 写回去。
  // 如果抢在它前面写状态，会被它覆盖（"当前登录账号"就丢了）。所以先等它跑完。
  await new Promise((r) => setTimeout(r, 1500));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const applied = await swSession.evaluate(`(async () => {
      await chrome.storage.local.set({
        'smo.accounts': ${JSON.stringify(FAKE_STATE.accounts)},
        'smo.libraries': ${JSON.stringify(FAKE_STATE.libraries)},
        'smo.settings': ${JSON.stringify(FAKE_STATE.settings)}
      });
      const index = await handlers.rebuildIndex();
      const state = await handlers.getState();
      return {
        appCount: index.appCount,
        currentAccountId: state.settings.currentAccountId,
        accountCount: state.accounts.length,
        syncedCount: state.summary.syncedCount,
      };
    })()`);
    if (applied.currentAccountId === FAKE_STATE.settings.currentAccountId) {
      console.log('演示数据就绪：' + JSON.stringify(applied));
      break;
    }
    console.log('第 ' + attempt + ' 次写入被覆盖，重试…');
    await new Promise((r) => setTimeout(r, 800));
  }

  // --- 设置页 ---
  let targets = await listTargets(PORT);
  let optInfo = targets.find((t) => t.url.includes('options.html'));
  const opt = await CdpSession.open(optInfo.webSocketDebuggerUrl);
  await opt.enableRuntime();
  await opt.send('Page.enable');
  await opt.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 860, deviceScaleFactor: 1, mobile: false });
  await opt.send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 1500));
  await shoot(opt, '3-settings', { fullPage: true });
  opt.close();

  // --- 弹窗 ---
  const popTarget = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/ui/popup.html` });
  await new Promise((r) => setTimeout(r, 400));
  targets = await listTargets(PORT);
  const popInfo = targets.find((t) => t.id === popTarget.targetId) || targets.find((t) => t.url.includes('popup.html'));
  const pop = await CdpSession.open(popInfo.webSocketDebuggerUrl);
  await pop.enableRuntime();
  await pop.send('Page.enable');
  await pop.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 1180, deviceScaleFactor: 2, mobile: false });
  await new Promise((r) => setTimeout(r, 1200));
  await shoot(pop, '4-popup');
  pop.close();

  // --- 商店页 + 愿望单（拦截网络伪造 Steam 页面，让 content script 真的跑起来） ---
  targets = await listTargets(PORT);
  const pageInfo = findPageTarget(targets);
  const page = await CdpSession.open(pageInfo.webSocketDebuggerUrl);
  await page.enableRuntime();
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*store.steampowered.com*', requestStage: 'Request' }] });
  page.on('Fetch.requestPaused', async (params) => {
    const url = params.request.url;
    let body = null;
    let code = 404;
    if (url.includes('/app/1245620')) { body = STORE_PAGE; code = 200; }
    else if (url.includes('/wishlist')) { body = WISHLIST_PAGE; code = 200; }
    else if (url.includes('/cart')) { body = CART_PAGE; code = 200; }
    try {
      if (body) {
        await page.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: code,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(body, 'utf8').toString('base64'),
        });
      } else {
        // 这台机器的 DNS 出不去，放行未匹配的请求会一直挂在网络上，
        // 直接把它们挡掉，页面才不会卡住。
        await page.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' });
      }
    } catch { /* 请求可能已取消 */ }
  });

  await page.send('Page.navigate', { url: 'https://store.steampowered.com/app/1245620/' });
  await new Promise((r) => setTimeout(r, 2600));
  await shoot(page, '1-store-page');

  // 收起面板 -> 贴边小标签
  await page.evaluate(`(() => {
    const host = document.getElementById('smo-panel-host');
    if (host && host.shadowRoot) host.shadowRoot.getElementById('head').click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  await shoot(page, '5-panel-collapsed');
  // 点回来，免得影响后面的截图
  await page.evaluate(`(() => {
    const host = document.getElementById('smo-panel-host');
    if (host && host.shadowRoot) host.shadowRoot.getElementById('tab').click();
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  await page.send('Page.navigate', { url: 'https://store.steampowered.com/wishlist/' });
  await new Promise((r) => setTimeout(r, 2600));
  await shoot(page, '2-wishlist');

  // 购物车：重复购买统计警告
  await page.send('Page.navigate', { url: 'https://store.steampowered.com/cart/' });
  await new Promise((r) => setTimeout(r, 2600));
  await shoot(page, '6-cart-warning');

  page.close();
  swSession.close();
  browser.close();
  console.log('\n截图完成，输出目录：' + DOCS);
} finally {
  await chrome.close();
}
