/*
 * 对 api.steampowered.com 的**真实**探测：确认 API key 那条同步链路的错误处理
 * 和真实服务的行为一致（这台机器能连 api，但连不上 store/community）。
 *
 * 用法：node tools/probe-api.mjs [你的APIkey]
 *   不带 key：验证"key 无效"这条路径
 *   带 key  ：额外验证 GetOwnedGames 的真实返回（会打印游戏数与前几个 appid）
 */
import '../src/lib/core.js';
import '../src/lib/steam-api.js';

const Api = globalThis.SteamApi;
const Core = globalThis.SteamOwnerCore;
const key = process.argv[2] || 'INVALID_KEY_FOR_PROBE';
const steamId = '76561197960287930'; // 已知存在的公开账号（Gabe），仅用于探测接口行为

function line(name, text) {
  console.log((text.ok ? '[OK]   ' : '[FAIL] ') + name + '：' + text.message);
}

console.log('探测目标：api.steampowered.com（真实请求）');
console.log('key：' + (key === 'INVALID_KEY_FOR_PROBE' ? '(故意用无效 key，验证错误处理)' : '(使用你提供的 key)'));
console.log('');

// 1. 无效 key / 权限错误 -> 必须变成一句人能看懂的话，而不是抛原始 JSON
try {
  const lib = await Api.getOwnedGames(fetch, 'INVALID_KEY_FOR_PROBE', steamId);
  line('无效 key 的处理', {
    ok: false,
    message: '竟然成功了？返回 ' + lib.appids.length + ' 款（说明这个端点不校验 key，需要重新评估）',
  });
} catch (err) {
  const good = /API key 无效或无权限|请求过于频繁|HTTP 4\d\d/.test(err.message);
  line('无效 key 的处理', { ok: good, message: err.message });
}

// 2. ResolveVanityURL 需要 key
try {
  await Api.resolveVanity(fetch, 'INVALID_KEY_FOR_PROBE', 'gabel');
  line('ResolveVanityURL 无效 key', { ok: false, message: '竟然成功了？' });
} catch (err) {
  line('ResolveVanityURL 无效 key', { ok: /HTTP 4\d\d|无效|找不到/.test(err.message), message: err.message });
}

// 3. 带真 key 时：看 GetOwnedGames 的真实返回
if (key !== 'INVALID_KEY_FOR_PROBE') {
  try {
    const lib = await Api.getOwnedGames(fetch, key, steamId);
    line('GetOwnedGames（真实 key）', {
      ok: !lib.privateProfile,
      message: lib.privateProfile
        ? '返回为空 -> 代码会判定为"档案未公开"（这是预期分支）'
        : lib.appids.length + ' 款，前 5 个：' + lib.appids.slice(0, 5).join(',') + '（' + Core.describeCount(lib) + '）',
    });
  } catch (err) {
    line('GetOwnedGames（真实 key）', { ok: false, message: err.message });
  }
} else {
  console.log('[跳过] GetOwnedGames 成功路径：需要一个真实 API key 才能验证（把 key 作为参数传给我即可）');
}

console.log('\n说明：store.steampowered.com / steamcommunity.com 在本机 DNS 不通，');
console.log('所以"登录态导入"和"社区公开档案"两条路无法在这里做真实端到端验证。');
