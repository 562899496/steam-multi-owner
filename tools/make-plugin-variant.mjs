/*
 * 生成一个「换了名和目录」的插件副本，用于在 DSH 里验证刚改过的代码。
 *
 * 为什么需要它：DSH 的 loader 对同一个目录只导入一次 JS 模块，
 * 改了 dsh/lib/index.js 之后再开关 bundle，仍然是旧的模块代际在应答
 * （官方文档也写明：替换已安装的包需要重启才能加载新的一代）。
 * 从一个从未被导入过的新目录安装，会走全新模块代际，于是不用重启也能验证。
 *
 * 用法：node tools/make-plugin-variant.mjs [目标目录]
 */
import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'dsh');
const DST = resolve(process.argv[2] || join(ROOT, '.verify-plugin'));
const VARIANT_NAME = '@local/steam-multi-owner-verify';

await rm(DST, { recursive: true, force: true });
await cp(SRC, DST, { recursive: true });

const pkgPath = join(DST, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
const oldName = pkg.name;
pkg.name = VARIANT_NAME;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

const patchPath = join(DST, 'cordis.patch.yml');
const rowId = 'steam-multi-owner-verify';
const patch = (await readFile(patchPath, 'utf8'))
  .replace(/^(\s*-\s*id:\s*).*$/m, '$1' + rowId)
  .replace(/^(\s*name:\s*').*('\s*)$/m, '$1' + VARIANT_NAME + '$2');
await writeFile(patchPath, patch, 'utf8');

console.log('已生成验证副本：' + DST);
console.log('包名：' + oldName + ' -> ' + pkg.name + ' / row id：' + rowId);
console.log('提示：验证完记得 plugin_manager remove_bundle ' + VARIANT_NAME + ' 并删除该目录。');
