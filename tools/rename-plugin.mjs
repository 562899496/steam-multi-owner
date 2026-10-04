/*
 * 改插件包的 name 与 patch 里的 row id / name（用于拿到全新的模块代际，见 cordis.patch.yml 注释）。
 * 用法：node tools/rename-plugin.mjs <新包名> <新row id>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const newName = process.argv[2];
const newRowId = process.argv[3] || newName.replace(/^@[^/]+\//, '');
if (!newName) {
  console.error('用法：node tools/rename-plugin.mjs <新包名> [新row id]');
  process.exit(1);
}

const pkgPath = join(ROOT, 'dsh', 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
const oldName = pkg.name;
pkg.name = newName;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

const patchPath = join(ROOT, 'dsh', 'cordis.patch.yml');
let patch = await readFile(patchPath, 'utf8');
patch = patch
  .replace(/^(\s*-\s*id:\s*).*$/m, '$1' + newRowId)
  .replace(/^(\s*name:\s*').*('\s*)$/m, '$1' + newName + '$2');
await writeFile(patchPath, patch, 'utf8');

console.log('包名：' + oldName + ' -> ' + newName);
console.log('row id：' + newRowId);
console.log('接着执行：plugin_manager remove_bundle <旧包名> 然后 install_bundle ' + join(ROOT, 'dsh'));
