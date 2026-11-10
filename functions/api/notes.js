/**
 * Cloudflare Pages Function —— 自选股「即时 AI 深度解读」
 * 路由：/api/notes
 *
 * GET  -> { ok:true, notes:{ CODE:{name,latest,fundamental,peNote,verdict,generatedAt} } }
 *         返回所有在服务端生成过、且已跨设备持久化的解读。
 * POST -> body: { code:"META", force?:false }
 *         拉取该股真实行情 → 调 LLM 生成四段式解读 → 写入 WATCHLIST_KV → 返回 note。
 *         加入自选股时由前端自动调用，因此不再需要等次日 06:30 的每日管线。
 *
 * 依赖：
 *   - KV 绑定 WATCHLIST_KV（与 /api/watchlist 共用同一个 namespace，另用独立 key）
 *   - Pages 环境变量（Secret）LLM_API_KEY；可选 LLM_BASE_URL / LLM_MODEL
 * 未配置密钥时明确返回 { ok:false, code:'NO_KEY' }，前端会提示"次日每日任务仍会补齐"，
 * 绝不用占位文字伪装成已生成。
 *
 * 防护（接口公开可写）：
 *   - 代码格式白名单 + 长度上限
 *   - 生成前必须能取到有效 Yahoo 行情（无效代码不消耗 LLM 额度）
 *   - 同一只股票 30 分钟冷却（force 可跳过）
 *   - 全局每日 60 次生成额度
 *   - LLM 输出禁词清洗 + 占位检测，不合格直接判失败、保留旧解读
 */
const STORE_KEY = 'usDashboard_notes_v1';
const WATCHLIST_KEY = 'usDashboard_watchlist_v2';
const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_PER_DAY = 60;
const CODE_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

const BANNED = /财报超预期|受.{0,8}(消息|传闻)推动|创下?新高|突破|后市有望|资金流入|机构上调|评级上调|预计将|有望|最大单日|利好刺激|主力净流入/g;
const PLACEHOLDER = /待接入|暂无数据|无法生成|作为\s?AI|占位|placeholder/i;

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function fail(error, code, status = 400) {
  return json({ ok: false, error, code }, status);
}

async function readStore(env) {
  try {
    const raw = await env.WATCHLIST_KV?.get(STORE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return { notes: o.notes || {}, daily: o.daily || { date: '', count: 0 } };
    }
  } catch (e) { /* KV 不可用 / 内容损坏：从空状态开始 */ }
  return { notes: {}, daily: { date: '', count: 0 } };
}

async function writeStore(env, store) {
  if (!env.WATCHLIST_KV) return false;
  try {
    await env.WATCHLIST_KV.put(STORE_KEY, JSON.stringify(store));
    return true;
  } catch (e) {
    return false;
  }
}

/** 是否在服务端 KV 保存的自选列表里（仅用于阻拦明显的乱刷，不强制） */
async function inWatchlist(env, code) {
  try {
    const raw = await env.WATCHLIST_KV?.get(WATCHLIST_KEY);
    if (!raw) return true; // 尚未建立列表时不阻拦
    const o = JSON.parse(raw);
    if (!Array.isArray(o.codes) || !o.codes.length) return true;
    return o.codes.includes(code);
  } catch (e) {
    return true;
  }
}

/** 与 /api/watchlist 一致的 Yahoo 快照，额外算出 52 周区间位置 */
async function getQuote(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=1d&interval=1m';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const resp = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; us-stock-dashboard/1.0)' },
    });
    if (!resp.ok) return null;
    const d = await resp.json();
    const r = d?.chart?.result?.[0];
    const m = r?.meta;
    if (!m) return null;
    const price = Number(m.regularMarketPrice);
    const prev = Number(m.previousClose != null ? m.previousClose : m.chartPreviousClose);
    if (!(price > 0) || !(prev > 0)) return null;
    const hi52 = Number(m.fiftyTwoWeekHigh) || null;
    const lo52 = Number(m.fiftyTwoWeekLow) || null;
    const pos = hi52 && lo52 && hi52 > lo52 ? ((price - lo52) / (hi52 - lo52)) * 100 : null;
    return {
      name: m.shortName || m.longName || symbol,
      price, prev, hi52, lo52,
      changePct: ((price - prev) / prev) * 100,
      valuationPos: pos,
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function fmt(v) { return v == null ? '—' : Number(v).toFixed(2); }

function describe(code, q) {
  return [
    `标的：${code}（${q.name}）`,
    `最新价：$${fmt(q.price)}`,
    `涨跌幅：${q.changePct >= 0 ? '+' : ''}${fmt(q.changePct)}%`,
    `前收：$${fmt(q.prev)}`,
    `52周高/低：$${fmt(q.hi52)} / $${fmt(q.lo52)}`,
    q.valuationPos != null ? `52周区间位置约 ${q.valuationPos.toFixed(0)}%` : '',
  ].filter(Boolean).join('；');
}

const STOCK_SYS = `你是美股财经编辑。为个股写四段式解读，用于投资者看板。
严格输出 JSON，字段：latest, fundamental, peNote, verdict（可选 name）。
字数上限（中文）：latest<=110字，fundamental<=130字，peNote<=65字，verdict<=175字。
分工：latest 讲当天涨跌与给定行情中的位置；fundamental 讲这类生意通常怎么赚钱、关键变量是什么；
peNote 讲贵不贵、贵在哪；verdict 结论先行，写"位置 + 对什么敏感 + 往后看什么"。
硬性要求：
- 只能使用用户给出的价格、涨跌幅、前收、52周高低与估值位置；禁止编造财报、新闻、政策、评级、订单、并购或任何未给出的数字与日期。
- 禁止写"财报超预期""受XX消息推动""创下新高""突破关口""后市有望"等无数据支撑的归因或预测；latest 只描述给定涨跌与相对位置，可用"当日波动较大/小幅整理"等中性表述。
- 可写常识性的商业模式（如"主要收入来自硬件与软件生态"），但不得声称这是当日发生的事件。
只输出 JSON，不要任何解释。`;

async function callLlm(code, q, env) {
  const apiKey = env.LLM_API_KEY || '';
  if (!apiKey) return { error: '服务端尚未配置 LLM_API_KEY（Cloudflare Pages → Settings → Environment variables），配置后重新部署即可即时生成；每日 06:30 的定时任务仍会自动补齐解读。', code: 'NO_KEY' };
  const base = (env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const model = env.LLM_MODEL || 'deepseek/deepseek-chat';

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 55000);
  try {
    const resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        'HTTP-Referer': 'https://us-stock-dashboard-bxj.pages.dev/',
        'X-Title': 'US Stock Dashboard',
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: STOCK_SYS },
          { role: 'user', content: describe(code, q) + `\n请基于以上行情为 ${code} 生成四段式解读 JSON。` },
        ],
      }),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 200);
      return { error: `LLM 网关返回 HTTP ${resp.status}（${detail}）`, code: 'LLM_HTTP' };
    }
    const j = await resp.json();
    const text = j?.choices?.[0]?.message?.content;
    if (!text) return { error: 'LLM 未返回内容', code: 'LLM_EMPTY' };
    const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) { return { error: 'LLM 输出不是合法 JSON', code: 'LLM_JSON' }; }
    return { parsed };
  } catch (e) {
    return { error: 'LLM 调用失败或超时：' + String(e && e.message ? e.message : e), code: 'LLM_FAIL' };
  } finally {
    clearTimeout(timer);
  }
}

/** 禁词命中时用只复述真实数字的中性文案替换该段，杜绝模型幻觉 */
function scrub(text, fallback, limit) {
  let t = String(text == null ? '' : text).replace(/<[^>]+>/g, '').trim().slice(0, limit);
  if (!t || PLACEHOLDER.test(t) || BANNED.test(t)) return fallback;
  return t;
}

function buildNote(code, q, parsed) {
  const dir = q.changePct >= 0 ? '上涨' : '下跌';
  const pos = q.valuationPos != null ? `，位于 52 周区间约 ${q.valuationPos.toFixed(0)}% 的位置` : '';
  const neutralLatest = `${code} 当日${dir} ${Math.abs(q.changePct).toFixed(2)}%，收于 ${fmt(q.price)} 美元${pos}。`;
  const neutralFund = `${code} 的基本面解读需结合其主营业务与行业格局观察，此处仅基于给定行情数据，不引用未经提供的财报或新闻。`;
  const neutralPe = '当前估值判断仅参考股价在 52 周区间中的相对位置。';
  const neutralVerdict = `${code} 当日${dir} ${Math.abs(q.changePct).toFixed(2)}%${pos}；后续需结合公司基本面与行业需求变化观察。`;
  const latest = scrub(parsed.latest, neutralLatest, 200);
  const verdict = scrub(parsed.verdict, neutralVerdict, 320);
  if (!latest || !verdict) return null;
  return {
    name: String(parsed.name || q.name || code).slice(0, 60),
    latest,
    fundamental: scrub(parsed.fundamental, neutralFund, 240),
    peNote: scrub(parsed.peNote, neutralPe, 120),
    verdict,
    generatedAt: new Date().toISOString(),
    source: 'realtime',
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'GET') {
    const store = await readStore(env);
    return json({ ok: true, notes: store.notes });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2048) return fail('请求体过大', 'BODY_TOO_LARGE', 413);
    body = JSON.parse(raw || '{}');
  } catch (e) {
    return fail('请求体必须是 JSON', 'BAD_JSON');
  }

  const code = String(body.code || '').toUpperCase().replace(/\.US$/, '').replace(/\s+/g, '');
  if (!CODE_RE.test(code)) return fail('股票代码格式不正确（示例：META、BRK.B）', 'BAD_CODE');
  const force = body.force === true;

  const store = await readStore(env);
  const prev = store.notes[code];
  if (!force && prev?.generatedAt && Date.now() - Date.parse(prev.generatedAt) < COOLDOWN_MS) {
    return json({ ok: true, note: prev, cached: true, reason: 'cooldown' });
  }

  const today = new Date().toISOString().slice(0, 10);
  if (store.daily.date !== today) store.daily = { date: today, count: 0 };
  if (store.daily.count >= MAX_PER_DAY) {
    return fail('今日即时解读生成额度已用完（60 次/天），明日自动恢复；每日 06:30 的定时任务仍会为全部自选股刷新解读。', 'RATE_LIMIT', 429);
  }

  // 明显乱刷：代码既不在服务端自选列表、又不是前端本次刚加入的，直接拒绝。
  // body.codes 由前端带上，用来覆盖「watchlist 的 POST 与 notes 的 POST 并发、KV 尚未落库」的窗口。
  const clientCodes = Array.isArray(body.codes) ? body.codes.map(c => String(c).toUpperCase()) : [];
  if (!(await inWatchlist(env, code)) && !clientCodes.includes(code)) {
    return fail('该代码不在当前自选股列表中', 'NOT_IN_WATCHLIST', 403);
  }

  const q = await getQuote(code);
  if (!q) return fail(`无法获取 ${code} 的有效行情：请确认代码正确且为美股上市主体`, 'NO_QUOTE', 422);

  const llm = await callLlm(code, q, env);
  if (llm.error) return fail(llm.error, llm.code, llm.code === 'NO_KEY' ? 503 : 502);

  const note = buildNote(code, q, llm.parsed);
  if (!note) return fail('LLM 输出缺少必需字段，已保留原有解读', 'BAD_NOTE', 502);

  store.daily.count += 1;
  store.notes[code] = note;
  const persisted = await writeStore(env, store);
  return json({
    ok: true,
    note,
    cached: false,
    persisted,
    quote: { price: q.price, changePct: q.changePct },
  });
}
