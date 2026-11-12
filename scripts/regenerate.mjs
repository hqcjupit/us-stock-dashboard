/**
 * 每日重生成脚本（Node >= 18，原生 fetch，无第三方依赖）
 *
 * 模拟原站那套每日自动化管线，刷新看板的"基线层 + 热度榜 + 编辑层"：
 *
 *   1) 基线层：用 Yahoo Finance 计算每只股票的 baseQuote（价格/前收/涨跌幅/52周高低）
 *      与 baseDyn（MA5/20/60 技术面、量能资金面、52周位置），写 baselines.json。
 *   2) 热度榜：富途美股热度 Top5（scripts/futu.mjs）——取代码后用 Yahoo 机械刷新
 *      basePrice/baseChg，再调 LLM 生成 why 短评，写 hot_list.json。
 *   3) 编辑层：读取线上 /api/watchlist 的自选股列表（KV，唯一真相源），为其中每一只
 *      调 LLM 重生成四段式深度解读（latest/fundamental/peNote/verdict），
 *      写 editorial.json 并合并注入 stockNotes —— 因此"用户后来新加的股票"次日即有解读，
 *      已有的解读也会每天刷新，而不是冻结在首次生成那天。
 *
 * 全部模块"无凭证即可跑"：缺富途源 → 热度榜空；缺 LLM key → 用占位文本兜底，
 * 且占位文本绝不覆盖已有真实解读；绝不因外部依赖缺失而中断。配齐凭证后即为完整每日管线。
 *
 * 用法：
 *   node scripts/regenerate.mjs --write-html   # 每日任务：按线上自选股全量重生成并注入
 *   node scripts/regenerate.mjs META --write-html  # 额外为 META（可不在自选里）生成并注入
 *
 * 环境变量（详见 README）：
 *   富途：FUTU_HOT_JSON / FUTU_HOST / FUTU_PORT / FUTU_TOPN
 *   LLM ：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / LLM_TIMEOUT
 *   自选：WATCHLIST_API_URL（默认生产域名 /api/watchlist）、WATCHLIST_CODES（直接注入代码，
 *         空格/逗号分隔，用于 CI 预取或本地离线测试；设置后不再发起网络请求）
 *   HTML_PATH：注入目标 HTML，默认 us-stock-dashboard.html
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchFutuHotList } from './futu.mjs';
import { buildMarketPulse, injectPulseIntoHtml } from './market_pulse.mjs';
import { buildModules, injectModulesIntoHtml } from './events.mjs';
import { buildExtra, injectExtraIntoHtml } from './market_extra.mjs';
import { generateEditorial, generateHotWhy, placeholderEditorial, placeholderWhy } from './llm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const HTML_PATH = process.env.HTML_PATH || resolve(ROOT, 'us-stock-dashboard.html');

// 默认要维护基线的标的（与原站 defaultStocks / hotStocks 对齐）
const DEFAULT_SYMBOLS = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'SPCX', 'MU', 'SNDK', 'INTC', '^GSPC', '^IXIC', '^DJI', '^VIX', '^TNX', '^TYX', 'DX-Y.NYB', 'CL=F', 'GC=F', 'HG=F', 'BTC-USD'];

const args = process.argv.slice(2);
const WRITE_HTML = args.includes('--write-html');
const REFRESH_DEFAULT_BASE = args.includes('--refresh-default-baselines');
const symbols = args.filter((a) => !a.startsWith('--'));

/* ===================== 线上自选股列表 ===================== */
// 服务端 /api/watchlist（KV）是自选股的唯一真相源。每日管线必须读它，
// 否则只能维护写死的默认列表，用户在网页上新加的股票永远等不到解读。
const WATCHLIST_API_URL = process.env.WATCHLIST_API_URL ||
  'https://us-stock-dashboard-bxj.pages.dev/api/watchlist';
const MAX_WATCHLIST = 20; // 接口公开可写，限制上限防止被塞满后拖垮 LLM 调用量

export function sanitizeCodes(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  return [...new Set(raw
    .map((s) => String(s || '').trim().toUpperCase())
    // 只接受常见美股代码；排除 ^ 开头的指数与任何含注入字符的内容
    .filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)))].slice(0, MAX_WATCHLIST);
}

async function fetchWatchlistCodes() {
  // CI 已用 curl 带重试预取，或本地离线测试可直接注入，避免再发一次请求
  if (process.env.WATCHLIST_CODES) {
    const codes = sanitizeCodes(process.env.WATCHLIST_CODES);
    console.log(`[watchlist] 使用 WATCHLIST_CODES（${codes.length} 只）：${codes.join(', ') || '(空)'}`);
    return codes;
  }
  let last = null;
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await fetch(WATCHLIST_API_URL, {
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'us-stock-dashboard-regenerate/1.0', 'Cache-Control': 'no-cache' },
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const j = await resp.json();
      if (!Array.isArray(j?.codes)) throw new Error('响应缺少 codes 数组');
      const codes = sanitizeCodes(j.codes);
      console.log(`[watchlist] 读取线上自选股（${codes.length} 只）：${codes.join(', ') || '(空)'}`);
      return codes;
    } catch (e) {
      last = e;
      console.warn(`[watchlist] 第 ${i + 1}/3 次读取失败：${e.message}`);
      if (i < 2) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  // 拉取失败时不猜列表；main() 会退回 HTML 内嵌 stockNotes 的 keys 继续全量刷新，
  // 绝不因网络抖动让个股解读冻结在上一次成功的那天。
  console.warn(`[watchlist] 三次读取均失败（${last?.message}），将改用页面已有解读列表继续刷新。`);
  return null;
}

// 占位文本 / 失败结果绝不能覆盖已有的真实 LLM 解读（例如密钥临时失效时）
export function isPlaceholderNote(note) {
  if (!note || !note.latest || !note.verdict) return true;
  return /待接入\s*LLM|占位|placeholder/i.test(String(note.latest) + String(note.verdict));
}

/* ===================== YAHOO 基线计算 ===================== */
async function fetchChart(symbol, range, interval) {
  const url = `${YAHOO}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000); // 单请求上限，避免网络死挂
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; us-stock-dashboard/1.0)' },
    });
    if (!resp.ok) throw new Error('upstream ' + resp.status);
    const d = await resp.json();
    const r = d?.chart?.result?.[0];
    if (!r) throw new Error('no result');
    return r;
  } finally {
    clearTimeout(timer);
  }
}

function maAt(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function buildDyn(closes, vols, price, hi52, lo52) {
  let tech = '均线数据暂时取不到。';
  let funds = '成交量数据暂时取不到。';
  let valuationPos = null;
  if (closes.length >= 30) {
    const ma5 = maAt(closes, 5), ma20 = maAt(closes, 20), ma60 = maAt(closes, 60);
    const above = [ma5, ma20, ma60].filter((m) => m != null && price >= m).length;
    const mas = `${ma5?.toFixed(1)}、${ma20?.toFixed(1)}、${ma60?.toFixed(1)}`;
    if (above === 3) tech = `股价运行在 5/20/60 日所有均线上方（${mas}），短中期趋势偏强。`;
    else if (above === 0) tech = `股价跌破 5/20/60 日所有均线（${mas}），趋势偏弱。`;
    else tech = `股价在均线之间拉锯（${mas}），方向未明。`;
    if (vols.length >= 21) {
      const lastV = vols[vols.length - 1];
      const avg20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
      const ratio = lastV / avg20;
      if (ratio >= 1.5) funds = `最新交易日成交量是近 20 日平均的 ${ratio.toFixed(1)} 倍，明显放量。`;
      else if (ratio >= 1.1) funds = `成交量较近 20 日均量温和放大（约 ${ratio.toFixed(1)} 倍）。`;
      else if (ratio <= 0.7) funds = `成交量只有近 20 日均量的 ${(ratio * 100).toFixed(0)}%，明显缩量。`;
      else funds = `成交量与近 20 日均量基本持平（约 ${(ratio * 100).toFixed(0)}%）。`;
    }
  }
  if (hi52 && lo52 && hi52 > lo52) valuationPos = ((price - lo52) / (hi52 - lo52)) * 100;
  return { tech, funds, valuationPos };
}

async function buildBaseline(symbol) {
  const day = await fetchChart(symbol, '1d', '1m').catch(() => fetchChart(symbol, '5d', '1d'));
  const meta = day.meta;
  const price = meta.regularMarketPrice;
  let prev = meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose;
  if (prev != null && Math.abs(price - prev) / prev > 0.25) {
    const closes = (day.indicators.quote[0].close || []).filter((v) => v != null);
    prev = closes[closes.length - 2];
  }
  const baseQuote = {
    price, prev,
    changePct: ((price - prev) / prev) * 100,
    hi52: meta.fiftyTwoWeekHigh != null ? meta.fiftyTwoWeekHigh : null,
    lo52: meta.fiftyTwoWeekLow != null ? meta.fiftyTwoWeekLow : null,
    marketTime: meta.regularMarketTime != null ? meta.regularMarketTime : null,
  };

  let baseDyn = null;
  try {
    const daily = await fetchChart(symbol, '3mo', '1d').catch(() => fetchChart(symbol, '6mo', '1d'));
    const q = daily.indicators.quote[0];
    const closes = (q.close || []).filter((v) => v != null);
    const vols = (q.volume || []).filter((v) => v != null);
    baseDyn = buildDyn(closes, vols, price, baseQuote.hi52, baseQuote.lo52);
  } catch (e) { /* 日线失败则只给 baseQuote */ }
  return { symbol, baseQuote, baseDyn };
}

/* ===================== 热度榜（富途） ===================== */
async function refreshHotList() {
  const raw = await fetchFutuHotList(); // [{code,name,heat,chg}]，已过滤 ETF/停牌
  if (!raw.length) return [];
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    // 机械刷新 basePrice/baseChg（富途不提供精确报价，用 Yahoo）
    let basePrice = s.chg != null ? null : null;
    let baseChg = s.chg != null ? s.chg : null;
    try {
      const b = await buildBaseline(s.code);
      basePrice = b.baseQuote.price;
      baseChg = b.baseQuote.changePct;
    } catch (e) { /* 取不到则保留富途 chg 占位 */ }

    // 生成 why（LLM，失败用占位）
    const ctx = basePrice != null ? { price: basePrice, prev: null, changePct: baseChg, hi52: null, lo52: null, valuationPos: null } : null;
    let why = await generateHotWhy(s, ctx);
    if (!why) why = placeholderWhy(s, i + 1, raw.length);

    out.push({ code: s.code, name: s.name, basePrice, baseChg, why });
    console.log(`  ✓ 热度#${i + 1} ${s.code} $${basePrice ?? '—'} (${baseChg != null ? (baseChg >= 0 ? '+' : '') + baseChg.toFixed(2) + '%' : '—'})`);
  }
  return out;
}

/* ===================== 编辑层（LLM 长文） ===================== */
async function buildEditorial(symbol, baseline) {
  const ctx = baseline?.baseQuote
    ? { price: baseline.baseQuote.price, prev: baseline.baseQuote.prev, changePct: baseline.baseQuote.changePct, hi52: baseline.baseQuote.hi52, lo52: baseline.baseQuote.lo52, valuationPos: baseline.baseDyn?.valuationPos ?? null }
    : null;
  let note = await generateEditorial(symbol, ctx);
  if (!note) note = placeholderEditorial(symbol, ctx);
  return note;
}

/* ===================== HTML 注入 ===================== */
// 用 const 名 + 明确的结束标记定位，整块替换为新字面量（保留块前注释）。
// 按新字面量首字符决定结束标记：数组 '[' → "\\n];"，对象 '{' → "\\n};"。
// 这样即使长文里出现 ASCII 分号/方括号也不会被误判为块结束（原正则会被 ';' 截断）。
function findConstEnd(html, start, newLiteral) {
  const term = String(newLiteral).trimStart()[0] === '[' ? '\n];' : '\n};';
  const end = html.indexOf(term, start);
  return end < 0 ? null : { end, term };
}
function setConstBlock(html, name, newLiteral) {
  const start = html.indexOf('const ' + name + ' = ');
  if (start < 0) {
    console.warn(`[html] 未找到 const ${name}，跳过注入。`);
    return html;
  }
  const hit = findConstEnd(html, start, newLiteral);
  if (!hit) {
    console.warn(`[html] 未找到 const ${name} 的结束标记，跳过注入。`);
    return html;
  }
  return html.slice(0, start) + 'const ' + name + ' = ' + newLiteral + ';\n' +
    html.slice(hit.end + hit.term.length);
}

// 读取 HTML 中已有的 stockNotes 对象（合法 JSON），用于"合并注入"而非覆盖。
// 注意：结束标记 "\\n};" 里的 '}' 就是对象自身的闭合符，必须补回，否则 JSON 少一个 '}'。
function readStockNotes(html) {
  const start = html.indexOf('const stockNotes = ');
  if (start < 0) return null;
  const objStart = html.indexOf('{', start);
  const end = html.indexOf('\n};', objStart);
  if (objStart < 0 || end < 0) return null;
  try {
    return JSON.parse(html.slice(objStart, end) + '\n}');
  } catch (e) {
    console.warn('[html] 现有 stockNotes 解析失败，将以新内容替换。');
    return null;
  }
}

// 刷新 defaultStocks 内嵌的 baseQuote/baseDyn（仅替换数字块，长文 latest/fundamental 等不动）。
// 限定在 const defaultStocks = [ ... ] 范围内，避免误伤 hotStocks 等同名属性。
function injectDefaultBaselines(html, baselines) {
  const dStart = html.indexOf('const defaultStocks = [');
  if (dStart < 0) return html;
  const dEnd = html.indexOf('\n];', dStart);
  if (dEnd < 0) return html;
  let block = html.slice(dStart, dEnd);
  let n = 0;
  for (const sym of Object.keys(baselines)) {
    const b = baselines[sym];
    if (!b || !b.baseQuote) continue;
    const anchor = `code:'${sym}'`;
    const i = block.indexOf(anchor);
    if (i < 0) continue;
    const ni = block.indexOf("code:'", i + anchor.length);
    const segEnd = ni < 0 ? block.length : ni;
    let seg = block.slice(i, segEnd);
    if (b.baseQuote) seg = seg.replace(/baseQuote:\s*\{[^}]*\}/, 'baseQuote:' + JSON.stringify(b.baseQuote));
    if (b.baseDyn) seg = seg.replace(/baseDyn:\s*\{[^}]*\}/, 'baseDyn:' + JSON.stringify(b.baseDyn));
    block = block.slice(0, i) + seg + block.slice(segEnd);
    n++;
  }
  if (n) console.log(`[html] 已刷新 defaultStocks 基线（${n} 只）。`);
  return html.slice(0, dStart) + block + html.slice(dEnd);
}

/**
 * 用 stockNotes 的每日解读同步覆盖 defaultStocks 内嵌的编辑性字段，
 * 让「前端读到 defaultStocks 兜底」时也不会拿到 11/6 的手写死文本。
 * 只改 latest/fundamental/peNote/verdict 四个字段，baseQuote/baseDyn 由另一函数维护。
 */
function injectDefaultEditorial(html, notes) {
  const dStart = html.indexOf('const defaultStocks = [');
  if (dStart < 0) return html;
  const dEnd = html.indexOf('\n];', dStart);
  if (dEnd < 0) return html;
  let block = html.slice(dStart, dEnd);
  let n = 0;
  for (const sym of Object.keys(notes || {})) {
    const note = notes[sym];
    if (!note || !note.latest || !note.verdict || isPlaceholderNote(note)) continue;
    const anchor = `code:'${sym}'`;
    const i = block.indexOf(anchor);
    if (i < 0) continue;
    const ni = block.indexOf("code:'", i + anchor.length);
    const segEnd = ni < 0 ? block.length : ni;
    let seg = block.slice(i, segEnd);
    for (const k of ['latest', 'fundamental', 'peNote', 'verdict']) {
      if (!note[k]) continue;
      const re = new RegExp("(\\b" + k + ":\\s*)'(?:[^'\\\\]|\\\\.)*'");
      seg = seg.replace(re, (_m, p1) => p1 + JSON.stringify(String(note[k])));
    }
    block = block.slice(0, i) + seg + block.slice(segEnd);
    n++;
  }
  if (n) console.log(`[html] 已同步 defaultStocks 编辑性字段（${n} 只）。`);
  return html.slice(0, dStart) + block + html.slice(dEnd);
}

export function injectIntoHtml(opts, baselines, pulse, modules, extra) {
  if (!existsSync(HTML_PATH)) {
    console.warn(`[html] 找不到 ${HTML_PATH}，跳过注入。`);
    return;
  }
  let html = readFileSync(HTML_PATH, 'utf8');
  // 热度榜以 market_extra.mjs 的 Yahoo 热搜榜为准（富途 OpenD 在 CI 里不可用，
  // 其 hotList 通常为空）；富途源可用时仍可作为兜底。
  const hot = Array.isArray(extra?.hotStocks) && extra.hotStocks.length
    ? extra.hotStocks : opts.hotStocks;
  // 注意：空数组/空对象不注入，保留 HTML 中现有内容，避免误清空热度榜或自选解读
  if (Array.isArray(hot) && hot.length) {
    html = setConstBlock(html, 'hotStocks', JSON.stringify(hot, null, 2));
    console.log(`[html] 已注入 hotStocks（${hot.length} 条，来源：${extra?.hotStocks?.length ? 'Yahoo 热搜榜' : '富途热度榜'}）。`);
  } else {
    console.log('[html] hotStocks 为空，保留现有热度榜（未写回）。');
  }
  if (opts.stockNotes && Object.keys(opts.stockNotes).length) {
    // 合并已有 stockNotes，避免覆盖此前注入的解读（如 AMD）；支持方案A多次追加新股
    const existing = readStockNotes(html);
    const merged = existing ? { ...existing, ...opts.stockNotes } : { ...opts.stockNotes };
    html = setConstBlock(html, 'stockNotes', JSON.stringify(merged, null, 2));
    html = injectDefaultEditorial(html, merged);
    console.log(`[html] 已合并 stockNotes（共 ${Object.keys(merged).length} 条，本次新增/更新 ${Object.keys(opts.stockNotes).length} 条）。`);
  } else {
    console.log('[html] stockNotes 为空（无新增自选），保留现有解读（未写回）。');
    // 即便本次没有新解读，也让默认股的兜底文字与最近一次解读保持一致，
    // 避免 11/6 的手写快照残留在 defaultStocks 里。
    const existing = readStockNotes(html);
    if (existing) html = injectDefaultEditorial(html, existing);
  }
  if (baselines && Object.keys(baselines).length) {
    html = injectDefaultBaselines(html, baselines);
  }
  // 01 模块市场脉搏：用真实指数/VIX 行情重写一句话、指数点评、情绪解读与 EDITORIAL_DATE
  const beforePulse = html;
  html = injectPulseIntoHtml(html, pulse);
  if (html !== beforePulse) console.log('[html] 已注入市场脉搏文案与解读日期。');
  // 02 事件 / 05 日程：用真实新闻 RSS + 经济/财报日历每日重写（此前是 11/6 编辑部静态快照）
  if (modules) {
    const beforeModules = html;
    html = injectModulesIntoHtml(html, modules);
    if (html !== beforeModules) console.log('[html] 已重写 02/05 模块并更新 EVENTS_DATE。');
  }
  // 01 情绪分 / 03 主题 / 06 宏观仪表盘：真实行情每日重算并重写（此前 03/06 是 11/6 静态快照）
  if (extra) {
    const beforeExtra = html;
    html = injectExtraIntoHtml(html, extra);
    if (html !== beforeExtra) console.log('[html] 已重写 01 情绪分 / 03 主题 / 06 宏观解读并更新 EXTRA_DATE。');
  }
  writeFileSync(HTML_PATH, html, 'utf8');
  console.log(`[html] 已写回 ${HTML_PATH}`);
}

/* ===================== 主流程 ===================== */
async function main() {
  const watchlist = await fetchWatchlistCodes();
  // 拉取成功 → 以线上自选股为长文目标；失败 → 退回页面已有 stockNotes 的 keys，
  // 保证网络抖动时个股解读仍会按当天行情重写，而不是冻结在上一次成功的那天。
  let autoTargets = watchlist && watchlist.length ? watchlist : null;
  if (!autoTargets) {
    try {
      const cur = readStockNotes(readFileSync(HTML_PATH, 'utf8'));
      const keys = cur ? Object.keys(cur) : [];
      if (keys.length) {
        autoTargets = keys;
        console.log(`[watchlist] 兜底：按页面已有解读列表全量刷新 ${keys.length} 只：${keys.join(', ')}`);
      }
    } catch (e) {
      console.warn('[watchlist] 读取页面已有解读失败：' + e.message);
    }
  }
  const list = [...new Set([...DEFAULT_SYMBOLS, ...symbols, ...(autoTargets || [])])];

  // 1) 基线层
  console.log(`\n[1/3] 刷新 ${list.length} 只标的的基线数据…`);
  const baselines = {};
  for (const sym of list) {
    try {
      const b = await buildBaseline(sym);
      baselines[sym] = b;
      console.log(`  ✓ ${sym}  $${b.baseQuote.price} (${b.baseQuote.changePct >= 0 ? '+' : ''}${b.baseQuote.changePct.toFixed(2)}%)`);
    } catch (e) {
      console.warn(`  ✗ ${sym} 失败: ${e.message}`);
    }
  }
  writeFileSync(resolve(ROOT, 'baselines.json'), JSON.stringify(baselines, null, 2), 'utf8');
  console.log('     已写出 baselines.json');

  // 1.5) 市场脉搏：复用上面刷新的真实指数/VIX 行情，生成 01 模块文案
  let marketPulse = null;
  try {
    marketPulse = await buildMarketPulse(baselines);
    if (marketPulse) {
      writeFileSync(resolve(ROOT, 'market_pulse.json'), JSON.stringify(marketPulse, null, 2), 'utf8');
      console.log(`     已写出 market_pulse.json（解读基于 ${marketPulse.editorialDate || '最新交易日'}）`);
    }
  } catch (e) {
    console.warn('[pulse] 生成失败，保留现有文案：', e.message);
  }

  // 2) 热度榜（富途 + LLM why）
  console.log('\n[2/3] 取富途热度榜并生成 why…');
  const hotList = await refreshHotList();
  writeFileSync(resolve(ROOT, 'hot_list.json'), JSON.stringify(hotList, null, 2), 'utf8');
  console.log(`     已写出 hot_list.json（${hotList.length} 条；无富途源则为空，属正常降级）。`);

  // 3) 编辑层（LLM 四段式）
  console.log('\n[3/3] 生成编辑性长文…');
  const editorial = {};
  // 只给"当前自选股 + 手动指定股"生成长文（而非 20 个指数/商品标的），省下大量无效 LLM 调用；
  // 读取自选股失败时退回默认列表，仅写 editorial.json 备查、不注入 HTML。
  const noteTargets = [...new Set([...(autoTargets || DEFAULT_SYMBOLS), ...symbols])];
  for (const sym of noteTargets) {
    try {
      const note = await buildEditorial(sym, baselines[sym]);
      editorial[sym] = note;
      console.log(`  ✓ ${sym} 长文${process.env.LLM_API_KEY ? '' : '（占位）'}已生成`);
    } catch (e) {
      console.warn(`  ✗ ${sym} 长文失败: ${e.message}`);
    }
  }
  writeFileSync(resolve(ROOT, 'editorial.json'), JSON.stringify(editorial, null, 2), 'utf8');
  console.log('     已写出 editorial.json');

  // 4) 注入 HTML（可选）
  if (WRITE_HTML) {
    console.log('\n[注入] --write-html 已启用');
    // 每日全量：线上自选股列表里的每一只都重新生成解读（既刷新此前冻结的 AMD/GOOGL/NVDA，
    // 也为用户新加但尚无解读的 INTC 等自动补上）；方案A 手动指定的代码额外并入。
    // 配合前端 buildStocks 的"stockNotes 优先"逻辑，可为任意股票（含默认股）重生成长文。
    const targets = [...new Set([...(autoTargets || []), ...symbols])];
    const stockNotesObj = {};
    // 时间戳用于和「加入自选时由 /api/notes 即时生成并写入 KV」的解读比较新旧：
    // 前端按 generatedAt 取较新者，保证每日全量刷新能覆盖当天早些时候的即时解读。
    const generatedAt = new Date().toISOString();
    let skipped = 0;
    for (const s of targets) {
      if (isPlaceholderNote(editorial[s])) {
        skipped++;
        console.warn(`[html] ${s} 本次未拿到真实 LLM 解读，保留已有内容（不覆盖）。`);
        continue;
      }
      stockNotesObj[s] = { ...editorial[s], generatedAt };
    }
    console.log(`[html] 本次待写入解读 ${Object.keys(stockNotesObj).length} 只：${Object.keys(stockNotesObj).join(', ') || '(无)'}${skipped ? `；跳过占位/失败 ${skipped} 只` : ''}`);
    // 空热度榜/空自选不注入，避免误清空；defaultStocks 基线始终按需刷新
    const injectOpts = {};
    if (hotList.length) injectOpts.hotStocks = hotList;
    if (Object.keys(stockNotesObj).length) injectOpts.stockNotes = stockNotesObj;

    // 02/05 模块：抓真实新闻与财经日历，交给 LLM 翻译/写看点（无 key 时降级为原标题 + 中文模板）
    let modulesData = null;
    try {
      modulesData = await buildModules();
      writeFileSync(resolve(ROOT, 'events.json'), JSON.stringify(modulesData.news, null, 2), 'utf8');
      writeFileSync(resolve(ROOT, 'calendar.json'), JSON.stringify(modulesData.calendar, null, 2), 'utf8');
      console.log(`[events] 02 新闻 ${modulesData.news.length} 条 / 05 日程 ${modulesData.calendar.length} 条，更新于 ${modulesData.updatedAt}`);
    } catch (e) {
      console.warn('[events] 02/05 刷新失败，保留现有内容：' + e.message);
    }

    // 01 情绪分 / 03 主题 / 06 宏观仪表盘：Yahoo 板块 ETF + 宏观行情 + FRED DGS2 + 热搜榜
    let extraData = null;
    try {
      extraData = await buildExtra();
      writeFileSync(resolve(ROOT, 'market_extra.json'), JSON.stringify({
        updatedAt: extraData.updatedAt,
        sentiment: extraData.sentiment,
        ust2y: extraData.ust2y,
        sectors: extraData.sectors,
        hotStocks: extraData.hotStocks,
        metrics: extraData.metrics?.map((r) => ({ id: r.id, value: r.value, change: r.change })),
      }, null, 2), 'utf8');
      console.log(`[extra] 情绪分 ${extraData.sentiment?.score ?? '—'} / 板块 ${extraData.sectors?.length ?? 0} 个 / 热搜 ${extraData.hotStocks?.length ?? 0} 只 / 宏观卡 ${extraData.metrics?.length ?? 0} 张，更新于 ${extraData.updatedAt}`);
    } catch (e) {
      console.warn('[extra] 01/03/06 刷新失败，保留现有内容：' + e.message);
    }
    injectIntoHtml(injectOpts, baselines, marketPulse, modulesData, extraData);
  }

  if (REFRESH_DEFAULT_BASE) {
    console.log('\n[提示] --refresh-default-baselines 已并入 --write-html：默认股 baseQuote/baseDyn 每日自动刷新，长文不动。');
  }

  console.log('\n完成。热度榜见 FUTU_* 配置；长文见 LLM_* 配置；二者缺失时已用占位/空兜底，管线不中断。');
}

// 仅在被直接执行时跑主流程；被 import 时只暴露纯函数，便于离线测试而不触发网络/LLM。
const isDirectRun = process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase();
if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
