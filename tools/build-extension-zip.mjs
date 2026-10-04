/*
 * 把扩展打包成"下载就能用"的 zip。
 *
 * 为什么要它：使用者大多不想看源码，只想要一个能装进 Chrome 的文件。
 * Chrome 稳定版**不能**直接拖 .crx 安装（会被拦），最可靠的路径是：
 *   解压 zip -> chrome://extensions -> 开发者模式 -> 加载已解压的扩展程序 -> 选中解压出来的文件夹
 * 所以这里产出的 zip 只包含扩展真正需要的文件（manifest.json / src / icons），
 * 解压出来那一层就是可直接加载的扩展目录。
 *
 * 用法：
 *   node tools/build-extension-zip.mjs            # 打包到 dist/
 *   node tools/build-extension-zip.mjs --verify   # 打包 + 自检（解压并真的让 Chrome 加载一次）
 *
 * 说明：zip 读写都用 Node 自带的 zlib 手写实现，不引入任何依赖，
 * 也不依赖 PowerShell 的 Compress-Archive（换平台/换 shell 都能跑）。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------ zip 写入 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 固定时间戳 -> 每次打包结果一致（方便比对，也避免无意义的 diff） */
function dosDateTime() {
  // 2020-01-01 00:00:00
  const time = 0;
  const date = ((2020 - 1980) << 9) | (1 << 5) | 1;
  return { time, date };
}

function zipWrite(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();

  for (const file of files) {
    const nameBuf = Buffer.from(file.name.split(sep).join('/'), 'utf8');
    const raw = file.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ------------------------------ zip 读取（自检用） ------------------------------ */

function zipRead(buf) {
  // 从尾部找 EOCD（注释最长 65535，这里没有注释，直接倒着找签名）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('本地头损坏：' + name);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const body = buf.slice(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : body;
    if (data.length !== usize) throw new Error('解压长度不符：' + name);
    if (crc32(data) !== crc) throw new Error('CRC 校验失败：' + name);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ------------------------------ 收集要打包的文件 ------------------------------ */

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
// 只打包扩展真正需要的：manifest + src/ + icons/
// （test/ tools/ docs/ mobile/ dsh/ 与开发配置都不进包，包越小越好装）
const INCLUDES = ['manifest.json', 'LICENSE'];
for (const dir of ['src', 'icons']) INCLUDES.push(...walk(join(ROOT, dir), ROOT));

const files = INCLUDES.map((name) => ({ name: name.split(sep).join('/'), data: readFileSync(join(ROOT, name)) }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const distDir = join(ROOT, 'dist');
mkdirSync(distDir, { recursive: true });
const zipName = 'steam-multi-owner-v' + manifest.version + '.zip';
const zipPath = join(distDir, zipName);

/* ------------------------------ --check：只检查，不重新打包 ------------------------------ */
// 用途：发版前确认 dist/ 里的包确实是**当前源码**打的，而不是忘了重新打包的旧包。
if (process.argv.includes('--check')) {
  const problems = [];
  const existing = readdirSync(distDir).filter((f) => f.endsWith('.zip'));
  if (!existing.includes(zipName)) problems.push('缺少 ' + zipName + '（跑 npm run build:zip）');
  for (const stale of existing.filter((f) => f !== zipName)) {
    problems.push('存在过期包 dist/' + stale + '（删掉，避免用户下错版本）');
  }
  if (existing.includes(zipName)) {
    const entries = zipRead(readFileSync(zipPath));
    if (entries.length !== files.length) problems.push('包内文件数 ' + entries.length + ' != 应为 ' + files.length);
    for (const e of entries) {
      const src = files.find((f) => f.name === e.name);
      if (!src) { problems.push('包内多了文件：' + e.name); continue; }
      if (!src.data.equals(e.data)) problems.push('与源码不一致：' + e.name);
    }
  }
  if (problems.length) {
    console.log('dist 检查未通过：');
    for (const p of problems) console.log('  ✖ ' + p);
    process.exit(1);
  }
  console.log('dist 检查通过：dist/' + zipName + ' 与当前源码（v' + manifest.version + '，' + files.length + ' 个文件）逐字节一致。');
  process.exit(0);
}

writeFileSync(zipPath, zipWrite(files));

const totalRaw = files.reduce((s, f) => s + f.data.length, 0);
console.log('已打包：dist/' + zipName);
console.log('  版本：' + manifest.version + '，文件 ' + files.length + ' 个，原始 ' + (totalRaw / 1024).toFixed(1) +
  ' KB -> zip ' + (readFileSync(zipPath).length / 1024).toFixed(1) + ' KB');
console.log('  内容：' + files.map((f) => f.name).join('、'));

if (process.argv.includes('--verify')) {
  console.log('\n开始自检（解压 + 让 Chrome 真的加载一次）…');
  const buf = readFileSync(zipPath);
  const entries = zipRead(buf);
  if (entries.length !== files.length) throw new Error('zip 里的文件数不对');
  for (const e of entries) {
    const src = files.find((f) => f.name === e.name);
    if (!src) throw new Error('zip 里多了文件：' + e.name);
    if (!src.data.equals(e.data)) throw new Error('内容不一致：' + e.name);
  }
  console.log('  ✔ zip 结构完好、' + entries.length + ' 个文件内容与源文件逐字节一致');

  const tmp = mkdtempSync(join(tmpdir(), 'smo-dist-'));
  for (const e of entries) {
    const target = join(tmp, e.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.data);
  }
  console.log('  ✔ 已解压到 ' + tmp);

  const { launchChrome, CdpSession, httpGetJson, waitForTarget } = await import('./cdp.mjs');
  const chromePath = process.env.SMO_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const port = 9466;
  const chrome = await launchChrome({ port, chromePath, extraArgs: ['--enable-unsafe-extension-debugging'] });
  try {
    const version = await httpGetJson('http://127.0.0.1:' + port + '/json/version');
    const browser = await CdpSession.open(version.webSocketDebuggerUrl);
    await browser.send('Target.setDiscoverTargets', { discover: true });
    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: tmp });
    if (!extId) throw new Error('Chrome 没有返回扩展 id');
    console.log('  ✔ Chrome 成功加载了解压出来的文件夹，扩展 id = ' + extId.slice(0, 8) + '…');
    const sw = await waitForTarget(port, (t) => t.type === 'service_worker' && t.url.includes(extId), 15000);
    const swSession = await CdpSession.open(sw.webSocketDebuggerUrl);
    await swSession.enableRuntime();
    await new Promise((r) => setTimeout(r, 800));
    const info = await swSession.evaluate(`(async () => {
      const m = chrome.runtime.getManifest();
      const state = await chrome.storage.local.get(null);
      return { name: m.name, version: m.version, permissions: m.permissions.length, storage: Object.keys(state).length };
    })()`);
    console.log('  ✔ 后台已启动：' + info.name + ' v' + info.version + '（权限 ' + info.permissions + ' 项）');
    swSession.close();
    browser.close();
  } finally {
    await chrome.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\n自检通过：这个 zip 解压后可以被 Chrome 直接加载。');
}
