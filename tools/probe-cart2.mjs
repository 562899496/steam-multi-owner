/*
 * 深入看 #application_config 上几个 data-* 里到底有什么（尤其 data-cart_config）。
 * 用法：node tools/probe-cart2.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

function decode(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

const res = await fetch('https://store.steampowered.com/cart/', {
  headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
});
const html = await res.text();
const cfgTag = (/<div[^>]*id="application_config"[^>]*>/i.exec(html) || [''])[0];

const attrs = {};
for (const m of cfgTag.matchAll(/\s(data-[a-z0-9_-]+)\s*=\s*"([^"]*)"/gi)) attrs[m[1]] = decode(m[2]);

for (const name of Object.keys(attrs)) {
  const val = attrs[name];
  console.log('=== ' + name + '（' + val.length + ' 字节）===');
  let pretty = val;
  try { pretty = JSON.stringify(JSON.parse(val), null, 1); } catch (e) { /* 不是 JSON */ }
  // 只看和购物车相关的键，避免刷屏
  if (/cart/i.test(name)) {
    console.log(pretty.slice(0, 2500));
  } else {
    const keys = [];
    try { const j = JSON.parse(val); for (const k of Object.keys(j)) keys.push(k + (/(cart|item|count)/i.test(k) ? ' ★' : '')); } catch (e) { /* ignore */ }
    console.log('  顶层键：' + (keys.length ? keys.join(', ') : '（非 JSON）'));
    console.log('  片段：' + pretty.slice(0, 300));
  }
  console.log('');
}
