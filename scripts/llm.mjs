/**
 * LLM 长文生成模块（scripts/llm.mjs）
 *
 * 调用任意 OpenAI 兼容的 /v1/chat/completions 端点，为单只股票生成看板所需的
 * 编辑性长文（latest / fundamental / peNote / verdict），以及热度股的 why 一句话。
 *
 * 配置（环境变量，全部可选，缺省即降级返回 null）：
 *   LLM_API_KEY   必填才真正调用；为空则 generate* 直接返回 null（主流程用占位兜底）。
 *   LLM_BASE_URL  默认 https://api.openai.com/v1
 *   LLM_MODEL     默认 gpt-4o-mini
 *   LLM_TIMEOUT   ms，默认 60000
 *
 * 设计原则：
 *   - 纯 fetch，无第三方依赖，Node >= 18 可直接跑。
 *   - 严格约束输出为 JSON，并遵守原站 v7.2 字数上限（latest<=110 / fundamental<=130 / peNote<=65 / verdict<=175）。
 *   - 任何失败（无 key / 网络错 / 解析失败）都返回 null，绝不抛错中断主流程。
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function cfg() {
  return {
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    timeout: Number(process.env.LLM_TIMEOUT || 60000),
  };
}

/**
 * 调一次 chat/completions，返回解析后的 JSON（必须是合法 JSON，否则返回 null）。
 */
async function chatJson(systemPrompt, userPrompt, c = cfg()) {
  if (!c.apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeout);
  try {
    const resp = await fetch(`${c.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({
        model: c.model,
        temperature: 0.5,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!resp.ok) {
      console.warn(`[llm] HTTP ${resp.status} ${resp.statusText}`);
      return null;
    }
    const j = await resp.json();
    const text = j?.choices?.[0]?.message?.content;
    if (!text) return null;
    // 容忍模型在 JSON 外加 markdown 代码块
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn(`[llm] 调用失败：${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 行情快照 -> 可读上下文文本
function ctxText(symbol, ctx) {
  if (!ctx) return `${symbol}（暂无实时基线数据）`;
  const pos = ctx.valuationPos != null ? `，52周区间位置约 ${ctx.valuationPos.toFixed(0)}%` : '';
  return [
    `标的：${symbol}`,
    `最新价：$${ctx.price}`,
    `涨跌幅：${ctx.changePct >= 0 ? '+' : ''}${ctx.changePct?.toFixed(2)}%`,
    `前收：$${ctx.prev}`,
    `52周高/低：$${ctx.hi52} / $${ctx.lo52}${pos}`,
  ].join('；');
}

const STOCK_SYS = `你是美股财经编辑。为个股写四段式解读，用于投资者看板。
严格输出 JSON，字段：latest, fundamental, peNote, verdict。
字数上限（中文）：latest<=110字，fundamental<=130字，peNote<=65字，verdict<=175字。
分工：latest 讲当天涨跌与原因；fundamental 讲生意怎么赚钱、关键变量是什么；
peNote 讲贵不贵、贵在哪；verdict 结论先行，写"位置 + 对什么敏感 + 往后看什么"。
只输出 JSON，不要任何解释。`;

/**
 * 为单只股票生成四段式深度解读。
 * @param {string} symbol
 * @param {object|null} ctx 由 buildBaseline 产出的 {price,prev,changePct,hi52,lo52,valuationPos}
 * @returns {Promise<{name,latest,fundamental,peNote,verdict}|null>}
 */
export async function generateEditorial(symbol, ctx) {
  const user = `${ctxText(symbol, ctx)}\n请基于以上行情为 ${symbol} 生成四段式解读 JSON。`;
  const j = await chatJson(STOCK_SYS, user);
  if (!j || !j.latest || !j.verdict) return null;
  return {
    name: j.name || symbol,
    latest: String(j.latest).slice(0, 200),
    fundamental: String(j.fundamental || '').slice(0, 240),
    peNote: String(j.peNote || '').slice(0, 120),
    verdict: String(j.verdict).slice(0, 320),
  };
}

const HOT_SYS = `你是美股财经编辑。为一支登上热度榜的股票写一句"为什么被关注"的短评。
严格输出 JSON，字段：why。why<=110字，写"为什么被关注（结合热度/涨幅）+ 可用来看什么信号"。
只输出 JSON。`;

/**
 * 为热度股生成 why 一句话。
 * @param {{code,name,heat,chg}} stock
 * @param {object|null} ctx 行情基线
 * @returns {Promise<string|null>}
 */
export async function generateHotWhy(stock, ctx) {
  const heatTxt = stock.heat ? `热度约 ${stock.heat} 万` : '热度靠前';
  const chgTxt = stock.chg != null ? `，当日涨跌 ${stock.chg >= 0 ? '+' : ''}${stock.chg}%` : '';
  const user = `股票 ${stock.name}(${stock.code})，${heatTxt}${chgTxt}。${ctxText(stock.code, ctx)}\n请生成该股的 why 短评 JSON。`;
  const j = await chatJson(HOT_SYS, user);
  if (!j || !j.why) return null;
  return String(j.why).slice(0, 200);
}

// 占位生成（LLM 不可用时兜底，保证页面有可读内容而非空）
export function placeholderEditorial(symbol, ctx) {
  const chg = ctx?.changePct != null ? `${ctx.changePct >= 0 ? '+' : ''}${ctx.changePct.toFixed(2)}%` : '—';
  const pos = ctx?.valuationPos != null ? `，52周位置约 ${ctx.valuationPos.toFixed(0)}%` : '';
  return {
    name: symbol,
    latest: `${symbol} 当日涨跌 ${chg}${pos}。具体驱动因素待接入 LLM 后自动生成。`,
    fundamental: `${symbol} 的基本面结构待接入 LLM 后自动生成（营收来源与关键变量）。`,
    peNote: `${symbol} 的估值贵贱点评待接入 LLM 后自动生成。`,
    verdict: `结论先行：${symbol} 处于区间${pos || '中段'}。对宏观与板块情绪最敏感，往后看资金面与业绩兑现；接入 LLM 后给出更完整评估。`,
  };
}

export function placeholderWhy(stock, rank, total) {
  const chgTxt = stock.chg != null ? `，涨${stock.chg >= 0 ? '+' : ''}${stock.chg}%` : '';
  return `热度第${rank}/${total}（约 ${stock.heat ?? '—'} 万${chgTxt}）。登录 LLM 后自动生成"为什么被关注"与可观察信号。`.slice(0, 200);
}

// 独立调试：node scripts/llm.mjs
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const c = cfg();
  if (!c.apiKey) {
    console.log('LLM_API_KEY 未设置，生成占位：');
    console.log(JSON.stringify(placeholderEditorial('AAPL', { price: 342, prev: 344, changePct: -0.52, hi52: 355, lo52: 243, valuationPos: 88 }), null, 2));
  } else {
    generateEditorial('AAPL', { price: 342, prev: 344, changePct: -0.52, hi52: 355, lo52: 243, valuationPos: 88 })
      .then((r) => console.log(JSON.stringify(r, null, 2)));
  }
}
