/*
 * 用真实端点复验这一轮的修复（之前那些假设现在可以逐条对账）。
 * 用法：node tools/probe-live3.mjs
 */
import '../src/lib/core.js';
import '../src/lib/steam-api.js';

const Api = globalThis.SteamApi;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const wrap = (u, o) => fetch(u, Object.assign({ headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } }, o || {}));

const ok = (pass, text) => console.log((pass ? '[OK]   ' : '[!!]   ') + text);

// 1) 未登录导入：必须明确报错，而不是建出"0 款游戏"的空账号
try {
  const lib = await Api.fetchSessionLibrary(wrap, {});
  ok(false, '未登录导入应该报错，实际却返回了 ' + lib.appids.length + ' 项');
} catch (e) {
  ok(/没有登录 Steam/.test(e.message), '未登录导入报错：' + e.message);
}

// 2) 社区游戏列表：真机已改为要求登录，提示必须说清
try {
  await Api.getCommunityGames(wrap, 'gabel');
  ok(false, '社区 XML 应该失败（该接口现在要求登录）');
} catch (e) {
  ok(/要求登录 Steam/.test(e.message), '社区 XML 报错：' + e.message.slice(0, 100));
}

// 3) appuserdetails（未登录）：必须"不下结论"，不能当成"没有"
const r = await Api.getAppUserDetails(wrap, 440);
ok(r.owns === null && r.uncertain === true, 'appuserdetails 未登录 -> owns=null，原因：' + r.reason);

// 4) 逐个分类（真机证明逗号批量会 400）
//    228980 这类"商店不公开"的条目会 success:false -> 归入 unresolved（既不是游戏也不算失败）
const c = await Api.classifyAppTypes(wrap, [440, 570, 228980], { delayMs: 250 });
ok(c.classified + c.unresolved.length === 3,
  '逐个分类 3 个 appid -> 分类成功 ' + JSON.stringify(c.types) +
  '，商店无公开信息 ' + c.unresolved.length + ' 个，请求失败 ' + c.failures + ' 个');

// 5) 商店页面解析：未登录时必须给出 logged_in=false
const ctx = await Api.getSessionContext(wrap);
ok(ctx.loggedIn === false, '未登录页面解析 -> loggedIn=' + ctx.loggedIn + '，signals=' + JSON.stringify(ctx.signals).slice(0, 200));

// 6) GetOwnedGames 单个 appid（无有效令牌）：必须"不下结论"
const live = await Api.getOwnedGamesForApp(wrap, 'INVALID', '76561197960287930', 440);
ok(live.owns === null && live.uncertain === true, 'GetOwnedGames 无效令牌 -> owns=null，原因：' + live.reason);
