# 指数与基金能力增强评估（含 UZI-Skill / finskills / quantskills 借鉴）

- 文档版本：v1.1（在原路线图基础上扩展）
- 状态：评估与规划 + 实现进展（P0-P2 已落地并验证；扩展项 E1/E2/E3 已落地并验证；其余扩展项规划中）
- 目标读者：Dexter 维护者 / 实现工程师
- 关联代码：`src/tools/finance/`、`src/tools/search/`、`src/tools/registry.ts`、`src/skills/`
- 关联文档：`docs/domestic-index-data-integration.md`（指数数据接入设计基线）
- 借鉴仓库：
  - `wbh604/UZI-Skill`（MIT）— A/H/美股个股深度分析引擎
  - `Geeksfino/finskills`（Apache-2.0）— 投资分析 Claude Skills 合集
  - `quantskills/quantskills`（社区目录，**无公开端点/无现成代码**）— 214 个量化 skill，含「ETF、基金与指数」分类，仅作方法论参考

---

## 1. 背景与目标

### 1.1 现状

- 指数能力已有但很浅：仅 9 个硬编码宽基指数、只有价量（点位/涨跌/量额 + 日周月 K 线），无估值、无成分股、无资金面（见 `src/tools/finance/domestic-index-api.ts`）。
- 个股结构化财务（`get_financials`/`read_filings`/`stock_screener`）由 `FINANCIAL_DATASETS_API_KEY` 门控，且只覆盖美股；A 股个股无对应能力。
- **基金 / ETF 完全空白**：没有净值、持仓、折溢价、筛选等任何工具或 skill。
- Skill 框架只支持 `SKILL.md` + 同目录引用文件；内置 skill 目前有 `dcf`、`write-memo`、`x-research`。

### 1.2 本文件目标

只聚焦 **指数（index）** 与 **基金（基金/ETF/LOF）** 两条线，回答三件事：

1. 现在还能优化哪些点（按性价比排序）。
2. 从 UZI-Skill、finskills、quantskills 能直接借鉴哪些 skill / 数据源 / 方法。
3. 需要新增哪些工具与 skill，以及接入方式、工作量、风险。

### 1.3 非目标（本文件不展开）

- 个股深度基本面重建（另需独立的 A 股财务 provider 规划）。
- 美股/港股能力扩展。
- 实盘交易、组合下单。

### 1.4 实现进展（v1.1 更新）

原 P0-P2 计划以及扩展项 E1/E2/E3 均已实现并通过验证（`bunx tsc --noEmit` 退出码 0；`bun test` 414 pass / 7 skip / 0 fail）。已落地能力如下，均可 keyless 使用，并复用既有「熔断 3 次/45s + 分层缓存 + GBK 解码 + `formatToolResult`」范式：

| 阶段 | 交付 | 工具 / 技能 | 状态 |
|---|---|---|---|
| P0 | 指数目录扩展 + 任意 secid | `INDEX_CATALOG` 9 → 19（含中证A100/800/全指/A500、科创100、中证红利、上证红利、深证100、国证2000、北证50），`resolveIndex` 支持任意 `1.xxxxxx`/`600519.SH`/`sh000001`/未知 6 位代码 | 已完成 |
| P0 | 指数估值分位 | `get_index_valuation`（蛋卷，PE/PB/股息率/分位/ROE/PEG/国债收益率；未覆盖指数优雅返回 null） | 已完成 |
| P0 | 基金/ETF 行情与净值 | `get_fund_quotes`（批量，含 ETF 场内价）、`get_fund_nav`（区间净值） | 已完成 |
| P1 | 市场广度 | `get_market_breadth`（涨跌/平盘家数、涨停/跌停、两市成交额） | 已完成 |
| P1 | 资金面（北向替代） | `get_margin_data`（两融余额/融资净买入/融券余额/占流通市值比） | 已完成（**北向已停披露，改以两融代理**） |
| P1 | 基金持仓穿透 | `get_fund_holdings`（前十持仓、占净值比、增减持、行业） | 已完成 |
| P1 | 指数 → ETF 映射 | `get_index_etf_map`（跟踪 ETF，过滤联接基金） | 已完成 |
| P2 | 指数成分 | `get_index_constituents`（成分代码 + 名称 + 最新价 + **权重**） | 已完成 |
| E3 | 真实成分权重 | `index-weights-api.ts`（中证官方 `closeweight.xls`，SheetJS 解析；非中证代码回退东财并标注无权重） | 已完成 |
| E1 | ETF 折溢价 | `get_fund_quotes` 新增**折溢价率**列（(场内价−净值)/净值；东财未暴露 IOPV，故为净值口径） | 已完成 |
| E2 | 指数调样事件 | skill `index-rebalance-event-study`（成分 + `domestic_search` 公告 + ETF 映射） | 已完成 |
| P2 | 行业板块 | `get_industry_boards`（东财行业板块，可下钻到板块成分） | 已完成 |
| P2 | 基金筛选/排行 | `get_fund_rankings`（按周期与类型排行） | 已完成 |
| P2 | 基金公司/经理 | `get_fund_profile`（公司/经理/类型/最新净值） | 已完成 |
| — | 技能 | `index-valuation`、`index-breadth-review`、`fund-holdings-lookthrough`、`sector-rotation`、`index-rebalance-event-study` | 已完成 |

开关：`FUND_TOOLS_DISABLED=1`（基金类）、`DOMESTIC_MARKET_DISABLED=1`（广度/两融/ETF 映射/成分/行业）。

> 说明：`get_index_valuation`、`get_market_breadth`、`get_margin_data`、`get_index_etf_map`、`get_index_constituents`、`get_industry_boards`、`get_fund_*` 均注册为**顶层工具**（不经过 `get_market_data` 路由）。北向净买入自 2024 年起停止每日披露，东财相关报表接口失效，故 `get_northbound_flow` 未实现；`northbound-flow` skill 相应调整为以两融为主。指数权重经 `index-weights-api.ts`（依赖 `xlsx@0.18.5`，SheetJS）读取中证官方 `closeweight.xls`（缓存 24h、熔断 3 次/45s，失败即回退东财成分且标注无权重）；E1 折溢价因东财未暴露 IOPV 采用净值口径；E2 为纯 skill，无新增接口。

---

## 2. 现状基线（改动落点）

| 层 | 文件 | 关键事实 |
|---|---|---|
| 指数数据 | `src/tools/finance/domestic-index-api.ts` | `INDEX_CATALOG` 已扩至 19 个；东财主源 + 腾讯兜底；30s 快照缓存；熔断 3 次/45s；`decodeGbk` 已导出；`getIndexSnapshot/Snapshots/Bars` |
| 指数工具 | `src/tools/finance/domestic-index.ts` | `get_index_snapshot`、`get_index_snapshots`、`get_index_prices`、`get_index_valuation` |
| 指数成分/权重 | `src/tools/finance/index-constituents-api.ts`、`index-weights-api.ts` | 成分（东财 `RPT_INDEX_COMPONENT`）+ 权重（中证 `closeweight.xls`，`xlsx`/SheetJS 解析）；熔断 + 24h 缓存 |
| 市场/行业 | `src/tools/finance/domestic-market-api.ts`、`industry-api.ts` | 广度（`ulist.np` f104/f105/f106）、两融（`RPTA_RZRQ_LSHJ`）、行业板块（`clist` + GBK） |
| 基金 | `src/tools/finance/domestic-fund-api.ts`、`fund-rank-api.ts`、`fund-profile-api.ts` | 净值/行情含**折溢价率**（`fundmobapi`）、持仓（`FundMNInverstPosition`）、排行（`rankhandler`，GBK）、画像（`FundSearchAPI`） |
| 路由 | `src/tools/finance/get-market-data.ts` | 无 key 时 `buildMarketDataTools` 只绑指数：`buildMarketDataTools`(:109-138)；两套描述 `GET_MARKET_DATA_DESCRIPTION[_INDEX_ONLY]`(:16-89) |
| 格式化 | `src/tools/finance/formatters.ts` | `MARKET_DATA_FORMATTERS` 以**子工具 name 为键**；顶层工具在自身 func 内格式化，不注册 |
| 顶层注册 | `src/tools/registry.ts` | keyless 工具默认注册；`FUND_TOOLS_DISABLED`/`DOMESTIC_MARKET_DISABLED` 可关 |
| 国内资讯 | `src/tools/search/domestic-search-api.ts` | 东财/CLS/新浪/股吧 + CNINFO 公告；分层缓存；`LicensedSourceAdapter` 授权源扩展点（:805-831） |
| Skill 发现 | `src/skills/registry.ts` | **只扫描一层目录**（`<dir>/<name>/SKILL.md`）；内置目录 = `src/skills/`，项目目录 = `.dexter/skills/` |
| Skill 解析 | `src/skills/loader.ts` | frontmatter **只解析 `name` 与 `description`**；其余字段（license/metadata/version）会被忽略但不报错 |

> 结论：新增能力应复用「东财/腾讯 keyless + 熔断 + 缓存 + GBK」这套既有范式；skill 侧可直接沿用 `dcf` 的「SKILL.md + 同目录 references」结构。

---

## 3. 借鉴仓库核对结论

### 3.1 仓库定位

| 仓库 | 定位 | 许可 | 可借鉴点 | 明确不覆盖 |
|---|---|---|---|---|
| UZI-Skill | A/H/美股**个股**深度分析（22 维度 + 22 估值模型 + 66 人陪审团，输出 HTML 报告） | MIT（可自由改写，保留版权声明） | 基金持仓（经理抄作业）、龙虎榜、北向资金、行业维度、HTML 报告渲染 | 指数、ETF/基金估值与选择（**显式拒绝 ETF**，README 把基金业务指向 `wbh604/jilao-skills`） |
| finskills | 投资分析 Skills 合集（美股 15 + 中国 15） | Apache-2.0（可商用，需保留声明并标注修改） | 行业轮动、资产配置、量化因子、红利策略、事件驱动、组合体检、A 股数据工具包 | 指数估值、基金/ETF 选择、基金持仓 |
| quantskills | 社区量化 skill 目录（214 个，10 大类，2026-09 快照） | 多为 GPL-3.0 / 无 License，**无公开端点、无现成代码** | 指数估值轮动、ETF 评价/套利监控、指数调样事件研究、市场参与度/拥挤度、概念轮动、市场状态识别 | 无可用实现，仅方法论/字段口径参考 |

### 3.2 能力对照表（我们 vs 三仓库）

| 目标能力 | 我们现状 | UZI-Skill | finskills | quantskills | 结论 |
|---|---|---|---|---|---|
| A 股指数行情/K 线 | 有（19 指数） | 无 | 无 | 有（方法论） | 已扩展 |
| 指数估值分位（PE/PB/股息率） | **有** | 无 | 无 | 有（`index-valuation-rotation`） | 已自建 |
| 指数成分股/权重 | **有**（权重经中证 `closeweight.xls`） | 无 | 无 | 无 | 已自建 |
| 市场广度（涨跌家数/涨停数） | **有** | 部分 | 无 | 有（`a-share-market-participation`） | 已自建 |
| 北向资金 / 两融 | 两融**有**、北向无 | 有（已失效） | 有（已失效） | 有（监控类） | 北向停披露，两融替代 |
| 行业/板块轮动 | **有**（板块 + skill） | 部分 | 有 | 有 | 已自建 |
| 龙虎榜/游资 | 无 | 有 | 无 | 有（`b6-limitup-pool`） | 借鉴，待评估 |
| 基金/ETF 净值行情 | **有** | 无（拒 ETF） | 无 | 无 | 已自建 |
| 基金持仓穿透 | **有** | 有 | 无 | 无 | 已自建 |
| 基金/ETF 筛选 | **有**（排行 + 画像） | 无 | 无 | 有（`etf-fund-evaluator`） | 已自建，可加深 |
| ETF 折溢价/套利 | **有**（折溢价率，净值口径） | 无 | 无 | 有（`etf-arbitrage-monitor`） | 已自建（IOPV/份额待补） |
| 指数调样事件 | **有**（skill） | 无 | 无 | 有（`index-rebalance-event-study`） | 已自建 |
| 资产配置 | 无 | 部分 | 有 | 无 | 借鉴 finskills |
| 量化因子筛选 | 无 | 无 | 有 | 有 | 借鉴（偏个股，低优先） |
| HTML 报告输出 | 有 `write-memo` | 有成熟渲染器 | 有 `output-template.md` | 无 | 借鉴模板 |

**关键判断**：指数与基金这两个方向**三个来源都没有可安装的现成实现**，可借鉴的是「数据源清单 + 方法论 + 报告模板」，工具与 skill 需自建。

---

## 4. 推荐的优化项（按性价比排序）

### 4.1 指数线

| 优先级 | 功能 | 价值 | 成本 | 数据源（已/待验证） | 状态 |
|---|---|---|---|---|---|
| P0 | 扩展指数目录 + 支持任意 secid | 从"9 个白名单"变成"全市场指数" | 极低 | 东财 `push2` | 已完成 |
| P0 | 指数估值分位（PE/PB/股息率 + 历史百分位） | 指数分析核心缺口 | 中 | 蛋卷估值 `index_eva/detail` | 已完成 |
| P1 | 市场广度（涨跌家数、涨停/跌停、成交额） | "今天大盘怎么样"的实质答案 | 低 | 东财 `push2`（`ulist.np` + `ZTPool`） | 已完成 |
| P1 | 两融余额（北向替代） | 资金面 | 中 | 东财 `RPTA_RZRQ_LSHJ` | 已完成 |
| P1 | 成分股（代码/名称/价格） | 支撑"指数由谁驱动" | 中 | 东财 `RPT_INDEX_COMPONENT` | 已完成（**无权重**） |
| P1 | 行业板块（东财）+ 下钻成分 | 行业轮动前置 | 低 | 东财 `clist`（GBK） | 已完成 |
| P2 | 真实成分权重 | 加权/集中度分析 | 中 | 中证官方 `closeweight.xls`（SheetJS 解析） | 已完成 |
| P2 | ETF 折溢价 / IOPV / 份额 | ETF 特有信号 | 中 | 东财 ETF 行情 + 交易所 IOPV | 已完成（折溢价率；IOPV/份额待补） |
| P2 | 指数调样事件研究 | 调样前后事件收益 | 中 | 中证/国证公告 + `domestic_search` | 已完成（skill） |
| P3 | 指数估值轮动（行业相对估值） | 轮动线索 | 中 | 中证行业指数估值 | **扩展项 E4** |
| P3 | 市场参与度/拥挤度 | 情绪与拥挤风险 | 中 | 两融 + 成交额 + 换手（已有底层） | **扩展项 E5** |
| P3 | 概念题材轮动 | 主题热度 | 中 | 东财概念板块 `clist` | **扩展项 E6** |
| P3 | 市场状态识别（regime） | 择时/配置前置 | 高 | 指数 + 宏观（LPR/PMI/社融） | **扩展项 E7** |

### 4.2 基金线

| 优先级 | 功能 | 价值 | 成本 | 数据源（已/待验证） | 状态 |
|---|---|---|---|---|---|
| P0 | 基金/ETF 行情与净值 | 基金分析底座 | 中 | `fundmobapi` + `f10/lsjz` | 已完成 |
| P0 | ETF 折溢价 / IOPV / 份额变化 | ETF 特有信号 | 中 | 东财 ETF 行情、交易所 IOPV | 已完成（折溢价率；IOPV/份额待补） |
| P1 | 基金持仓穿透 | 高信息量，UZI 已验证需求 | 中 | `FundMNInverstPosition` | 已完成 |
| P1 | 基金筛选与排行 | 选基入口 | 中 | `rankhandler` | 已完成（可加深：回撤/夏普/规模/费率） |
| P1 | 指数 → ETF 映射 | 连接指数与基金两线 | 低 | `FundSearchAPI` | 已完成 |
| P2 | 基金公司/经理画像 | 主动基金 | 中 | `FundSearchAPI`（`FundBaseInfo`） | 已完成（简版） |
| P3 | 基金评价（同指数横向比较/跟踪误差/流动性） | 选基决策 | 中 | ETF 行情 + 净值序列 | **扩展项 E8** |
| P3 | 资产配置（股债/核心-卫星 ETF） | 配置方案 | 中 | 指数估值 + 基金筛选 | **扩展项 E9** |

---

## 5. 建议新增的 Skill

Skill 目录约定：`src/skills/<name>/SKILL.md`（内置）或 `.dexter/skills/<name>/SKILL.md`（项目）。references 放同目录（如 `dcf/sector-wacc.md`）。注意 frontmatter 仅 `name`/`description` 生效。

| Skill 名 | 触发场景 | 依赖工具 | 借鉴来源 | 状态 |
|---|---|---|---|---|
| `index-valuation` | "沪深300 估值高吗 / 处于历史什么分位" | `get_index_valuation`、`get_index_prices` | 自建方法论 | 已完成 |
| `index-breadth-review` | "今天大盘怎么样 / 市场情绪" | `get_market_breadth`、`get_margin_data`、`domestic_search(flash)` | UZI `screen.py` | 已完成 |
| `sector-rotation` | "现在该配哪个行业 / 行业轮动" | `get_industry_boards`、`get_market_breadth`、`get_margin_data` | finskills `sector-rotation-detector` | 已完成（简版） |
| `fund-holdings-lookthrough` | "基金经理最新重仓 / 抄作业" | `get_fund_holdings`、`get_fund_quotes`、`get_index_etf_map` | UZI `fetch_fund_holders.py` | 已完成 |
| `etf-selection` | "选哪只 ETF / 哪些 ETF 跟踪沪深300" | `get_fund_quotes`、`get_index_etf_map`、`get_index_valuation` | 自建 + quantskills `etf-fund-evaluator` | 待建（扩展 E8） |
| `fund-deep-dive` | "分析这只基金" | `get_fund_quotes`、`get_fund_holdings`、`get_fund_rankings` | UZI 基金面板 | 待建 |
| `etf-arbitrage-monitor` | "ETF 折溢价 / 套利空间" | `get_fund_quotes`（折溢价率）+ `get_index_etf_map` | quantskills `etf-arbitrage-monitor` | 待建（折溢价数据已就绪） |
| `index-rebalance-event-study` | "指数调样影响 / 纳入剔除" | `get_index_constituents` + `domestic_search` + `get_index_etf_map` | quantskills `index-rebalance-event-study` | 已完成 |
| `index-valuation-rotation` | "指数/行业相对估值与轮动" | `get_index_valuation` + 行业估值 | quantskills `index-valuation-rotation` | 待建（扩展 E4） |
| `northbound-flow` | "北向资金在买什么" | —（北向已停披露） | UZI / finskills | **改为两融口径，并入 `index-breadth-review`** |
| `asset-allocation` | "怎么配置 / 股债比例" | 指数估值 + 基金筛选 | finskills `risk-adjusted-return-optimizer` | 待建（扩展 E9） |
| `index-report`（可选） | "生成指数/基金报告" | 复用 `write-memo` 的 HTML 输出 | UZI HTML 渲染 + finskills `output-template.md` | 可选 |

> 已落 5 个：`index-valuation`、`index-breadth-review`、`sector-rotation`、`fund-holdings-lookthrough`、`index-rebalance-event-study`。

---

## 6. 接入方式

1. **工具层**
   - 指数：`domestic-index-api.ts` 已放宽 catalog / secid 解析；已新增 `domestic-index-valuation-api.ts`；顶层工具在 `formatters.ts` 内自带格式化。
   - 市场/行业：`domestic-market-api.ts`、`industry-api.ts`（东财 + GBK + 熔断 + 缓存）。
   - 基金：`domestic-fund-api.ts`、`fund-rank-api.ts`、`fund-profile-api.ts`。
   - 复用现值：`fetchWithTimeout`、熔断（3 次/45s）、`TTL_15M/1H/24H`、`decodeGbk`、`formatToolResult`。
2. **注册层**（`src/tools/registry.ts`）
   - 指数/基金 keyless，默认注册；`FUND_TOOLS_DISABLED=1`、`DOMESTIC_MARKET_DISABLED=1` 开关对齐 `DOMESTIC_SEARCH_DISABLED` 风格。
   - 若引入 Tushare 等授权源，用 `checkApiKeyExists('TUSHARE_TOKEN')` 门控。
3. **路由层**（`get-market-data.ts`）
   - 指数估值已并入 `buildMarketDataTools` 与 `GET_MARKET_DATA_DESCRIPTION[_INDEX_ONLY]`；新增顶层工具（广度/两融/行业/基金）不经路由。
4. **Skill 层**
   - 新增目录 + `SKILL.md`；references 放同目录。
   - 移植外部 SKILL.md 时：忽略 `license`/`metadata`/`version` 字段（我们只解析 `name`/`description`），把 Python 取数步骤改写为调用我们的工具。
5. **许可合规**
   - UZI 为 MIT：保留版权与许可声明即可自由改写。
   - finskills 为 Apache-2.0：保留声明、**标注修改过的文件**、附许可证副本。
   - quantskills 多为 GPL-3.0 / 无 License 且无代码：**只借鉴方法论与字段口径，不复制文本/代码**。

---

## 7. 分阶段路线图

### 7.1 原始路线图（执行结果）

| 阶段 | 内容 | 交付 | 预估 | 结果 |
|---|---|---|---|---|
| P0 | 指数 catalog 放宽 + 估值分位 + 基金/ETF 净值行情工具 | `get_index_valuation`、`get_fund_quotes`、`get_fund_nav` | 3-5 天 | 已完成 |
| P1 | 市场广度 + 两融 + 基金持仓 + 指数→ETF 映射 | 4 个工具 + 2 个 skill | 1-2 周 | 已完成 |
| P2 | 行业板块 + 成分 + 基金排行/画像 + 行业轮动 skill | 4 个工具 + 1 个 skill | 2-3 周 | 已完成 |
| P3 | 可选：Tushare 授权源增强、龙虎榜（借 UZI） | 扩展 provider | 待定 | 顺延至 7.2 |

> P1 中"北向资金"因数据源自 2024 年停止披露，替换为**两融**（`get_margin_data`）。

### 7.2 扩展路线图（v1.1 新增）

在原 P0-P2 基础上，按"性价比 × 与现有工具的契合度"扩展：

| 编号 | 扩展项 | 价值 | 成本 | 数据源 | 依赖现状 | 归属阶段 |
|---|---|---|---|---|---|---|
| **E1** | ETF 折溢价 / IOPV / 份额监控 | ETF 特有信号，套利与情绪 | 中 | 东财 ETF 行情 + 交易所 IOPV | 已有 `get_fund_quotes` 场内价，补 IOPV/折溢价即可 | 已完成（折溢价率） |
| **E2** | 指数调样事件研究 | 调样前后事件收益 | 中 | 中证/国证公告 + `domestic_search` | 已有 `get_index_constituents` 可做前后对比 | 已完成 |
| **E3** | 真实成分权重 | 加权/集中度分析 | 中 | 中证官方 `closeweight.xls`（SheetJS） | 已有 `get_index_constituents`，补权重字段 | 已完成 |
| **E4** | 指数估值轮动 / 行业相对估值 | 轮动线索 | 中 | 中证行业指数估值 + 蛋卷 | 已有 `get_index_valuation`，扩到行业指数 | P3 |
| **E5** | 市场参与度 / 拥挤度 | 情绪与拥挤风险 | 中 | 两融 + 成交额 + 换手 | 已有 `get_market_breadth` + `get_margin_data` | P3 |
| **E6** | 概念题材轮动 | 主题热度 | 中 | 东财概念板块 `clist` | 复用 `industry-api` 的 `clist` 范式（`fs=m:90+t:3`） | P3 |
| **E7** | 市场状态识别（regime） | 择时/配置前置 | 高 | 指数 + 宏观（LPR/PMI/社融） | 需新增宏观数据工具 | P3 |
| **E8** | ETF 评价（横向比较/跟踪误差/流动性） | 选基决策 | 中 | ETF 行情 + 净值序列 | 已有 `get_fund_quotes`/`get_fund_nav`/`get_index_etf_map` | P3 |
| **E9** | 资产配置（股债/核心-卫星 ETF） | 配置方案 | 中 | 指数估值 + 基金筛选 | 已有估值/筛选/映射，补配置模型 | P3 |
| **E10** | 龙虎榜 / 游资（借 UZI） | 短线资金 | 中 | 东财 `ZTPool`/龙虎榜接口 | 已有 `ZTPool` 范式 | P3 |

**落地进展**：E3（真实成分权重，中证 `closeweight.xls` + SheetJS）→ E1（ETF 折溢价率）→ E2（调样事件 skill）均**已完成**。**后续建议顺序**：E8/E9（选基与配置）→ E5/E6/E4 → E7/E10。

---

## 8. 风险与合规

- **接口稳定性**：东财/腾讯/新浪/股吧均为非官方接口，可能限流、改字段、需 Referer/UA；已有熔断可缓解，但需为每个新接口补类型守卫与缓存校验（参照 `domestic-index-api.ts` 的 `isIndex*` 守卫）。
- **数据版权**：中证/国证官网、理杏仁等估值/权重数据有使用条款，接入前需确认许可；优先官方或明确可用的接口。
- **GBK**：腾讯系与东财 `clist`/`rankhandler` 返回 GBK，需复用 `decodeGbk`。
- **准确性**：基金持仓有披露滞后（季报）；指数估值分位口径（等权/加权、起始年限）需在 skill 中显式声明。
- **已失效数据源**：北向净买入自 2024 年停止每日披露；`fundgz.1234567.com.cn` 实时估值接口已失效（改用 `fundmobapi`）；基金公司/经理明细接口 `FundMNManager*` 返回 404（改用 `FundSearchAPI`）。
- **免责声明**：所有产出需标注"非投资建议"。

---

## 9. 附录：借鉴映射表

| 来源文件/模块 | 借鉴内容 | 我们对应落点 | 状态 |
|---|---|---|---|
| UZI `fetch_capital_flow.py` | 北向资金 20 日净买入 | `get_margin_data`（两融替代） | 已替换 |
| UZI `fetch_fund_holders.py` / `fund_holdings_runner.py` | 基金持仓、经理、NAV、夏普 | `get_fund_holdings` + `fund-holdings-lookthrough` | 已完成 |
| UZI `skills/lhb-analyzer/` | 龙虎榜席位识别 | 扩展项 E10 | 待建 |
| UZI `screen.py`（板块宽度） | 市场广度 | `get_market_breadth` | 已完成 |
| UZI HTML 渲染器 | 报告样式 | `index-report` skill（复用 `write-memo`） | 可选 |
| finskills `sector-rotation-detector/` | 宏观驱动行业轮动方法论 | `sector-rotation` skill | 已完成（简版） |
| finskills `risk-adjusted-return-optimizer/` | 资产配置框架 | 扩展项 E9 | 待建 |
| finskills `high-dividend-strategy/` | 红利可持续性分析 | 并入 `index-valuation`（红利指数已入 catalog） | 部分 |
| finskills `findata-toolkit-cn/scripts/*` | AKShare 取数清单 | 工具数据源候选 | 参考 |
| quantskills `skill-etf-arbitrage-monitor` | ETF 折溢价/申赎可行性 | 折溢价率已实现（E1）；申赎可行性待建 | 部分 |
| quantskills `skill-etf-fund-evaluator` | ETF 同指数横向比较 | 扩展项 E8 + `etf-selection` | 待建 |
| quantskills `skill-index-rebalance-event-study` | 指数调样事件研究 | `index-rebalance-event-study` skill（E2） | 已完成 |
| quantskills `skill-index-valuation-rotation` | 指数估值分位 + 行业相对估值 | `index-valuation`（已覆盖分位）+ 扩展项 E4 | 部分 |
| quantskills `skill-a-share-market-participation` | 市场广度/参与度/拥挤度 | `get_market_breadth` + 扩展项 E5 | 部分 |
| quantskills `skill-capital-flow-crowding-monitor` | 融资融券/北向/大宗资金一致性 | `get_margin_data` + 扩展项 E5 | 部分 |
| quantskills `skill-northbound-margin-monitor` | 北向+两融+期货风险信号 | `get_margin_data`（北向不可用） | 部分 |
| quantskills `skill-b6-limitup-pool` | 涨停池/连板/情绪指标 | 扩展项 E10（`ZTPool` 已有底层） | 待建 |
| quantskills `skill-dividend-yield-scan` | 滚动股息率/连续分红/除权日历 | 并入 `index-valuation` / 红利线 | 部分 |
| quantskills `skill-concept-rotation-monitor` | 概念题材动量/宽度/轮动 | 扩展项 E6 | 待建 |
| quantskills `skill-market-regime-analysis` | 指数+宏观+波动率市场状态 | 扩展项 E7 | 待建 |
| `simonlin1212/a-stock-data` | 中证/国证成分、权重、估值 | 中证 `closeweight.xls` + SheetJS（E3） | 已完成 |

---

## 10. 一句话结论

原 P0-P2 已全部落地（指数估值/成分/广度/两融、行业板块、基金净值/持仓/排行/画像 + 5 个 skill），且扩展项 **E3（真实成分权重，中证 `closeweight.xls` + SheetJS）、E1（ETF 折溢价率）、E2（指数调样事件 skill）已完成并验证（`bun test` 414 pass / 7 skip / 0 fail）**；v1.1 共扩展 E1-E10 十个方向，后续建议顺序 E8/E9 → E5/E6/E4 → E7/E10；外部仓库（UZI/finskills/quantskills）均无指数/基金现成实现，继续坚持"取其数据源与方法论、工具与 skill 自建"的策略，并遵守各许可条款。
