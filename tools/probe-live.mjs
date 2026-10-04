/*
 * 真实网络探测：确认依赖的端点是否可达、返回什么。
 * 用法：node tools/probe-live.mjs [vanity]
 * 不需要 API key。
 */
import '../src/lib/core.js';
import '../src/lib/steam-api.js';

const Core = globalThis.SteamOwnerCore;
const Api = globalThis.SteamApi;
const vanity = process.argv[2] || 'gabel';

async function probe(name, fn) {
  const started = Date.now();
  try {
    const out = await fn();
    console.log(`✔ ${name} (${Date.now() - started}ms)`);
    return out;
  } catch (err) {
    console.log(`✖ ${name} (${Date.now() - started}ms) -> ${err.message}`);
    return null;
  }
}

console.log('--- 无需登录、无需 key 的端点 ---');

const xml = await probe(`社区游戏列表 XML (${vanity})`, async () => {
  const res = await fetch(Api.communityGamesUrl(vanity), { headers: { Accept: 'text/xml' } });
  const body = await res.text();
  const lib = Core.fromCommunityGamesXml(body);
  console.log(`   HTTP ${res.status}, ${body.length} 字节, 解析到 ${lib ? lib.appids.length : 0} 款游戏`);
  if (lib && lib.appids.length) console.log(`   示例: ${lib.appids.slice(0, 5).join(', ')}`);
  return lib;
});

await probe('商店 appdetails（取名字）', async () => {
  const name = await Api.getAppName(fetch, 440);
  console.log(`   440 -> ${name}`);
  return name;
});

console.log('--- 需要浏览器登录态（这里预期失败/被重定向） ---');
await probe('dynamicstore/userdata（无 cookie 时应失败）', async () => {
  const res = await fetch(Api.STORE_ROOT + '/dynamicstore/userdata/', { headers: { Accept: 'application/json' } });
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* 登录页 HTML */ }
  console.log(`   HTTP ${res.status}, JSON=${!!parsed}, 首段=${JSON.stringify(body.slice(0, 80))}`);
  return parsed;
});

await probe('Web API GetOwnedGames（无 key 应 4xx）', async () => {
  const res = await fetch(Api.API_ROOT + '/IPlayerService/GetOwnedGames/v1/?steamid=76561197960287930');
  console.log(`   HTTP ${res.status}`);
  return res.status;
});

console.log('\n结论：', xml ? '✔ 无 key 路径可用，可做端到端验证' : '✖ 无 key 路径不可达，只能靠浏览器会话导入');
