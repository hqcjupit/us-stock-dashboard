/**
 * 02「发生了什么大事」+ 05「接下来要注意什么」每日刷新（scripts/events.mjs）
 *
 * 此前这两个模块是 2026-11-06 的编辑部手写快照，每日管线完全不碰，
 * 于是指数/个股每天更新，而事件与日程永远停在 11/6（还写着已过去的 11/10 CPI）。
 * 本模块改为从真实公开数据源取数，每日重写两个模块：
 *
 *   02 新闻  : Google News RSS / CNBC Top News / WSJ Markets → 真实标题、来源、时间、原文链接
 *   05 日程  : ForexFactory 本周经济日历（USD 高影响，时间为 GMT）+ Nasdaq 财报日历
 *
 * LLM 只做「翻译与常识性看点」，硬性禁止编造数字、新闻、政策或预测；
 * 无 LLM_API_KEY 时降级为「中文事件名 + 真实英文原标题 + 模板化看点」，仍然每天更新，
 * 绝不用占位文字冒充已生成。
 *
 * 独立调试：
 *   node scripts/events.mjs                 # 抓取 + 生成，写出 events.json / calendar.json
 *   node scripts/events.mjs --write-html   # 额外把两个模块注入两份 HTML
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chatJson } from './llm.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (compatible; us-stock-dashboard/1.0)';
const BJ_OFFSET = 8 * 3600 * 1000;

const NEWS_FEEDS = [
  { url: 'https://news.google.com/rss/search?q=US+stocks+S%26P+500+Nasdaq+when:3d&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
  { url: 'https://news.google.com/rss/search?q=Fed+CPI+inflation+earnings+when:3d&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', source: 'CNBC' },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', source: 'WSJ' },
];
// FF 的 HTTPS 端点对同一 IP 短时间多次请求会返回 429；HTTP 端点与带查询串的地址作为备用依次尝试
const FF_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.xml',
  'http://nfs.faireconomy.media/ff_calendar_thisweek.xml',
  'https://nfs.faireconomy.media/ff_calendar_thisweek.xml?x=',
];

const BANNED = /财报超预期|受.{0,8}(消息|传闻)推动|创下?新高|突破|后市有望|资金流入|机构上调|评级上调|预计将|有望|最大单日|利好刺激|主力净流入|必将|一定会涨/g;

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeLink(u) { return /^https?:\/\//i.test(String(u || '')) ? esc(u) : '#'; }

function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (/^#/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return m;
  });
}
function tagText(s, name) {
  const r = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(s);
  if (!r) return '';
  const cd = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(r[1].trim());
  return decodeEntities((cd ? cd[1] : r[1]).trim()).replace(/<[^>]+>/g, '').trim();
}
/* 公开 RSS / 日历接口偶发 429 或代理抖动：重试 3 次再放弃，避免整块模块因一次抖动停更。 */
async function fetchText(url, timeout = 20000, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept': '*/*' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      last = e;
      console.warn(`[events] 取数重试 ${i + 1}/${retries}：${url.slice(0, 70)} → ${e.message}`);
    } finally { clearTimeout(timer); }
    if (i < retries - 1) await new Promise(res => setTimeout(res, 600 * (i + 1)));
  }
  throw last;
}
function bj(ts) { return new Date(ts + BJ_OFFSET); }
export function bjStamp(ts = Date.now()) {
  return new Date(ts + BJ_OFFSET).toISOString().slice(0, 16).replace('T', ' ');
}
function bjShort(ts) {
  const d = bj(ts);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function weekdayCN(ts) { return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][bj(ts).getUTCDay()]; }

/* ==================== 解析 ==================== */
export function parseRss(xml, fallbackSource) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const s = m[1];
    const rawTitle = tagText(s, 'title');
    if (!rawTitle) continue;
    const sourceTag = /<source\b[^>]*>([\s\S]*?)<\/source>/i.exec(s);
    let source = sourceTag ? decodeEntities(sourceTag[1].trim()) : '';
    let title = rawTitle;
    const suffix = /\s+-\s+([^-]{2,45})$/.exec(title);
    if (suffix) {
      if (!source) source = suffix[1].trim();
      title = title.slice(0, suffix.index).trim();
    }
    if (!source) source = fallbackSource;
    const pub = tagText(s, 'pubDate') || tagText(s, 'dc:date');
    const ts = Date.parse(pub);
    out.push({
      title, source,
      link: tagText(s, 'link') || tagText(s, 'guid'),
      desc: tagText(s, 'description').slice(0, 320),
      ts: Number.isFinite(ts) ? ts : 0,
    });
  }
  return out;
}

const TOPIC_WEIGHTS = [
  [/fed|fomc|rate|inflation|cpi|ppi|payroll|jobs|treasury|yields?|bond/i, 4],
  [/s&p|nasdaq|dow|stocks?|market|wall street|rally|selloff/i, 3],
  [/earnings|nvidia|ai\b|chip|tech|tariff|oil|dollar|gold/i, 2],
];
const TRUSTED = /bloomberg|reuters|cnbc|wsj|financial times|associated press|yahoo finance|marketwatch/i;

function scoreNews(n, now) {
  let s = 0;
  for (const [re, w] of TOPIC_WEIGHTS) if (re.test(n.title)) s += w;
  if (TRUSTED.test(n.source)) s += 2;
  const ageH = (now - n.ts) / 3600000;
  if (ageH <= 24) s += 3; else if (ageH <= 48) s += 1;
  return s;
}
function normWords(t) {
  return new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
}
function similar(a, b) {
  const A = normWords(a), B = normWords(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

export async function collectNews(now = Date.now()) {
  const all = [];
  const errors = [];
  const results = await Promise.allSettled(NEWS_FEEDS.map(f => fetchText(f.url)));
  results.forEach((r, i) => {
    const f = NEWS_FEEDS[i];
    if (r.status === 'fulfilled') all.push(...parseRss(r.value, f.source));
    else errors.push(`${f.source}: ${r.reason?.message || r.reason}`);
  });
  const fresh = all.filter(n => n.ts > now - 3 * 86400000 && n.ts <= now + 3600000 && n.title.length > 15 && scoreNews(n, now) >= 4);
  fresh.sort((a, b) => scoreNews(b, now) - scoreNews(a, now) || b.ts - a.ts);
  const picked = [];
  for (const n of fresh) {
    if (picked.some(p => similar(p.title, n.title) > 0.55)) continue;
    picked.push(n);
    if (picked.length >= 3) break;
  }
  if (errors.length) console.warn(`[events] 部分新闻源不可用：${errors.join('；')}`);
  console.log(`[events] 新闻候选 ${all.length} 条，去重后取 ${picked.length} 条`);
  return picked;
}

export function parseFfCalendar(xml) {
  const out = [];
  for (const m of xml.matchAll(/<event>([\s\S]*?)<\/event>/gi)) {
    const s = m[1];
    const country = tagText(s, 'country');
    const impact = tagText(s, 'impact');
    if (country !== 'USD' || !/High|Medium/i.test(impact)) continue;
    const title = tagText(s, 'title');
    const date = tagText(s, 'date');           // MM-DD-YYYY
    const time = tagText(s, 'time');           // GMT，如 1:30pm
    const dm = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(date);
    const tm = /^(\d{1,2}):(\d{2})(am|pm)$/i.exec(time);
    if (!title || !dm || !tm) continue;
    let h = (Number(tm[1]) % 12) + (tm[3].toLowerCase() === 'pm' ? 12 : 0);
    const ts = Date.UTC(+dm[3], +dm[1] - 1, +dm[2], h, +tm[2]);
    out.push({
      kind: 'macro', title, impact, ts,
      forecast: tagText(s, 'forecast'), previous: tagText(s, 'previous'),
      source: 'ForexFactory 经济日历', url: tagText(s, 'url'),
    });
  }
  return out;
}

const BIG_NAMES = /^(NVDA|AAPL|MSFT|AMZN|GOOGL|GOOG|META|TSLA|AVGO|AMD|WMT|HD|CSCO|CRM|ORCL|INTC|NFLX|JPM|BAC|GS|MS|V|MA|UNH|JNJ|XOM|COST|LLY|PLTR|MU|QCOM|TXN|AMAT|ADI|PANW|CRWD|SHOP|UBER|DIS|KO|PEP|MCD|BA|CAT|GE|IBM)$/i;
const NASDAQ_TIME = { 'time-pre-market': '盘前', 'time-after-hours': '盘后', 'time-not-supplied': '时间待定' };

async function collectEarnings(now) {
  const out = [];
  const base = bj(now);
  const start = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  for (let i = 0; i < 6; i++) {
    const day = new Date(start + i * 86400000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const iso = day.toISOString().slice(0, 10);
    try {
      const txt = await fetchText(`https://api.nasdaq.com/api/calendar/earnings?date=${iso}`);
      const rows = JSON.parse(txt)?.data?.rows || [];
      const cap = r => Number(String(r.marketCap || '').replace(/[^0-9.]/g, '')) || 0;
      // 只保留市场关注度高的知名美股；否则某天最大的可能是外国银行 ADR，与美股看板无关
      const top = [...rows].sort((a, b) => cap(b) - cap(a)).find(r => BIG_NAMES.test(r.symbol));
      if (!top) continue;
      out.push({
        kind: 'earnings',
        title: `${top.symbol} ${top.name} 财报`,
        ts: day.getTime() + 12 * 3600000,
        timeNote: NASDAQ_TIME[top.time] || '时间待定',
        forecast: top.epsForecast && top.epsForecast !== '--' ? `每股预期 ${top.epsForecast}` : '',
        previous: top.lastYearEPS && top.lastYearEPS !== '--' ? `去年同期 ${top.lastYearEPS}` : '',
        source: 'Nasdaq 财报日历', url: `https://www.nasdaq.com/market-activity/stocks/${String(top.symbol).toLowerCase()}`,
      });
    } catch (e) {
      console.warn(`[events] Nasdaq ${iso} 财报日历不可用：${e.message}`);
    }
    await new Promise(res => setTimeout(res, 300)); // 轻微限速，避免连续请求被 429
  }
  return out;
}

async function fetchFf() {
  for (const base of FF_URLS) {
    const url = base.endsWith('x=') ? base + Date.now() : base;
    try { return await fetchText(url, 15000, 2); }
    catch (e) { console.warn(`[events] FF 地址不可用 ${url.slice(0, 62)} → ${e.message}`); }
  }
  console.warn('[events] ForexFactory 日历全部地址不可用');
  return null;
}

export async function collectCalendar(now = Date.now()) {
  const macro = [];
  const xml = await fetchFf();
  if (xml) {
    macro.push(...parseFfCalendar(xml).filter(e => e.ts > now - 2 * 3600000 && e.ts < now + 10 * 86400000));
  }
  // 同一时间的 CPI / Core CPI 之类只留主指标，避免日程里出现两条几乎相同的内容
  const bySlot = new Map();
  for (const e of macro) {
    const key = e.ts + '|' + e.title.replace(/^Core\s+/i, '');
    const prev = bySlot.get(key);
    if (!prev || (prev.title.startsWith('Core ') && !e.title.startsWith('Core '))) bySlot.set(key, e);
  }
  // 高影响优先入选，展示时仍按时间先后；周内事件较少时保留中影响事件，避免日程只有一两条
  const macroPicked = [...bySlot.values()]
    .sort((a, b) => (a.impact === 'High' ? 0 : 1) - (b.impact === 'High' ? 0 : 1) || a.ts - b.ts)
    .slice(0, 5)
    .sort((a, b) => a.ts - b.ts);
  const earnings = (await collectEarnings(now)).filter(e => e.ts > now - 2 * 3600000).slice(0, 2);
  const items = [...macroPicked.slice(0, 5 - earnings.length), ...earnings].sort((a, b) => a.ts - b.ts);
  console.log(`[events] 日程：宏观 ${macroPicked.length} 条 + 财报 ${earnings.length} 条 → 取 ${items.length} 条`);
  return items;
}

/* ==================== LLM 加工（严格禁止编造） ==================== */
const EVENT_SYS = `你是中文财经编辑，把一条真实英文财经新闻改写成投资者看板卡片。
严格输出 JSON，字段：title, what, why。
- title：忠实翻译或概括原标题，<=28 字，不得添加原标题没有的事实。
- what：<=130 字，复述这条报道讲了什么；只能使用给定标题、来源、时间与摘要中的信息。
- why：<=120 字，用常识解释「这类消息为什么值得关注、之后可以核对什么公开信息」；不得预测涨跌、不得断言资金流向或政策结果、不得引入新事实。
硬性要求：
- 禁止编造任何数字、日期、财报、官员表态、评级、订单或因果关系；摘要里没有的就写「报道未提供更多细节」。
- 禁止使用"财报超预期""创下新高""突破""后市有望""资金流入""利好刺激"等无依据表述。
- 中文纯文本，不要 Markdown，只输出 JSON。`;

const CAL_SYS = `你是中文财经编辑，为一条真实的经济数据/财报日程写卡片。
严格输出 JSON，字段：title, why。
- title：把给定事件名忠实译成中文，<=22 字；可保留英文缩写（如 CPI、PPI）。
- why：<=110 字，说明这个指标/财报通常反映什么、公布后可以核对哪类公开信息；不得预测数值或方向。
硬性要求：
- 只能使用给定事件名、时间、预期与前值；禁止编造任何其它数字、新闻、政策或结果。
- 禁止"预计将""有望""突破""后市有望""资金流入"等预测或无依据表述。
中文纯文本，只输出 JSON。`;

function pick(v, fallback, max) {
  const t = String(v == null ? '' : v).replace(/<[^>]+>/g, '').replace(/```/g, '').trim().slice(0, max);
  return t && !BANNED.test(t) ? t : fallback;
}
/* 网关偶发 fetch failed：重试一次，避免单条卡片降级成英文原标题 */
async function llmJson(sys, user) {
  const first = await chatJson(sys, user);
  return first || await chatJson(sys, user);
}

const ZH_TITLE = [
  [/^Core CPI m\/m$/i, '核心 CPI（月率）'], [/^CPI m\/m$/i, 'CPI 消费者物价指数（月率）'],
  [/^Core PPI m\/m$/i, '核心 PPI（月率）'], [/^PPI m\/m$/i, 'PPI 生产者物价指数（月率）'],
  [/^Nonfarm Payrolls/i, '非农就业人数'], [/^Unemployment Rate/i, '失业率'],
  [/^Retail Sales m\/m$/i, '零售销售（月率）'], [/^FOMC Statement$/i, 'FOMC 利率决议'],
  [/^Fed Chair/i, '美联储主席讲话'], [/^FOMC Member/i, '美联储官员讲话'],
  [/^Initial Jobless Claims$/i, '初请失业金人数'], [/^Core PCE/i, '核心 PCE 物价指数'],
  [/^Prelim GDP/i, 'GDP 初值'], [/^ISM/i, 'ISM 景气指数'],
  [/^Prelim UoM Consumer Sentiment/i, '密歇根大学消费者信心初值'],
];
function zhTitle(raw) {
  for (const [re, zh] of ZH_TITLE) if (re.test(raw)) return zh;
  return raw;
}
function genericWhy(e) {
  if (e.kind === 'earnings') return '财报里的营收、利润与管理层指引是可核对的硬信息，公布后可与市场预期直接比对；在此之前不宜把单季数字外推成趋势。';
  if (/CPI|PPI|PCE|inflation/i.test(e.title)) return '这类通胀读数会影响市场对利率路径的预期；公布后可比对给定预期与前值，并观察美债收益率与股指的实际反应。';
  if (/Payroll|Unemployment|Jobless|Employment/i.test(e.title)) return '就业数据反映劳动力市场松紧，是判断政策取向的重要输入；公布后可比对预期、前值与后续修正。';
  if (/FOMC|Fed Chair|Rate/i.test(e.title)) return '政策表态直接关系利率预期；可核对官方声明原文与点阵图，不必提前押方向。';
  return '这类数据公布后可直接比对给定预期与前值，再观察市场实际反应；单月读数不足以定趋势。';
}

export async function buildEventCards(news) {
  const cards = [];
  for (const n of news) {
    const j = await llmJson(EVENT_SYS,
      `标题：${n.title}\n来源：${n.source}\n发布时间（北京时间）：${bjShort(n.ts)}\n摘要：${n.desc || '（该 RSS 未提供摘要）'}`);
    cards.push({
      title: pick(j?.title, n.title.slice(0, 60), 60),
      what: pick(j?.what, `据 ${n.source} 报道：${n.title}`, 260),
      why: pick(j?.why, '报道未提供更多可核对细节；建议点开原文查看全文，并以官方数据或公司公告为准。', 240),
      source: n.source, link: n.link, time: bjShort(n.ts), rawTitle: n.title,
    });
  }
  return cards;
}

export async function buildCalendarItems(items) {
  const out = [];
  for (const e of items) {
    const j = await llmJson(CAL_SYS,
      `事件：${e.title}\n类型：${e.kind === 'earnings' ? '公司财报' : '宏观经济数据'}\n时间（北京时间）：${bjShort(e.ts)}${e.timeNote ? '（' + e.timeNote + '）' : ''}\n市场预期：${e.forecast || '未提供'}\n前值：${e.previous || '未提供'}`);
    const d = bj(e.ts);
    out.push({
      ...e,
      zh: pick(j?.title, zhTitle(e.title), 60),
      why: pick(j?.why, genericWhy(e), 240),
      dateLabel: `${d.getUTCMonth() + 1}/${String(d.getUTCDate()).padStart(2, '0')}`,
      weekday: weekdayCN(e.ts),
      timeLabel: e.kind === 'earnings' ? (e.timeNote || '时间待定')
        : `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
    });
  }
  return out;
}

/* ==================== 渲染与注入 ==================== */
function updateLine(stamp, text) {
  return `    <div class="module-update">自动更新于 ${esc(stamp)}（北京时间）· ${esc(text)}</div>`;
}

export function renderEventsHtml(cards, stamp) {
  if (!cards.length) return '';
  const body = cards.map((c, i) => `    <div class="event-card">
      <div class="event-title">${i + 1}. ${esc(c.title)}</div>
      <div class="event-row"><span class="ev-label">发生了什么：</span>${esc(c.what)}<span class="dim">（来源：${esc(c.source)} · ${esc(c.time)}）</span></div>
      <div class="event-row"><span class="ev-label">所以呢：</span>${esc(c.why)}</div>
      <div class="event-row dim"><a href="${safeLink(c.link)}" target="_blank" rel="noopener">阅读原文核对 ↗</a> · 原标题：${esc(c.rawTitle)}</div>
    </div>`).join('\n\n');
  return `${updateLine(stamp, '新闻取自 Google News / CNBC / WSJ 公开 RSS，点击原文链接可核对')}\n\n${body}`;
}

export function renderCalendarHtml(items, stamp) {
  if (!items.length) return '';
  const body = items.map(e => {
    const meta = [e.forecast, e.previous].filter(Boolean).map(esc).join(' · ');
    return `      <li class="cal-item">
        <div class="cal-date"><div class="monthday">${esc(e.dateLabel)}</div><span class="weekday">${esc(e.weekday)} ${esc(e.timeLabel)}</span></div>
        <div class="cal-content">
          <div class="cal-title">${esc(e.zh)}</div>
          <div class="cal-desc">${meta ? '日历数据：' + meta + ' · ' : ''}原始条目：${esc(e.title)}</div>
          <div class="cal-impact"><strong>所以呢：</strong>${esc(e.why)}<span class="dim">（来源：${esc(e.source)}）</span></div>
        </div>
      </li>`;
  }).join('\n');
  return `${updateLine(stamp, '日程取自 ForexFactory 经济日历（原始时间为 GMT，已换算北京时间）与 Nasdaq 财报日历')}\n\n    <ul class="cal-list">\n${body}\n    </ul>`;
}

const B_EVENTS = '<!-- BEGIN:DYNAMIC_EVENTS -->';
const E_EVENTS = '<!-- END:DYNAMIC_EVENTS -->';
const B_CAL = '<!-- BEGIN:DYNAMIC_CALENDAR -->';
const E_CAL = '<!-- END:DYNAMIC_CALENDAR -->';

function section(html, begin, end) {
  const a = html.indexOf(begin);
  const b = a < 0 ? -1 : html.indexOf(end, a + begin.length);
  return a < 0 || b < 0 ? null : { a, b, inner: html.slice(a + begin.length, b) };
}
function replaceSection(html, begin, end, content) {
  const s = section(html, begin, end);
  if (!s) { console.warn(`[events] 找不到注入锚点 ${begin}，跳过该模块`); return html; }
  return html.slice(0, s.a + begin.length) + '\n' + content + '\n    ' + html.slice(s.b);
}
function prependSection(html, begin, end, warning) {
  const s = section(html, begin, end);
  if (!s) return html;
  return html.slice(0, s.a + begin.length) + '\n' + warning + s.inner + html.slice(s.b);
}

/**
 * 把生成好的两个模块写回 HTML。任一模块本次没抓到数据 → 保留旧内容并前置警告，
 * 绝不静默留着过期内容冒充新内容；EVENTS_DATE 仅在至少一个模块成功刷新时更新。
 */
export function injectModulesIntoHtml(html, data) {
  if (!data) return html;
  let out = html;
  const warn = (which) => `    <div class="module-update" style="color:var(--down);">本次${which}数据源不可用，以下仍显示上次成功更新的内容（${esc(data.updatedAt || '时间未知')}）；下次每日任务会自动重试。</div>`;
  if (data.eventsHtml) out = replaceSection(out, B_EVENTS, E_EVENTS, data.eventsHtml);
  else out = prependSection(out, B_EVENTS, E_EVENTS, warn('新闻'));
  if (data.calendarHtml) out = replaceSection(out, B_CAL, E_CAL, data.calendarHtml);
  else out = prependSection(out, B_CAL, E_CAL, warn('日程'));
  if (data.updatedAt && (data.eventsHtml || data.calendarHtml)) {
    out = out.replace(/const EVENTS_DATE = '[^']*'/, `const EVENTS_DATE = '${data.updatedAt}'`);
  }
  return out;
}

/** 抓取 + 生成 + 渲染；返回可直接交给 injectModulesIntoHtml 的对象。 */
export async function buildModules(now = Date.now()) {
  const stamp = bjStamp(now);
  // 串行而非并发：本地代理/公开接口在多个请求同时发出时容易抖动或 429
  const news = await collectNews(now).catch(e => { console.warn('[events] 新闻抓取失败：' + e.message); return []; });
  const rawCal = await collectCalendar(now).catch(e => { console.warn('[events] 日程抓取失败：' + e.message); return []; });
  const cards = news.length ? await buildEventCards(news) : [];
  const calItems = rawCal.length ? await buildCalendarItems(rawCal) : [];
  return {
    updatedAt: stamp,
    eventsHtml: renderEventsHtml(cards, stamp),
    calendarHtml: renderCalendarHtml(calItems, stamp),
    news: cards, calendar: calItems,
  };
}

// 独立调试：node scripts/events.mjs [--write-html]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await buildModules();
  writeFileSync(resolve(ROOT, 'events.json'), JSON.stringify(data.news, null, 2), 'utf8');
  writeFileSync(resolve(ROOT, 'calendar.json'), JSON.stringify(data.calendar, null, 2), 'utf8');
  console.log(`[events] 已写出 events.json（${data.news.length} 条）/ calendar.json（${data.calendar.length} 条）`);
  if (data.news.length) console.log('  新闻示例：', data.news[0].title, '|', data.news[0].what.slice(0, 70));
  if (data.calendar.length) console.log('  日程示例：', data.calendar[0].dateLabel, data.calendar[0].zh, '|', data.calendar[0].why.slice(0, 70));
  if (process.argv.includes('--write-html')) {
    for (const f of ['us-stock-dashboard.html', 'index.html']) {
      const p = resolve(ROOT, f);
      writeFileSync(p, injectModulesIntoHtml(readFileSync(p, 'utf8'), data), 'utf8');
      console.log(`[events] 已注入 ${f}`);
    }
  }
}
