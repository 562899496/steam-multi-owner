/*
 * 真实链路探测（第二阶段）：现在能连上 store/community 了，就把之前的假设逐条验证掉。
 *
 * 用法：node tools/probe-live2.mjs
 */
import '../src/lib/core.js';
import '../src/lib/steam-api.js';
import { writeFileSync } from 'node:fs';

const Api = globalThis.SteamApi;
const Core = globalThis.SteamOwnerCore;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

async function get(url, extra) {
  const t0 = Date.now();
  const res = await fetch(url, Object.assign({
    headers: { 'User-Agent': UA, Accept: 'text/html,application/json,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    redirect: 'manual',
  }, extra || {}));
  const body = await res.text();
  return { status: res.status, body, ms: Date.now() - t0, location: res.headers.get('location') };
}

function reportLine(name, ok, detail) {
  console.log((ok ? '[OK]   ' : '[!!]   ') + name + '：' + detail);
}

/* ---------- 1. 商店页面里到底有没有"会话凭据"的痕迹 ---------- */

console.log('=== 1. 商店页面结构（未登录状态，验证我的解析目标是否存在） ===');
writeFileSync('C:/dev/steam-multi-owner/.probe-store-home.html', '', 'utf8');
try {
  const home = await get('https://store.steampowered.com/');
  reportLine('GET /', home.status === 200, 'HTTP ' + home.status + '，' + home.body.length + ' 字节，' + home.ms + 'ms');
  writeFileSync('C:/dev/steam-multi-owner/.probe-store-home.html', home.body, 'utf8');
  const html = home.body;
  const checks = [
    ['#application_config 元素', /id="application_config"/.test(html)],
    ['data-store_user_config 属性', /data-store_user_config/.test(html)],
    ['data-store-user-config 属性', /data-store-user-config/.test(html)],
    ['data-userinfo 属性', /data-userinfo/.test(html)],
    ['裸 JSON "webapi_token"', /"webapi_token"/.test(html)],
    ['转义 JSON &quot;webapi_token&quot;', /&quot;webapi_token&quot;/.test(html)],
    ['g_steamID 变量', /g_steamID/.test(html)],
    ['g_sessionID 变量', /g_sessionID/.test(html)],
  ];
  for (const [name, hit] of checks) reportLine('  ' + name, hit, hit ? '存在' : '不存在');
  // 把这个元素的原始属性名原样打出来，供解析器精确适配
  const cfg = /<div[^>]*id="application_config"[^>]*>/i.exec(html);
  console.log('  #application_config 原始标签：' + (cfg ? cfg[0].slice(0, 400) : '（未找到）'));
  const parsed = Api.parseSessionContext(html);
  console.log('  parseSessionContext 结果：token=' + (parsed.token || 'null') + ' steamId64=' + (parsed.steamId64 || 'null') +
    ' signals=' + JSON.stringify(parsed.signals));
} catch (e) {
  reportLine('GET /', false, e.message);
}

/* ---------- 2. 应用详情页 ---------- */
console.log('\n=== 2. 游戏页结构 ===');
try {
  const app = await get('https://store.steampowered.com/app/440/');
  reportLine('GET /app/440/', app.status === 200, 'HTTP ' + app.status + '，' + app.body.length + ' 字节');
  writeFileSync('C:/dev/steam-multi-owner/.probe-app-page.html', app.body, 'utf8');
  console.log('  含 application_config：' + /id="application_config"/.test(app.body));
  console.log('  含 webapi_token（裸/转义）：' + /"webapi_token"|&quot;webapi_token&quot;/.test(app.body));
  console.log('  含 "已在库中" 字样：' + /已在库中|In Library|IN LIBRARY|already in your Steam library/i.test(app.body));
} catch (e) {
  reportLine('GET /app/440/', false, e.message);
}

/* ---------- 3. 社区游戏列表 XML（无需 key 的那条路） ---------- */
console.log('\n=== 3. 社区公开档案游戏列表（不需要 API key） ===');
for (const vanity of ['gabel', 'wchill']) {
  try {
    const lib = await Api.getCommunityGames(fetch, vanity);
    reportLine('  ' + vanity, lib.appids.length > 0,
      lib.appids.length + ' 款，前 5 个：' + lib.appids.slice(0, 5).join(',') + '，示例名：' + (lib.names[lib.appids[0]] || '（无）'));
  } catch (e) {
    reportLine('  ' + vanity, false, e.message);
  }
}

/* ---------- 4. appdetails 多 appid + 类型（分类那条路） ---------- */
console.log('\n=== 4. appdetails 批量 + 类型分类（我给"许可证列表"反推游戏数就靠它） ===');
try {
  const out = await Api.classifyAppTypes(fetch, [440, 570, 620, 72850, 1070560, 228980], { batchSize: 6, delayMs: 0 });
  reportLine('classifyAppTypes', out.classified > 0,
    '请求 ' + out.requested + ' 个，拿到 ' + out.classified + ' 个，失败批次数 ' + out.failures);
  for (const [id, type] of Object.entries(out.types)) {
    console.log('    ' + id + ' -> ' + type + '（' + (out.names[id] || '无名字') + '）');
  }
} catch (e) {
  reportLine('classifyAppTypes', false, e.message);
}

/* ---------- 5. appuserdetails（"当前登录账号有没有这款"的商店接口） ---------- */
console.log('\n=== 5. appuserdetails（未登录，看它返回什么形状） ===');
try {
  const r = await get('https://store.steampowered.com/api/appuserdetails?appids=440');
  reportLine('appuserdetails', true, 'HTTP ' + r.status + '，响应：' + r.body.slice(0, 300));
} catch (e) {
  reportLine('appuserdetails', false, e.message);
}

/* ---------- 6. 未登录时的 dynamicstore / licenses 行为 ---------- */
console.log('\n=== 6. 未登录时的登录态接口（验证我的"未登录"判定） ===');
try {
  const r = await get('https://store.steampowered.com/dynamicstore/userdata/');
  reportLine('dynamicstore', true, 'HTTP ' + r.status + '，前 120 字：' + r.body.slice(0, 120).replace(/\s+/g, ' '));
} catch (e) { reportLine('dynamicstore', false, e.message); }
try {
  const r = await get('https://store.steampowered.com/account/licenses/');
  const lib = Core.fromLicensesHtml(r.body);
  reportLine('licenses 页面', true, 'HTTP ' + r.status + '，fromLicensesHtml 判定：' + (lib ? lib.appids.length + ' 个 appid（不该有）' : '未登录（正确）'));
} catch (e) { reportLine('licenses 页面', false, e.message); }

console.log('\n（页面 HTML 已存到 .probe-store-home.html / .probe-app-page.html 方便进一步分析）');
