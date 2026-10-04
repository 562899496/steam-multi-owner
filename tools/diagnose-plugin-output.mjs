/*
 * 用 DSH 真实的 @deepseek-ai/dsh-util-values 校验器，逐条检查插件工具的输出，
 * 并精确定位是哪个路径让整份输出被判为 "value is not lossless JSON"。
 *
 * 这就是真机上踩到的坑：返回值里只要有一个 undefined，
 * DSH 就会把整次工具调用判为非法输出。
 *
 * 用法：node tools/diagnose-plugin-output.mjs
 */
import { registerHooks } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isJsonValue, snapshotJsonValue } from '@deepseek-ai/dsh-util-values';

/* ---------- 把 DSH 运行时依赖换成桩（同 test/dsh-plugin.test.mjs） ---------- */

const stubDir = await mkdtemp(join(tmpdir(), 'smo-diag-'));
await writeFile(join(stubDir, 'dsh-tools.mjs'), 'export function defineTool(d) { return d; }\n', 'utf8');
await writeFile(join(stubDir, 'schemastery.mjs'), `
function chain() { const api = { default: () => api, description: () => api, required: () => api, optional: () => api }; return api; }
export default { object: () => chain(), string: () => chain(), boolean: () => chain(), number: () => chain() };
`, 'utf8');
const stubBase = 'file:///' + stubDir.replace(/\\/g, '/') + '/';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: new URL('dsh-tools.mjs', stubBase).href, shortCircuit: true };
    if (specifier === '@deepseek-ai/schemastery') return { url: new URL('schemastery.mjs', stubBase).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const plugin = await import('../dsh/lib/index.js');

function makeCtx() {
  const tools = new Map();
  return {
    tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name); } },
    effect(cb) { const d = cb(); return () => { if (typeof d === 'function') d(); }; },
    registered: tools,
  };
}

/** 找出让整份值不合规的第一个路径。 */
function findViolation(value, path = '') {
  if (isJsonValue(value)) return null;
  if (value === undefined) return path + ' = undefined';
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return path + ' = ' + value;
  if (typeof value === 'function') return path + ' = function';
  if (typeof value === 'symbol') return path + ' = symbol';
  if (typeof value === 'bigint') return path + ' = bigint';
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return path + ' 数组原型异常';
      if (Reflect.ownKeys(value).length !== value.length + 1) return path + ' 数组有额外自有键: ' + Reflect.ownKeys(value).map(String).join(',');
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) return path + '[' + i + '] 稀疏';
        const hit = findViolation(value[i], path + '[' + i + ']');
        if (hit) return hit;
      }
      return null;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return path + ' 原型不是 Object.prototype（是 ' + (Object.getPrototypeOf(value) === null ? 'null' : '其它') + '），键: ' + Reflect.ownKeys(value).map(String).join(',');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return path + ' 有 Symbol 键';
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) return path + '.' + key + ' 不可枚举';
      const hit = findViolation(value[key], path + '.' + key);
      if (hit) return hit;
    }
    return null;
  }
  return path + ' = ' + String(value);
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
    main: { appids: [440, 620], names: { 440: 'Team Fortress 2', 620: 'Portal 2' }, method: 'api' },
    alt: { appids: [570, 1245620], names: { 1245620: 'ELDEN RING', 570: 'Dota 2' }, method: 'session' },
    cn: { appids: [440], names: {}, method: 'community-xml' },
  },
  settings: { currentAccountId: 'main' },
};

const dir = await mkdtemp(join(tmpdir(), 'smo-diag-store-'));
const dataFile = join(dir, 'store.json');
const ctx = makeCtx();
plugin.apply(ctx, { apiKey: '', dataFile, defaultCurrentAccount: '' });

const check = ctx.registered.get('steam_owner_check');
const accounts = ctx.registered.get('steam_owner_accounts');
const data = ctx.registered.get('steam_owner_data');

const cases = [
  ['check 空状态', () => check.execute({ query: '440' })],
  ['accounts list 空', () => accounts.execute({ action: 'list' })],
  ['data status 空', () => data.execute({ action: 'status' })],
  ['data import', () => data.execute({ action: 'import', json: JSON.stringify(FAKE_EXPORT) })],
  ['data export', () => data.execute({ action: 'export' })],
  ['data status 有数据', () => data.execute({ action: 'status' })],
  ['accounts list 有数据', () => accounts.execute({ action: 'list' })],
  ['accounts add', () => accounts.execute({ action: 'add', label: '新号', key: '76561198999999999' })],
  ['check 只有别的账号有', () => check.execute({ query: '1245620' })],
  ['check 当前账号有', () => check.execute({ query: '620' })],
  ['check 谁都没有', () => check.execute({ query: '999999' })],
  ['check 多候选', () => check.execute({ query: 'or' })],
  ['check 找不到', () => check.execute({ query: '不存在zzz' })],
  ['check 看不懂', () => check.execute({ query: '!!!' })],
  ['check set_current', () => data.execute({ action: 'set_current', accountId: 'alt' })],
];

let bad = 0;
for (const [label, run] of cases) {
  const value = await run();
  const lossless = isJsonValue(value);
  const detached = snapshotJsonValue(value);
  if (lossless && detached !== undefined) {
    console.log('[OK]   ' + label);
    continue;
  }
  bad++;
  console.log('[FAIL] ' + label);
  console.log('   isJsonValue=' + lossless + ' snapshot=' + (detached === undefined ? 'undefined' : 'ok'));
  console.log('   首个违规路径: ' + findViolation(value));
  console.log('   值: ' + JSON.stringify(value));
}

console.log('\n--- render 输出检查 ---');
const value = await check.execute({ query: '1245620' });
for (const [toolName, def] of ctx.registered) {
  try {
    const blocks = def.output.render({ query: '1245620' }, value);
    const okish = isJsonValue(blocks);
    console.log((okish ? '[OK]   ' : '[FAIL] ') + toolName + '.render -> ' + (okish ? 'lossless' : '违规: ' + findViolation(blocks)));
  } catch (err) {
    console.log('[FAIL] ' + toolName + '.render 抛错: ' + err.message);
  }
}

console.log('\n结论: ' + (cases.length - bad) + ' / ' + cases.length + ' 条输出通过 DSH 真实校验');
process.exit(bad === 0 ? 0 : 1);
