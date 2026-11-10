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

export async function buildMarketPulse(baselines) {
  const snap = buildSnapshot(baselines);
  if (!Object.keys(snap.indices).length) {
    console.warn('[pulse] 无指数行情，跳过（保留现有文案）');
    return null;
  }
  let p = await generateMarketPulse(snap);
  if (!pulseLooksValid(p, snap)) {
    if (p) console.warn('[pulse] LLM 输出未复现真实点位，回退到机械文案');
    else console.log('[pulse] LLM 不可用，使用含真实数字的机械文案');
    p = placeholderMarketPulse(snap);
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
  if (pulse.sentimentSummary) out = replaceInner(out, 'sentiment-summary-text', esc(String(pulse.sentimentSummary)));
  if (pulse.editorialDate) {
    out = out.replace(/const EDITORIAL_DATE = '[^']*'/, `const EDITORIAL_DATE = '${pulse.editorialDate}'`);
  }
  return out;
}
