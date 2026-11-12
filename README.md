# 美股新手看板 · 自托管镜像

原站 `https://us-stock-dashboard-1hz.pages.dev/` 的复刻版本：单文件静态前端 + Cloudflare Pages Functions 后端，行情数据来自 Yahoo Finance，自选股可跨设备同步。

## 目录结构
```
us-stock-dashboard.html   # 前端单文件（已加固：转义股票名/代码防 XSS）
functions/
  api/quote.js            # 自有行情中转，替代第三方 CORS 代理
  api/watchlist.js        # 自选股同步后端（KV 持久化）
  api/notes.js            # 加入自选股即时生成 AI 解读（LLM + KV，跨设备共享）
scripts/
  regenerate.mjs          # 每日总管线：基线 + 个股长文 + 01/02/03/05/06 全模块重写 + 注入
  events.mjs              # 02 新闻 + 05 日程：RSS / 经济日历 / 财报日历取数与中文生成
  market_pulse.mjs        # 01 指数解读：当日指数/VIX 行情 + LLM 文案
  market_extra.mjs        # 01 情绪分 / 03 主题 / 06 宏观：Yahoo 板块+宏观行情、FRED、热搜榜
  verify-live.mjs         # 部署后回读线上，比对 stockNotes / EVENTS_DATE / EXTRA_DATE
  futu.mjs                # 富途美股热度榜取数（OpenD 实时 / 本地 JSON 源）
  futu_hot.mjs            # 本地连 OpenD 产出 futu_hot.json（供 CI/脚本消费）
  llm.mjs                 # LLM 长文生成（OpenAI 兼容，纯 fetch）
.github/workflows/daily.yml  # 每日 06:30(北京) 自动跑管线并提交的 GitHub Actions
wrangler.toml            # Pages + KV 绑定配置
baselines.json           # 脚本产出：每只标的的 baseQuote + baseDyn（每日更新）
hot_list.json            # 脚本产出：富途热度 Top5（hotStocks 形状）
editorial.json           # 脚本产出：默认股 + 新增自选的四段式解读（stockNotes 形状）
events.json              # 脚本产出：02 模块新闻卡片（含来源、时间、原文链接）
calendar.json            # 脚本产出：05 模块日程（宏观数据 + 重点财报，北京时间）
market_pulse.json        # 脚本产出：01 模块指数解读与解读日期
market_extra.json        # 脚本产出：情绪分项、11 个板块涨跌、9 张宏观卡、热搜榜
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
- **个股解读层**：`stockNotes` —— 加入自选股时由 `/api/notes` 即时生成（存 KV、跨设备）+ 每日 06:30 全量重生成，前端按 `generatedAt` 取较新者。

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

> 四段式严格遵守原站 v7.2 字数上限（latest≤110 / fundamental≤130 / peNote≤65 / verdict≤175 字）。无 `LLM_API_KEY` 时 `editorial.json` 写占位文本，但**不会注入页面**（保留已有真实解读）。个股 prompt 明令禁止编造财报、新闻、评级与未给出的数字。

可用 GitHub Action / cron 每天 06:30 触发，再把结果写回 HTML 重新部署。

### 一键每日自动化（GitHub Actions）
仓库已带 `.github/workflows/daily.yml`：每天**北京时间 06:30** 自动跑管线——先预取线上自选股列表，按当天行情为**每一只自选股**重生成长文并注入 HTML、同步 `index.html` 后提交；**若已配置 `CLOUDFLARE_API_TOKEN`**，再由 wrangler 部署到 Cloudflare Pages（生产分支 `main`）并回读线上校验。

使用前准备：
1. 本地 `node scripts/futu_hot.mjs` 生成并提交 `futu_hot.json`（CI 直接用它，不必连 OpenD）。
2. 在仓库 **Settings → Secrets** 配置 `LLM_API_KEY`（即 OpenRouter 的 `sk-or-v1-...` 密钥）；默认已走 OpenRouter `deepseek/deepseek-chat`，不配则长文用占位。
3. **若要"生成后自动部署到线上"**（一次性配置，之后全自动），创建 Cloudflare API Token 并写入仓库 Secret：

   **① Cloudflare 控制台 → My Profile → API Tokens → Create Token → Start from scratch / Custom**
   | 字段 | 填什么 |
   |---|---|
   | Token name | `github-actions-us-stock-dashboard` |
   | Permissions | 在 **Edit Account policy** 里，用 `Search for permission groups...` 搜 `Pages`，勾选 **Cloudflare Pages → Edit**（新版 UI，2026-11 起；Pages 归在 `Developer Platform` 分类）。旧版 UI 是三个下拉：**Account / Cloudflare Pages / Edit** |
   | Account Resources | `Include` 保持，把默认的 `All accounts` 改成 **你的账号**（能改就改；只有一个账号时不改也能用） |
   | Client IP address filtering | **留空**（GitHub Actions runner 出口 IP 不固定，填了会导致 CI 鉴权失败） |
   | Token expiration | 建议 `1 year`（到期前重建 Token 并更新 Secret）；`No expiration` 也能用，但长期凭证风险更高 |

   > ⚠️ 不要用 **"Edit Cloudflare Workers"** 模板——它不含 Pages 权限，部署会报 `Could not route to /client/v4/accounts/.../pages/projects`；也别用 `Bulk Select` 批量勾选，只勾上面这一条权限，泄漏影响面最小。
   > 选完后权限计数应从 `0` 变成 `1`。点 **Continue to summary → Create Token**，然后**立刻复制 token 值**（Cloudflare 只显示一次）。
   > 可用 `curl https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer <token>"` 验证 Token 有效。

   **② GitHub 仓库 → Settings → Secrets and variables → Actions → Secrets 标签页 → New repository secret**
   - Name：`CLOUDFLARE_API_TOKEN`（**必须一字不差**，写错会被静默跳过部署）
   - Secret：粘贴上一步的 token → **Add secret**

   > Account ID 已写死在 `daily.yml`（`c926e05f2df0b00dd6bb32c06000df66`），**不需要**再配 `CLOUDFLARE_ACCOUNT_ID`。
   > 本项目是用 `wrangler` Direct Upload 创建的，不要再切 Git 集成（切换不可逆，且会绕过本仓库的生成步骤）。

   - 未配置该 Secret 时：工作流**仍能生成长文并提交**，`Check deploy credentials` 步骤会打印 `::notice::` 并**明确跳过**部署（不会假成功），线上站点需手动 `wrangler pages deploy . --project-name us-stock-dashboard --branch main`。
   - 已配置时：部署完成后工作流会自动拉取生产域名，校验本次 `stockNotes` 是否全部上线；不一致直接把 job 标红。
4. 推送后 Actions 即按 cron 运行；也可在 Actions 页面手动 `Run workflow` 立即试跑。

#### 每日到底更新什么（数据分层）

| 层 | 内容 | 更新方式 |
|---|---|---|
| 实时层 | 三大指数 / 个股 / VIX 的**价格数字** | 每次打开页面经 `/api/quote` 拉 Yahoo |
| 基线层 | `defaultStocks` 的 `baseQuote`/`baseDyn`、`baselines.json` | 每日管线刷新 |
| 指数解读层 | 01 模块「一句话」、三大指数点评、VIX 与情绪解读、`EDITORIAL_DATE` | 每日管线用 `^GSPC/^IXIC/^DJI/^VIX` 真实行情 + LLM 生成并注入（`scripts/market_pulse.mjs`，产物 `market_pulse.json`） |
| 个股长文 | `stockNotes`（线上自选股里的每一只） | **两条来源**：① 加入自选股时由 `/api/notes` **即时生成**（写 KV、跨设备）；② 每日全量重生成：管线先读 `/api/watchlist` 的 codes，用当天行情 + LLM 重写四段式并合并注入。前端按 `generatedAt` 取较新者；LLM 失败/占位时保留旧解读 |
| 热度榜 | `hotStocks` | **每日自动更新**：Yahoo Finance 美股热搜榜（trending）取前 5，再用 Yahoo 行情补价格/涨跌（`scripts/market_extra.mjs`）；富途 OpenD 可用时保留为兜底，CI 无 OpenD 也不再冻结榜单 |
| 02 事件 / 05 日程 | 真实报道 RSS + 经济/财报日历 | **每日管线重写**（`scripts/events.mjs`），模块顶部与页脚显示「自动更新于 X（北京时间）」；数据源失败时保留上次内容并显式提示 |
| 01 情绪综合分 | `fg-value` / 指针 / 口径说明 | **每日重算**：指数动能、板块宽度、VIX、避险需求、信用需求、指数动量六分项等权（`scripts/market_extra.mjs`）。CNN 官方 Fear & Greed 接口已下线，卡片已改名为「市场情绪综合分（本看板计算）」并写明口径，不再展示假的静态数字 |
| 03 市场主题 | 主线、领涨/落后板块、两个提醒 | **每日重写**：11 只 SPDR 行业 ETF 当日涨跌 + 热搜榜，LLM 只做基于给定数字的叙述 |
| 06 核心指标 | 9 张卡的数值 / 涨跌 / 解读 / 来源 + 三句话串讲 | **每日整体重写**：Yahoo `^TNX/^TYX/DX-Y.NYB/CL=F/GC=F/HG=F/BTC-USD/^GSPC` + FRED `DGS2`。原「12 月加息概率 78%」无可靠免费数据源，已替换为真实的「2 年期美债收益率（FRED DGS2）」，并同步作为 2Y-10Y 利差的计算输入（`YIELD_2Y_BASE`） |

> 修复记录：此前 01 模块整块是写死的 11/6 文案，导致「顶部日期是新的、解读还停留在上周五，且一句话里的点位与卡片实时价互相矛盾」。现在 01 模块每天随行情重写；LLM 输出还会经过**数字一致性校验**（必须复现至少两个真实收盘点位），不合格即回退到只复述真实数字的机械文案，绝不编造新闻或数字。

#### 02「发生了什么大事」/ 05「接下来要注意什么」怎么更新

此前这两块是 11/6 的手写快照，每日管线完全不碰——指数和个股每天变，事件却永远停在 11/6（还写着已经过去的 11/10 CPI）。现在改为每日重写：

| 模块 | 真实数据源 | 处理 |
|---|---|---|
| 02 | Google News RSS（两组查询）、CNBC Top News、WSJ Markets | 合并去重，按主题相关度与时效打分取 3 条；卡片给出中文改写、来源、北京时间、原文链接与英文原标题 |
| 05 | ForexFactory 本周经济日历（USD，High/Medium，原始时间 GMT）、Nasdaq 财报日历（仅知名美股） | 换算为北京时间、同场次去重，按时间排序取 4~5 条；附市场预期/前值与可核对的看点 |

- LLM 只做翻译与常识性「看点」，prompt 硬性禁止编造数字、新闻、政策与预测；输出再做禁词清洗。无 `LLM_API_KEY` 时降级为「中文事件名 + 真实英文原标题 + 模板化看点」，**依然每天更新**。
- 公开接口偶发 429 / 代理抖动：取数重试 3 次，FF 依次尝试 HTTPS / HTTP / 带查询串三个地址，新闻与日程串行抓取；单模块彻底失败时保留上次内容并在模块顶部明确提示，不静默留过期内容。
- 每次成功刷新都会写入 `EVENTS_DATE`，模块顶部与页脚都显示「自动更新于 YYYY-MM-DD HH:mm（北京时间）」，可直接判断有没有更新。
- 本地单独验证/刷新：`node scripts/events.mjs --write-html`（会同时注入 `us-stock-dashboard.html` 与 `index.html`）。

#### 01 情绪分 / 03 主题 / 06 仪表盘怎么更新

全站已无「11/6 编辑部快照」模块。`scripts/market_extra.mjs` 在每日管线里串行抓取，一次 Yahoo `spark` 批量请求即可拿多只标的的日线，避免逐只请求被限流：

| 内容 | 数据源 | 说明 |
|---|---|---|
| 11 个行业 ETF 当日涨跌 | Yahoo `XLK/XLC/XLY/XLP/XLB/XLE/XLF/XLV/XLI/XLU/XLRE` | 03 领涨/落后板块、板块宽度分项 |
| 9 个宏观指标 | Yahoo `^TNX ^TYX DX-Y.NYB CL=F GC=F HG=F BTC-USD ^GSPC ^VIX` | 06 九张卡；10Y/30Y 的差值换算成 bp 时要 ×100（原始单位是百分点） |
| 2 年期美债收益率 | FRED `DGS2` CSV（工作日更新，约滞后 1 日） | 06 新卡 + `YIELD_2Y_BASE`，前端 2Y-10Y 利差也用它 |
| 情绪六分项 | Yahoo `SPY`（125 日均线）、`HYG`/`IEF`（20 日相对收益）、`^GSPC`、`^VIX`、板块宽度 | 0~100 等权合成，页面列出每项得分与原始数字 |
| 热搜榜 Top5 | Yahoo `v1/finance/trending/US` + `spark` 行情 | 03 热搜卡；短评为纯机械模板，避免给陌生代码编造行业/新闻 |

- LLM 只写文字，数值全部来自上述接口；prompt 禁止编造财报、新闻、政策、评级与宏观状态判断，输出再经禁词清洗。无 `LLM_API_KEY` 时降级为「真实数字 + 中性模板」，**依然每天更新**。
- 任一模块取数失败 → 保留上次内容并在模块顶部插入醒目提示，不静默留过期内容；成功刷新写入 `EXTRA_DATE`，顶部/页脚/`verify-live` 都会核对。
- 本地单独刷新：`node scripts/market_extra.mjs --write-html`（同时注入两份 HTML）；跑完整管线用 `LLM_API_KEY=... node scripts/regenerate.mjs --write-html`。

#### 新加自选股，解读什么时候出现？

**现在：加入的当场就生成（约 20~60 秒），不用等次日。**

链路：

1. 网页点「加入自选」→ `POST /api/watchlist` 保存代码 → 前端紧接着 `POST /api/notes`（带上本次完整 codes，避免两次写入的并发窗口）。
2. `functions/api/notes.js` 先向 Yahoo 取该股**真实行情**（取不到直接拒绝，不浪费 LLM 额度），再用服务端密钥调用 OpenRouter 生成四段式解读；输出经过禁词清洗与占位检测，禁止编造财报/新闻/评级。
3. 结果写入 `WATCHLIST_KV` 的 `usDashboard_notes_v1` key。任意设备打开页面时 `GET /api/notes` 会把它合并进 `stockNotes`，因此**跨设备可见**。
4. 卡片显示「⏳ AI 解读生成中… → ✅ 已生成」；失败时列出具体原因并提供「↻ 重试生成解读」按钮，**原有解读不会被覆盖**。

每条解读都带 `generatedAt`。前端按时间戳比较 `/api/notes` 的即时解读与 HTML 内嵌的每日解读，取较新者，所以次日 06:30 的每日全量刷新不会被当天早些时候的即时解读反向覆盖。

同时保留每日兜底：工作流每天 06:30（北京时间）读 `/api/watchlist` 拿到**当前全部自选股**，逐只重生成解读并注入 `stockNotes`，再提交、部署、回读校验。因此：

- **新加的股票**：当场生成；即使即时生成失败，次日 06:30 也会自动补齐。
- **已有的股票**：解读每天重写一次，不再冻结在首次生成那天。
- **想手动全量刷新**：Actions → `Daily US Stock Dashboard Regenerate` → **Run workflow**，`stocks` **留空**即为全量重生成。
- `stocks` 输入框只用于**额外指定不在自选列表里的股票**（空格/逗号分隔，如 `META COIN`），运行后同样会生成并注入。
- 前端 `buildStocks` 对默认股也优先使用 `stockNotes`，因此默认 6 只同样每天更新，不再显示 11/6 的手写快照。

#### 让「即时生成」生效（只需配置一次）

**Cloudflare Pages 的环境变量与 GitHub Actions 的 Secrets 是两套独立配置**，每日任务能生成不代表网页端也能生成：

1. Cloudflare Dashboard → **Workers & Pages** → `us-stock-dashboard` → **Settings → Environment variables → Production → Add variables**，添加 `LLM_API_KEY`（类型选 Secret / Encrypt），值为 OpenRouter 的 `sk-or-v1-...`；保存后**重新部署一次**（变量在部署时注入）。
   CLI 等价命令：`wrangler pages secret put LLM_API_KEY --project-name us-stock-dashboard`（交互式输入，不落盘）。
2. 可选变量：`LLM_BASE_URL`（默认 `https://openrouter.ai/api/v1`）、`LLM_MODEL`（默认 `deepseek/deepseek-chat`）。
3. 自检：`GET https://us-stock-dashboard-bxj.pages.dev/api/notes` 应返回 `{"ok":true,"notes":{...}}`；未配置密钥时 `POST /api/notes` 返回 `HTTP 503 / NO_KEY`，页面会明确提示，不会伪装成已生成。

> 安全边界：`/api/watchlist` 与 `/api/notes` 是公开可写的，两侧都做代码格式白名单校验；`/api/notes` 另有限流：同一只股票 30 分钟冷却、全局 60 次/天、代码必须在服务端自选列表或本次请求携带的 `codes` 中、必须能取到有效行情。LLM 密钥只存在服务端环境变量，前端永远拿不到；LLM 未返回真实内容时**跳过该股、保留已有解读**，不会用占位文本覆盖。
> 本地等价操作：`WATCHLIST_CODES="AAPL TSLA NVDA MSFT AMZN AMD GOOGL INTC" node scripts/regenerate.mjs --write-html`，再把 `us-stock-dashboard.html` 复制为 `index.html` 后部署。也可不设该变量，让脚本自己拉线上列表（`WATCHLIST_API_URL` 可改地址）。

## 安全说明
- 已对股票名/代码渲染做 HTML 转义，修复原站的 XSS 隐患。
- 自选股代码会 POST 到 `/api/watchlist`；若介意暴露浏览过的代码，可不绑定 KV（仅本机 localStorage）。
