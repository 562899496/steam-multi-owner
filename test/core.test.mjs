/*
 * 单元测试：核心纯逻辑 + API 层（注入假 fetch）。
 * 运行：node --test test/   或   node test/core.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/lib/core.js';
import '../src/lib/steam-api.js';

const Core = globalThis.SteamOwnerCore;
const Api = globalThis.SteamApi;

/* ----------------------------- parseAppId ----------------------------- */

test('parseAppId 支持纯数字 / store 链接 / 各种尾巴', () => {
  assert.equal(Core.parseAppId('440'), 440);
  assert.equal(Core.parseAppId(' 730 '), 730);
  assert.equal(Core.parseAppId('https://store.steampowered.com/app/1245620/ELDEN_RING/'), 1245620);
  assert.equal(Core.parseAppId('https://store.steampowered.com/app/1245620'), 1245620);
  assert.equal(Core.parseAppId('https://store.steampowered.com/app/1245620/?snr=1_5_9__205'), 1245620);
  assert.equal(Core.parseAppId('steam://store/1245620'), 1245620);
  assert.equal(Core.parseAppId('app/570'), 570);
  assert.equal(Core.parseAppId('https://store.steampowered.com/wishlist/'), null);
  assert.equal(Core.parseAppId(''), null);
  assert.equal(Core.parseAppId(null), null);
  assert.equal(Core.parseAppId('0'), null);
});

/* --------------------------- parseAccountKey -------------------------- */

test('parseAccountKey 支持 64 位 ID / profile 链接 / 自定义 ID', () => {
  assert.deepEqual(Core.parseAccountKey('76561197960287930'), { steamId64: '76561197960287930' });
  assert.deepEqual(Core.parseAccountKey('https://steamcommunity.com/profiles/76561197960287930/'), {
    steamId64: '76561197960287930',
  });
  assert.deepEqual(Core.parseAccountKey('https://steamcommunity.com/id/gabel/'), { vanity: 'gabel' });
  assert.deepEqual(Core.parseAccountKey('gabel'), { vanity: 'gabel' });
  assert.equal(Core.parseAccountKey('空间 不合法'), null);
});

/* ------------------------- 数据源 -> 统一形状 ------------------------- */

test('fromGetOwnedGames 解析正常响应', () => {
  const lib = Core.fromGetOwnedGames({
    response: { game_count: 2, games: [{ appid: 440, name: 'Team Fortress 2' }, { appid: 570, name: 'Dota 2' }] },
  });
  assert.deepEqual(lib.appids, [440, 570]);
  assert.equal(lib.names[570], 'Dota 2');
  assert.equal(lib.gameCount, 2);
  assert.equal(lib.empty, false);
});

test('fromGetOwnedGames 空响应视为隐私受限', () => {
  const lib = Core.fromGetOwnedGames({ response: {} });
  assert.deepEqual(lib.appids, []);
  assert.equal(lib.empty, true);
});

test('fromDynamicStore 解析当前登录会话', () => {
  const lib = Core.fromDynamicStore({ steamid: '76561197960287930', rgOwnedApps: [440, 570, 0], rgWishlist: [1245620] });
  assert.deepEqual(lib.appids, [440, 570]);
  assert.deepEqual(lib.wishlist, [1245620]);
  assert.equal(lib.steamId64, '76561197960287930');
  assert.equal(Core.fromDynamicStore({ nope: 1 }), null);
});

test('fromCommunityGamesXml 解析 XML 并还原实体', () => {
  const xml = `<?xml version="1.0"?><gamesList>
    <games>
      <game><appID>440</appID><name><![CDATA[Team Fortress 2]]></name></game>
      <game><appID>1245620</appID><name>ELDEN RING &amp; co</name></game>
    </games></gamesList>`;
  const lib = Core.fromCommunityGamesXml(xml);
  assert.deepEqual(lib.appids, [440, 1245620]);
  assert.equal(lib.names[440], 'Team Fortress 2');
  assert.equal(lib.names[1245620], 'ELDEN RING & co');
  assert.equal(Core.fromCommunityGamesXml('<html>login</html>'), null);
});

test('fromLicensesHtml 抽取 appid 且拒绝未登录页', () => {
  const html = '<html>g_steamID = "76561197960287930";' + 'x'.repeat(220) +
    '<a href="https://store.steampowered.com/app/440/">TF2</a><a href="/app/570/">Dota</a><a href="/app/440/">dup</a></html>';
  const lib = Core.fromLicensesHtml(html);
  assert.deepEqual(lib.appids, [440, 570]);
  assert.equal(Core.fromLicensesHtml('<html>g_steamID = false;' + 'x'.repeat(220) + '</html>'), null);
});

/* ------------------------------- 索引 -------------------------------- */

const accounts = [
  { id: 'main', label: '大号', steamId64: '76561197960287930' },
  { id: 'alt', label: '小号', vanity: 'my-alt' },
  { id: 'cn', label: '国区号' },
];
const libraries = [
  { accountId: 'main', label: '大号', appids: [440, 570, 1245620] },
  { accountId: 'alt', label: '小号', appids: [570, 1091500] },
  { accountId: 'cn', label: '国区号', appids: [440, 570] },
];

test('buildIndex 合并多账号库并去重', () => {
  const index = Core.buildIndex(libraries, '2024-01-01T00:00:00.000Z');
  assert.equal(index.appCount, 4);
  assert.deepEqual(index.owners[570].sort(), ['alt', 'cn', 'main']);
  assert.deepEqual(index.owners[440].sort(), ['cn', 'main']);
  assert.equal(index.perAccount.alt.appCount, 2);
  assert.equal(index.builtAt, '2024-01-01T00:00:00.000Z');
});

test('queryOwnership 还原账号可读信息', () => {
  const index = Core.buildIndex(libraries);
  const r = Core.queryOwnership(index, '570', accounts);
  assert.equal(r.owned, true);
  assert.deepEqual(r.owners.map((o) => o.label), ['大号', '小号', '国区号']);
  const none = Core.queryOwnership(index, 999999, accounts);
  assert.equal(none.owned, false);
  assert.equal(Core.describeOwnership(none), '无人拥有');
});

test('ownedByOthers 区分「当前账号已有」和「只有别的账号有」', () => {
  const index = Core.buildIndex(libraries);
  const a = Core.ownedByOthers(index, 1091500, accounts, 'main');
  assert.equal(a.ownedByCurrent, false);
  assert.equal(a.ownedByOtherOnly, true);
  assert.deepEqual(a.others.map((o) => o.label), ['小号']);
  const b = Core.ownedByOthers(index, 570, accounts, 'main');
  assert.equal(b.ownedByCurrent, true);
  assert.equal(b.ownedByOtherOnly, false);
  assert.equal(b.others.length, 2);
  const c = Core.ownedByOthers(index, 999999, accounts, 'main');
  assert.equal(c.owned, false);
});

test('queryMany 批量查询并跳过非法 id', () => {
  const index = Core.buildIndex(libraries);
  const out = Core.queryMany(index, [440, 440, 0, '1091500'], accounts);
  assert.equal(Object.keys(out).length, 2);
  assert.equal(out[440].ownerCount, 2);
  assert.equal(out[1091500].ownerCount, 1);
});

test('makeAccountId 生成稳定且不冲突的 id', () => {
  assert.equal(Core.makeAccountId('My Main Account'), 'my-main-account');
  assert.equal(Core.makeAccountId('main', [{ id: 'main' }]), 'main-2');
  assert.equal(Core.makeAccountId('', []), 'account');
});

test('dedupeAccounts 按 steamId64 / vanity 去重', () => {
  const out = Core.dedupeAccounts([
    { id: 'a', steamId64: '76561197960287930' },
    { id: 'b', steamId64: '76561197960287930' },
    { id: 'c', vanity: 'Gabel' },
    { id: 'd', vanity: 'gabel' },
    { id: 'e' },
  ]);
  assert.deepEqual(out.map((x) => x.id), ['a', 'c', 'e']);
});

test('summarize 汇总已同步账号', () => {
  const index = Core.buildIndex(libraries);
  const s = Core.summarize(index, accounts);
  assert.equal(s.accountCount, 3);
  assert.equal(s.syncedCount, 3);
  assert.equal(s.uniqueAppCount, 4);
  assert.equal(s.totalGames, 7);
});

test('decideBadge：其他账号拥有 -> 警告别重复买', () => {
  const index = Core.buildIndex(libraries);
  const detail = Core.ownedByOthers(index, 1091500, accounts, 'main');
  const badge = Core.decideBadge(detail, { accountCount: 3, syncedCount: 3 });
  assert.equal(badge.tone, 'owned-other');
  assert.equal(badge.warn, true);
  assert.match(badge.short, /小号/);
  assert.match(badge.long, /不用重复购买/);
  assert.equal(badge.incomplete, false);
});

test('decideBadge：当前账号拥有 -> 不警告', () => {
  const index = Core.buildIndex(libraries);
  const detail = Core.ownedByOthers(index, 1245620, accounts, 'main'); // 只有大号有
  const badge = Core.decideBadge(detail, { accountCount: 3, syncedCount: 3 });
  assert.equal(badge.tone, 'owned-current');
  assert.equal(badge.warn, false);
});

test('decideBadge：当前账号和其他账号都有 -> owned-both', () => {
  const index = Core.buildIndex(libraries);
  const detail = Core.ownedByOthers(index, 440, accounts, 'main'); // 大号 + 国区号
  const badge = Core.decideBadge(detail, { accountCount: 3, syncedCount: 3 });
  assert.equal(badge.tone, 'owned-both');
  assert.equal(badge.warn, false);
  assert.match(badge.long, /1个其他账号/);
});

test('decideBadge：谁都没有 -> none，且措辞不说"没有"以外的结论', () => {
  const index = Core.buildIndex(libraries);
  const detail = Core.ownedByOthers(index, 999999, accounts, 'main');
  const badge = Core.decideBadge(detail, { accountCount: 3, syncedCount: 3 });
  assert.equal(badge.tone, 'none');
  assert.equal(badge.incomplete, false);
  assert.match(badge.long, /3 个账号都没有/);
});

test('decideBadge：一个都没同步 -> unknown，绝不能给出"没有"的结论', () => {
  const empty = Core.buildIndex([]);
  const detail = Core.ownedByOthers(empty, 440, accounts, 'main');
  const badge = Core.decideBadge(detail, { accountCount: 3, syncedCount: 0 });
  assert.equal(badge.tone, 'unknown');
  assert.equal(badge.incomplete, true);
  assert.match(badge.long, /无法判断/);
  assert.doesNotMatch(badge.long, /都没有这款游戏/);
});

test('decideBadge：部分账号未同步 -> 必须声明结论不完整', () => {
  const index = Core.buildIndex([libraries[0]]); // 只同步了大号
  const detail = Core.ownedByOthers(index, 1091500, accounts, 'main');
  const badge = Core.decideBadge(detail, { accountCount: 3, syncedCount: 1 });
  assert.equal(badge.tone, 'none');
  assert.equal(badge.incomplete, true);
  assert.match(badge.long, /已同步的 1 个账号都没有/);
  assert.match(badge.long, /另有 2 个账号未同步/);
});

test('decideBadge：已拥有的结论也要带上"未同步"的提醒', () => {
  const index = Core.buildIndex(libraries);
  const detail = Core.ownedByOthers(index, 1091500, accounts, 'main');
  const badge = Core.decideBadge(detail, { accountCount: 4, syncedCount: 3 });
  assert.equal(badge.tone, 'owned-other');
  assert.equal(badge.incomplete, true);
  assert.match(badge.long, /另有 1 个账号未同步/);
});

/* ------------------- 数量的口径：以"游戏数"为主 ------------------- */

test('describeCount：游戏数优先，DLC 等只做补充说明', () => {
  // 纯游戏列表
  assert.equal(Core.describeCount({ appids: [1, 2], kind: 'games' }), '2 款游戏');
  // 305 个条目里识别出 71 款游戏 —— 真机上出过的问题：显示成 305 会被当成"游戏数"
  const big = {
    appids: Array.from({ length: 305 }, (_, i) => i + 1),
    gameAppids: Array.from({ length: 71 }, (_, i) => i + 1),
  };
  assert.equal(Core.describeCount(big), '71 款游戏（另 234 项 DLC/工具）');
  // 还没识别出游戏数时，照实说，不许冒充"款游戏"
  const unknown = { appids: Array.from({ length: 305 }, (_, i) => i + 1), kind: 'apps' };
  assert.equal(Core.describeCount(unknown), '305 项（含 DLC/工具，游戏数待识别）');
  assert.doesNotMatch(Core.describeCount(unknown), /款游戏/);
  assert.equal(Core.describeCount(null), '未同步');
  // 条目数与游戏数相同：不啰嗦
  assert.equal(Core.describeCount({ appids: [1, 2], gameAppids: [1, 2] }), '2 款游戏');
});

test('buildIndex 分别统计"条目"和"游戏"', () => {
  const index = Core.buildIndex([
    { accountId: 'a', label: '大号', appids: [1, 2, 3, 4], gameAppids: [1, 2], kind: 'mixed' },
    { accountId: 'b', label: '小号', appids: [2, 5], kind: 'games' },
  ]);
  assert.equal(index.appCount, 5, 'AppID 并集应为 5');
  assert.equal(index.perAccount.a.appCount, 4);
  assert.equal(index.perAccount.a.gameCount, 2);
  assert.equal(index.perAccount.b.gameCount, 2, 'kind=games 时全部算游戏');
  assert.equal(index.gameAppCount, 3, '并集里的游戏应为 {1,2,5} = 3');
  assert.equal(index.gameCountComplete, true);
});

test('有账号没识别出游戏数时 gameCountComplete 为 false，且只统计已知部分', () => {
  const index = Core.buildIndex([
    { accountId: 'a', appids: [1, 2], gameAppids: [1, 2] },
    { accountId: 'b', appids: [3, 4], kind: 'apps' },
  ]);
  assert.equal(index.gameCountComplete, false);
  assert.equal(index.perAccount.b.gameCount, null);
  const s = Core.summarize(index, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(s.unknownGameCount, 1);
  assert.equal(s.totalRealGames, 2, '只统计已知的那部分');
  assert.equal(s.totalGames, 4, '条目总数仍是 4');
});

test('describeSummary / describeIndex 用游戏数说话', () => {
  const index = Core.buildIndex([
    { accountId: 'a', appids: [1, 2, 3], gameAppids: [1, 2] },
    { accountId: 'b', appids: [3, 4], gameAppids: [3] },
  ]);
  const summary = Core.summarize(index, [{ id: 'a' }, { id: 'b' }]);
  const text = Core.describeSummary(summary);
  assert.match(text, /2 个账号（已同步 2）/);
  assert.match(text, /索引覆盖 4 个 AppID/);
  assert.match(text, /其中 3 款游戏/);
  assert.match(Core.describeIndex(index), /4 个 AppID，其中 3 款游戏/);
});

test('describeAge 把快照时间说成人话（快照风险就是过期）', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  assert.equal(Core.describeAge('2026-01-10T11:59:40Z', now), '刚刚');
  assert.equal(Core.describeAge('2026-01-10T11:30:00Z', now), '30 分钟前');
  assert.equal(Core.describeAge('2026-01-10T06:00:00Z', now), '6 小时前');
  assert.equal(Core.describeAge('2026-01-07T12:00:00Z', now), '3 天前');
  assert.equal(Core.describeAge('2025-11-10T12:00:00Z', now), '2 个月前');
  assert.equal(Core.describeAge(null, now), '未知时间');
  assert.equal(Core.describeAge('不是时间', now), '未知时间');
  // 时钟偏差（快照时间在未来）不能显示成负数
  assert.equal(Core.describeAge('2026-01-10T13:00:00Z', now), '刚刚');
});

test('getOwnedGamesForApp：实时查单个 appid 的三种结果', async () => {
  // 拥有
  const yes = fakeFetch([['GetOwnedGames', {
    body: JSON.stringify({ response: { game_count: 1, games: [{ appid: 440, playtime_forever: 10 }] } }),
  }]]);
  const r1 = await Api.getOwnedGamesForApp(yes, 'KEY', '76561197960287930', 440);
  assert.equal(r1.owns, true);
  assert.equal(r1.uncertain, false);
  assert.match(yes.calls[0].url, /appids_filter\[0\]=440/, '必须只查这一个 appid');

  // 明确没有（返回了数组但不含它）
  const no = fakeFetch([['GetOwnedGames', {
    body: JSON.stringify({ response: { game_count: 0, games: [] } }),
  }]]);
  const r2 = await Api.getOwnedGamesForApp(no, 'KEY', '76561197960287930', 440);
  assert.equal(r2.owns, false);
  assert.equal(r2.uncertain, false);

  // 空 response / 令牌失效 -> 必须"不下结论"，绝不能当成"没有"
  const empty = fakeFetch([['GetOwnedGames', { body: JSON.stringify({ response: {} }) }]]);
  const r3 = await Api.getOwnedGamesForApp(empty, 'KEY', '76561197960287930', 440);
  assert.equal(r3.owns, null);
  assert.equal(r3.uncertain, true);

  const bad = fakeFetch([['GetOwnedGames', { status: 401, body: '{}' }]]);
  const r4 = await Api.getOwnedGamesForApp(bad, 'BAD', '76561197960287930', 440);
  assert.equal(r4.owns, null);
  assert.match(r4.reason, /无效或已过期/);

  await assert.rejects(() => Api.getOwnedGamesForApp(yes, 'KEY', '76561197960287930', 'not-an-appid'), /不是有效的 AppID/);
});

/* ------------------------------ API 层 ------------------------------- */

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      if (url.includes(match)) {
        const out = typeof handler === 'function' ? handler(url, init) : handler;
        return {
          ok: out.status ? out.status < 400 : true,
          status: out.status || 200,
          text: async () => out.body,
          json: async () => JSON.parse(out.body),
        };
      }
    }
    throw new Error('unexpected url ' + url);
  };
  impl.calls = calls;
  return impl;
}

test('resolveVanity 走 ResolveVanityURL 并校验 success', async () => {
  const f = fakeFetch([['ResolveVanityURL', { body: JSON.stringify({ response: { success: 1, steamid: '76561197960287930' } }) }]]);
  assert.equal(await Api.resolveVanity(f, 'KEY', 'gabel'), '76561197960287930');
  const bad = fakeFetch([['ResolveVanityURL', { body: JSON.stringify({ response: { success: 42, message: 'No match' } }) }]]);
  await assert.rejects(() => Api.resolveVanity(bad, 'KEY', 'nope'), /找不到该自定义 ID/);
});

test('getOwnedGames 识别隐私受限 / 正常返回', async () => {
  const priv = fakeFetch([['GetOwnedGames', { body: JSON.stringify({ response: {} }) }]]);
  const lib = await Api.getOwnedGames(priv, 'KEY', '76561197960287930');
  assert.equal(lib.privateProfile, true);
  assert.match(lib.note, /游戏详情/);

  const ok = fakeFetch([['GetOwnedGames', { body: JSON.stringify({ response: { game_count: 1, games: [{ appid: 440, name: 'TF2' }] } }) }]]);
  const lib2 = await Api.getOwnedGames(ok, 'KEY', '76561197960287930');
  assert.equal(lib2.privateProfile, false);
  assert.deepEqual(lib2.appids, [440]);
});

test('getCommunityGames 解析 XML，私密档案报错', async () => {
  const xml = '<gamesList><games><game><appID>440</appID><name>TF2</name></game></games></gamesList>';
  const f = fakeFetch([['/games?tab=all&xml=1', { body: xml }]]);
  const lib = await Api.getCommunityGames(f, 'gabel');
  assert.deepEqual(lib.appids, [440]);
  assert.match(f.calls[0].url, /steamcommunity\.com\/id\/gabel\/games/);

  const priv = fakeFetch([['/games?tab=all&xml=1', { body: '<html>This profile is private</html>' }]]);
  await assert.rejects(() => Api.getCommunityGames(priv, 'gabel'), /私密/);
});

test('fetchLibrary 回退链：API 私密 -> 社区 XML 成功', async () => {
  const f = fakeFetch([
    ['GetOwnedGames', { body: JSON.stringify({ response: {} }) }],
    ['/games?tab=all&xml=1', { body: '<gamesList><games><game><appID>570</appID><name>Dota</name></game></games></gamesList>' }],
  ]);
  const lib = await Api.fetchLibrary(f, { steamId64: '76561197960287930', apiKey: 'KEY' }, {});
  assert.equal(lib.method, 'community-xml');
  assert.deepEqual(lib.appids, [570]);
});

test('fetchLibrary 会话导入不需要 key', async () => {
  const f = fakeFetch([['dynamicstore/userdata', { body: JSON.stringify({ rgOwnedApps: [440, 570] }) }]]);
  const lib = await Api.fetchLibrary(f, { vanity: 'me' }, { useSession: true });
  assert.equal(lib.method, 'session');
  assert.deepEqual(lib.appids, [440, 570]);
});

test('fetchLibrary 失败时给出可读的原因链', async () => {
  const f = fakeFetch([['GetOwnedGames', { body: JSON.stringify({ response: {} }) }]]);
  await assert.rejects(
    () => Api.fetchLibrary(f, { vanity: 'me', apiKey: 'KEY' }, {}),
    (err) => {
      assert.match(err.message, /抓取失败/);
      assert.ok(err.attempts.length >= 2);
      return true;
    },
  );
});

test('getAppName 解析商店 appdetails', async () => {
  const f = fakeFetch([['appdetails', { body: JSON.stringify({ 440: { success: true, data: { name: 'Team Fortress 2' } } }) }]]);
  assert.equal(await Api.getAppName(f, 440), 'Team Fortress 2');
  const miss = fakeFetch([['appdetails', { body: JSON.stringify({ 440: { success: false } }) }]]);
  assert.equal(await Api.getAppName(miss, 440), null);
});

/* -------------- 登录态导入该落到哪条记录（真机上出过的事故） -------------- */

test('pickSessionAccount：有 SteamID 且已有记录 -> 更新那一条', () => {
  const accounts = [
    { id: 'a', label: '大号', steamId64: '76561198000000001', auto: true },
    { id: 'b', label: '小号', steamId64: '76561198000000002', auto: true },
  ];
  const picked = Core.pickSessionAccount(accounts, '76561198000000002');
  assert.equal(picked.account.id, 'b');
  assert.equal(picked.created, false);
  assert.equal(picked.matchedBy, 'steamid');
  assert.equal(picked.unverified, false);
});

test('pickSessionAccount：换另一个号导入时必须新建记录，绝不覆盖已有账号', () => {
  // 事故现场：原来只有一条 auto 记录（大号），导入小号时旧逻辑把它覆盖了，
  // 小号的库被写进"大号"那条记录，面板拿错数据 -> 已拥有的游戏显示成未拥有。
  const accounts = [{ id: 'main', label: '大号', steamId64: '76561198000000001', auto: true }];
  const picked = Core.pickSessionAccount(accounts, '76561198000000042', { label: 'example_login' });
  assert.equal(picked.created, true);
  assert.equal(picked.matchedBy, 'new');
  assert.equal(picked.account.steamId64, '76561198000000042');
  assert.equal(picked.account.label, 'example_login');
  assert.ok(picked.account.id && picked.account.id !== 'main', '新记录 id 不能撞上已有账号');
  assert.equal(accounts.length, 1, '不能就地修改传入的数组');
});

test('pickSessionAccount：读不到 SteamID 时退回更新自动账号，但标记 unverified', () => {
  const accounts = [
    { id: 'manual', label: '手填的号', vanity: 'x' },
    { id: 'auto1', label: '登录态的号', auto: true },
  ];
  const picked = Core.pickSessionAccount(accounts, null);
  assert.equal(picked.account.id, 'auto1');
  assert.equal(picked.matchedBy, 'fallback');
  assert.equal(picked.unverified, true, '必须标记"身份未确认"，界面要据此报警');
});

test('pickSessionAccount：读不到 SteamID 且没有可更新记录时给出新建方案', () => {
  const picked = Core.pickSessionAccount([{ id: 'manual', label: '手填' }], null, { label: '这个号' });
  assert.equal(picked.account, null);
  assert.equal(picked.unverified, true);
});

test('所有商店请求都禁用了 HTTP 缓存（换号后不能吃到上一个号的响应）', async () => {
  const f = fakeFetch([
    ['/account/', { body: STORE_HTML_WITH_SESSION }],
    ['GetOwnedGames', { body: JSON.stringify({ response: { game_count: 1, games: [{ appid: 1, name: 'A' }] } }) }],
    ['dynamicstore/userdata', { body: JSON.stringify({ rgOwnedApps: [1] }) }],
  ]);
  await Api.fetchSessionLibrary(f, { delayMs: 0 });
  assert.ok(f.calls.length >= 3, '应该至少请求了页面、GetOwnedGames、dynamicstore');
  for (const call of f.calls) {
    assert.equal(call.init.cache, 'no-store', '每个请求都要 no-store: ' + call.url);
    assert.ok(/_=\d+/.test(call.url), 'URL 要带 cache-buster: ' + call.url);
  }
});

test('身份未确认时会明确标记，而不是假装数据属于当前账号', async () => {
  const f = fakeFetch([
    ['/account/', { body: '<html>页面里既没有 token 也没有 steamid</html>' }],
    ['dynamicstore/userdata', { body: JSON.stringify({ rgOwnedApps: [440] }) }],
    ['appdetails', { body: JSON.stringify({ 440: { success: true, data: { type: 'game', name: 'TF2' } } }) }],
  ]);
  const lib = await Api.fetchSessionLibrary(f, { delayMs: 0 });
  assert.equal(lib.identity.verified, false, '没读到 SteamID 时 verified 必须是 false');
  assert.equal(lib.steamId64, null);
  assert.match(lib.sourceNote, /无法确认这份快照属于哪个账号/);
});

test('页面里的 SteamID 与数据里的 steamid 冲突时要报出来', async () => {
  const f = fakeFetch([
    ['/account/', { body: STORE_HTML_WITH_SESSION }],
    ['GetOwnedGames', { body: JSON.stringify({ response: { game_count: 1, games: [{ appid: 1 }] } }) }],
    ['dynamicstore/userdata', { body: JSON.stringify({ rgOwnedApps: [1], steamid: '76561198000000099' }) }],
  ]);
  const lib = await Api.fetchSessionLibrary(f, { delayMs: 0 });
  assert.equal(lib.identity.verified, true);
  assert.match(lib.identity.conflict, /不一致/);
  assert.equal(lib.steamId64, '76561198000000001', '以页面里的身份为准');
});

test('communityGamesUrl 支持两种标识', () => {
  assert.match(Api.communityGamesUrl('76561197960287930'), /\/profiles\/76561197960287930\/games/);
  assert.match(Api.communityGamesUrl('gabel'), /\/id\/gabel\/games/);
  assert.equal(Api.communityGamesUrl('!!!'), null);
});

/* ------------------- 登录态导入：拿到准确的"游戏数" ------------------- */

const STORE_HTML_WITH_SESSION = `<html><body>
  <div id="application_config"
    data-store_user_config="{&quot;webapi_token&quot;:&quot;TOKEN_ABC&quot;,&quot;logged_in&quot;:true}"
    data-userinfo="{&quot;logged_in&quot;:true,&quot;steamid&quot;:&quot;76561198000000001&quot;,&quot;persona_name&quot;:&quot;example_alt&quot;}"></div>
</body></html>`;

test('parseSessionContext 能从商店页面里抠出会话 token / steamid / 昵称', () => {
  const ctx = Api.parseSessionContext(STORE_HTML_WITH_SESSION);
  assert.equal(ctx.token, 'TOKEN_ABC');
  assert.equal(ctx.steamId64, '76561198000000001');
  assert.equal(ctx.persona, 'example_alt');

  // 属性名换成连字符写法也要认
  const alt = Api.parseSessionContext(
    '<div data-store-user-config="{&quot;webapi_token&quot;:&quot;T2&quot;}" data-userinfo="{&quot;steamid&quot;:&quot;76561198000000002&quot;}"></div>');
  assert.equal(alt.token, 'T2');
  assert.equal(alt.steamId64, '76561198000000002');

  // 没登录：返回空壳而不是抛错，并留下"三种形态都没命中"的探测信号
  const empty = Api.parseSessionContext('<html>login</html>');
  assert.equal(empty.token, null);
  assert.equal(empty.steamId64, null);
  assert.ok(Array.isArray(empty.signals) && empty.signals.length > 0, '应报告探测信号');
  assert.match(empty.signals.join('；'), /都没命中/);
  assert.equal(Api.parseSessionContext(undefined).token, null);
});

test('parseSessionContext 认得被 HTML 转义过的凭据（真机上很可能就栽在这）', () => {
  // 属性里的 JSON 会被转义成 &quot;...&quot;：只写"普通 JSON"的正则就会整个漏掉
  const html = `<html><body><div id="application_config"
    data-store_user_config="{&quot;webapi_token&quot;:&quot;ESC_TOKEN&quot;}"
    data-userinfo="{&quot;steamid&quot;:&quot;76561198000000042&quot;,&quot;persona_name&quot;:&quot;example_login&quot;}"></div></body></html>`;
  const ctx = Api.parseSessionContext(html);
  assert.equal(ctx.token, 'ESC_TOKEN');
  assert.equal(ctx.steamId64, '76561198000000042');
  assert.equal(ctx.persona, 'example_login');
  assert.match(ctx.signals.join('；'), /webapi_token/);
});

test('fetchSessionLibrary：token 给出准确游戏数，许可证列表补全 DLC 条目', async () => {
  const f = fakeFetch([
    ['/account/', { body: STORE_HTML_WITH_SESSION }],
    ['GetOwnedGames', {
      body: JSON.stringify({
        response: { game_count: 2, games: [{ appid: 440, name: 'Team Fortress 2' }, { appid: 1245620, name: 'ELDEN RING' }] },
      }),
    }],
    // 许可证列表比游戏多两个 DLC —— 真机上 305 vs 71 就是这么来的
    ['dynamicstore/userdata', { body: JSON.stringify({ rgOwnedApps: [440, 1245620, 441, 442] }) }],
  ]);
  const lib = await Api.fetchSessionLibrary(f, { delayMs: 0 });
  assert.equal(lib.method, 'session-api+session');
  assert.equal(lib.kind, 'mixed');
  assert.equal(lib.appids.length, 4, '索引要收全（含 DLC），这样 DLC 拥有情况也能识别');
  assert.deepEqual(lib.gameAppids, [440, 1245620], '游戏数必须来自 GetOwnedGames');
  assert.equal(Core.describeCount(lib), '2 款游戏（另 2 项 DLC/工具）');
  assert.equal(lib.names[440], 'Team Fortress 2');
  assert.match(lib.sourceNote, /GetOwnedGames/);
});

test('fetchSessionLibrary：拿不到 token 时用商店类型分类反推游戏数', async () => {
  const f = fakeFetch([
    ['/account/', { body: '<html>页面里没有 token</html>' }],
    ['dynamicstore/userdata', { body: JSON.stringify({ rgOwnedApps: [440, 1245620, 441, 442] }) }],
    ['appdetails', {
      body: JSON.stringify({
        440: { success: true, data: { type: 'game', name: 'Team Fortress 2' } },
        1245620: { success: true, data: { type: 'game', name: 'ELDEN RING' } },
        441: { success: true, data: { type: 'dlc', name: 'DLC 一号' } },
        442: { success: true, data: { type: 'tool', name: '某个工具' } },
      }),
    }],
  ]);
  const lib = await Api.fetchSessionLibrary(f, { delayMs: 0 });
  assert.equal(lib.method, 'session');
  assert.equal(lib.kind, 'apps');
  assert.deepEqual(lib.gameAppids.slice().sort((a, b) => a - b), [440, 1245620]);
  assert.equal(Core.describeCount(lib), '2 款游戏（另 2 项 DLC/工具）');
  assert.equal(lib.names[441], 'DLC 一号', '顺带把 DLC 名字也收了，方便按名字搜');
});

test('分类失败时不冒充"款游戏"，而是照实说游戏数待识别', async () => {
  const f = fakeFetch([
    ['/account/', { body: '<html>无 token</html>' }],
    ['dynamicstore/userdata', { body: JSON.stringify({ rgOwnedApps: [440, 1245620, 441] }) }],
    ['appdetails', { status: 429, body: '{"ok":false}' }],
  ]);
  const lib = await Api.fetchSessionLibrary(f, { delayMs: 0 });
  assert.equal(lib.gameAppids, undefined);
  assert.equal(lib.classifyFailed, 'requests-failed');
  assert.equal(Core.describeCount(lib), '3 项（含 DLC/工具，游戏数待识别）');
  assert.doesNotMatch(Core.describeCount(lib), /款游戏/);
});

test('条目太多时跳过分类，不去打几百个请求', async () => {
  const many = Array.from({ length: 700 }, (_, i) => i + 1);
  const f = fakeFetch([
    ['/account/', { body: '<html>无 token</html>' }],
    ['dynamicstore/userdata', { body: JSON.stringify({ rgOwnedApps: many }) }],
  ]);
  const lib = await Api.fetchSessionLibrary(f, { delayMs: 0 });
  assert.equal(lib.classifySkipped, 'too-many');
  assert.equal(lib.gameAppids, undefined);
  // 没有任何 appdetails 请求
  assert.ok(!f.calls.some((c) => c.url.includes('appdetails')), '不该发起分类请求');
});

test('classifyAppTypes 逐个查（真机证明批量会 400）并汇总类型与名字', async () => {
  let calls = 0;
  const seen = [];
  const f = async (url) => {
    calls++;
    const id = new URL(url).searchParams.get('appids');
    seen.push(id);
    const body = {};
    body[id] = { success: true, data: { type: Number(id) % 2 === 0 ? 'game' : 'dlc', name: 'App ' + id } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const out = await Api.classifyAppTypes(f, [2, 3, 4], { delayMs: 0 });
  assert.equal(calls, 3, '每个 appid 一次请求');
  assert.deepEqual(seen.sort(), ['2', '3', '4'], '每次请求只能带一个 appid（逗号批量会被商店拒绝）');
  assert.equal(out.requested, 3);
  assert.equal(out.classified, 3);
  assert.equal(out.types['2'], 'game');
  assert.equal(out.types['3'], 'dlc');
  assert.equal(out.names['3'], 'App 3');
});

test('分类不完整时绝不用它当游戏数（少报和虚报一样糟）', async () => {
  // 只成功分类了一部分 -> 必须放弃给游戏数，照实说"待识别"
  let n = 0;
  const f = async (url) => {
    n++;
    const id = new URL(url).searchParams.get('appids');
    if (n === 1) throw new Error('网络抖动');
    const body = {};
    body[id] = { success: true, data: { type: 'game', name: 'App ' + id } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const lib = { appids: [1, 2, 3], kind: 'apps', names: {} };
  const out = await Api.refineLibraryTypes(f, lib, { delayMs: 0 });
  assert.equal(out.classifyFailed, 'partial');
  assert.equal(out.gameAppids, undefined, '分类不完整时不许写 gameAppids');
  assert.equal(Core.describeCount(out), '3 项（含 DLC/工具，游戏数待识别）');
});

test('未登录时必须直接报错，绝不能建出"0 款游戏"的空账号（真机验证过 dynamicstore 会 200+空数组）', async () => {
  const f = fakeFetch([
    ['/account/', { body: '<div id="application_config" data-userinfo="{&quot;logged_in&quot;:false,&quot;country_code&quot;:&quot;HK&quot;}"></div>' }],
    ['dynamicstore/userdata', { body: JSON.stringify({ rgWishlist: [], rgOwnedPackages: [], rgOwnedApps: [] }) }],
  ]);
  await assert.rejects(
    () => Api.fetchSessionLibrary(f, { delayMs: 0 }),
    /没有登录 Steam/,
  );
});

test('社区游戏列表接口改为要求登录时，给出明确指引而不是"档案未公开"', async () => {
  const f = fakeFetch([['/games?tab=all&xml=1', { status: 302, body: 'Found. Redirecting to /login/' }]]);
  await assert.rejects(() => Api.getCommunityGames(f, 'gabel'), /要求登录 Steam/);
});

test('getAppUserDetails：只用 cookie 的实时接口，未登录时不下结论', async () => {
  const anon = fakeFetch([['appuserdetails', { body: JSON.stringify({ 440: { success: false } }) }]]);
  const r1 = await Api.getAppUserDetails(anon, 440);
  assert.equal(r1.owns, null);
  assert.equal(r1.uncertain, true);
  assert.match(r1.reason, /没登录|success=false/);

  const own = fakeFetch([['appuserdetails', { body: JSON.stringify({ 440: { success: true, data: { owns: true } } }) }]]);
  const r2 = await Api.getAppUserDetails(own, 440);
  assert.equal(r2.owns, true);
  assert.equal(r2.uncertain, false);

  const notOwn = fakeFetch([['appuserdetails', { body: JSON.stringify({ 440: { success: true, data: { owns: false } } }) }]]);
  assert.equal((await Api.getAppUserDetails(notOwn, 440)).owns, false);
});

test('mergeLibraries 用并集覆盖条目、用游戏列表定游戏数', () => {
  const merged = Api.mergeLibraries(
    { appids: [1, 2], names: { 1: 'A', 2: 'B' } },
    { appids: [2, 3, 4], wishlist: [9] },
  );
  assert.deepEqual(merged.appids, [1, 2, 3, 4]);
  assert.deepEqual(merged.gameAppids, [1, 2]);
  assert.equal(merged.entryCount, 4);
  assert.equal(merged.extraCount, 2);
  assert.deepEqual(merged.wishlist, [9]);
});
