/**
 * 富途美股热度榜取数模块（scripts/futu.mjs）
 *
 * 两种数据源，按优先级自动选择：
 *   1) 本地 JSON 文件源（默认 ./futu_hot.json，可用 FUTU_HOT_JSON 覆盖）
 *      —— 由任意方式产出的热度榜文件，每行形如 {"code":"NVDA","name":"英伟达","heat":999.99,"chg":2.78}
 *      —— 与原站注释中的 .workbuddy/futu_hot.json 对齐，推荐在 CI/服务器上用 OpenD 脚本预生成。
 *   2) 直连富途 OpenD 实时取（需安装 futu-api 且本地有 FutuOpenD 进程在跑）
 *      —— 通过 Qot_GetHotList 取美股综合热度榜，过滤 ETF/停牌，返回 TopN。
 *
 * 两者皆不可用时返回 []（主流程会自动降级为占位，不阻塞每日管线）。
 *
 * 降级容错：本模块绝不抛错中断主流程，只 warn 并返回可用数据。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 判定是否为 ETF（富途热度榜会混入 ETF，需剔除）
function looksLikeETF(code, name) {
  if (!code) return true;
  const c = String(code).toUpperCase();
  if (/(\.|^)(ETF|ETN|ETP)$/.test(c)) return true;
  if (/ETF|指数|基金/i.test(name || '')) return true;
  return false;
}
// 判定是否停牌（chg 为 null/NaN 视为停牌或不可报价）
function isSuspended(chg) {
  return chg == null || (typeof chg === 'number' && Number.isNaN(chg));
}

/**
 * 从本地 JSON 读取热度榜。
 * 支持两种格式：
 *   - 数组 [{code,name,heat,chg}, ...]
 *   - 对象 { data: [...], stockList: [...], list: [...] }
 * 返回规范化数组 [{code, name, heat, chg}]，已过滤 ETF/停牌，按 heat 降序。
 */
function readFromJson(jsonPath) {
  if (!jsonPath || !existsSync(jsonPath)) return null;
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
  let arr = Array.isArray(raw) ? raw : (raw.data || raw.stockList || raw.list || raw.hotList || null);
  if (!Array.isArray(arr)) return null;
  const norm = arr
    .filter((s) => s && s.code)
    .map((s) => ({
      code: String(s.code).toUpperCase().replace(/\.US$/i, ''),
      name: s.name || s.code,
      heat: typeof s.heat === 'number' ? s.heat : (typeof s.heatVal === 'number' ? s.heatVal : 0),
      chg: typeof s.chg === 'number' ? s.chg : (typeof s.changeRate === 'number' ? s.changeRate : (s.changePct ?? null)),
    }))
    .filter((s) => !looksLikeETF(s.code, s.name) && !isSuspended(s.chg));
  norm.sort((a, b) => b.heat - a.heat);
  return norm;
}

/**
 * 直连富途 OpenD 实时取热度榜。
 * 需要：npm i futu-api，且本地 FutuOpenD 已启动并可连接。
 * 环境变量：FUTU_HOST(默认 127.0.0.1) / FUTU_PORT(默认 11111) / FUTU_TOPN(默认 5)
 * 返回规范化数组 [{code, name, heat, chg}]，失败返回 null（不抛错）。
 */
export async function fetchFromOpenD(topN) {
  try {
    const futu = (await import('futu-api')).default || (await import('futu-api'));
    const { OpenQuoteContext, Qot_Common } = futu;
    const host = process.env.FUTU_HOST || '127.0.0.1';
    const port = Number(process.env.FUTU_PORT || 11111);
    const ctx = new OpenQuoteContext({ host, port });

    // 富途热度榜：美股全市场综合热度
    const req = {
      market: Qot_Common.QotMarket.QotMarket_US,
      plateSetType: Qot_Common.SimplePlateSetType.SimplePlateSetType_All,
      typeList: [Qot_Common.QotGetHotListType.QotGetHotListType_ChangeRate],
    };
    const ret = await ctx.getHotList(req);
    await ctx.close();

    // 兼容不同 futu-api 版本的返回结构
    const payload = ret?.retData || ret || {};
    const sub = payload.subTypeList?.[0] || {};
    const list = sub.stockList || sub.list || payload.stockList || [];
    if (!Array.isArray(list) || !list.length) return null;

    const norm = list
      .map((s) => ({
        code: String(s.code || s.stockCode || '').toUpperCase().replace(/\.US$/i, ''),
        name: s.name || s.stockName || s.code || '',
        heat: typeof s.heat === 'number' ? s.heat : (s.heatVal ?? 0),
        chg: typeof s.chg === 'number' ? s.chg : (s.changeRate ?? s.changePct ?? null),
      }))
      .filter((s) => s.code && !looksLikeETF(s.code, s.name) && !isSuspended(s.chg));
    norm.sort((a, b) => b.heat - a.heat);
    return norm.slice(0, topN);
  } catch (e) {
    console.warn(`[futu] OpenD 实时取数失败（${e.message}）。可改用本地 futu_hot.json 源。`);
    return null;
  }
}

/**
 * 主入口：返回美股热度 TopN（默认 5），已过滤 ETF/停牌，按热度降序。
 * @returns {Promise<Array<{code,name,heat,chg}>>}
 */
export async function fetchFutuHotList() {
  const topN = Number(process.env.FUTU_TOPN || 5);
  const jsonPath = process.env.FUTU_HOT_JSON
    ? resolve(ROOT, process.env.FUTU_HOT_JSON)
    : resolve(ROOT, 'futu_hot.json');

  // 1) 本地 JSON 优先（最稳，适合服务器/CI）
  const fromJson = readFromJson(jsonPath);
  if (fromJson && fromJson.length) {
    console.log(`[futu] 从 ${jsonPath} 读取热度榜 ${fromJson.length} 条（取前 ${Math.min(topN, fromJson.length)}）。`);
    return fromJson.slice(0, topN);
  }
  if (existsSync(jsonPath)) console.warn('[futu] futu_hot.json 存在但解析为空（可能全是 ETF/停牌），回退 OpenD。');

  // 2) 直连 OpenD 实时
  const fromOpenD = await fetchFromOpenD(topN);
  if (fromOpenD && fromOpenD.length) {
    console.log(`[futu] 从 OpenD 实时取热度榜 ${fromOpenD.length} 条。`);
    return fromOpenD;
  }

  console.warn('[futu] 两种数据源均不可用，热度榜返回空（主流程将以占位兜底）。');
  return [];
}

// 供独立运行调试：node scripts/futu.mjs
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchFutuHotList().then((list) => {
    console.log(JSON.stringify(list, null, 2));
  });
}
