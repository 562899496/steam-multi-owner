/*
 * DSH 插件的独立测试：用 module.registerHooks 把 DSH 的两个运行时依赖换成桩，
 * 然后在 Node 里真实调用 apply() 注册出来的工具。
 * 这样不用把插件装进 profile 也能验证它的业务逻辑。
 *
 * 运行：node --test test/dsh-plugin.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ---------------- 把 DSH 运行时依赖替换成桩 ---------------- */

const STUB_TOOLS = `
export function defineTool(definition) { return definition; }
`;

const STUB_SCHEMASTERY = `
function chain() {
  const api = {
    default: () => api,
    description: () => api,
    required: () => api,
    optional: () => api,
  };
  return api;
}
const z = { object: () => chain(), string: () => chain(), boolean: () => chain(), number: () => chain() };
export default z;
`;

const stubDir = await mkdtemp(join(tmpdir(), 'smo-dsh-stub-'));
await writeFile(join(stubDir, 'dsh-tools.mjs'), STUB_TOOLS, 'utf8');
await writeFile(join(stubDir, 'schemastery.mjs'), STUB_SCHEMASTERY, 'utf8');
const stubBase = 'file:///' + stubDir.replace(/\\/g, '/') + '/';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: new URL('dsh-tools.mjs', stubBase).href, shortCircuit: true };
    }
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: new URL('schemastery.mjs', stubBase).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const plugin = await import('../dsh/lib/index.js');

/* ---------------- 假的 ctx：收集注册的工具与 effect ---------------- */

function makeCtx() {
  const tools = new Map();
  const effects = [];
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    // Cordis 的 ctx.effect：立即执行并记录返回的清理函数
    effect(callback) {
      const disposer = callback();
      effects.push(disposer);
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    disposeAll() {
      for (const disposer of effects.splice(0)) {
        if (typeof disposer === 'function') disposer();
      }
    },
    effects,
    registered: tools,
  };
}

const FAKE_EXPORT = {
  exportedAt: '2024-01-02T00:00:00.000Z',
  version: '1.0.0',
  accounts: [
    { id: 'main', label: '大号', steamId64: '76561198000000001' },
    { id: 'alt', label: '小号', vanity: 'my-alt' },
    { id: 'cn', label: '国区号' },
  ],
  libraries: {
    main: { appids: [440, 620], gameAppids: [440, 620], kind: 'games', names: { 440: 'Team Fortress 2', 620: 'Portal 2' }, method: 'api' },
    alt: { appids: [570, 1245620], gameAppids: [570, 1245620], kind: 'games', names: { 1245620: 'ELDEN RING', 570: 'Dota 2' }, method: 'session' },
    cn: { appids: [440], gameAppids: [440], kind: 'games', names: {}, method: 'community-xml' },
  },
  settings: { currentAccountId: 'main' },
};

async function setup(configPatch = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'smo-dsh-'));
  const dataFile = join(dir, 'store.json');
  const ctx = makeCtx();
  plugin.apply(ctx, Object.assign({ apiKey: '', dataFile, defaultCurrentAccount: '' }, configPatch));
  return { ctx, dataFile, dir };
}

/* ---------------- 测试 ---------------- */

test('插件导出 DSH 需要的 name / inject / Config / apply', () => {
  assert.equal(plugin.name, 'steam-multi-owner');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.ok(plugin.Config, '缺少 Config');
  assert.equal(typeof plugin.apply, 'function');
});

test('apply 注册了 3 个工具，参数 schema 合法', () => {
  const ctx = makeCtx();
  plugin.apply(ctx, { apiKey: '', dataFile: join(tmpdir(), 'nope.json'), defaultCurrentAccount: '' });
  assert.deepEqual([...ctx.registered.keys()].sort(),
    ['steam_owner_accounts', 'steam_owner_check', 'steam_owner_data']);
  for (const [toolName, def] of ctx.registered) {
    assert.equal(typeof def.execute, 'function', toolName + ' 缺少 execute');
    assert.ok(def.description && def.description.length > 10, toolName + ' 描述太短');
    assert.ok(def.parameters && typeof def.parameters === 'object', toolName + ' 缺少 parameters');
    assert.ok(def.output && def.output.schema, toolName + ' 缺少 output.schema');
    assert.equal(typeof def.output.render, 'function', toolName + ' 缺少 output.render');
  }
});

test('没有账号时给出可执行的下一步而不是崩溃', async () => {
  const { ctx } = await setup();
  const res = await ctx.registered.get('steam_owner_check').execute({ query: '1245620' });
  assert.equal(res.found, false);
  assert.match(res.verdict, /还没有配置任何 Steam 账号/);
  assert.match(res.verdict, /steam_owner_data/);
});

test('导入扩展导出的 JSON 后能正确回答跨账号问题', async () => {
  const { ctx, dataFile } = await setup();
  const imp = await ctx.registered.get('steam_owner_data').execute({
    action: 'import', json: JSON.stringify(FAKE_EXPORT),
  });
  assert.equal(imp.accountCount, 3);
  assert.equal(imp.syncedCount, 3);
  assert.equal(imp.appCount, 4);

  // 数据真的落盘了
  const onDisk = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.equal(onDisk.accounts.length, 3);
  assert.equal(onDisk.source, 'chrome-extension-export');

  const check = ctx.registered.get('steam_owner_check');
  const other = await check.execute({ query: '1245620' });
  assert.equal(other.found, true);
  assert.equal(other.name, 'ELDEN RING');
  assert.equal(other.owned, true);
  assert.equal(other.ownedByCurrent, false);
  assert.equal(other.ownedByOtherOnly, true);
  assert.deepEqual(other.others, ['小号']);
  assert.equal(other.needsPurchase, false, '别的账号已经有了，不该再买');
  assert.match(other.verdict, /不用重复购买/);
  assert.match(other.report, /小号：已拥有/);
  assert.match(other.report, /大号：未拥有 ←当前登录/);

  // 当前账号自己有的
  const mine = await check.execute({ query: '620' });
  assert.equal(mine.ownedByCurrent, true);
  assert.equal(mine.ownedByOtherOnly, false);

  // 两个账号都有
  const both = await check.execute({ query: '440' });
  assert.equal(both.ownedByCurrent, true);
  assert.deepEqual(both.others, ['国区号']);

  // 谁都没有 -> 才需要买
  const none = await check.execute({ query: '999999' });
  assert.equal(none.owned, false);
  assert.equal(none.needsPurchase, true);
  assert.match(none.verdict, /3 个账号都没有这款游戏/);

  // 商店链接
  const viaUrl = await check.execute({ query: 'https://store.steampowered.com/app/1245620/ELDEN_RING/' });
  assert.equal(viaUrl.appid, 1245620);
  assert.equal(viaUrl.ownedByOtherOnly, true);
});

test('按游戏名模糊搜索：唯一命中就直接给结论，多个命中就列候选', async () => {
  const { ctx } = await setup();
  await ctx.registered.get('steam_owner_data').execute({ action: 'import', json: JSON.stringify(FAKE_EXPORT) });
  const check = ctx.registered.get('steam_owner_check');

  // 唯一命中：直接落到具体游戏
  const unique = await check.execute({ query: 'dota' });
  assert.equal(unique.found, true);
  assert.equal(unique.appid, 570);
  assert.equal(unique.owned, true);
  assert.deepEqual(unique.others, ['小号'], 'Dota 2 只有小号有');

  // 多个命中：只列候选，不硬猜（"or" 同时命中 Team Fortress 2 和 Portal 2）
  const many = await check.execute({ query: 'or' });
  assert.equal(many.found, false);
  assert.ok(many.candidates.length > 1, '应列出多个候选');
  assert.match(many.verdict, /需要你确认是哪一个/);
  assert.ok(many.candidates.every((c) => c.appid && Array.isArray(c.ownedBy)));

  // 找不到
  const none = await check.execute({ query: 'zzzz不存在zzzz' });
  assert.equal(none.found, false);
  assert.match(none.verdict, /找不到/);
});

test('切换"当前登录账号"会改变结论', async () => {
  const { ctx } = await setup();
  await ctx.registered.get('steam_owner_data').execute({ action: 'import', json: JSON.stringify(FAKE_EXPORT) });
  const set = await ctx.registered.get('steam_owner_data').execute({ action: 'set_current', accountId: 'alt' });
  assert.match(set.report, /账号 3 个/);
  const res = await ctx.registered.get('steam_owner_check').execute({ query: '1245620' });
  assert.equal(res.ownedByCurrent, true, '当前账号换成小号后应已拥有');
  assert.equal(res.ownedByOtherOnly, false);
});

test('未同步的账号绝不能被当成"没有这款游戏"', async () => {
  const { ctx } = await setup();
  await ctx.registered.get('steam_owner_accounts').execute({
    action: 'add', label: '还没同步的号', key: '76561198999999999',
  });
  await ctx.registered.get('steam_owner_data').execute({
    action: 'import',
    json: JSON.stringify({ accounts: FAKE_EXPORT.accounts, libraries: FAKE_EXPORT.libraries, settings: {} }),
  });
  const res = await ctx.registered.get('steam_owner_check').execute({ query: '999999' });
  assert.equal(res.incomplete, true, '必须标记结论不完整');
  assert.match(res.verdict, /另有 1 个账号未同步/);
});

test('一个账号都没同步时结论是"无法判断"，不是"没有"', async () => {
  const { ctx } = await setup();
  await ctx.registered.get('steam_owner_accounts').execute({ action: 'add', label: '甲', key: 'alice' });
  const res = await ctx.registered.get('steam_owner_check').execute({ query: '1245620' });
  assert.equal(res.owned, false);
  assert.match(res.verdict, /无法判断/);
  assert.doesNotMatch(res.verdict, /都没有这款游戏/);
});

test('账号增删查与清空', async () => {
  const { ctx } = await setup();
  const accounts = ctx.registered.get('steam_owner_accounts');
  await ctx.registered.get('steam_owner_data').execute({ action: 'import', json: JSON.stringify(FAKE_EXPORT) });

  let list = await accounts.execute({ action: 'list' });
  assert.equal(list.accounts.length, 3);
  assert.equal(list.accounts.find((a) => a.id === 'main').isCurrent, true);
  assert.equal(list.accounts.find((a) => a.id === 'alt').gameCount, 2);

  const added = await accounts.execute({ action: 'add', label: '新号', key: 'https://steamcommunity.com/id/brandnew/' });
  assert.ok(added.accounts.some((a) => a.label === '新号' && a.identity === 'brandnew'));
  assert.equal(added.accounts.length, 4);

  const removed = await accounts.execute({ action: 'remove', accountId: 'cn' });
  assert.equal(removed.accounts.length, 3);
  await assert.rejects(() => accounts.execute({ action: 'remove', accountId: 'nope' }), /没有这个账号/);

  const cleared = await accounts.execute({ action: 'clear' });
  assert.equal(cleared.accounts.length, 0);
  const after = await ctx.registered.get('steam_owner_check').execute({ query: '440' });
  assert.match(after.verdict, /还没有配置任何 Steam 账号/);
});

test('导出内容不含 API key，且可再次导入（往返一致）', async () => {
  const { ctx } = await setup({ apiKey: 'deadbeefdeadbeefdeadbeefdeadbeef' });
  await ctx.registered.get('steam_owner_data').execute({ action: 'import', json: JSON.stringify(FAKE_EXPORT) });
  const out = await ctx.registered.get('steam_owner_data').execute({ action: 'export' });
  assert.ok(out.json, 'export 应返回 json');
  assert.ok(!out.json.includes('deadbeef'), '导出内容不能含 API key');
  const parsed = JSON.parse(out.json);
  assert.equal(parsed.accounts.length, 3);
  assert.equal(parsed.settings.apiKey, '');

  // 往返：导出的东西再导入另一个实例，结论一致
  const second = await setup();
  await second.ctx.registered.get('steam_owner_data').execute({ action: 'import', json: out.json });
  const res = await second.ctx.registered.get('steam_owner_check').execute({ query: '1245620' });
  assert.equal(res.ownedByOtherOnly, true);
  assert.deepEqual(res.others, ['小号']);
});

test('import 会拒绝不是本扩展格式的 JSON，并给出人话错误', async () => {
  const { ctx } = await setup();
  const data = ctx.registered.get('steam_owner_data');
  await assert.rejects(() => data.execute({ action: 'import', json: '{"foo":1}' }), /没有 accounts 数组/);
  await assert.rejects(() => data.execute({ action: 'import', json: 'not json' }), /JSON 解析失败/);
  await assert.rejects(() => data.execute({ action: 'import' }), /需要 json 或 file 参数/);
});

test('没有 API key 时 sync 给出明确指引而不是静默失败', async () => {
  const { ctx } = await setup();
  await assert.rejects(
    () => ctx.registered.get('steam_owner_data').execute({ action: 'sync' }),
    /需要 Steam Web API key/,
  );
});

test('status 动作报告数据概况', async () => {
  const { ctx, dataFile } = await setup();
  await ctx.registered.get('steam_owner_data').execute({ action: 'import', json: JSON.stringify(FAKE_EXPORT) });
  const res = await ctx.registered.get('steam_owner_data').execute({ action: 'status' });
  assert.equal(res.dataFile, dataFile);
  assert.equal(res.accountCount, 3);
  assert.equal(res.appCount, 4);
  assert.match(res.report, /4 个 AppID/);
  assert.match(res.report, /其中 4 款游戏/);
  // 版本号必须报出来：这是判断"改动到底生效没有"最可靠的依据。
  // 开发目录里是 vdev；打包后的副本由 pack-plugin.mjs 写入真实版本号。
  assert.match(res.report, /插件版本：v(\d+\.\d+\.\d+|dev)/);
});

/* ---------------- 真实 DSH 契约：输出必须是 lossless JSON ---------------- */

/*
 * 规则照抄 DSH 的 dsh-util-values：snapshotJsonValue 只要遇到一个不合规的节点，
 * 整个返回值就被判为 "value is not lossless JSON"，整次工具调用失败。
 * 关键点（容易踩）：
 *   · undefined / 函数 / Symbol / NaN / Infinity / -0 都不是 JSON
 *   · 对象必须是"普通记录"：原型必须是 Object.prototype —— Object.create(null) 不算
 *   · 数组必须是密集数组，且没有额外自有的字符串/符号键
 */
function assertLosslessJson(value, path = 'value') {
  const fail = (why) => {
    throw new Error(path + ' ' + why + '（DSH 会判为 value is not lossless JSON，整次调用失败）');
  };
  if (value === undefined) fail('是 undefined');
  const t = typeof value;
  if (t === 'function') fail('是函数');
  if (t === 'symbol') fail('是 Symbol');
  if (t === 'bigint') fail('是 BigInt');
  if (t === 'number') {
    if (!Number.isFinite(value)) fail('不是有限数字: ' + value);
    if (Object.is(value, -0)) fail('是 -0');
    return;
  }
  if (t === 'string' || t === 'boolean') return;
  if (value === null) return;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail('数组原型不是 Array.prototype');
    if (Reflect.ownKeys(value).length !== value.length + 1) fail('数组带有额外的自有键');
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) fail('数组在 ' + i + ' 处是稀疏的');
      assertLosslessJson(value[i], path + '[' + i + ']');
    }
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail('不是普通记录（原型必须是 Object.prototype）');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('带有 Symbol 键');
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) fail('键 ' + key + ' 不可枚举');
    assertLosslessJson(value[key], path + '.' + key);
  }
}

test('所有工具的返回值都是 lossless JSON（照 DSH 的精确规则）', async () => {
  // 真机上踩过的坑：返回值里带 undefined 会让整次工具调用失败
  // "tool ... returned invalid output: value is not lossless JSON"
  const { ctx } = await setup();
  const check = ctx.registered.get('steam_owner_check');
  const accounts = ctx.registered.get('steam_owner_accounts');
  const data = ctx.registered.get('steam_owner_data');

  const outputs = [];
  // 空状态
  outputs.push(await check.execute({ query: '440' }));
  outputs.push(await accounts.execute({ action: 'list' }));
  outputs.push(await data.execute({ action: 'status' }));
  // 有数据
  outputs.push(await data.execute({ action: 'import', json: JSON.stringify(FAKE_EXPORT) }));
  outputs.push(await data.execute({ action: 'export' }));
  outputs.push(await data.execute({ action: 'status' }));
  outputs.push(await accounts.execute({ action: 'list' }));
  outputs.push(await accounts.execute({ action: 'add', label: '新号', key: '76561198999999999' }));
  outputs.push(await accounts.execute({ action: 'list' }));
  outputs.push(await check.execute({ query: '1245620' }));   // 只有别的账号有
  outputs.push(await check.execute({ query: '620' }));       // 当前账号有
  outputs.push(await check.execute({ query: '999999' }));    // 谁都没有
  outputs.push(await check.execute({ query: 'or' }));        // 多候选
  outputs.push(await check.execute({ query: '不存在zzz' })); // 找不到
  outputs.push(await check.execute({ query: '!!!' }));       // 看不懂

  for (const [i, out] of outputs.entries()) {
    assertLosslessJson(out, 'outputs[' + i + ']');
    // 再证明一次真的能无损往返（DSH 的 snapshot 就是这个语义）
    assert.deepEqual(JSON.parse(JSON.stringify(out)), JSON.parse(JSON.stringify(out)));
  }
  assert.ok(outputs.length >= 15);
  // 明确盯住踩过的那个键：没有同步结果时 results 必须整个消失，而不是 undefined
  const status = await data.execute({ action: 'status' });
  assert.ok(!('results' in status), 'results 为 undefined 时应删掉这个键');
  assert.ok(!('json' in status), 'json 为 undefined 时应删掉这个键');
});

test('注册通过 ctx.effect 登记，bundle 卸载时工具会被回收', async () => {
  // 真机上踩过的坑：直接 register 而不登记 effect，停用 bundle 后旧实现仍然在应答
  const { ctx } = await setup();
  assert.equal(ctx.registered.size, 3);
  assert.equal(ctx.effects.length, 3, '3 个工具都应登记 effect');
  ctx.disposeAll();
  assert.equal(ctx.registered.size, 0, '卸载后工具必须全部回收');
});

test('export 出来的 json 字段是字符串而不是 undefined', async () => {
  const { ctx } = await setup();
  await ctx.registered.get('steam_owner_data').execute({ action: 'import', json: JSON.stringify(FAKE_EXPORT) });
  const out = await ctx.registered.get('steam_owner_data').execute({ action: 'export' });
  assert.equal(typeof out.json, 'string');
  assert.ok(!('results' in out), 'results 为 undefined 时应删掉这个键');
});

test('数量口径：305 个条目要显示成 71 款游戏，而不是 305 款', async () => {
  // 真机上出现过的问题：许可证列表 305 个条目被当成"305 款游戏"，
  // 而 Steam 档案里其实是 71 款 —— 用户一眼就看出不对。
  const { ctx } = await setup();
  const payload = {
    accounts: [{ id: 'big', label: '大号' }],
    libraries: {
      big: {
        appids: Array.from({ length: 305 }, (_, i) => i + 1),
        gameAppids: Array.from({ length: 71 }, (_, i) => i + 1),
        kind: 'mixed',
        names: {},
      },
    },
    settings: { currentAccountId: 'big' },
  };
  await ctx.registered.get('steam_owner_data').execute({ action: 'import', json: JSON.stringify(payload) });

  const status = await ctx.registered.get('steam_owner_data').execute({ action: 'status' });
  assert.equal(status.appCount, 305, '索引要收全（DLC 拥有情况也要能识别）');
  assert.match(status.report, /305 个 AppID/);
  assert.match(status.report, /其中 71 款游戏/);

  const list = await ctx.registered.get('steam_owner_accounts').execute({ action: 'list' });
  assert.equal(list.accounts[0].gameCount, 71);
  assert.equal(list.accounts[0].entryCount, 305);
  assert.equal(list.accounts[0].countText, '71 款游戏（另 234 项 DLC/工具）');
  assert.match(list.report, /71 款游戏（另 234 项 DLC\/工具）/);
  assert.doesNotMatch(list.report, /305 款/);
});

test('游戏数未知时，绝不冒充"款游戏"', async () => {
  const { ctx } = await setup();
  await ctx.registered.get('steam_owner_data').execute({
    action: 'import',
    json: JSON.stringify({
      accounts: [{ id: 'x', label: '只有条目的号' }],
      libraries: { x: { appids: [1, 2, 3], kind: 'apps' } },
      settings: {},
    }),
  });
  const list = await ctx.registered.get('steam_owner_accounts').execute({ action: 'list' });
  assert.equal(list.accounts[0].countText, '3 项（含 DLC/工具，游戏数待识别）');
  assert.ok(!('gameCount' in list.accounts[0]), '游戏数未知时不该给出这个字段');
  assert.doesNotMatch(list.report, /款游戏/);
});

test('插件自带的 core / steam-api 副本与真源逐字节一致', async () => {
  for (const file of ['core.js', 'steam-api.js']) {
    const copy = await readFile(new URL('../dsh/lib/' + file, import.meta.url), 'utf8');
    const source = await readFile(new URL('../src/lib/' + file, import.meta.url), 'utf8');
    assert.equal(copy, source, 'dsh/lib/' + file + ' 与 src/lib/' + file + ' 不一致，请运行 node tools/sync-plugin-lib.mjs');
  }
});
