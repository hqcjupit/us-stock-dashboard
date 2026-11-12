/**
 * 全站"剩余静态模块"的每日真实数据生成器（Node >= 18，原生 fetch，无第三方依赖）
 *
 * 覆盖：
 *   01 市场情绪综合分 —— CNN 官方 Fear & Greed 公开接口已下线，改为本看板基于 Yahoo 公开
 *      行情自行计算的六分项综合分（指数动能 / 板块宽度 / VIX / 避险需求 / 信用需求 / 指数动量），
 *      页面明确标注口径，绝不再挂一个假的静态数字。
 *   03 市场主题 —— 11 只 SPDR 行业 ETF 当日涨跌（Yahoo spark 批量）+ Yahoo 美股热搜榜，
 *      LLM 只做基于给定数字的叙述与常识性"看什么"，禁止编造新闻/财报/政策。
 *   06 核心指标仪表盘 —— 9 张卡全部用 Yahoo 行情 + FRED DGS2 重算数值、涨跌、解读与来源，
 *      三句话串讲每日重写；原「12 月加息概率 78%」无可靠免费数据源，已替换为真实的
 *      「2 年期美债收益率（FRED DGS2）」，并同步供 2Y-10Y 利差卡使用。
 *
 * 设计原则（与 events.mjs 一致）：
 *   - 全部数值来自公开行情，LLM 只写文字；输出经禁词清洗 + 长度截断。
 *   - 任一模块本次取数失败 → 保留上次内容并前置醒目警告，绝不静默留过期内容冒充新内容。
 *   - 无 LLM key 也能跑：降级为基于真实数字的机械模板，不写占位套话。
 *
 * 用法：
 *   node scripts/market_extra.mjs --write-html      # 单独调试：抓数 + 生成 + 注入两份 HTML
 *   由 scripts/regenerate.mjs 每日管线自动调用 buildExtra() / injectExtraIntoHtml()
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatJson } from './llm.mjs';
import { esc, bjStamp } from './events.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (compatible; us-stock-dashboard/1.0)';
const SPARK = 'https://query1.finance.yahoo.com/v7/finance/spark';
const TRENDING = 'https://query1.finance.yahoo.com/v1/finance/trending/US?count=10';
const FRED_DGS2 = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2';

const SECTORS = [
  ['XLK', '科技'], ['XLC', '通信服务'], ['XLY', '可选消费'], ['XLP', '必需消费'],
  ['XLB', '材料'], ['XLE', '能源'], ['XLF', '金融'], ['XLV', '医疗'],
  ['XLI', '工业'], ['XLU', '公用事业'], ['XLRE', '房地产'],
];

const MACRO_SYMBOLS = [
  '^TNX', '^TYX', 'DX-Y.NYB', 'CL=F', 'GC=F', 'HG=F', 'BTC-USD', '^GSPC', '^VIX',
];
const SENTIMENT_SYMBOLS = ['SPY', 'HYG', 'IEF'];

const ZH_NAMES = {
  NVDA: '英伟达', AAPL: '苹果', TSLA: '特斯拉', MSFT: '微软', AMZN: '亚马逊',
  GOOGL: '谷歌', GOOG: '谷歌', META: 'Meta', AMD: '超威半导体', INTC: '英特尔',
  AVGO: '博通', MU: '美光科技', NFLX: '奈飞', PLTR: 'Palantir', MSTR: 'Strategy',
  BABA: '阿里巴巴', NBIS: 'Nebius', LLY: '礼来', CSCO: '思科', WMT: '沃尔玛',
  COIN: 'Coinbase', SOFI: 'SoFi', UBER: '优步', DIS: '迪士尼', BA: '波音',
  SNDK: '闪迪', SPCX: 'SpaceX', CRWD: 'CrowdStrike', ORCL: '甲骨文', IBM: 'IBM',
};

const BANNED = /财报超预期|受.{0,8}(消息|传闻)推动|创下?新高|突破|后市有望|资金流入|机构上调|评级上调|预计将|有望|最大单日|利好刺激|主力净流入|必将|一定会涨|加息概率|非农太强|下周.{0,6}试金石/g;

/* ==================== 抓取 ==================== */
async function fetchText(url, timeout = 20000, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/csv, */*' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (!t || t.length < 20) throw new Error('empty response');
      return t;
    } catch (e) {
      last = e;
      if (i < retries - 1) await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last || new Error('fetch failed');
}

/** Yahoo spark：一次请求拿多个标的的日线序列与当日涨跌，避免逐只请求被限流。 */
async function spark(symbols, range = '1mo') {
  const q = symbols.map(encodeURIComponent).join(',');
  const url = `${SPARK}?symbols=${q}&range=${range}&interval=1d`;
  const j = JSON.parse(await fetchText(url));
  const out = new Map();
  for (const r of j?.spark?.result || []) {
    const d = r.response?.[0];
    if (!d) continue;
    const closes = (d.indicators?.quote?.[0]?.close || [])
      .filter((v) => typeof v === 'number' && Number.isFinite(v));
    const price = Number(d.meta?.regularMarketPrice ?? closes.at(-1));
    const rawPct = Number(d.meta?.regularMarketChangePercent);
    const prev = closes.length > 1 ? closes.at(-2) : null;
    out.set(r.symbol, {
      symbol: r.symbol,
      price: Number.isFinite(price) ? price : null,
      prev,
      chgPct: Number.isFinite(rawPct) ? rawPct
        : (prev ? (price / prev - 1) * 100 : null),
      closes,
      name: d.meta?.shortName || d.meta?.longName || r.symbol,
      marketTime: d.meta?.regularMarketTime || null,
    });
  }
  return out;
}

/** FRED / 美国财政部 DGS2 序列最后一个有效值（工作日更新，通常滞后 1 个交易日）。 */
async function fetchUst2y() {
  const csv = await fetchText(FRED_DGS2);
  const lines = csv.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i > 0; i--) {
    const [date, raw] = lines[i].split(',');
    const value = Number(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) && value > 0) {
      return { date, value };
    }
  }
  throw new Error('DGS2 无有效数据');
}

async function collectHot() {
  const j = JSON.parse(await fetchText(TRENDING));
  const codes = (j?.finance?.result?.[0]?.quotes || [])
    .map((q) => String(q.symbol || '').toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9-]{0,7}$/.test(s))
    .slice(0, 10);
  if (!codes.length) throw new Error('热搜榜为空');
  const data = await spark(codes, '5d');
  return codes.slice(0, 5).map((code, i) => {
    const q = data.get(code);
    return {
      code,
      name: ZH_NAMES[code] || (q?.name && q.name !== code ? q.name : code),
      basePrice: q?.price != null ? Math.round(q.price * 100) / 100 : null,
      baseChg: q?.chgPct != null ? Math.round(q.chgPct * 100) / 100 : null,
      rank: i + 1,
    };
  }).filter((s) => s.basePrice != null);
}

/* ==================== 计算 ==================== */
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const lin = (v, lo, hi) => clamp(((v - lo) / (hi - lo)) * 100);
const r2 = (v) => Math.round(v * 100) / 100;
const pctText = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + r2(v).toFixed(2) + '%');
function ret(q, n) {
  if (!q || q.closes.length < n + 1) return null;
  const a = q.closes[q.closes.length - 1 - n];
  const b = q.closes.at(-1);
  return a ? b / a - 1 : null;
}

/** 六分项等权的市场情绪综合分；每项都记录原始数字，便于页面核对口径。 */
export function computeSentiment(snap, sectorRows) {
  const spy = snap.get('SPY'), gspc = snap.get('^GSPC'), vix = snap.get('^VIX');
  const hyg = snap.get('HYG'), ief = snap.get('IEF');
  const parts = [];
  const push = (label, score, raw) => {
    if (score == null || !Number.isFinite(score)) return;
    parts.push({ label, score: Math.round(score), raw });
  };

  if (spy && spy.closes.length >= 60) {
    const arr = spy.closes.slice(-125);
    const ma = arr.reduce((a, b) => a + b, 0) / arr.length;
    const dev = spy.closes.at(-1) / ma - 1;
    push('指数动能', lin(dev, -0.08, 0.08), `SPY 较 ${arr.length} 日均线 ${pctText(dev * 100)}`);
  }
  if (sectorRows.length) {
    const up = sectorRows.filter((s) => s.chgPct > 0).length;
    push('板块宽度', (up / sectorRows.length) * 100,
      `${sectorRows.length} 个行业 ETF 中 ${up} 个上涨`);
  }
  if (vix?.price != null) {
    push('波动率', lin(vix.price, 32, 12), `VIX ${vix.price.toFixed(2)}`);
  }
  const spy20 = ret(spy, 20), ief20 = ret(ief, 20), hyg20 = ret(hyg, 20);
  if (spy20 != null && ief20 != null) {
    push('避险需求', lin(spy20 - ief20, -0.08, 0.08),
      `SPY 与 IEF 近 20 日相对收益 ${pctText((spy20 - ief20) * 100)}`);
  }
  if (hyg20 != null && ief20 != null) {
    push('信用需求', lin(hyg20 - ief20, -0.05, 0.05),
      `HYG 与 IEF 近 20 日相对收益 ${pctText((hyg20 - ief20) * 100)}`);
  }
  const gspc20 = ret(gspc, 20);
  if (gspc20 != null) {
    push('指数动量', lin(gspc20, -0.08, 0.08), `标普500 近 20 日 ${pctText(gspc20 * 100)}`);
  }
  if (!parts.length) return null;
  const score = Math.round(parts.reduce((a, p) => a + p.score, 0) / parts.length);
  const label = score < 25 ? '极度恐惧' : score < 45 ? '恐惧'
    : score < 55 ? '中性' : score < 75 ? '贪婪' : '极度贪婪';
  return { score, label, parts };
}

function metricRows(snap, ust2y) {
  const g = (s) => snap.get(s);
  const tnx = g('^TNX'), tyx = g('^TYX'), dxy = g('DX-Y.NYB');
  const wti = g('CL=F'), gold = g('GC=F'), copper = g('HG=F'), btc = g('BTC-USD');
  // ^TNX / ^TYX 的 price 单位是「百分点」（4.998 = 4.998%），1bp = 0.01 百分点，
  // 因此两个收盘价之差要乘 100 才是基点；盘中无新收盘时改用当日涨跌百分比反推。
  const bp = (q) => {
    if (q?.price == null) return null;
    if (q?.chgPct != null && Number.isFinite(q.chgPct) && q.chgPct > -100) {
      return (q.price - q.price / (1 + q.chgPct / 100)) * 100;
    }
    return q?.prev != null ? (q.price - q.prev) * 100 : null;
  };
  const chg = (q, prefix = '', fixed = 2, suffix = '%') =>
    q?.chgPct == null ? '数据暂缺' :
      `${prefix}${q.chgPct >= 0 ? '+' : ''}${q.chgPct.toFixed(fixed)}${suffix}（较前一交易日）`;
  const rows = [];
  const add = (r) => rows.push(r);

  add({
    id: 'tnx', group: 0, name: '10 年期美债收益率', hint: '全球资产的基准利率', macro: false,
    value: tnx?.price != null ? tnx.price.toFixed(3) + '%' : '—',
    change: bp(tnx) != null ? `${bp(tnx) >= 0 ? '+' : ''}${bp(tnx).toFixed(1)}bp（较前一交易日）` : '数据暂缺',
    tone: (bp(tnx) ?? 0) >= 0 ? 'up' : 'down',
    data: { value: tnx?.price, chg: bp(tnx) },
    source: 'Yahoo Finance ^TNX（每日重取）',
  });
  add({
    id: 'tyx', group: 0, name: '30 年期美债收益率', hint: '长端财政与通胀定价', macro: true,
    value: tyx?.price != null ? tyx.price.toFixed(3) + '%' : '—',
    change: bp(tyx) != null ? `${bp(tyx) >= 0 ? '+' : ''}${bp(tyx).toFixed(1)}bp（较前一交易日）` : '数据暂缺',
    tone: (bp(tyx) ?? 0) >= 0 ? 'up' : 'down',
    data: { value: tyx?.price, chg: bp(tyx) },
    source: 'Yahoo Finance ^TYX（每日重取）',
  });
  add({
    id: 'dxy', group: 0, name: '美元指数 DXY', hint: '美元强弱', macro: false,
    value: dxy?.price != null ? dxy.price.toFixed(2) : '—',
    change: chg(dxy), tone: (dxy?.chgPct ?? 0) >= 0 ? 'up' : 'down',
    data: { value: dxy?.price, chgPct: dxy?.chgPct },
    source: 'Yahoo Finance DX-Y.NYB（ICE 美元指数）',
  });

  const spread = tnx?.price != null && ust2y ? tnx.price - ust2y.value : null;
  add({
    id: 'yieldcurve', group: 1, name: '2Y-10Y 美债利差', hint: '衰退预警灯', macro: true,
    value: spread != null ? (spread >= 0 ? '+' : '') + spread.toFixed(2) + '%' : '—',
    change: spread != null
      ? `${spread >= 0 ? '曲线未倒挂' : '曲线倒挂'} · 10Y ${tnx.price.toFixed(2)}% − 2Y ${ust2y.value.toFixed(2)}%`
      : '数据暂缺',
    tone: (spread ?? 0) >= 0 ? 'up' : 'down',
    data: { spread, tnx: tnx?.price, ust2y: ust2y?.value },
    source: `Yahoo ^TNX − FRED DGS2（${ust2y?.date || '日期未知'}）`,
  });
  add({
    id: 'ust2y', group: 1, name: '2 年期美债收益率', hint: '政策预期最敏感的一端', macro: true,
    value: ust2y ? ust2y.value.toFixed(2) + '%' : '—',
    change: ust2y ? `FRED 公布日 ${ust2y.date}` : '数据暂缺',
    tone: 'flat',
    data: { value: ust2y?.value, date: ust2y?.date },
    source: 'FRED / 美国财政部 DGS2（每个工作日更新，滞后约 1 个交易日）',
  });
  const ratio = copper?.price != null && gold?.price ? copper.price / gold.price : null;
  add({
    id: 'cugold', group: 1, name: '铜金比', hint: '增长 vs 避险', macro: true,
    value: ratio != null ? ratio.toFixed(5) : '—',
    change: ratio != null ? `铜 $${copper.price.toFixed(2)} / 金 $${gold.price.toFixed(0)}` : '数据暂缺',
    tone: 'flat',
    data: { ratio, copper: copper?.price, gold: gold?.price },
    source: 'Yahoo Finance HG=F（COMEX 铜）/ GC=F（COMEX 金）',
  });

  add({
    id: 'wti', group: 2, name: 'WTI 原油', hint: '通胀与地缘供给', macro: false,
    value: wti?.price != null ? '$' + wti.price.toFixed(2) : '—',
    change: chg(wti), tone: (wti?.chgPct ?? 0) >= 0 ? 'up' : 'down',
    data: { value: wti?.price, chgPct: wti?.chgPct },
    source: 'Yahoo Finance CL=F（NYMEX WTI）',
  });
  add({
    id: 'gold', group: 2, name: '黄金', hint: '避险/抗通胀', macro: false,
    value: gold?.price != null ? '$' + gold.price.toFixed(2) : '—',
    change: chg(gold), tone: (gold?.chgPct ?? 0) >= 0 ? 'up' : 'down',
    data: { value: gold?.price, chgPct: gold?.chgPct },
    source: 'Yahoo Finance GC=F（COMEX 期金）',
  });
  add({
    id: 'btc', group: 2, name: '比特币 BTC', hint: '风险偏好/流动性', macro: false,
    value: btc?.price != null ? '$' + btc.price.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—',
    change: chg(btc), tone: (btc?.chgPct ?? 0) >= 0 ? 'up' : 'down',
    data: { value: btc?.price, chgPct: btc?.chgPct },
    source: 'Yahoo Finance BTC-USD',
  });
  return rows;
}

/* ==================== LLM 文本 ==================== */
function clean(v, fallback, max = 150) {
  let t = String(v == null ? '' : v).replace(/<[^>]+>/g, '').replace(/```/g, '').trim();
  t = t.replace(BANNED, '').replace(/\s+/g, ' ').slice(0, max);
  return t && t.length >= 8 ? t : fallback;
}

async function llmJson(sys, user) {
  for (let i = 0; i < 3; i++) {
    try {
      const j = await chatJson(sys, user);
      if (j && typeof j === 'object') return j;
    } catch (e) {
      console.warn(`[extra] LLM 第 ${i + 1} 次失败：${e.message}`);
    }
  }
  return null;
}

const THEME_SYS = `你是中文美股看板编辑。用户会给出当日 11 只 SPDR 行业 ETF 的真实涨跌幅、三大指数涨跌、VIX 与 5 只热搜股（代码、价格、涨跌幅）。
严格输出 JSON：{"mainline":"...","sectorNotes":{"XLK":"...","XLC":"..."},"reminders":["...","..."]}
硬性要求：
- 只能使用用户给出的数字与代码；禁止编造财报、新闻、政策、评级、订单、并购、资金流向或任何未给出的数字与日期。
- 禁止写"财报超预期""受消息推动""创下新高""突破""后市有望""资金流入""机构上调""预计将"等无数据支撑的归因或预测。
- mainline 用 <=130 字概括当日板块结构（哪些涨、哪些跌、是否普涨、领涨领跌差多少），可写常识性的"怎么看"，不得声称发生了某事件。
- sectorNotes 只为出现的板块代码写一句 <=38 字的中文点评，描述该板块当日涨跌与相对位置，不编造原因。
- reminders 两条，每条 <=90 字，只能提示"可核对什么"（例如对照 05 模块的日程、观察板块宽度是否延续），不得预测点位或方向。
只输出 JSON，不要任何解释。`;

const MACRO_SYS = `你是中文美股看板编辑。用户会给出 9 个宏观指标的真实名称、最新值、当日变化与数据源。
严格输出 JSON：{"notes":{"tnx":"...","tyx":"...","dxy":"...","yieldcurve":"...","ust2y":"...","cugold":"...","wti":"...","gold":"...","btc":"..."},"summary":["...","...","..."],"chain":"..."}
硬性要求：
- 只能使用用户给出的数值；禁止编造财报、新闻、政策、会议、评级、资金流向或任何未给出的数字与日期。
- 禁止写"非农太强""加息概率""下周试金石""后市有望""突破""资金流入"等无数据支撑的归因或预测。
- 禁止给出宏观状态判断（如"经济前景平稳""通胀压力上升""避险需求回落""风险偏好改善"），只做数值之间的对照和"可核对什么"的提示。
- notes 每项 <=110 字：说明这个指标通常衡量什么（常识性机制），再描述今天给出的数值与变化，最后写"可核对什么"。
- summary 三段分别对应"资金成本与美元""经济周期与政策预期""通胀与风险偏好"三组，每段 <=110 字，只能用本组给定数值做横向对照。
- chain 一句 <=110 字，把三组指标的当日方向串成一条可核对的观察链，不预测后市。
只输出 JSON，不要任何解释。`;

/* ==================== 渲染 ==================== */
function updateLine(stamp, text) {
  return `    <div class="module-update">自动更新于 ${esc(stamp)}（北京时间）· ${esc(text)}</div>`;
}

function sectorItem(s, note) {
  const gain = s.chgPct >= 0;
  return `        <div class="sector-item ${gain ? 'gain' : 'loss'}">
          <span class="s-name">${esc(s.zh)} <span class="small muted">${esc(note)}</span></span>
          <span class="s-pct ${gain ? 'up' : 'down'}">${esc(pctText(s.chgPct))}</span>
        </div>`;
}

function renderTheme(rows, text, stamp) {
  if (!rows.length) return '';
  const sorted = [...rows].sort((a, b) => b.chgPct - a.chgPct);
  const top = sorted.slice(0, 2);
  const bottom = sorted.slice(-2).reverse();
  const upCount = rows.filter((s) => s.chgPct > 0).length;
  const note = (s, isBottom) => clean(text?.sectorNotes?.[s.sym], null, 42)
    || `当日 ${pctText(s.chgPct)}，在 ${rows.length} 个行业 ETF 中${isBottom ? '相对靠后' : '相对靠前'}。`;
  const mainline = clean(text?.mainline, null, 160)
    || `11 个行业 ETF 中 ${upCount} 涨 ${rows.length - upCount} 跌，领涨 ${top[0]?.zh} ${pctText(top[0]?.chgPct)}，相对落后 ${bottom[0]?.zh} ${pctText(bottom[0]?.chgPct)}；数字全部来自当日 ETF 行情，热搜个股见下方榜单。`;
  const lead = upCount >= rows.length - 1 ? '普涨' : upCount <= 1 ? '普跌' : '行业分化';
  const bottomTitle = bottom.every((s) => s.chgPct >= 0) ? '相对落后板块' : '领跌板块';
  return `${updateLine(stamp, '板块涨跌取自 11 只 SPDR 行业 ETF（Yahoo Finance），主线与点评基于当日真实数字生成')}

    <div class="theme-box">
      <strong>主线：${esc(lead)}。</strong><br>
      ${esc(mainline)}
    </div>

    <div class="sector-grid">
      <div class="sector-col">
        <h4>领涨板块</h4>
${top.map((s) => sectorItem(s, note(s, false))).join('\n')}
      </div>
      <div class="sector-col">
        <h4>${esc(bottomTitle)}</h4>
${bottom.map((s) => sectorItem(s, note(s, true))).join('\n')}
      </div>
    </div>`;
}

function renderTips(items, rows, stamp) {
  const fallback = [
    `板块宽度是 ${rows.filter((s) => s.chgPct > 0).length}/${rows.length}：上涨行业占比只能说明当日的普涨/分化程度，可连续观察几日是否延续，不能单独当作方向信号。`,
    '05 模块列出了未来一周的经济数据与知名公司财报日程；公布后可回来核对本页的利率、商品与板块数字是否发生变化。',
  ];
  const list = [0, 1].map((i) => clean(items?.[i], null, 110) || fallback[i]);
  return `    <div class="tip-box">
      <h4>两个提醒</h4>
      <ul>
        <li>${esc(list[0])}</li>
        <li>${esc(list[1])}</li>
      </ul>
    </div>`;
}

const GROUP_TITLES = [
  '第一组：资金成本与美元（股票贵不贵）',
  '第二组：经济周期与政策预期（会不会衰退）',
  '第三组：通胀、地缘与风险偏好（有没有黑天鹅）',
];

function renderMetrics(rows, text, stamp, ust2y) {
  if (rows.length < 9) return '';
  const groups = [0, 1, 2].map((g) => {
    const cards = rows.filter((r) => r.group === g).map((r) => {
      const note = clean(text?.notes?.[r.id], null, 130)
        || `${r.name}最新 ${r.value}，${r.change}。该指标的常见读法是把当日变化与同组其他指标对照；具体口径与来源见下方。`;
      return `      <div class="metric-card${r.macro ? ' macro' : ''}">
        <div class="m-name">${esc(r.name)} <span class="small muted">（${esc(r.hint)}）</span></div>
        <div class="m-value" id="metric-${esc(r.id)}">${esc(r.value)}</div>
        <div class="m-change ${esc(r.tone)}" id="metric-${esc(r.id)}-change">${esc(r.change)}</div>
        <div class="m-explain">${esc(note)}</div>
        <div class="m-source">来源：${esc(r.source)}</div>
      </div>`;
    }).join('\n');
    return `    <h4 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--ink-light);margin:${g === 0 ? '0' : '22px'} 0 10px;">${esc(GROUP_TITLES[g])}</h4>
    <div class="metrics-grid"${g < 2 ? ' style="margin-bottom:8px;"' : ''}>
${cards}
    </div>`;
  }).join('\n\n');

  const summary = [0, 1, 2].map((i) => clean(text?.summary?.[i], null, 140)
    || `本组指标当日数值：${rows.filter((r) => r.group === i).map((r) => `${r.name} ${r.value}`).join('、')}；可对照 05 模块的日程做后续核对。`);
  const chain = clean(text?.chain, null, 140)
    || '把三组的当日数字放在一起看，可以先确认资金成本、期限结构与风险资产的方向是否一致，再用 05 模块的日程核对后续数据。';
  const strong = ['第一组：钱的价格。', '第二组：期限与政策预期。', '第三组：通胀与风险偏好。'];

  return `${updateLine(stamp, `9 张卡的数值、涨跌、解读与来源全部按 Yahoo Finance 当日行情重取；2 年期收益率取自 FRED DGS2（${ust2y?.date || '日期未知'}）`)}
${groups}

    <div class="macro-summary" id="macro-summary">
      <div class="label">三句话串起来看</div>
${summary.map((s, i) => `      <p><strong>${esc(strong[i])}</strong>${esc(s)}</p>`).join('\n')}
      <p><strong>记一条链就够了：</strong>${esc(chain)}</p>
      <p class="dim">（以上文字每日基于当日真实指标自动生成，更新于 ${esc(stamp)} 北京时间；页面打开时上方数值还会再向 Yahoo 刷新一次。）</p>
    </div>`;
}

/* ==================== 注入 ==================== */
const B_THEME = '<!-- BEGIN:DYNAMIC_THEME -->';
const E_THEME = '<!-- END:DYNAMIC_THEME -->';
const B_TIPS = '<!-- BEGIN:DYNAMIC_TIPS -->';
const E_TIPS = '<!-- END:DYNAMIC_TIPS -->';
const B_METRICS = '<!-- BEGIN:DYNAMIC_METRICS -->';
const E_METRICS = '<!-- END:DYNAMIC_METRICS -->';

function section(html, begin, end) {
  const a = html.indexOf(begin);
  const b = a < 0 ? -1 : html.indexOf(end, a + begin.length);
  return a < 0 || b < 0 ? null : { a, b, inner: html.slice(a + begin.length, b) };
}
function replaceSection(html, begin, end, content) {
  const s = section(html, begin, end);
  if (!s) { console.warn(`[extra] 找不到注入锚点 ${begin}，跳过该模块`); return html; }
  return html.slice(0, s.a + begin.length) + '\n' + content + '\n    ' + html.slice(s.b);
}
function prependSection(html, begin, end, warning) {
  const s = section(html, begin, end);
  if (!s) return html;
  return html.slice(0, s.a + begin.length) + '\n' + warning + s.inner + html.slice(s.b);
}
function replaceInner(html, id, inner) {
  const m = new RegExp('<(\\w+)([^>]*\\bid="' + id + '"[^>]*)>').exec(html);
  if (!m) return html;
  const start = m.index + m[0].length;
  const end = html.indexOf('</' + m[1] + '>', start);
  if (end < 0) return html;
  return html.slice(0, start) + inner + html.slice(end);
}

/** 把生成结果写回 HTML；找不到锚点或本次取数失败的模块保留旧内容并给出警告。 */
export function injectExtraIntoHtml(html, data) {
  if (!data) return html;
  let out = html;
  const warn = (which) => `    <div class="module-update" style="color:var(--down);">本次${which}数据源不可用，以下仍显示上次成功更新的内容；下次每日任务会自动重试。</div>`;
  if (data.themeHtml) out = replaceSection(out, B_THEME, E_THEME, data.themeHtml);
  else out = prependSection(out, B_THEME, E_THEME, warn('板块行情'));
  if (data.tipsHtml) out = replaceSection(out, B_TIPS, E_TIPS, data.tipsHtml);
  if (data.metricsHtml) out = replaceSection(out, B_METRICS, E_METRICS, data.metricsHtml);
  else out = prependSection(out, B_METRICS, E_METRICS, warn('宏观行情'));

  const s = data.sentiment;
  if (s) {
    out = replaceInner(out, 'fg-value', String(s.score));
    out = out.replace(/(<div class="gauge-pointer" id="fg-pointer" style="left:)[^"%]+(%")/,
      `$1${clamp(s.score, 2, 98)}$2`);
    const detail = s.parts.map((p) => `${p.label} ${p.score}`).join('、');
    const explain = `市场情绪综合分 ${s.score}（${s.label}），由 ${s.parts.length} 项公开行情分项等权计算，更新于 ${data.updatedAt}（北京时间）。分项得分：${detail}。口径：${s.parts.map((p) => p.raw).join('；')}。本分数由本看板基于 Yahoo Finance 行情自行计算，非 CNN 官方 Fear & Greed 指数（其公开接口已下线）。`;
    out = replaceInner(out, 'fg-explain', esc(explain));
  }
  if (data.ust2y?.value != null) {
    out = out.replace(/const YIELD_2Y_BASE = [\d.]+;/,
      `const YIELD_2Y_BASE = ${data.ust2y.value};`);
  }
  if (data.updatedAt && (data.themeHtml || data.metricsHtml)) {
    out = out.replace(/const EXTRA_DATE = '[^']*'/, `const EXTRA_DATE = '${data.updatedAt}'`);
  }
  return out;
}

/* ==================== 主流程 ==================== */
export async function buildExtra(now = Date.now()) {
  const stamp = bjStamp(now);
  const out = { updatedAt: stamp };

  // 串行取数：公开接口在并发请求时容易 429
  let sectorSnap = new Map(), macroSnap = new Map(), sentSnap = new Map();
  try {
    sectorSnap = await spark(SECTORS.map((s) => s[0]), '1mo');
    console.log(`[extra] 板块 ETF ${sectorSnap.size}/${SECTORS.length} 只`);
  } catch (e) { console.warn('[extra] 板块行情不可用：' + e.message); }
  try {
    macroSnap = await spark(MACRO_SYMBOLS, '1mo');
    console.log(`[extra] 宏观标的 ${macroSnap.size}/${MACRO_SYMBOLS.length} 只`);
  } catch (e) { console.warn('[extra] 宏观行情不可用：' + e.message); }
  try {
    sentSnap = await spark(SENTIMENT_SYMBOLS, '1y');
    console.log(`[extra] 情绪分项 ${sentSnap.size}/${SENTIMENT_SYMBOLS.length} 只`);
  } catch (e) { console.warn('[extra] 情绪分项行情不可用：' + e.message); }

  const snap = new Map([...sectorSnap, ...macroSnap, ...sentSnap]);
  let ust2y = null;
  try {
    ust2y = await fetchUst2y();
    out.ust2y = ust2y;
    console.log(`[extra] FRED DGS2 = ${ust2y.value}%（${ust2y.date}）`);
  } catch (e) { console.warn('[extra] FRED DGS2 不可用：' + e.message); }

  let hot = [];
  try {
    hot = await collectHot();
    out.hotStocks = hot.map((h) => ({
      code: h.code, name: h.name, basePrice: h.basePrice, baseChg: h.baseChg,
      why: `热度榜第 ${h.rank} 名，当日 ${pctText(h.baseChg)}。可用来观察热搜个股与板块涨跌是否同向。`,
    }));
    console.log(`[extra] 热搜榜 ${hot.length} 只：${hot.map((h) => h.code).join(', ')}`);
  } catch (e) { console.warn('[extra] 热搜榜不可用：' + e.message); }

  const sectorRows = SECTORS.map(([sym, zh]) => {
    const q = sectorSnap.get(sym);
    return q?.price != null && q.chgPct != null
      ? { sym, zh, chgPct: r2(q.chgPct), price: q.price } : null;
  }).filter(Boolean);
  out.sectors = sectorRows;
  out.sentiment = computeSentiment(snap, sectorRows);
  if (out.sentiment) {
    console.log(`[extra] 情绪综合分 ${out.sentiment.score}（${out.sentiment.label}），${out.sentiment.parts.length} 个分项`);
  }

  const metricData = macroSnap.size >= 6 ? metricRows(snap, ust2y) : [];
  out.metrics = metricData;

  // LLM：03 主题、06 解读、热搜 why（各自失败都有机械模板兜底）
  const ctxCommon = [
    `数据日期：${stamp}（北京时间）；数字均来自 Yahoo Finance 当日行情 / FRED DGS2。`,
    `行业 ETF 当日涨跌：${sectorRows.map((s) => `${s.zh}(${s.sym}) ${pctText(s.chgPct)}`).join('；') || '无数据'}。`,
    `指数：标普500 ${pctText(macroSnap.get('^GSPC')?.chgPct)}，VIX ${macroSnap.get('^VIX')?.price?.toFixed(2) ?? '—'}。`,
    `Yahoo 美股热搜前 5：${hot.map((h) => `第${h.rank} ${h.code} ${h.name} $${h.basePrice} ${pctText(h.baseChg)}`).join('；') || '无数据'}。`,
  ].join('\n');

  let themeText = null;
  if (sectorRows.length) {
    themeText = await llmJson(THEME_SYS, ctxCommon);
    out.themeHtml = renderTheme(sectorRows, themeText, stamp);
    out.tipsHtml = renderTips(themeText?.reminders, sectorRows, stamp);
  } else {
    console.warn('[extra] 板块数据为空，03 模块保留上次内容');
  }

  if (metricData.length >= 9) {
    const macroCtx = [
      `数据日期：${stamp}（北京时间）。以下为 9 个宏观指标的真实数值与当日变化：`,
      ...metricData.map((r) => `${r.id}（${r.name}）：${r.value}；${r.change}；来源 ${r.source}`),
      `2 年期美债收益率 FRED DGS2 公布日：${ust2y?.date || '未取到'}。`,
      `板块宽度：${sectorRows.filter((s) => s.chgPct > 0).length}/${sectorRows.length} 个行业 ETF 上涨。`,
    ].join('\n');
    const macroText = await llmJson(MACRO_SYS, macroCtx);
    out.metricsHtml = renderMetrics(metricData, macroText, stamp, ust2y);
  } else {
    console.warn('[extra] 宏观数据不足，06 模块保留上次内容');
  }

  // 热度榜短评用纯机械模板：模型容易给陌生代码贴上过时/错误的行业标签（例如把 MSTR
  // 说成"商业智能软件"），而热搜榜本身只提供排名与行情，没有任何可核实的新闻归因。
  if (hot.length) {
    out.hotStocks = hot.map((h) => ({
      code: h.code, name: h.name, basePrice: h.basePrice, baseChg: h.baseChg,
      why: `Yahoo 美股热搜第 ${h.rank} 名，最新 $${h.basePrice?.toFixed(2)}，当日 ${pctText(h.baseChg)}。可对照上方行业 ETF 涨跌，看热搜个股与板块方向是否同向；本条不含新闻归因。`,
    }));
  }
  return out;
}

// 独立调试：node scripts/market_extra.mjs [--write-html]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await buildExtra();
  const dump = {
    updatedAt: data.updatedAt, sentiment: data.sentiment, ust2y: data.ust2y,
    sectors: data.sectors, hotStocks: data.hotStocks,
    metrics: data.metrics?.map((r) => ({ id: r.id, value: r.value, change: r.change })),
  };
  writeFileSync(resolve(ROOT, 'market_extra.json'), JSON.stringify(dump, null, 2), 'utf8');
  console.log('[extra] 已写出 market_extra.json');
  if (process.argv.includes('--write-html')) {
    for (const f of ['us-stock-dashboard.html', 'index.html']) {
      const p = resolve(ROOT, f);
      writeFileSync(p, injectExtraIntoHtml(readFileSync(p, 'utf8'), data), 'utf8');
      console.log(`[extra] 已注入 ${f}`);
    }
  }
}
