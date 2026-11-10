#!/usr/bin/env node
/**
 * 校验生产站点是否已包含本次生成的长文，防止「部署步骤显示成功、线上却仍是旧版」的假成功。
 *
 * 部署完成后 Cloudflare 边缘节点常有数秒传播延迟，因此除了网络错误，
 * 「内容不一致」也会轮询重试，全部一致才通过；耗尽仍缺才真正标红。
 *
 * CI 中由 .github/workflows/daily.yml 在部署后调用，也可本地运行：
 *   node scripts/verify-live.mjs [url]
 *   LIVE_PATH=/path/to/live.html node scripts/verify-live.mjs   # 离线自测，不联网、不重试
 *   SRC_PATH=us-stock-dashboard.html node scripts/verify-live.mjs
 * 可用 VERIFY_ATTEMPTS（默认 6）/ VERIFY_WAIT_MS（默认 10000）调整等待策略。
 */
import { readFileSync } from 'node:fs';

const URL_DEFAULT = 'https://us-stock-dashboard-bxj.pages.dev/';
const url = process.argv[2] || URL_DEFAULT;
const srcPath = process.env.SRC_PATH || 'index.html';
const livePath = process.env.LIVE_PATH || '';
const attempts = livePath ? 1 : Number(process.env.VERIFY_ATTEMPTS || 6);
const waitMs = Number(process.env.VERIFY_WAIT_MS || 10000);

function stockNoteKeys(html) {
  const s = html.indexOf('const stockNotes = ');
  if (s < 0) return [];
  const o = html.indexOf('{', s);
  const e = html.indexOf('\n};', o);
  if (o < 0 || e < 0) return [];
  try {
    return Object.keys(JSON.parse(html.slice(o, e) + '\n}'));
  } catch {
    return [];
  }
}

// 本地若处于需代理的网络，用 setGlobalDispatcher 让全局 fetch 走代理（与 llm.mjs 一致）。
// 注意：不能把本地 undici 的 ProxyAgent 直接作为 fetch 的 dispatcher 选项传入——
// Node 内置 undici 与 npm 版 undici 版本不同会报 "invalid onRequestStart method"。
// CI 直连环境没有代理变量，也不会加载 undici，零依赖。
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy;
if (proxy && !livePath) {
  try {
    const undici = await import('undici');
    if (undici?.ProxyAgent && undici?.setGlobalDispatcher) {
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
      console.log('[verify] 检测到代理，已启用全局出站 dispatcher');
    }
  } catch {
    console.log('[verify] 未安装 undici，忽略代理设置');
  }
}

async function fetchLiveOnce() {
  // 加时间戳参数绕过中间缓存
  const target = url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now();
  const r = await fetch(target, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const src = readFileSync(srcPath, 'utf8');
const want = stockNoteKeys(src);
console.log(`[verify] 源文件 ${srcPath}：stockNotes = ${want.join(', ') || '(空)'}`);

let got = [];
let missing = want;
for (let i = 1; i <= attempts; i++) {
  let live = '';
  try {
    live = livePath ? readFileSync(livePath, 'utf8') : await fetchLiveOnce();
  } catch (err) {
    console.log(`[verify] 第 ${i}/${attempts} 次拉取失败：${err.message}`);
  }
  if (live) got = stockNoteKeys(live);
  console.log(`[verify] 第 ${i}/${attempts} 次回读 ${livePath || url}：stockNotes = ${got.join(', ') || '(空)'}`);
  missing = want.filter((k) => !got.includes(k));
  if (!missing.length) {
    console.log(`[verify] 线上已包含本次全部长文（第 ${i} 次回读确认）`);
    process.exit(0);
  }
  if (i < attempts) {
    console.log(`[verify] 尚缺 ${missing.join(', ')}，${waitMs / 1000}s 后重试（部署可能仍在边缘传播）…`);
    await sleep(waitMs);
  }
}

console.error(`::error::线上仍缺少 ${missing.join(', ')} —— 部署未生效或 CDN 缓存未刷新`);
process.exit(1);
