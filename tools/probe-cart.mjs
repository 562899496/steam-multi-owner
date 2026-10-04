/*
 * 看真实购物车页的结构：找出"商品"到底放在哪个容器里、页面有没有自带 JSON 数据。
 * 用法：node tools/probe-cart.mjs
 * 说明：未登录时购物车是空的，但**结构**照样能看到（这正是我要的）。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const res = await fetch('https://store.steampowered.com/cart/', {
  headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
});
const html = await res.text();
console.log('HTTP ' + res.status + '，长度 ' + html.length);

/* 1. #application_config 上都有哪些 data-* 属性（Steam 把页面数据挂这儿） */
const cfgTag = /<div[^>]*id="application_config"[^>]*>/i.exec(html);
if (cfgTag) {
  const names = [...cfgTag[0].matchAll(/\s(data-[a-z0-9_-]+)\s*=/gi)].map((m) => m[1]);
  console.log('\n[1] #application_config 的 data-* 属性（' + names.length + ' 个）：');
  console.log('    ' + names.join(', '));
} else {
  console.log('\n[1] 没有 #application_config');
}

/* 2. 页面里有没有"购物车内容"的 JSON 键 */
console.log('\n[2] 和购物车相关的 JSON 键：');
for (const key of ['rgCartItems', 'cart_items', 'g_rgCart', 'rgItems', 'cartitem', 'shoppingcart', 'rgCartContents']) {
  const re = new RegExp('(?:&quot;|")' + key + '(?:&quot;|")', 'i');
  const hit = re.exec(html);
  console.log('    ' + key.padEnd(18) + (hit ? '命中 -> ' + JSON.stringify(html.slice(Math.max(0, hit.index - 20), hit.index + 160)) : '无'));
}

/* 3. 主内容容器的 class / id（看结构） */
console.log('\n[3] 可能的容器元素：');
for (const sel of ['application_root', 'react_root', 'cart_area', 'cart_item', 'cart_body', 'cart_contents', 'checkout', 'recommend', '为您推荐', 'responsive_page_content', 'main_content']) {
  const re = new RegExp(sel, 'gi');
  const count = (html.match(re) || []).length;
  console.log('    ' + String(sel).padEnd(26) + count);
}

/* 4. "为空"的文案与推荐区文案（我要靠它们做判断） */
console.log('\n[4] 关键文案：');
for (const text of ['您的购物车是空的', '购物车中没有', '为您推荐', 'Recommended', '移除', 'Remove']) {
  console.log('    ' + text.padEnd(14) + (html.includes(text) ? '存在' : '不存在'));
}

/* 5. 把购物车主体那一段 HTML 打出来（截断），看看真实标签长什么样 */
console.log('\n[5] 购物车主体 HTML 片段：');
const anchors = ['您的购物车是空的', 'cart_area', 'cart_body', 'application_root'];
for (const a of anchors) {
  const i = html.indexOf(a);
  if (i < 0) continue;
  console.log('  --- 在 "' + a + '" 附近（位置 ' + i + '）---');
  console.log('  ' + html.slice(Math.max(0, i - 300), i + 700).replace(/\s+/g, ' '));
  console.log('');
}
