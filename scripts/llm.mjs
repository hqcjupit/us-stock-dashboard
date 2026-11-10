/**
 * LLM 长文生成模块（scripts/llm.mjs）
 *
 * 调用任意 OpenAI 兼容的 /v1/chat/completions 端点，为单只股票生成看板所需的
 * 编辑性长文（latest / fundamental / peNote / verdict），以及热度股的 why 一句话。
 *
 * 配置（环境变量，全部可选，缺省即降级返回 null）：
 *   LLM_API_KEY   必填才真正调用；为空则 generate* 直接返回 null（主流程用占位兜底）。
 *   LLM_BASE_URL  默认 https://openrouter.ai/api/v1（OpenRouter，开箱即用只需设 LLM_API_KEY）
 *   LLM_MODEL     默认 deepseek/deepseek-chat
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

// —— 可选：本地若处于需要走代理的网络（如本机沙箱 HTTPS_PROXY），让全局 fetch 走代理 ——
// 仅当存在代理环境变量且本机装了 undici 时启用；CI 直连环境自动跳过，不依赖任何第三方包。
const PROXY_URL =
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY_URL) {
  try {
    const undici = await import('undici');
    if (undici?.ProxyAgent && undici?.setGlobalDispatcher) {
      undici.setGlobalDispatcher(new undici.ProxyAgent(PROXY_URL));
      console.warn(`[llm] 检测到代理，已启用全局出站 dispatcher → ${PROXY_URL}`);
    }
  } catch (e) {
    console.warn('[llm] 未安装 undici，跳过代理设置（CI 直连环境可忽略此提示）。');
  }
}

function cfg() {
  return {
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.LLM_MODEL || 'deepseek/deepseek-chat',
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

/* ==================== 市场脉搏（01 模块）每日盘后解读 ==================== */
const PULSE_SYS = `你是美股财经编辑，为「市场脉搏」看板写每日盘后解读。
严格输出 JSON，字段：oneline（字符串数组，3~4 段）、indexNotes（对象，含 sp500/nasdaq/dow 三个字符串）、vixExplain（字符串）、sentimentSummary（字符串）。
硬性要求：
- 只能基于用户给出的真实行情数字做解读；禁止编造新闻事件、政策、财报、官员讲话或任何未给出的具体数字。
- oneline 第一段必须准确复述三大指数收盘点位与涨跌幅（使用给定数字，保留两位小数、加千分位）。
- 后续段落只做结构性与定性分析（谁领涨/谁落后、分化还是共振、风险偏好、可验证的观察点），可用"市场情绪""资金""利率预期"等定性表述，但不得杜撰事实。
- 禁止使用"创下新高/突破/见底/后市有望/预计/将"等未经给定数据支撑的判断或预测；不要推断星期几，直接用给定日期。
- 可用信息仅限三类：给定日期、三大指数点位与涨跌幅（及由此推出的相对强弱）、VIX 数值与涨跌幅（及 20 分界的通常含义）。
- 禁止断言板块表现、资金流向、市场广度、利率/政策预期、成交量与后市走势——这些都没有数据支撑。可写"纳指涨幅高于标普与道指，成长风格相对占优"这类由给定涨跌幅直接推出的相对判断。
- 每段<=90字；indexNotes 每条<=70字；vixExplain<=90字；sentimentSummary<=110字。
- 中文纯文本，不要 Markdown，只输出 JSON。`;

function fmtNum(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(v) {
  return v == null ? '—' : `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}

function pulsePrompt(snap) {
  const names = { sp500: '标普500(^GSPC)', nasdaq: '纳斯达克(^IXIC)', dow: '道琼斯(^DJI)' };
  const lines = [`交易日：${snap.date || '最新交易日'}`];
  for (const [k, n] of Object.entries(names)) {
    const q = snap.indices[k];
    if (q) lines.push(`${n}：收盘 ${fmtNum(q.price)}，涨跌幅 ${fmtPct(q.changePct)}，前收 ${fmtNum(q.prev)}`);
  }
  if (snap.vix) lines.push(`VIX 恐慌指数：${fmtNum(snap.vix.price)}，涨跌幅 ${fmtPct(snap.vix.changePct)}`);
  lines.push('请基于以上真实行情生成 JSON。再次强调：不得编造任何新闻事件或未给出的数字。');
  return lines.join('\n');
}

/**
 * 用 LLM 生成 01 模块文案；失败/无 key 返回 null，由主流程用占位兜底。
 * @param {{date:string|null, indices:object, vix:object|null}} snap
 */
export async function generateMarketPulse(snap) {
  const j = await chatJson(PULSE_SYS, pulsePrompt(snap));
  if (!j || !Array.isArray(j.oneline) || !j.oneline.length) return null;
  return {
    oneline: j.oneline.filter(Boolean).map((x) => String(x).slice(0, 160)),
    indexNotes: {
      sp500: String(j.indexNotes?.sp500 || '').slice(0, 140),
      nasdaq: String(j.indexNotes?.nasdaq || '').slice(0, 140),
      dow: String(j.indexNotes?.dow || '').slice(0, 140),
    },
    vixExplain: String(j.vixExplain || '').slice(0, 180),
    sentimentSummary: String(j.sentimentSummary || '').slice(0, 220),
  };
}

/** 无 LLM 时的机械兜底：只复述真实数字，绝不编造原因。 */
export function placeholderMarketPulse(snap) {
  const names = { sp500: '标普500', nasdaq: '纳斯达克', dow: '道琼斯' };
  const parts = Object.entries(names)
    .filter(([k]) => snap.indices[k])
    .map(([k, n]) => `${n} ${fmtNum(snap.indices[k].price)}（${fmtPct(snap.indices[k].changePct)}）`);
  return {
    oneline: [
      `${snap.date || '最新交易日'} 收盘：${parts.join('，')}。`,
      '以上为每日自动刷新的收盘行情快照；深度解读需配置 LLM 后自动生成。',
    ],
    indexNotes: Object.fromEntries(Object.entries(names).map(([k, n]) => [
      k,
      snap.indices[k]
        ? `${n}收于 ${fmtNum(snap.indices[k].price)}，当日 ${fmtPct(snap.indices[k].changePct)}。点评待接入 LLM 后生成。`
        : '行情暂缺。',
    ])),
    vixExplain: snap.vix
      ? `VIX 报 ${fmtNum(snap.vix.price)}，当日 ${fmtPct(snap.vix.changePct)}。它衡量买保险的成本，数值越高代表市场越紧张；20 以下通常视为警报缓解。`
      : 'VIX 行情暂缺。',
    sentimentSummary: '情绪指标需结合指数涨跌与成交量观察；完整解读待接入 LLM 后自动生成。',
  };
}

// 独立调试：node scripts/llm.mjs
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const c = cfg();
  if (!c.apiKey) {
    console.log('LLM_API_KEY 未设置，生成占位：');
    console.log(JSON.stringify(placeholderEditorial('AAPL', { price: 342, prev: 344, changePct: -0.52, hi52: 355, lo52: 243, valuationPos: 88 }), null, 2));
  } else {
    generateEditorial('AAPL', { price: 342, prev: 344, changePct: -0.52, hi52: 355, lo52: 243, valuationPos: 88 })
      .then((r) => console.log(JSON.stringify(r, null, 2)));
  }
}
