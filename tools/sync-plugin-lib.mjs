/*
 * 把共享的纯逻辑同步进 DSH 插件包。
 * 插件安装到 profile 后会离开项目目录，所以必须自带一份副本；
 * 这个脚本保证副本永远等于 src/lib 下的真源（verify-extension.mjs 会校验一致性）。
 *
 * 用法：node tools/sync-plugin-lib.mjs [--check]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['core.js', 'steam-api.js'];
const checkOnly = process.argv.includes('--check');

let drift = 0;
for (const file of FILES) {
  const source = await readFile(join(ROOT, 'src', 'lib', file), 'utf8');
  const target = join(ROOT, 'dsh', 'lib', file);
  let current = null;
  try {
    current = await readFile(target, 'utf8');
  } catch {
    current = null;
  }
  if (current === source) {
    console.log('[一致]   dsh/lib/' + file);
    continue;
  }
  if (checkOnly) {
    drift++;
    console.log('[不一致] dsh/lib/' + file + (current === null ? '（缺失）' : ''));
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, 'utf8');
  console.log('[已同步] dsh/lib/' + file + '（' + source.length + ' 字节）');
}

if (checkOnly && drift > 0) {
  console.log('\n插件副本与真源不一致，运行 node tools/sync-plugin-lib.mjs 修复。');
  process.exit(1);
}
console.log(checkOnly ? '\n副本与真源完全一致。' : '\n同步完成。');
