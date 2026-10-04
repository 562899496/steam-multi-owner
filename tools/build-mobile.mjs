#!/usr/bin/env node
/*
 * 移动端单文件构建：src/lib/core.js + mobile/app.html  ->  mobile/index.html
 *
 * 为什么需要构建：手机上的 Chrome 不支持扩展，只能给一个纯静态页面；
 * 而从 file:// 打开时 ES module 会被 CORS 拦掉，所以必须是「内联的 classic script」。
 * 这里把纯逻辑层 core.js 原样内联进模板，产出单个可离线打开的 HTML。
 *
 * 无第三方依赖；幂等：同样的输入永远产出同样的字节（不写入任何时间戳）。
 *
 * 用法: node tools/build-mobile.mjs
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_FILE = join(ROOT, 'src', 'lib', 'core.js');
const TEMPLATE_FILE = join(ROOT, 'mobile', 'app.html');
const OUT_FILE = join(ROOT, 'mobile', 'index.html');
const PLACEHOLDER = '/* __SMO_CORE__ */';

const BANNER = '/* ===== 以下来自 src/lib/core.js（构建时内联，请勿手改本文件）===== */';
const FOOTER = '/* ===== core.js 结束 ===== */';

let step = 0;
function ok(msg) { console.log(`  ✔ ${msg}`); }
function info(msg) { console.log(`  · ${msg}`); }
function die(msg) { console.error(`  ✖ ${msg}`); process.exit(1); }
function section(title) { step++; console.log(`\n[${step}] ${title}`); }

function extractInlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push({ attrs: m[1], code: m[2], at: m.index });
  }
  return out;
}

console.log('Steam 多 Owner — 移动端单文件构建');
console.log('项目目录: ' + ROOT);

/* ------------------------------------------------------------------ */
section('读取输入');

if (!existsSync(CORE_FILE)) die('找不到 ' + CORE_FILE);
if (!existsSync(TEMPLATE_FILE)) die('找不到 ' + TEMPLATE_FILE);

const coreSrc = await readFile(CORE_FILE, 'utf8');
const template = await readFile(TEMPLATE_FILE, 'utf8');
ok(`src/lib/core.js  ${coreSrc.split('\n').length} 行 / ${Buffer.byteLength(coreSrc, 'utf8')} 字节`);
ok(`mobile/app.html  ${template.split('\n').length} 行 / ${Buffer.byteLength(template, 'utf8')} 字节`);

/* ------------------------------------------------------------------ */
section('检查 core.js 适合内联（classic script，不是 ESM）');

if (/^[ \t]*(import|export)\s/m.test(coreSrc)) {
  die('core.js 里出现了顶层 import/export，内联进 classic <script> 会直接语法错误（请改回 IIFE + globalThis 挂载）');
}
ok('没有顶层 import/export 语句');

if (!/typeof\s+module\s*!==\s*['"]undefined['"]/.test(coreSrc)) {
  die('core.js 里没有找到 `typeof module !== \'undefined\'` 守卫：在浏览器里 module 未定义会抛 ReferenceError');
}
ok('module.exports 有 typeof 守卫（浏览器里不会抛 ReferenceError）');

if (!/SteamOwnerCore\s*=/.test(coreSrc)) die('core.js 没有把 SteamOwnerCore 挂到全局');
ok('core.js 会挂载 globalThis.SteamOwnerCore');

/* ------------------------------------------------------------------ */
section('替换占位符');

const hits = template.split(PLACEHOLDER).length - 1;
if (hits !== 1) die(`mobile/app.html 里 ${PLACEHOLDER} 应该恰好出现 1 次，实际 ${hits} 次`);
ok(`占位符 ${PLACEHOLDER} 出现 1 次`);

const injected = BANNER + '\n' + coreSrc.replace(/\s*$/, '') + '\n' + FOOTER;
const output = template.replace(PLACEHOLDER, () => injected);

if (output.includes(PLACEHOLDER)) die('替换后占位符仍存在');
if (output.includes('\r')) die('产物里出现了 CR，请把源文件保存为 LF');
ok('core.js 已原样内联，占位符已消失');

/* ------------------------------------------------------------------ */
section('产物自检');

if (/type\s*=\s*["']module["']/i.test(output)) die('产物里出现了 type="module"（file:// 下会被 CORS 拦掉）');
ok('没有 type="module"');

const scripts = extractInlineScripts(output);
if (!scripts.length) die('产物里没有内联 <script>');
for (const pattern of [
  /<script[^>]*\bsrc\s*=/i,
  /<link[^>]*\bhref\s*=\s*["']https?:/i,
  /@import\s+(?:url\(\s*)?["']?https?:/i,
  /url\(\s*["']?https?:\/\//i,
]) {
  if (pattern.test(output)) die('产物里有外部资源引用（必须完全离线）: ' + pattern);
}
ok('没有任何外部 http(s) 资源引用（无 CDN / 无外链字体）');

for (const [i, s] of scripts.entries()) {
  try {
    new vm.Script(s.code, { filename: `mobile/index.html#inline-script-${i}` });
  } catch (err) {
    die(`第 ${i + 1} 个内联脚本语法错误: ${err.message}`);
  }
}
ok(`${scripts.length} 个内联脚本都能通过 vm.Script 编译`);

for (const fn of ['function decideBadge', 'decideBadge: decideBadge', 'function buildIndex', 'function ownedByOthers', 'function parseAppId', 'function summarize']) {
  if (!output.includes(fn)) die('产物里缺少 core 的关键函数: ' + fn);
}
ok('core 的关键函数（decideBadge / buildIndex / ownedByOthers / parseAppId / summarize）都在产物里');

/* ------------------------------------------------------------------ */
section('写出产物');

let previous = null;
if (existsSync(OUT_FILE)) previous = await readFile(OUT_FILE, 'utf8');

await mkdir(dirname(OUT_FILE), { recursive: true });
await writeFile(OUT_FILE, output, 'utf8');

const bytes = Buffer.byteLength(output, 'utf8');
const before = previous == null ? null : Buffer.byteLength(previous, 'utf8');

console.log(`  输出: ${OUT_FILE}`);
console.log(`  大小: ${bytes} 字节 (${(bytes / 1024).toFixed(1)} KB) / ${output.split('\n').length} 行`);
if (before != null) console.log(`  上次: ${before} 字节`);
console.log(previous === output ? '  幂等: 与上次构建结果完全一致（无变化）' : '  幂等: 内容已更新为本次构建结果');

console.log('\n构建完成。用手机浏览器打开 mobile/index.html 即可（可直接 file:// 打开）。');
