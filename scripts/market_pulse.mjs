/**
 * 市场脉搏（01 模块）每日文案生成与注入。
 *
 * 数据源：regenerate.mjs 刷新出的 baselines.json 中 ^GSPC / ^IXIC / ^DJI / ^VIX 的真实行情，
 * 无需新增外部数据源。LLM 只负责把这些数字写成可读解读，prompt 明确禁止编造新闻与数字。
 *
 * 设计原则：
 *   - 无行情 → buildMarketPulse 返回 null，主流程保留 HTML 中现有文案，绝不写坏页面。
 *   - 无 LLM key / 调用失败 → 用只复述真实数字的机械文案兜底。
 *   - injectPulseIntoHtml 是纯函数，可离线单测（不需要联网/凭证）。
 */
import { generateMarketPulse, placeholderMarketPulse } from './llm.mjs';

const MAP = { sp500: '^GSPC', nasdaq: '^IXIC', dow: '^DJI', vix: '^VIX' };

/** Yahoo 的 regularMarketTime 是 Unix 秒；转成美东交易日的 YYYY-MM-DD。 */
function etDate(ts) {
  try {
    return new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  } catch {
    return null;
  }
}

export function buildSnapshot(baselines) {
  const snap = { date: null, indices: {}, vix: null };
  for (const [key, sym] of Object.entries(MAP)) {
    const q = baselines?.[sym]?.baseQuote;
    if (!q || q.price == null) continue;
    const item = {
      symbol: sym,
      price: Number(q.price),
      prev: q.prev != null ? Number(q.prev) : null,
      changePct: q.changePct != null ? Number(q.changePct) : null,
      marketTime: q.marketTime || null,
    };
    if (key === 'vix') snap.vix = item;
    else snap.indices[key] = item;
    if (!snap.date && q.marketTime) snap.date = etDate(q.marketTime);
  }
  return snap;
}

/**
 * 一致性校验：LLM 文案里必须能找到至少两个真实收盘点位（去千分位后比对）。
 * 防止模型漏写/写错数字造成"一句话与卡片数字打架"（本次要修的核心问题）。
 */
function pulseLooksValid(p, snap) {
  if (!p || !Array.isArray(p.oneline) || p.oneline.length < 2) return false;
  const text = p.oneline.join('').replace(/[\s,，]/g, '');
  let hits = 0;
  for (const q of Object.values(snap.indices)) {
    const n = Number(q.price).toFixed(2);
    if (text.includes(n)) hits++;
  }
  return hits >= 2;
}

// 无数据支撑的断言/预测：prompt 已禁止，但模型偶有违反，故在代码层再做一次逐字段兜底。
const BANNED = /突破|创(下|出)?新高|创新高|最大单日|近[一二三四五六七八九十\d]+[周月日]|资金(集中)?流入|资金流出|板块贡献|市场广度|后市|预计|料将|有望|全线上扬/;
const NAMES = { sp500: '标普500', nasdaq: '纳斯达克', dow: '道琼斯' };

function plainIndexNote(k, snap) {
  const q = snap.indices[k];
  if (!q) return '行情暂缺。';
  const n = q.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${NAMES[k]}收于 ${n}，当日 ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%。`;
}

/** 只清洗命中的字段，保留 LLM 其余合格内容；第一段含真实点位，不改动。 */
function sanitizePulse(p, snap) {
  const out = { ...p, oneline: [...p.oneline], indexNotes: { ...p.indexNotes } };
  let hits = 0;
  for (let i = 1; i < out.oneline.length; i++) {
    if (BANNED.test(out.oneline[i])) {
      out.oneline[i] = '涨幅差异反映风格相对强弱；更多细节需结合成交量与后续数据观察。';
      hits++;
    }
  }
  for (const k of Object.keys(NAMES)) {
    if (BANNED.test(out.indexNotes[k] || '')) { out.indexNotes[k] = plainIndexNote(k, snap); hits++; }
  }
  if (BANNED.test(out.vixExplain || '')) {
    out.vixExplain = snap.vix
      ? `VIX 报 ${snap.vix.price.toFixed(2)}，当日 ${snap.vix.changePct >= 0 ? '+' : ''}${snap.vix.changePct.toFixed(2)}%。数值越高代表买保险越贵；20 以下通常视为警报缓解。`
      : 'VIX 行情暂缺。';
    hits++;
  }
  if (BANNED.test(out.sentimentSummary || '')) {
    out.sentimentSummary = '三大指数与 VIX 的组合反映当日风险偏好变化；完整解读需结合更多数据。';
    hits++;
  }
  if (hits) console.log(`[pulse] 已清洗 ${hits} 处无数据支撑的表述`);
  return out;
}

export async function buildMarketPulse(baselines) {
  const snap = buildSnapshot(baselines);
  if (!Object.keys(snap.indices).length) {
    console.warn('[pulse] 无指数行情，跳过（保留现有文案）');
    return null;
  }
  let p = await generateMarketPulse(snap);
  if (!p) p = await generateMarketPulse(snap); // 网关偶发 fetch failed：重试一次，避免回落到机械文案
  if (!pulseLooksValid(p, snap)) {
    if (p) console.warn('[pulse] LLM 输出未复现真实点位，回退到机械文案');
    else console.log('[pulse] LLM 不可用，使用含真实数字的机械文案');
    p = placeholderMarketPulse(snap);
  } else {
    p = sanitizePulse(p, snap);
  }
  return { ...p, editorialDate: snap.date, snapshot: snap };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 按 id 找到起始标签，替换其内部文本（内部无同名嵌套标签，故取第一个闭合标签即可）。 */
function replaceInner(html, id, inner) {
  const m = new RegExp('<(\\w+)([^>]*\\bid="' + id + '"[^>]*)>').exec(html);
  if (!m) return html;
  const tag = m[1];
  const start = m.index + m[0].length;
  const close = '</' + tag + '>';
  const end = html.indexOf(close, start);
  if (end < 0) return html;
  return html.slice(0, start) + inner + html.slice(end);
}

/**
 * 把生成好的文案注入 HTML 的 01 模块，并同步 EDITORIAL_DATE。
 * 找不到的锚点会被静默跳过（不影响页面其它部分）。
 */
export function injectPulseIntoHtml(html, pulse) {
  if (!pulse) return html;
  let out = html;
  const oneline = (Array.isArray(pulse.oneline) ? pulse.oneline : [pulse.oneline])
    .filter(Boolean).map((x) => esc(String(x))).join('<br>');
  if (oneline) out = replaceInner(out, 'pulse-oneline', oneline);
  for (const k of ['sp500', 'nasdaq', 'dow']) {
    const t = pulse.indexNotes?.[k];
    if (t) out = replaceInner(out, k + '-note', esc(String(t)));
  }
  if (pulse.vixExplain) out = replaceInner(out, 'vix-explain', esc(String(pulse.vixExplain)));
  // CNN 贪婪指数没有免费自动数据源，卡片数值/指针是 11/6 编辑部快照。
  // 每日情绪解读更新后，必须明确标注它是静态的，避免与旁边"情绪回暖"的新文案互相矛盾。
  out = replaceInner(out, 'fg-explain',
    'CNN 贪婪指数无免费自动数据源，此卡片数值为 2026-11-06 编辑部静态快照，不随每日行情更新；实时情绪请参考左侧 VIX。');
  if (pulse.sentimentSummary) out = replaceInner(out, 'sentiment-summary-text', esc(String(pulse.sentimentSummary)));
  if (pulse.editorialDate) {
    out = out.replace(/const EDITORIAL_DATE = '[^']*'/, `const EDITORIAL_DATE = '${pulse.editorialDate}'`);
  }
  return out;
}
