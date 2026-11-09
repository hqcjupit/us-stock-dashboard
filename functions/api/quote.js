/**
 * Cloudflare Pages Function —— 自有行情中转
 * 路由：/api/quote?symbol=^GSPC&range=1d&interval=1m
 *
 * 作用：在服务端请求 Yahoo Finance，把结果原样返回给前端，
 * 从而彻底摆脱对 allorigins / corsproxy.io / codetabs 等第三方 CORS 代理的依赖
 * （原站那段 5 代理轮询 + 重试的脆弱链路，在没有本函数时作为兜底仍保留在前端）。
 *
 * 返回结构与 Yahoo 完全一致：{ chart: { result: [...], error: null } }，
 * 因此前端无需任何解析逻辑改动。
 */
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const symbol = url.searchParams.get('symbol');
  const range = url.searchParams.get('range') || '1d';
  const interval = url.searchParams.get('interval') || '1m';

  if (!symbol) {
    return json({ error: 'missing symbol' }, 400);
  }

  const target =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    '?range=' + encodeURIComponent(range) +
    '&interval=' + encodeURIComponent(interval);

  try {
    const resp = await fetch(target, {
      headers: {
        // Yahoo 对部分 symbol 会校验 UA，带上以降低被拒概率
        'User-Agent':
          'Mozilla/5.0 (compatible; us-stock-dashboard/1.0; +https://example.com)',
      },
    });
    if (!resp.ok) {
      return json({ error: 'upstream ' + resp.status }, resp.status);
    }
    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // 行情短缓存即可，降低对 Yahoo 的重复请求
        'cache-control': 'public, max-age=30',
        // 同源 Pages 不需要，但保留以便本地/跨域调试
        'access-control-allow-origin': '*',
      },
    });
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
