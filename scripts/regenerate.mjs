/**
 * 每日重生成脚本（Node >= 18，原生 fetch，无第三方依赖）
 *
 * 模拟原站那套每日自动化管线，刷新看板的"基线层 + 热度榜 + 编辑层"：
 *
 *   1) 基线层：用 Yahoo Finance 计算每只股票的 baseQuote（价格/前收/涨跌幅/52周高低）
 *      与 baseDyn（MA5/20/60 技术面、量能资金面、52周位置），写 baselines.json。
 *   2) 热度榜：富途美股热度 Top5（scripts/futu.mjs）——取代码后用 Yahoo 机械刷新
 *      basePrice/baseChg，再调 LLM 生成 why 短评，写 hot_list.json。
 *   3) 编辑层：为默认股 + 命令行指定的新增自选股调 LLM 生成四段式深度解读
 *      （latest/fundamental/peNote/verdict），写 editorial.json（新增股注入 stockNotes）。
 *
 * 全部模块"无凭证即可跑"：缺富途源 → 热度榜空；缺 LLM key → 用占位文本兜底，
 * 绝不因外部依赖缺失而中断。配齐凭证后即为完整每日管线。
 *
 * 用法：
 *   node scripts/regenerate.mjs                         # 刷新默认列表基线 + 热度榜 + 默认股 editorial
 *   node scripts/regenerate.mjs AAPL NVDA                # 额外为这两只生成 stockNotes 并注入
 *   node scripts/regenerate.mjs --write-html            # 把热度榜与 stockNotes 注入 us-stock-dashboard.html
 *   node scripts/regenerate.mjs --refresh-default-baselines  # 同时用 live Yahoo 刷新默认自选的 baseQuote/baseDyn
 *
 * 环境变量（详见 README）：
 *   富途：FUTU_HOT_JSON / FUTU_HOST / FUTU_PORT / FUTU_TOPN
 *   LLM ：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / LLM_TIMEOUT
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchFutuHotList } from './futu.mjs';
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
// 用 const 名定位，整块替换为新字面量（保留块前注释）。非贪婪匹配到首个分号终止符。
function setConstBlock(html, name, newLiteral) {
  const re = new RegExp('const ' + name + ' = [\\s\\S]*?(\\n\\];|\\n\\};|;)');
  if (!re.test(html)) {
    console.warn(`[html] 未找到 const ${name}，跳过注入。`);
    return html;
  }
  return html.replace(re, 'const ' + name + ' = ' + newLiteral + ';\n');
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

function injectIntoHtml(opts, baselines) {
  if (!existsSync(HTML_PATH)) {
    console.warn(`[html] 找不到 ${HTML_PATH}，跳过注入。`);
    return;
  }
  let html = readFileSync(HTML_PATH, 'utf8');
  // 注意：空数组/空对象不注入，保留 HTML 中现有内容，避免误清空热度榜或自选解读
  if (Array.isArray(opts.hotStocks) && opts.hotStocks.length) {
    html = setConstBlock(html, 'hotStocks', JSON.stringify(opts.hotStocks, null, 2));
    console.log(`[html] 已注入 hotStocks（${opts.hotStocks.length} 条）。`);
  } else {
    console.log('[html] hotStocks 为空，保留现有热度榜（未写回）。');
  }
  if (opts.stockNotes && Object.keys(opts.stockNotes).length) {
    html = setConstBlock(html, 'stockNotes', JSON.stringify(opts.stockNotes, null, 2));
    console.log(`[html] 已注入 stockNotes（${Object.keys(opts.stockNotes).length} 条）。`);
  } else {
    console.log('[html] stockNotes 为空（无新增自选），保留现有解读（未写回）。');
  }
  if (baselines && Object.keys(baselines).length) {
    html = injectDefaultBaselines(html, baselines);
  }
  writeFileSync(HTML_PATH, html, 'utf8');
  console.log(`[html] 已写回 ${HTML_PATH}`);
}

/* ===================== 主流程 ===================== */
async function main() {
  const list = symbols.length ? [...new Set([...DEFAULT_SYMBOLS, ...symbols])] : DEFAULT_SYMBOLS;

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

  // 2) 热度榜（富途 + LLM why）
  console.log('\n[2/3] 取富途热度榜并生成 why…');
  const hotList = await refreshHotList();
  writeFileSync(resolve(ROOT, 'hot_list.json'), JSON.stringify(hotList, null, 2), 'utf8');
  console.log(`     已写出 hot_list.json（${hotList.length} 条；无富途源则为空，属正常降级）。`);

  // 3) 编辑层（LLM 四段式）
  console.log('\n[3/3] 生成编辑性长文…');
  const editorial = {};
  // 默认股 + 命令行指定股都生成（默认股写入 editorial.json 备查，不覆盖手写文本）
  const noteTargets = [...new Set([...DEFAULT_SYMBOLS, ...symbols])];
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
    // stockNotes：仅注入命令行明确指定的"新增自选股"（默认股走手写/每日任务，不覆盖）
    const added = symbols.filter((s) => !DEFAULT_SYMBOLS.includes(s));
    const stockNotesObj = {};
    if (added.length) {
      for (const s of added) if (editorial[s]) stockNotesObj[s] = editorial[s];
    }
    // 空热度榜/空自选不注入，避免误清空；defaultStocks 基线始终按需刷新
    const injectOpts = {};
    if (hotList.length) injectOpts.hotStocks = hotList;
    if (Object.keys(stockNotesObj).length) injectOpts.stockNotes = stockNotesObj;
    injectIntoHtml(injectOpts, baselines);
  }

  if (REFRESH_DEFAULT_BASE) {
    console.log('\n[提示] --refresh-default-baselines 已并入 --write-html：默认股 baseQuote/baseDyn 每日自动刷新，长文不动。');
  }

  console.log('\n完成。热度榜见 FUTU_* 配置；长文见 LLM_* 配置；二者缺失时已用占位/空兜底，管线不中断。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
