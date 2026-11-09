/**
 * 富途热度榜本地产出脚本（scripts/futu_hot.mjs）
 *
 * 连本地 FutuOpenD 实时取美股热度 TopN，写出 futu_hot.json，供 regenerate.mjs 在
 * 每日管线中消费（无需在 CI 里连 OpenD）。
 *
 * 前置：
 *   - 安装依赖：npm i futu-api
 *   - 本地启动 FutuOpenD（富途牛牛开放平台 -> 下载 OpenD），可连接成功
 *   - 环境变量（可选）：FUTU_HOST(默认 127.0.0.1) / FUTU_PORT(默认 11111) / FUTU_TOPN(默认 5)
 *     / FUTU_HOT_JSON(输出路径，默认 ./futu_hot.json)
 *
 * 用法：
 *   node scripts/futu_hot.mjs                 # 取 Top5 写 futu_hot.json
 *   FUTU_TOPN=10 node scripts/futu_hot.mjs    # 取 Top10
 *
 * 产出格式（与 regenerate 的 FUTU_HOT_JSON 约定一致）：
 *   [{ "code": "NVDA", "name": "英伟达", "heat": 999.99, "chg": 2.78 }, ...]
 *
 * 注：若 OpenD 不可用，脚本会 warn 并退出（不写空文件，避免覆盖已有数据）。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchFromOpenD } from './futu.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const topN = Number(process.env.FUTU_TOPN || 5);
  const outPath = process.env.FUTU_HOT_JSON
    ? resolve(ROOT, process.env.FUTU_HOT_JSON)
    : resolve(ROOT, 'futu_hot.json');

  console.log(`[futu_hot] 连接 OpenD 取美股热度 Top${topN}…`);
  const list = await fetchFromOpenD(topN);
  if (!list || !list.length) {
    console.warn('[futu_hot] 未取到数据（确认 OpenD 已启动且可连接、futu-api 已安装）。未写入文件，保留现有 futu_hot.json（如有）。');
    process.exit(0);
  }
  writeFileSync(outPath, JSON.stringify(list, null, 2), 'utf8');
  console.log(`[futu_hot] 已写出 ${list.length} 条到 ${outPath}`);
  console.log(JSON.stringify(list, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
