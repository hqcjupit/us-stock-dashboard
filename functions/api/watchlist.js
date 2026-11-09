/**
 * Cloudflare Pages Function —— 自选股同步后端
 * 路由：/api/watchlist
 *
 * GET  -> { ok:true, extras:{ CODE:{name,baseQuote,baseDyn} }, invalid:[] }
 *         返回服务端已缓存的自选基线（跨设备共享）。
 * POST -> body: string[]（股票代码数组）
 *         服务端为新增代码拉取 Yahoo 基线，写回 KV，并返回 extras + invalid。
 *
 * 依赖 KV 绑定：WATCHLIST_KV（在 wrangler.toml / 控制台绑定）。
 * 未绑定 KV 时优雅降级：GET 返回空 extras，POST 仍会实时计算并返回 extras
 * （只是不持久化，跨设备同步失效）。
 *
 * 说明：baseDyn（技术面/资金面/52周位置）的计算逻辑较重，
 * 这里只返回 baseQuote（价格/前收/涨跌幅/52周高低），
 * baseDyn 仍由前端 refreshStockCard 在客户端用 /api/quote 取得日线后计算，
 * 保持后端轻量、无重复实现。
 */
const NS = 'usDashboard_watchlist_v2';

async function getQuote(symbol) {
  const target =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    '?range=1d&interval=1m';
  try {
    const resp = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; us-stock-dashboard/1.0)' },
    });
    const d = await resp.json();
    const r = d && d.chart && d.chart.result && d.chart.result[0];
    if (!r) return null;
    const m = r.meta;
    const price = m.regularMarketPrice;
    const prev = m.previousClose != null ? m.previousClose : m.chartPreviousClose;
    if (price == null || prev == null) return null;
    return {
      name: m.shortName || m.longName || symbol,
      baseQuote: {
        price,
        prev,
        changePct: ((price - prev) / prev) * 100,
        hi52: m.fiftyTwoWeekHigh != null ? m.fiftyTwoWeekHigh : null,
        lo52: m.fiftyTwoWeekLow != null ? m.fiftyTwoWeekLow : null,
        marketTime: m.regularMarketTime != null ? m.regularMarketTime : null,
      },
    };
  } catch (e) {
    return null;
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'GET') {
    try {
      const raw = await env.WATCHLIST_KV?.get(NS);
      const obj = raw ? JSON.parse(raw) : { extras: {}, codes: [] };
      // codes 是跨设备共享的"自选股代码列表"；前端加载时以它为准重建列表，实现跨设备同步
      return json({
        ok: true,
        codes: Array.isArray(obj.codes) ? obj.codes : [],
        extras: obj.extras || {},
        invalid: [],
      });
    } catch (e) {
      return json({ ok: true, codes: [], extras: {}, invalid: [] });
    }
  }

  if (request.method === 'POST') {
    let codes = [];
    try {
      codes = await request.json();
    } catch (e) {
      /* ignore */
    }
    if (!Array.isArray(codes)) {
      return json({ ok: false, error: 'body must be an array of codes' }, 400);
    }
    codes = codes
      .map((c) => String(c).toUpperCase().replace(/\.US$/, '').replace(/\s+/g, ''))
      .filter(Boolean);

    const extras = {};
    const invalid = [];
    for (const code of codes) {
      const q = await getQuote(code);
      if (q && q.baseQuote && q.baseQuote.price > 0) {
        extras[code] = { name: q.name, baseQuote: q.baseQuote };
      } else {
        invalid.push(code);
      }
    }

    // 持久化（仅在有 KV 绑定时生效）
    try {
      const prevRaw = await env.WATCHLIST_KV?.get(NS);
      const prev = prevRaw ? JSON.parse(prevRaw) : { extras: {} };
      prev.extras = Object.assign(prev.extras || {}, extras);
      prev.codes = codes;
      await env.WATCHLIST_KV?.put(NS, JSON.stringify(prev));
    } catch (e) {
      /* 无 KV 绑定时静默跳过 */
    }

    return json({ ok: true, extras, invalid });
  }

  return new Response('Method Not Allowed', { status: 405 });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
