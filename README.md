# 美股新手看板 · 自托管镜像

原站 `https://us-stock-dashboard-1hz.pages.dev/` 的复刻版本：单文件静态前端 + Cloudflare Pages Functions 后端，行情数据来自 Yahoo Finance，自选股可跨设备同步。

## 目录结构
```
us-stock-dashboard.html   # 前端单文件（已加固：转义股票名/代码防 XSS）
functions/
  api/quote.js            # 自有行情中转，替代第三方 CORS 代理
  api/watchlist.js        # 自选股同步后端（KV 持久化）
scripts/
  regenerate.mjs          # 每日管线：基线 + 富途热度榜 + LLM 长文
  futu.mjs                # 富途美股热度榜取数（OpenD 实时 / 本地 JSON 源）
  futu_hot.mjs            # 本地连 OpenD 产出 futu_hot.json（供 CI/脚本消费）
  llm.mjs                 # LLM 长文生成（OpenAI 兼容，纯 fetch）
.github/workflows/daily.yml  # 每日 06:30(北京) 自动跑管线并提交的 GitHub Actions
wrangler.toml            # Pages + KV 绑定配置
baselines.json           # 脚本产出：每只标的的 baseQuote + baseDyn（每日更新）
hot_list.json            # 脚本产出：富途热度 Top5（hotStocks 形状）
editorial.json           # 脚本产出：默认股 + 新增自选的四段式解读（stockNotes 形状）
futu_hot.json            # 富途热度榜原始数据（本地 futu_hot.mjs 生成后提交；CI 直接消费）
```

## 部署（Cloudflare Pages）
1. 把 `us-stock-dashboard.html` 改名为 `index.html`（或部署时指定入口）。
2. 绑定本仓库到 Cloudflare Pages（Git 推送或 `wrangler pages deploy .`）。
3. 创建 KV namespace，把 ID 填进 `wrangler.toml` 的 `id` 字段；绑定名必须为 `WATCHLIST_KV`。
   - 不绑 KV 也能跑：只是自选股不做跨设备同步，其余功能（含实时行情）不受影响。

### 跨设备同步说明（已支持）
- 自选股代码列表与基线都存于 KV（`WATCHLIST_KV`）。在任意设备打开网址、增删自选后，服务端即保存完整代码列表。
- **在另一台电脑上直接输入网址打开**，页面加载时会从服务端拉取代码列表并以其为准重建自选股——因此 A 电脑加的股，B 电脑打开同一网址就能看到，删除也会同步。
- 注意：每台设备仍会缓存一份到 `localStorage` 作为离线兜底；当与服务端不一致时，以服务端为准（服务端是跨设备的唯一真相源）。
4. 部署后访问站点即可。前端会优先调用 `/api/quote`，无后端时自动回退第三方代理链。

## 数据架构
- **编辑层**：六大模块的中文长文解读（冻结在示例交易日，需每日重生成）。
- **基线层**：`defaultStocks`/`hotStocks`/`extraBase` 内嵌的价格与动态基线，每天刷新一次。
- **实时层**：打开页面经 `/api/quote` 拉 Yahoo，每 5 分钟自动刷新，失败则停在基线值。

## 每日自动化（可选，完整管线）
`scripts/regenerate.mjs` 一次跑完三层数据刷新，且**无凭证即可跑**（缺失时自动降级，不中断）：

1. **基线层**：Yahoo 计算每只标的 `baseQuote` + `baseDyn` → `baselines.json`
2. **热度榜**：富途美股热度 Top5（`scripts/futu.mjs`）→ `hot_list.json`
3. **编辑层**：LLM 四段式解读（`scripts/llm.mjs`）→ `editorial.json`

用法：
```bash
node scripts/regenerate.mjs                  # 刷新默认列表基线 + 热度榜 + 默认股解读
node scripts/regenerate.mjs AAPL NVDA        # 额外为这两只生成 stockNotes 并注入
node scripts/regenerate.mjs --write-html     # 把热度榜与 stockNotes 注入 us-stock-dashboard.html
node scripts/regenerate.mjs --refresh-default-baselines  # 同时用 live Yahoo 刷新默认自选 baseQuote/baseDyn
```

### 环境变量
**富途热度榜（`scripts/futu.mjs`，二选一即可，优先本地 JSON）：**
| 变量 | 说明 | 默认 |
|---|---|---|
| `FUTU_HOT_JSON` | 本地热度榜文件路径（任意方式产出的 `[{code,name,heat,chg}]`） | `./futu_hot.json` |
| `FUTU_HOST` / `FUTU_PORT` | 直连 OpenD 实时取数时的地址 | `127.0.0.1:11111` |
| `FUTU_TOPN` | 取前 N 名 | `5` |

> 没有富途账号时，可手动放一份 `futu_hot.json`（如从富途牛牛导出），或直接留空——热度榜返回空，主流程不阻塞。

**本地生成 `futu_hot.json`（推荐，需富途开放平台账号）：**
```bash
npm i futu-api            # 一次性安装富途 SDK
# 启动本地 FutuOpenD（富途牛牛开放平台下载），保持可连接
node scripts/futu_hot.mjs                 # 取 Top5 写 futu_hot.json
FUTU_TOPN=10 node scripts/futu_hot.mjs    # 取 Top10
```
生成的 `futu_hot.json` 提交进仓库后，CI 每日直接消费它，**无需在 GitHub runner 上连 OpenD**。

> CI 网络注意：GitHub Actions 的 runner 是数据中心 IP，Yahoo 可能返回 403（与本地沙箱同因）。因此**最佳实践**是把每日任务跑在能稳定访问 Yahoo 的环境（Cloudflare Cron Worker 边缘、或本地机器 cron）后 push；GitHub Actions 也能跑，只是基线刷新依赖 Yahoo 可达性——拿不到时基线保留上次结果，长文/热度榜仍正常生成。

**LLM 长文（`scripts/llm.mjs`，OpenAI 兼容）：**
| 变量 | 说明 | 默认 |
|---|---|---|
| `LLM_API_KEY` | 模型网关密钥；**为空则全部用占位文本** | 空 |
| `LLM_BASE_URL` | 兼容 `/v1/chat/completions` 的地址 | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | 模型名 | `deepseek/deepseek-chat` |
| `LLM_TIMEOUT` | 单次超时(ms) | `60000` |

> 默认走 **OpenRouter**（`sk-or-v1-...` 密钥），开箱即用只需设 `LLM_API_KEY`。任何 OpenAI 兼容网关都可用：改 `LLM_BASE_URL`/`LLM_MODEL` 即可（如直连 DeepSeek、硅基流动、本地 Ollama 等）。
> 本地若处于需代理的网络（如本机沙箱 `HTTPS_PROXY`），脚本会自动加载 `undici` 走全局代理；CI 直连环境无需 `undici`。

> 四段式严格遵守原站 v7.2 字数上限（latest≤110 / fundamental≤130 / peNote≤65 / verdict≤175 字）。无 `LLM_API_KEY` 时生成占位，页面仍有可读内容。

可用 GitHub Action / cron 每天 06:30 触发，再把结果写回 HTML 重新部署。

### 一键每日自动化（GitHub Actions）
仓库已带 `.github/workflows/daily.yml`：每天**北京时间 06:30** 自动跑管线，生成长文并注入 HTML、同步 `index.html` 后提交，再由 wrangler 部署到 Cloudflare Pages（生产分支 `main`）。

使用前准备：
1. 本地 `node scripts/futu_hot.mjs` 生成并提交 `futu_hot.json`（CI 直接用它，不必连 OpenD）。
2. 在仓库 **Settings → Secrets** 配置 `LLM_API_KEY`（即 OpenRouter 的 `sk-or-v1-...` 密钥）；默认已走 OpenRouter `deepseek/deepseek-chat`，不配则长文用占位。
3. **若要"提交后自动部署到线上"**，再配置 `CLOUDFLARE_API_TOKEN`（Cloudflare API Token，需 `Pages:Edit` 权限，在 Cloudflare 控制台 → My Profile → API Tokens 创建）。
   - 未配置时工作流**仍能生成长文并提交**，只是最后部署步骤被跳过（设为 `continue-on-error`，不阻断主流程）——线上站点不会自动更新。
   - 二选一补救：① 本地 `wrangler pages deploy . --project-name us-stock-dashboard --branch main` 手动部署；② 在 Cloudflare 把 Pages 项目改为 **Git 集成**（绑定本仓库），此后每次 push 自动部署，无需任何 Token。
4. 推送后 Actions 即按 cron 运行；也可在 Actions 页面手动 `Run workflow` 立即试跑。

#### 方案A：为指定股票一键生成 LLM 长文（推荐）
仓库的 `Daily US Stock Dashboard Regenerate` 工作流支持手动触发输入：
- 进入仓库 **Actions → Daily US Stock Dashboard Regenerate → Run workflow**；
- 在 `stocks` 输入框填入股票代码（**空格或逗号分隔**，如 `GOOGL META`），留空则只刷新默认基线；
- 点运行：脚本会为该股票调 OpenRouter 生成四段式长文，**合并**注入 `stockNotes`（不覆盖已有的 AMD 等解读），同步 `index.html` 后提交；若已配 `CLOUDFLARE_API_TOKEN` 则自动部署上线。
- 之后在网站把该股票加入自选，卡片即显示真实 LLM 长文（前端 `buildStocks` 优先使用 `stockNotes`）。

> 也可以本地等价操作：`node scripts/regenerate.mjs GOOGL --write-html`，再把 `us-stock-dashboard.html` 复制为 `index.html` 后部署。

## 安全说明
- 已对股票名/代码渲染做 HTML 转义，修复原站的 XSS 隐患。
- 自选股代码会 POST 到 `/api/watchlist`；若介意暴露浏览过的代码，可不绑定 KV（仅本机 localStorage）。
