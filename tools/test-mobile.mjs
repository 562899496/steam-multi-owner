#!/usr/bin/env node
/*
 * 移动端单文件页面验证器（真的把 mobile/index.html 跑起来）：
 *
 *   1. 静态检查：不含 type="module"、不含任何外部 http(s) 资源、core 已内联
 *   2. 用 node:vm + 手写的假 DOM 执行页面里的内联 <script>，确认页面能启动
 *   3. 在 vm 里用 SteamOwnerCore 直接跑多账号查询，四种结论全覆盖
 *      （unknown / none / owned-other / owned-current）
 *   4. 真的驱动 UI：导入 JSON -> 查询 AppID/链接/游戏名 -> 切换当前账号
 *      -> 删除账号 -> 清空数据 -> 文件导入
 *
 * 无第三方依赖。用法: node tools/test-mobile.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'mobile', 'index.html');

/* ================================================================== *
 * 极简假 DOM：只实现这个页面用得到的部分
 * ================================================================== */

class FakeText {
  constructor(text) {
    this.nodeValue = String(text);
    this.textContent = this.nodeValue;
    this.childNodes = [];
    this.parentNode = null;
  }
}

class FakeEl {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = Object.create(null);
    this._listeners = Object.create(null);
    this._text = '';
    this._classes = [];
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.files = null;
    this.href = '';
    this.target = '';
    this.rel = '';
    this.type = '';
    this.id = '';
  }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((n) => n instanceof FakeEl); }
  get className() { return this._classes.join(' '); }
  set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }
  get classList() {
    const self = this;
    return {
      add(...cs) { for (const c of cs) if (!self._classes.includes(c)) self._classes.push(c); },
      remove(...cs) { self._classes = self._classes.filter((c) => !cs.includes(c)); },
      contains(c) { return self._classes.includes(c); },
      toggle(c) { if (self._classes.includes(c)) self.classList.remove(c); else self.classList.add(c); },
    };
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    this._text = '';
    return node;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n);
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) { this.childNodes.splice(i, 1); node.parentNode = null; }
    return node;
  }
  setAttribute(name, value) {
    const key = String(name);
    this.attributes[key] = String(value);
    if (key === 'id') this.id = String(value);
    else if (key === 'class') this.className = String(value);
    else if (key === 'href') this.href = String(value);
    else if (key === 'type') this.type = String(value);
    else if (key.startsWith('data-')) {
      const camel = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[camel] = String(value);
    }
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, String(name)) ? this.attributes[String(name)] : null;
  }
  addEventListener(type, fn) {
    (this._listeners[String(type)] || (this._listeners[String(type)] = [])).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[String(type)];
    if (list) this._listeners[String(type)] = list.filter((f) => f !== fn);
  }
  dispatchEvent(ev) {
    const event = ev || {};
    event.type = event.type || 'click';
    event.target = event.target || this;
    if (typeof event.preventDefault !== 'function') event.preventDefault = () => { event.defaultPrevented = true; };
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n);
    for (const node of path) { // 冒泡（事件委托靠这个）
      const list = node._listeners && node._listeners[event.type];
      if (list) for (const fn of list.slice()) fn.call(node, event);
    }
    return !event.defaultPrevented;
  }
  click() { return this.dispatchEvent({ type: 'click' }); }
  get textContent() { return this._text + this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = []; this._text = v == null ? '' : String(v); }
  get innerHTML() { return this.textContent; }
  querySelectorAll(sel) { return walkAll(this).filter((n) => matches(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function walkAll(root) {
  const out = [];
  const stack = [...root.childNodes];
  while (stack.length) {
    const n = stack.shift();
    if (n instanceof FakeEl) { out.push(n); stack.push(...n.childNodes); }
  }
  return out;
}
function matches(el, sel) {
  const s = String(sel).trim();
  let rest = s;
  const attr = /\[([a-z0-9-]+)(?:=["']?([^"'\]]*)["']?)?\]/i.exec(rest);
  if (attr) {
    rest = rest.replace(attr[0], '');
    const name = attr[1].startsWith('data-')
      ? attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      : null;
    const actual = name ? el.dataset[name] : el.attributes[attr[1]];
    if (actual == null) return false;
    if (attr[2] != null && String(actual) !== attr[2]) return false;
  }
  const id = /#([A-Za-z0-9_-]+)/.exec(rest);
  if (id && el.id !== id[1]) return false;
  const classes = [...rest.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  for (const c of classes) if (!el.classList.contains(c)) return false;
  const tag = /^[A-Za-z][A-Za-z0-9]*/.exec(rest);
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  return true;
}

function makeDocument() {
  const byId = new Map();
  const doc = {
    createElement(tag) { return new FakeEl(tag, doc); },
    createTextNode(text) { return new FakeText(text); },
    getElementById(id) {
      const key = String(id);
      if (!byId.has(key)) { const e = new FakeEl('div', doc); e.id = key; byId.set(key, e); }
      return byId.get(key);
    },
    querySelector(sel) { return doc.body.querySelector(sel); },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.body = new FakeEl('body', doc);
  doc.documentElement = new FakeEl('html', doc);
  doc.documentElement.appendChild(doc.body);
  doc.head = new FakeEl('head', doc);
  doc.documentElement.appendChild(doc.head);
  return doc;
}

/* ================================================================== *
 * 测试数据
 * ================================================================== */

const FAKE_EXPORT = {
  exportedAt: '2024-01-01T00:00:00.000Z',
  version: '1.0.0',
  accounts: [
    { id: 'main', label: '大号', steamId64: '76561198000000001' },
    { id: 'alt', label: '小号', vanity: 'my-alt' },
    { id: 'cn', label: '国区号' },
  ],
  libraries: {
    // gameAppids/kind 表示"哪些是游戏本体"已知；没有它的账号只能显示"游戏数待识别"
    main: { appids: [440, 620], gameAppids: [440, 620], kind: 'games', names: { 440: 'Team Fortress 2', 620: 'Portal 2' }, updatedAt: '2024-01-02T00:00:00.000Z', method: 'api' },
    alt: { appids: [570, 1245620], gameAppids: [570, 1245620], kind: 'games', names: { 1245620: 'ELDEN RING' }, updatedAt: '2024-01-02T00:00:00.000Z', method: 'session' },
    cn: { appids: [440], gameAppids: [440], kind: 'games', names: {}, updatedAt: '2024-01-02T00:00:00.000Z', method: 'community-xml' },
  },
  settings: { currentAccountId: 'main', apiKey: 'deadbeefdeadbeef' },
};

// 多一个「只有身份、还没同步库」的账号：它绝不能被当成「没有这款游戏」
const WITH_UNSYNCED = Object.assign({}, FAKE_EXPORT, {
  accounts: FAKE_EXPORT.accounts.concat([{ id: 'ghost', label: '还没同步的号', steamId64: '76561198999999999' }]),
});

// 一个库都没同步：结论必须是「无法判断」，而不是「没有」
const NO_LIBRARIES = Object.assign({}, FAKE_EXPORT, { libraries: {} });

// 30 个带名字的游戏：用来验证候选最多只列 20 条
const MANY_NAMES = {
  exportedAt: '2024-02-02T00:00:00.000Z',
  version: '1.0.0',
  accounts: [{ id: 'main', label: '大号' }],
  libraries: {
    main: {
      appids: Array.from({ length: 30 }, (_, i) => 1000 + i),
      names: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [1000 + i, 'Game Number ' + String(i + 1).padStart(2, '0')])),
    },
  },
  settings: { currentAccountId: 'main' },
};

/* ================================================================== *
 * 断言小工具
 * ================================================================== */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra) {
  pass++;
  console.log(`  ✔ ${name}${extra ? '  ' + extra : ''}`);
}
function bad(name, err) {
  fail++;
  failures.push(name + ': ' + (err && err.message ? err.message : err));
  console.log(`  ✖ ${name} -> ${err && err.message ? err.message : err}`);
}
function check(name, fn) {
  try {
    const extra = fn();
    ok(name, typeof extra === 'string' ? extra : '');
    return true;
  } catch (err) {
    bad(name, err);
    return false;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function assertMatch(text, re, msg) {
  if (!re.test(String(text))) throw new Error(`${msg || '文本不匹配'}：${re} 未命中 ${JSON.stringify(String(text).slice(0, 260))}`);
}
function assertNotMatch(text, re, msg) {
  if (re.test(String(text))) throw new Error(`${msg || '文本不应匹配'}：${re} 命中了 ${JSON.stringify(String(text).slice(0, 260))}`);
}
function findAll(root, pred) { return walkAll(root).filter(pred); }
function byClass(root, cls) { return walkAll(root).filter((n) => n.classList.contains(cls)); }
function firstByClass(root, cls) { return byClass(root, cls)[0] || null; }

/* ================================================================== *
 * 开始
 * ================================================================== */

console.log('Steam 多账号拥有检查 — 移动端页面验证器');
console.log('项目目录: ' + ROOT);

if (!existsSync(PAGE)) {
  console.error('\n找不到 ' + PAGE + '，请先运行: node tools/build-mobile.mjs');
  process.exit(1);
}
const html = await readFile(PAGE, 'utf8');

/* ---------------- 1. 静态检查 ---------------- */
console.log('\n[1] 静态检查（单文件 / 离线 / 无 ESM）');

check('没有 type="module"（file:// 下 ES module 会被 CORS 拦掉）', () => {
  assertNotMatch(html, /type\s*=\s*["']module["']/i);
  return 'classic script';
});

check('没有外部 <script src>（无 CDN）', () => {
  assertNotMatch(html, /<script[^>]*\bsrc\s*=/i);
  return '0 个外链脚本';
});

check('没有外部 <link href="http..."> 等资源引用', () => {
  assertNotMatch(html, /<link[^>]*\bhref\s*=\s*["']https?:/i, '外链样式');
  assertNotMatch(html, /@import\s+(?:url\(\s*)?["']?https?:/i, '外链 @import');
  assertNotMatch(html, /url\(\s*["']?https?:\/\//i, 'CSS 里的外链资源');
  return '完全离线';
});

check('内联了 core 的关键函数', () => {
  for (const fn of ['function decideBadge', 'decideBadge: decideBadge', 'function buildIndex', 'function ownedByOthers', 'function parseAppId', 'function summarize', 'function queryOwnership']) {
    assert(html.includes(fn), '缺少 ' + fn);
  }
  return 'parseAppId / buildIndex / ownedByOthers / summarize / decideBadge';
});

check('占位符已被替换，core 的 module 守卫仍在', () => {
  assert(!html.includes('/* __SMO_CORE__ */'), '占位符还在，构建没生效');
  assertMatch(html, /typeof module !== 'undefined'/, 'core.js 的 module 守卫丢了');
  return 'ok';
});

/* ---------------- 2. 抽取内联脚本并在假 DOM 里执行 ---------------- */
console.log('\n[2] 在 node:vm + 假 DOM 里真的执行页面脚本');

const inlineScripts = [];
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=/i.test(m[1])) continue;
  inlineScripts.push(m[2]);
}

const doc = makeDocument();
const storageMap = new Map();
const localStorage = {
  getItem(k) { return storageMap.has(String(k)) ? storageMap.get(String(k)) : null; },
  setItem(k, v) { storageMap.set(String(k), String(v)); },
  removeItem(k) { storageMap.delete(String(k)); },
  clear() { storageMap.clear(); },
  key(i) { return [...storageMap.keys()][i] ?? null; },
  get length() { return storageMap.size; },
};

class FakeFileReader {
  constructor() { this.result = null; this.error = null; this.onload = null; this.onerror = null; }
  readAsText(file) {
    if (!file || typeof file.__text !== 'string') {
      this.error = new Error('假 FileReader：文件没有 __text');
      if (this.onerror) this.onerror({ target: this }); // 浏览器里 FileReader 回调是异步的，这里同步即可
      return;
    }
    this.result = file.__text;
    if (this.onload) this.onload({ target: this });
  }
}

let confirmAnswer = true;
const sandbox = {
  console,
  document: doc,
  localStorage,
  sessionStorage: localStorage,
  navigator: { userAgent: 'dsh-test/1.0', language: 'zh-CN', onLine: false },
  FileReader: FakeFileReader,
  setTimeout: () => 0,   // 页面只用它做过期自动隐藏，测试里不需要真的跑
  clearTimeout: () => {},
  alert: () => {},
  confirm: () => confirmAnswer,
  location: { href: 'file:///mobile/index.html', protocol: 'file:' },
};
sandbox.window = sandbox;
sandbox.self = sandbox;

const ctx = vm.createContext(sandbox);

check(`内联脚本共 ${inlineScripts.length} 个，全部能编译且能执行`, () => {
  assert(inlineScripts.length >= 1, '没有内联脚本');
  for (const [i, code] of inlineScripts.entries()) {
    const script = new vm.Script(code, { filename: `mobile/index.html#inline-${i}` });
    script.runInContext(ctx);
  }
  return `${inlineScripts.length} 个脚本执行完毕`;
});

const Core = ctx.SteamOwnerCore;
check('执行后 globalThis.SteamOwnerCore 已挂上', () => {
  assertEq(typeof Core, 'object', 'SteamOwnerCore 类型');
  assertEq(typeof Core.decideBadge, 'function', 'decideBadge');
  assertEq(typeof Core.buildIndex, 'function', 'buildIndex');
  return `${Object.keys(Core).length} 个导出`;
});

const $ = (id) => doc.getElementById(id);

check('页面真的启动了（顶部状态已渲染）', () => {
  const summary = $('summary').textContent;
  assertMatch(summary, /0 个账号/, '初始摘要');
  assertNotMatch(summary, /正在读取本机数据/, '摘要还是初始占位符，boot() 没跑');
  return summary;
});

/* ---------------- 3. 直接用 core 跑四种结论 ---------------- */
console.log('\n[3] core 多账号查询：unknown / none / owned-other / owned-current 全覆盖');

const accounts3 = FAKE_EXPORT.accounts;
const accounts4 = WITH_UNSYNCED.accounts;
const syncedLibs = accounts3
  .filter((a) => FAKE_EXPORT.libraries[a.id])
  .map((a) => ({ accountId: a.id, label: Core.accountLabel(a), appids: FAKE_EXPORT.libraries[a.id].appids, updatedAt: FAKE_EXPORT.libraries[a.id].updatedAt }));
const index = Core.buildIndex(syncedLibs);
const sum3 = Core.summarize(index, accounts3);
const indexEmpty = Core.buildIndex([]);
const sumEmpty = Core.summarize(indexEmpty, accounts3);
const indexUnsynced = Core.buildIndex(syncedLibs);
const sum4 = Core.summarize(indexUnsynced, accounts4);

check('索引统计：3 个账号全同步 / 合并 4 款（未同步账号不入索引）', () => {
  assertEq(sum3.accountCount, 3, 'accountCount');
  assertEq(sum3.syncedCount, 3, 'syncedCount');
  assertEq(sum3.uniqueAppCount, 4, 'uniqueAppCount');
  assertEq(sum4.accountCount, 4, '含未同步账号的 accountCount');
  assertEq(sum4.syncedCount, 3, '含未同步账号的 syncedCount');
  assertEq(sumEmpty.syncedCount, 0, '空库的 syncedCount');
  return `账号 ${sum3.accountCount}/已同步 ${sum3.syncedCount}/唯一游戏 ${sum3.uniqueAppCount}`;
});

check('owned-other（当前账号没有、小号有）-> ⚠ 小号 已拥有 + 不用重复购买', () => {
  const detail = Core.ownedByOthers(index, 1245620, accounts3, 'main');
  const badge = Core.decideBadge(detail, { accountCount: sum3.accountCount, syncedCount: sum3.syncedCount, currentAccountId: 'main' });
  assertEq(badge.tone, 'owned-other', 'tone');
  assertEq(badge.warn, true, 'warn');
  assertEq(detail.ownedByCurrent, false, 'ownedByCurrent');
  assertEq(detail.ownedByOtherOnly, true, 'ownedByOtherOnly');
  assertEq(detail.others.length, 1, 'others 数量');
  assertMatch(badge.short, /小号/, 'short 应带账号名');
  assertMatch(badge.long, /不用重复购买/, 'long 应给结论');
  return `${badge.short} / ${badge.long}`;
});

check('owned-current（当前账号已有）-> ✓ 当前账号已有，不警告', () => {
  const badge = Core.decideBadge(Core.ownedByOthers(index, 620, accounts3, 'main'), { accountCount: 3, syncedCount: 3, currentAccountId: 'main' });
  assertEq(badge.tone, 'owned-current', 'tone');
  assertEq(badge.warn, false, 'warn');
  assertMatch(badge.long, /当前账号已拥有/, 'long');
  return badge.short;
});

check('none（谁都没有）-> 你的 N 个账号都没有', () => {
  const badge = Core.decideBadge(Core.ownedByOthers(index, 999999, accounts3, 'main'), { accountCount: 3, syncedCount: 3, currentAccountId: 'main' });
  assertEq(badge.tone, 'none', 'tone');
  assertEq(badge.incomplete, false, 'incomplete');
  assertMatch(badge.long, /你的 3 个账号都没有这款游戏/, 'long');
  return badge.long;
});

check('unknown（谁都没同步库）-> 无法判断，绝不说"都没有"', () => {
  const badge = Core.decideBadge(Core.ownedByOthers(indexEmpty, 1245620, accounts3, 'main'), { accountCount: sumEmpty.accountCount, syncedCount: sumEmpty.syncedCount, currentAccountId: 'main' });
  assertEq(badge.tone, 'unknown', 'tone');
  assertMatch(badge.long, /无法判断/, 'long 必须说无法判断');
  assertNotMatch(badge.long, /都没有这款游戏/, '不能给出假的安全结论');
  return badge.long;
});

check('未同步的账号不能算作"没有这款游戏"（结论标记不完整）', () => {
  const badge = Core.decideBadge(Core.ownedByOthers(indexUnsynced, 999999, accounts4, 'main'), { accountCount: sum4.accountCount, syncedCount: sum4.syncedCount, currentAccountId: 'main' });
  assertEq(badge.tone, 'none', 'tone');
  assertEq(badge.incomplete, true, 'incomplete');
  assertMatch(badge.long, /另有 1 个账号未同步/, 'long');
  return badge.long;
});

check('owned-both（当前账号和国区号都有 440）', () => {
  const badge = Core.decideBadge(Core.ownedByOthers(index, 440, accounts3, 'main'), { accountCount: 3, syncedCount: 3, currentAccountId: 'main' });
  assertEq(badge.tone, 'owned-both', 'tone');
  return badge.long;
});

/* ---------------- 4. 真的驱动 UI ---------------- */
console.log('\n[4] 驱动 UI：导入 / 查询 / 切换账号 / 删除 / 清空 / 文件导入');

function importText(data, asString) {
  $('json-input').value = asString != null ? asString : JSON.stringify(data);
  $('import-btn').click();
  return $('import-msg').textContent;
}
function stored() {
  const raw = storageMap.get('smo.mobile.state');
  return raw ? JSON.parse(raw) : null;
}
function query(text) {
  $('query-input').value = text;
  $('query-btn').click();
  return $('result');
}
function tone() {
  const box = firstByClass($('result'), 'res');
  return box ? box.getAttribute('data-tone') : null;
}

check('导入 JSON：写入 localStorage(smo.mobile.state)', () => {
  const msg = importText(FAKE_EXPORT);
  assertMatch(msg, /导入成功/, '提示');
  const s = stored();
  assert(s, 'localStorage 里没有 smo.mobile.state');
  assertEq(s.accounts.length, 3, '账号数');
  assertEq(Object.keys(s.libraries).length, 3, '库快照数');
  assertEq(s.settings.currentAccountId, 'main', '当前账号');
  assert(!JSON.stringify(s).includes('deadbeef'), '不该把 apiKey 之类的东西留在本机状态里');
  return msg;
});

check('顶部状态：N 个账号 / 合并 M 款游戏 / 数据时间', () => {
  const summary = $('summary').textContent;
  assertMatch(summary, /3 个账号/, '账号数');
  assertMatch(summary, /4 款游戏/, '游戏数');
  assertMatch(summary, /数据时间 2024-01-0/, '数据时间');
  assertMatch($('sync-note').textContent, /全部 3 个账号都已同步/, '同步说明');
  assertEq($('storage-warn').hidden, true, '存储可用时不该显示警告');
  return summary;
});

check('账号区：3 行 + 3 个选项 + 当前登录标记', () => {
  const rows = findAll($('accounts-list'), (n) => n.tagName === 'LI');
  assertEq(rows.length, 3, '账号行数');
  assertEq(findAll($('accounts-list'), (n) => n.getAttribute('data-act') === 'delete-account').length, 3, '删除按钮数');
  assertEq(findAll($('accounts-list'), (n) => n.classList.contains('me')).length, 1, '当前登录标记数');
  const options = findAll($('current-select'), (n) => n.tagName === 'OPTION');
  assertEq(options.length, 3, '下拉选项数');
  assertEq($('current-select').value, 'main', '下拉当前值');
  assertMatch($('accounts-list').textContent, /大号/, '账号名');
  assertMatch($('accounts-list').textContent, /2 款游戏/, '每个账号的游戏数');
  return rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
});

check('导入校验：缺 accounts 数组 -> 人话错误，且不覆盖已有数据', () => {
  const msg = importText(null, '{"foo":1}');
  assertMatch(msg, /导入失败/, '提示前缀');
  assertMatch(msg, /accounts/, '错误里应点名 accounts');
  assertEq(stored().accounts.length, 3, '原有数据不该被破坏');
  return msg;
});

check('导入校验：不是 JSON / accounts 为空 -> 人话错误', () => {
  const msg1 = importText(null, '这不是 json');
  assertMatch(msg1, /JSON 解析失败/, '解析失败提示');
  const msg2 = importText(null, JSON.stringify({ accounts: [] }));
  assertMatch(msg2, /没有任何有效账号/, '空账号提示');
  const msg3 = importText(null, JSON.stringify({ accounts: [{ id: 'x' }] }));
  assertMatch(msg3, /导入成功/, '只有 id 的账号应可用');
  assertEq(stored().accounts.length, 1, '账号数');
  return msg1.slice(0, 40) + ' / ' + msg2.slice(0, 40);
});

check('查询 AppID 1245620 -> owned-other，结果卡 + 逐账号列出 + 商店链接', () => {
  importText(FAKE_EXPORT);
  const result = query('1245620');
  assertEq(tone(), 'owned-other', 'tone');
  const text = result.textContent.replace(/\s+/g, ' ');
  assertMatch(text, /小号/, '要指出是哪个账号有');
  assertMatch(text, /不用重复购买/, '结论');
  assertMatch(text, /ELDEN RING/, '应带出游戏名');
  assertMatch(text, /AppID 1245620/, '应显示 AppID');

  const rows = findAll(result, (n) => n.tagName === 'LI');
  assertEq(rows.length, 3, '三个账号各一行');
  const mainRow = rows.find((r) => r.textContent.includes('大号'));
  const altRow = rows.find((r) => r.textContent.includes('小号'));
  const cnRow = rows.find((r) => r.textContent.includes('国区号'));
  assertMatch(mainRow.textContent, /未拥有/, '大号应显示未拥有');
  assertMatch(altRow.textContent, /已拥有/, '小号应显示已拥有');
  assertMatch(cnRow.textContent, /未拥有/, '国区号应显示未拥有');

  const links = findAll(result, (n) => n.tagName === 'A');
  assertEq(links.length, 3, '每条一个商店链接');
  for (const a of links) assertEq(a.href, 'https://store.steampowered.com/app/1245620/', '链接地址');
  return text.slice(0, 120);
});

check('查询 Steam 商店链接 -> 解析出 AppID 并给出 ✓ 当前账号已有', () => {
  const result = query('https://store.steampowered.com/app/620/Portal_2/?snr=1_5_9__205');
  assertEq(tone(), 'owned-current', 'tone');
  assertMatch(result.textContent, /当前账号已有/, '结论');
  assertEq(findAll(result, (n) => n.tagName === 'A')[0].href, 'https://store.steampowered.com/app/620/', '链接');
  return result.textContent.replace(/\s+/g, ' ').slice(0, 80);
});

check('查询游戏名（子串模糊）-> 列出候选，点选后出结论', () => {
  importText(FAKE_EXPORT);
  const result = query('elden');
  const cands = findAll($('candidates'), (n) => n.getAttribute('data-act') === 'pick-candidate');
  assertEq(cands.length, 1, '候选数');
  assertMatch(cands[0].textContent, /ELDEN RING/, '候选名');
  assertMatch($('query-msg').textContent, /匹配到/, '提示');

  cands[0].click(); // 走 #candidates 上的事件委托
  assertEq(tone(), 'owned-other', '点选后的 tone');
  assertMatch($('result').textContent, /不用重复购买/, '结论');
  return cands[0].textContent.replace(/\s+/g, ' ').trim();
});

check('游戏名候选最多列出 20 条', () => {
  importText(MANY_NAMES);
  query('game');
  const cands = findAll($('candidates'), (n) => n.getAttribute('data-act') === 'pick-candidate');
  assertEq(cands.length, 20, '候选上限');
  assertMatch($('query-msg').textContent, /匹配到 20 个/, '提示里的数量');
  return cands.length + ' 条候选';
});

check('查询不存在的 AppID -> none（你的 N 个账号都没有）', () => {
  importText(FAKE_EXPORT);
  const result = query('999999');
  assertEq(tone(), 'none', 'tone');
  assertMatch(result.textContent, /你的 3 个账号都没有这款游戏/, '结论');
  assertNotMatch(result.textContent, /不用重复购买/, '不该出现重复购买提示');
  return result.textContent.replace(/\s+/g, ' ').slice(0, 90);
});

check('查询乱七八糟的输入 -> 人话提示，不崩', () => {
  const msg1 = (query(''), $('query-msg').textContent);
  assertMatch($('query-msg').textContent, /请输入/, '空输入提示');
  query('zzzz-不存在的游戏');
  assertMatch($('query-msg').textContent, /没有匹配/, '无候选提示');
  assertEq(tone(), null, '无候选时不该有结果卡');
  return msg1.slice(0, 30);
});

check('切换当前登录账号 -> 存进 localStorage 并改变结论', () => {
  importText(FAKE_EXPORT);
  query('1245620');
  assertEq(tone(), 'owned-other', '切换前');

  $('current-select').value = 'alt';
  $('current-select').dispatchEvent({ type: 'change' });
  assertEq(stored().settings.currentAccountId, 'alt', 'localStorage 里的当前账号');
  assertEq(tone(), 'owned-current', '切到小号后 re-render 的 tone');
  assertMatch($('result').textContent, /当前账号已有/, '换账号后的结论');
  assertMatch($('account-msg').textContent, /切换为「小号」/, '提示');

  $('current-select').value = 'main';
  $('current-select').dispatchEvent({ type: 'change' });
  assertEq(tone(), 'owned-other', '切回大号');
  return 'main -> alt -> main';
});

check('删除账号：连带快照一起删，结论随之变化', () => {
  importText(FAKE_EXPORT);
  query('440');
  assertEq(tone(), 'owned-both', '删除前：大号和国区号都有');

  const del = findAll($('accounts-list'), (n) => n.getAttribute('data-account-id') === 'cn' && n.getAttribute('data-act') === 'delete-account')[0];
  assert(del, '找不到国区号的删除按钮');
  del.click(); // 走 #accounts-list 上的事件委托

  const s = stored();
  assertEq(s.accounts.length, 2, '删除后的账号数');
  assert(!s.libraries.cn, '国区号的库快照应一起删掉');
  const rows = findAll($('accounts-list'), (n) => n.tagName === 'LI');
  assertEq(rows.length, 2, '列表行数');
  assertEq(tone(), 'owned-current', '只剩大号拥有 440');
  assertMatch($('account-msg').textContent, /已删除账号「国区号」/, '提示');
  return $('summary').textContent;
});

check('未同步的账号：UI 标注未同步，并提示结论不完整', () => {
  importText(WITH_UNSYNCED);
  assertMatch($('sync-note').textContent, /另有 1 个账号还没同步/, '同步说明');
  assertEq(findAll($('accounts-list'), (n) => n.tagName === 'LI').length, 4, '账号行数');
  assertMatch($('accounts-list').textContent, /未同步（无法判断拥有情况）/, '账号行标注');

  const result = query('999999');
  assertEq(tone(), 'none', 'tone');
  assertMatch(result.textContent, /不完整/, '结论不完整提示');
  assertMatch(result.textContent, /未同步 ≠ 没有这款游戏/, '必须说清未同步不等于没有');
  assertEq(findAll(result, (n) => n.tagName === 'LI').length, 4, '未同步账号也要列出');
  assertMatch(result.textContent, /未同步/, '未同步账号那行的状态');
  return result.textContent.replace(/\s+/g, ' ').slice(0, 130);
});

check('一个都没同步：页面给出「无法判断」，而不是「都没有」', () => {
  importText(NO_LIBRARIES);
  assertMatch($('sync-note').textContent, /还没同步/, '同步说明');
  const result = query('1245620');
  assertEq(tone(), 'unknown', 'tone');
  assertMatch(result.textContent, /无法判断/, '结论');
  assertNotMatch(result.textContent, /都没有这款游戏/, '不能给出假的安全结论');
  return result.textContent.replace(/\s+/g, ' ').slice(0, 90);
});

check('选择文件导入（FileReader）也能用', () => {
  importText(null, ''); // 先清掉输入框
  const input = $('file-input');
  input.files = [{ name: 'smo-export.json', __text: JSON.stringify(FAKE_EXPORT) }];
  input.dispatchEvent({ type: 'change' });
  assertMatch($('import-msg').textContent, /导入成功/, '提示');
  assertEq(stored().accounts.length, 3, '文件导入的账号数');
  assertEq($('file-input').value, '', '导入后应清空 file input');
  return $('import-msg').textContent;
});

check('清空全部数据：localStorage 清掉、界面回到空状态', () => {
  importText(FAKE_EXPORT);
  $('clear-btn').click();
  assertEq(storageMap.get('smo.mobile.state'), undefined, 'localStorage 应被移除');
  assertMatch($('summary').textContent, /0 个账号/, '摘要');
  assertEq(findAll($('accounts-list'), (n) => n.tagName === 'LI').length, 0, '账号行数');
  assertEq(findAll($('result'), (n) => n.classList.contains('res')).length, 0, '结果卡应清掉');
  assertMatch($('import-msg').textContent, /已清空/, '提示');
  return $('summary').textContent;
});

check('清空/删除都需要确认：用户点「取消」时不动作', () => {
  importText(FAKE_EXPORT);
  confirmAnswer = false;
  try {
    $('clear-btn').click();
    assertEq(stored().accounts.length, 3, '取消后不该清空');
    const del = findAll($('accounts-list'), (n) => n.getAttribute('data-act') === 'delete-account')[0];
    del.click();
    assertEq(stored().accounts.length, 3, '取消后不该删除账号');
  } finally {
    confirmAnswer = true;
  }
  return '取消 = 不动作';
});

check('刷新页面（重新执行脚本）后本机数据仍在', () => {
  importText(FAKE_EXPORT);
  const fresh = makeDocument();
  const freshStorage = localStorage; // 同一个 localStorage = 同一台设备的浏览器
  const sb = Object.assign({}, sandbox, { document: fresh, localStorage: freshStorage, confirm: () => confirmAnswer });
  sb.window = sb;
  sb.self = sb;
  const c2 = vm.createContext(sb);
  for (const code of inlineScripts) new vm.Script(code).runInContext(c2);
  const summary = fresh.getElementById('summary').textContent;
  assertMatch(summary, /3 个账号/, '重开后的摘要');
  assertMatch(summary, /4 款游戏/, '重开后的游戏数');
  const rows = walkAll(fresh.getElementById('accounts-list')).filter((n) => n.tagName === 'LI');
  assertEq(rows.length, 3, '重开后的账号行数');
  return summary;
});

check('localStorage 不可用时降级为内存并提醒（不崩）', () => {
  const fresh = makeDocument();
  const broken = {
    getItem() { throw new Error('QuotaExceeded'); },
    setItem() { throw new Error('QuotaExceeded'); },
    removeItem() { throw new Error('QuotaExceeded'); },
  };
  const sb = Object.assign({}, sandbox, { document: fresh, localStorage: broken, confirm: () => true });
  sb.window = sb;
  sb.self = sb;
  const c3 = vm.createContext(sb);
  for (const code of inlineScripts) new vm.Script(code).runInContext(c3);
  fresh.getElementById('json-input').value = JSON.stringify(FAKE_EXPORT);
  fresh.getElementById('import-btn').click();
  assertMatch(fresh.getElementById('import-msg').textContent, /导入成功/, '内存模式下也要能用');
  assertEq(fresh.getElementById('storage-warn').hidden, false, '应显示存储不可用提醒');
  const rows = walkAll(fresh.getElementById('accounts-list')).filter((n) => n.tagName === 'LI');
  assertEq(rows.length, 3, '内存模式下的账号行数');
  return fresh.getElementById('summary').textContent;
});

/* ---------------- 汇总 ---------------- */
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败明细:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
