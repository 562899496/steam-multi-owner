/*
 * 把 dsh/ 打包成一个"可安装的副本"，目录名带版本号。
 *
 * 为什么必须换新目录：DSH 的 loader 按**解析后的文件路径**缓存 JS 模块代际。
 * 同一个目录改了代码后再装卸 bundle，跑的还是旧代码（现象极具迷惑性：
 * 磁盘上的文件明明是新的，工具返回的却是老逻辑）。换一个没被导入过的目录路径
 * 才会加载新的一代，于是不用重启 DSH 也能让改动生效。
 *
 * 用法：node tools/pack-plugin.mjs
 * 之后：plugin_manager install_bundle <输出的目录>
 */
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'dsh');

const pkg = JSON.parse(await readFile(join(SRC, 'package.json'), 'utf8'));
const DST = join(ROOT, 'dsh-install-' + pkg.version);

await rm(DST, { recursive: true, force: true });
await cp(SRC, DST, { recursive: true });

// 打包时把版本号**字面量替换**进代码里。
// 不要在运行时读 package.json、也不要动态 import ——
// 插件由 DSH 的 loader 加载，import.meta.url 与相对模块解析都不保证可用
//（两种办法实测都只能拿到 unknown）。字面量替换零依赖、零失败点。
const indexPath = join(DST, 'lib', 'index.js');
const indexSrc = await readFile(indexPath, 'utf8');
const PLACEHOLDER = '__SMO_PLUGIN_VERSION__';
if (!indexSrc.includes(PLACEHOLDER)) {
  throw new Error('lib/index.js 里找不到版本占位符 ' + PLACEHOLDER + '，打包中止（否则版本号永远显示 dev）');
}
await writeFile(indexPath, indexSrc.split(PLACEHOLDER).join(pkg.version), 'utf8');

console.log('已打包：' + DST);
console.log('包名：' + pkg.name + ' v' + pkg.version);
console.log('版本号已写入 lib/index.js');
console.log('');
console.log('接着在会话里执行：');
console.log('  plugin_manager action=set_bundle  target=<上一步装过的包名>      enabled=false');
console.log('  plugin_manager action=install_bundle target=' + DST);
console.log('  plugin_manager action=remove_bundle target=<上一步装过的包名>');
