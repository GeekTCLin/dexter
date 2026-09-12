# 接入国内指数数据 — 开发设计文档

- 文档版本：v1.0
- 状态：设计待评审
- 目标读者：Dexter 维护者 / 实现工程师
- 关联代码：`src/tools/finance/`、`src/tools/registry.ts`

---

## 1. 背景与目标

### 1.1 背景

Dexter 当前所有金融数据来自单一上游 `https://api.financialdatasets.ai`（见 `src/tools/finance/api.ts:4`），认证方式为单一的 `FINANCIAL_DATASETS_API_KEY`。该数据源覆盖美股、美 SEC 文件、加密货币，**不包含 A 股与国内指数**。现有 heartbeat 巡检清单也只跟踪 S&P 500 / NASDAQ / Dow（`src/gateway/heartbeat/prompt.ts:7`）。

### 1.2 目标

新增国内指数（A 股主要宽基指数）的**实时快照**与**历史日/周/月 K 线**能力，使 Dexter 能回答诸如：

- “上证指数现在多少点？涨跌幅多少？”
- “沪深300 最近一个月走势 / 今年以来表现”
- “今天 A 股主要指数表现如何？”（多指数批量对比）

首批覆盖指数：上证综指、深证成指、创业板指、沪深300、中证500、科创50、中证1000，并预留扩展位。

### 1.3 非目标（本期不做）

- A 股个股行情、财务基本面、财报/公告、龙虎榜、资金流向
- 指数成分股、估值分位、ETF 映射
- 港股/美股外围指数（本期只做境内指数）

---

## 2. 现状分析（改动基线）

现有数据链路完全围绕 financialdatasets 设计，接入国内数据需要新增一条**并行的 provider 链路**，而不是复用现有 `api` 客户端。

| 组件 | 文件 | 关键事实 |
|---|---|---|
| HTTP 客户端 | `src/tools/finance/api.ts` | `BASE_URL` 硬编码（`:4`）；`getApiKey()` 读 `FINANCIAL_DATASETS_API_KEY`（`:43`）；统一注入 `x-api-key`（`:91`）；按 `next_page_url` 翻页（`:150-156`）；`cacheable/ttlMs` 走本地缓存 |
| 子工具范式 | `src/tools/finance/crypto.ts:14-23`、`stock-price.ts:16-27` | `DynamicStructuredTool` + zod schema → `api.get(path, params)` → `formatToolResult(data.<field> || [], [url])` |
| 结果信封 | `src/tools/types.ts:1-12` | `ToolResult { data; sourceUrls? }`，`formatToolResult(data, urls)` 返回 JSON 字符串 |
| 路由 meta-tool | `src/tools/finance/get-market-data.ts` | `buildMarketDataTools(model)`（`:68-86`）组装子工具；LLM 原生 tool-calling 选择子工具（`:165`）；结果按 `${tool}_${ticker}` 合并（`:220-228`）；`_errors` 汇总（`:231-237`） |
| 格式化注册表 | `src/tools/finance/formatters.ts:427-438` | `MARKET_DATA_FORMATTERS`，键**必须等于**子工具 `name` |
| 顶层注册 | `src/tools/registry.ts:48-162` | `getToolRegistry(model)` 返回 `RegisteredTool[]`（`name/tool/description/compactDescription/concurrencySafe`） |
| 共享助手 | `src/tools/finance/utils.ts:8,20-31` | `SUB_TOOL_TIMEOUT_MS=60_000`、`TTL_15M/1H/6H/24H`、`withTimeout(promise, ms, label)` |
| 描述约定 | 顶层 meta-tool | 导出 `SCREAMING_SNAKE_DESCRIPTION` 常量；仅四个顶层 meta-tool 导入到 `registry.ts` |

> 关键判断：现有 `api.ts` 的 base URL、鉴权 header（`x-api-key`）、翻页协议（`next_page_url`）都强绑定 financialdatasets，**不可复用**。国内指数需要独立的 fetch 客户端。

---

## 3. 数据源选型

### 3.1 候选对比

| 数据源 | 实时 | 历史 | 鉴权 | 编码 | Node 直连 | 结论 |
|---|---|---|---|---|---|---|
| **东方财富 push2 / push2his** | ✅ | ✅日/周/月/分钟 | 无需 key | UTF-8 JSON | ✅ | **主选** |
| 腾讯 `qt.gtimg.cn` / `web.ifzq.gtimg.cn` | ✅ | ✅ | 无需 key | GBK（有 UTF-8 镜像） | ✅ | **回退** |
| 新浪 `hq.sinajs.cn` | ✅ | ❌ | 需 `Referer`，否则 403 | GBK | ✅ | 末位回退 |
| AKShare | ✅ | ✅ | Python 库 | — | ❌（本质调用上面同款接口） | 不采用 |
| Tushare Pro | ✅ | ✅ | Token + 积分门槛（`index_daily` 需 2000 积分） | — | 可行但受限 | 不采用 |
| Baostock | ✅ | ✅ | Python SDK（TCP 私有协议） | — | ❌ | 不采用 |

**结论：主选东方财富（Eastmoney），腾讯作为回退，新浪作为末位回退。** 东方财富为 UTF-8 JSON、无需 key、`fltt=2` 时数值已是十进制、字段覆盖实时+历史，解析成本最低。

### 3.2 东方财富接口规格（主选）

**实时快照（单指数）**

```
GET https://push2.eastmoney.com/api/qt/stock/get
  ?secid=1.000001
  &fltt=2&invt=2
  &fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f116,f117,f169,f170,f171
```

| 参数 | 说明 |
|---|---|
| `secid` | `{market}.{code}`，见 §3.4 |
| `fltt=2` | **必须**，否则价格被放大 100 倍（`f43:388811` vs `3888.11`） |
| `invt=2` | 常与 `fltt=2` 搭配 |
| `fields` | 逗号分隔字段码 |
| `ut` | 页面公开 token，非鉴权，可省略 |

响应（节选）：

```json
{"rc":0,"data":{
  "f43":3888.11,"f44":3912.32,"f45":3852.03,"f46":3910.92,
  "f47":579123145,"f48":958186336970.1,
  "f57":"000001","f58":"上证指数","f60":3934.4,
  "f86":1789114292,"f169":-46.29,"f170":-1.18,"f171":1.53
}}
```

字段码映射：

| 字段 | 含义 | 单位 |
|---|---|---|
| `f43` | 最新价 | 点 |
| `f44` / `f45` / `f46` | 最高 / 最低 / 开盘 | 点 |
| `f47` | 成交量 | 手 |
| `f48` | 成交额 | 元 |
| `f57` / `f58` | 代码 / 名称 | — |
| `f60` | 昨收 | 点 |
| `f86` | 行情时间戳 | Unix 秒 |
| `f169` / `f170` | 涨跌额 / **涨跌幅** | 点 / %（已还原） |
| `f171` | 振幅 | % |

**实时快照（批量，推荐用于“主要指数概览”）**

```
GET https://push2.eastmoney.com/api/qt/ulist.np/get
  ?fltt=2&invt=2
  &fields=f12,f13,f14,f2,f3,f4
  &secids=1.000001,0.399001,1.000300,1.000905,1.000688,1.000852,0.399006
```

响应 `data.diff[]` 中：`f2`=最新价，`f3`=涨跌幅%，`f4`=涨跌额，`f12`=代码，`f13`=市场，`f14`=名称。
> 注意：批量接口字段码与单接口**不同**（`f2/f3/f4/f12/f13/f14`），实现时需分别映射。

**历史 K 线**

```
GET https://push2his.eastmoney.com/api/qt/stock/kline/get
  ?secid=1.000001
  &fields1=f1,f2,f3,f4,f5,f6
  &fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61
  &klt=101&fqt=0
  &beg=20240101&end=20240110
```

| 参数 | 值 |
|---|---|
| `klt` | `101`=日，`102`=周，`103`=月 |
| `fqt` | `0`=不复权（**指数固定用 0**），`1`=前复权，`2`=后复权 |
| `beg`/`end` | `YYYYMMDD` |
| `lmt` | 行数上限，浏览器用 `1000000` |

响应 `data.klines` 为字符串数组，每行 11 个逗号分隔字段：

```
"2024-01-02,2972.78,2962.28,2976.27,2962.28,304141793,345950729194.60,0.47,-0.43,-12.65,0.63"
 日期       开       收       高       低       量(手)     额(元)          振幅%  涨跌%  涨跌额  换手%
```

> `smplmt` 单次响应上限约 460 行，**完整历史需分页**（按 `beg/end` 分段拉取或使用 `lmt` 翻页）。`data.dktotal` 是服务端总根数，非本次返回数。

### 3.3 回退源规格（腾讯）

- 实时：`GET https://qt.gtimg.cn/q=sh000001,sz399001`，`~` 分隔字段，GBK；UTF-8 镜像 `https://sqt.gtimg.cn/utf8/q=...`。关键位：`1`=名称，`3`=最新价，`4`=昨收，`5`=开盘，`31`=涨跌额，`32`=涨跌幅%，`33/34`=高/低。
- 历史：`GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,2024-01-02,2024-01-10,10,qfq`，返回 `data.<code>.day` 数组，行格式 `[date, open, close, high, low, volume]`（**注意顺序为开、收、高、低**，与东方财富不同）。

### 3.4 指数代码 → secid 映射

| 指数 | 通用代码 | Eastmoney `secid` | 腾讯代码 |
|---|---|---|---|
| 上证综指 | 000001.SH | `1.000001` | `sh000001` |
| 深证成指 | 399001.SZ | `0.399001` | `sz399001` |
| 创业板指 | 399006.SZ | `0.399006` | `sz399006` |
| 沪深300 | 000300.SH | `1.000300` | `sh000300` |
| 中证500 | 000905.SH | `1.000905` | `sh000905` |
| 科创50 | 000688.SH | `1.000688` | `sh000688` |
| 中证1000 | 000852.SH | `1.000852` | `sh000852` |
| 上证50 | 000016.SH | `1.000016` | `sh000016` |
| 上证180 | 000010.SH | `1.000010` | `sh000010` |

市场前缀规则（Eastmoney）：

- `1` = 上交所（SSE）及托管于此的 CSI 指数：`000xxx`（如 000001/000300/000905）、`6xxxxx`/`688xxx` 股票
- `0` = 深交所（SZSE）：`399xxx` 指数、`000/002/300xxx` 股票
- `2` / `93` = 部分中证系列指数（如 000859 用 `2`）

> **歧义警告**：`000001` 在 `1.` 下是上证综指，在 `0.` 下是平安银行。市场前缀必需。规则：`399` 开头用 `0`；CSI/SSE 发布的 `000300/000905/000688/000852` 用 `1`；不确定时按 `1 → 0 → 2` 探测并校验 `data != null`。

### 3.5 合规与稳定性

- 上述接口均为**未公开、非官方、无数据许可**的网页接口，数据所有权归交易所（SSE/SZSE/CSI）。**商业使用或再分发需获得授权**。
- 无固定公开 QPS 限制；风控表现为**连接被直接断开**（`Empty reply` / `EOF`）。应实现客户端熔断：批量失败后暂停约 30–60s 再恢复。
- 建议发送真实 `User-Agent` 与 `Referer: https://quote.eastmoney.com/`，并在结果中标注数据来源。

---

## 4. 架构设计

### 4.1 总体思路

新增一条**独立的国内指数 provider 链路**，与现有 financialdatasets 链路并存，互不影响；通过扩展现有 `get_market_data` meta-tool 暴露给主 Agent，保持顶层工具数量不变（token 效率最优）。

```
Agent
  └─ get_market_data (meta-tool, LLM 路由)
        ├─ ... 现有子工具 (US)
        └─ get_index_snapshot / get_index_prices   ← 新增
              └─ domesticIndexApi (新客户端)
                    ├─ EastmoneyProvider (主)
                    └─ TencentProvider  (回退)
```

**为什么挂到 `get_market_data` 而不是新增顶层工具？**

- 顶层工具增加会扩大系统提示与工具 schema 的 token 占用；指数行情与股价行情语义同族，路由 prompt 里加两条即可。
- 若后续指数能力扩张到独立领域（成分股、估值），再抽出独立顶层 meta-tool `get_index_data`（届时按 §7 的“可选”路径）。

### 4.2 新增文件

```
src/tools/finance/
  domestic-index.ts          # 子工具定义 (DynamicStructuredTool) + 描述
  domestic-index-api.ts      # provider 客户端：Eastmoney + Tencent + 熔断/缓存
  domestic-index.test.ts     # 单元测试
```

### 4.3 数据模型（TypeScript）

```ts
// domestic-index-api.ts
export type IndexInterval = 'day' | 'week' | 'month';

export interface IndexDefinition {
  symbol: string;      // 通用代码，如 '000001.SH'
  name: string;        // 中文名，如 '上证综指'
  emSecid: string;     // Eastmoney secid，如 '1.000001'
  txCode: string;      // Tencent 代码，如 'sh000001'
}

export interface IndexSnapshot {
  symbol: string;      // '000001.SH'
  name: string;        // '上证综指'
  price: number;       // 最新
  change: number;      // 涨跌额
  changePercent: number; // 涨跌幅 %
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;      // 手
  amount: number;      // 元
  amplitude?: number;  // 振幅 %
  timestamp: number;   // Unix 秒
  source: 'eastmoney' | 'tencent';
}

export interface IndexBar {
  date: string;        // YYYY-MM-DD
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;      // 手
  amount: number;      // 元
  changePercent: number;
}
```

### 4.4 provider 客户端设计

```ts
// domestic-index-api.ts
export const INDEX_CATALOG: IndexDefinition[] = [ /* §3.4 表 */ ];

export function resolveIndex(query: string): IndexDefinition | undefined;
// 支持：'000001.SH' | 'sh000001' | '上证综指' | '沪深300' 等别名归一

export async function getIndexSnapshot(symbol: string): Promise<IndexSnapshot>;
// 主：Eastmoney stock/get；失败 → 腾讯 qt.gtimg.cn

export async function getIndexSnapshots(symbols: string[]): Promise<IndexSnapshot[]>;
// 主：Eastmoney ulist.np 批量；失败 → 腾讯多代码 q=

export async function getIndexBars(
  symbol: string,
  interval: IndexInterval,
  startDate: string,
  endDate: string,
): Promise<IndexBar[]>;
// 主：Eastmoney kline；失败 → 腾讯 ifzq fqkline();
// 分页：按 smplmt≈460 分段，或按日期窗口切分
```

要点：

- **不复用 `api.ts`**：独立 fetch、独立 base URL、无 `x-api-key`、独立翻页/分段逻辑。
- **编码**：东方财富为 UTF-8，直接用 `response.json()`。腾讯为 GBK，回退时 `new TextDecoder('gbk').decode(await response.arrayBuffer())`。
- **超时**：复用 `withTimeout`，为指数请求单独设定（建议 15s，见 §4.6）。
- **缓存**：复用 `src/utils/cache.ts` 的读写（`readCache`/`writeCache`/`describeRequest`），或直接给新客户端接入同一缓存 API。TTL 见 §4.5。
- **熔断**：模块级状态，连续 N 次网络级失败后进入冷却窗口（30–60s），期间直接走回退源或抛错。

### 4.5 缓存策略

指数为**盘中实时变动、收盘后当日数据终态**：

| 数据 | TTL | 说明 |
|---|---|---|
| 实时快照 | 30s（盘中）/ 至收盘（收盘后） | 简化实现可统一 30–60s |
| 当日 K 线 | 15min | `TTL_15M` |
| 历史 K 线（结束日 < 今日） | 24h | `TTL_24H`，已终态 |
| 指数目录/别名 | 进程内常量 | 无需网络 |

判断“已收盘/历史”逻辑参考 `stock-price.ts:62-66` 的 `endDate < today` 写法。

### 4.6 错误处理与降级

1. 主源抛错（网络断开/解析失败/非 200）→ 记录 `logger.warn`，切换回退源。
2. 回退源也失败 → 抛错，由 `get-market-data.ts` 的 `_errors` 机制汇总返回给 LLM（`:231-237`），不使整个 meta-tool 失败。
3. 每个子工具调用由 meta-tool 统一包 `withTimeout`（`get-market-data.ts:188`），沿用 `SUB_TOOL_TIMEOUT_MS`；若国内源更慢，可在子工具内部再包一层 15s 超时后自行回退。
4. 指数代码无法解析 → 返回明确错误（`Unknown index: <query>`），提示可用指数列表。

---

## 5. 工具定义

### 5.1 子工具 1：实时快照

```ts
const IndexSnapshotInputSchema = z.object({
  symbol: z.string().describe(
    "指数代码或名称，如 '000001.SH'、'sh000001'、'上证综指'、'沪深300'。"
  ),
});
// name: 'get_index_snapshot'
```

### 5.2 子工具 2：多指数快照（可选但推荐）

```ts
const IndexSnapshotsInputSchema = z.object({
  symbols: z.array(z.string()).min(1).describe(
    "指数代码/名称列表，如 ['上证综指','深证成指','沪深300']，用于主要指数概览。"
  ),
});
// name: 'get_index_snapshots'
```

### 5.3 子工具 3：历史 K 线

```ts
const IndexPricesInputSchema = z.object({
  symbol: z.string().describe("指数代码或名称，如 '000001.SH'。"),
  interval: z.enum(['day', 'week', 'month']).default('day'),
  start_date: z.string().describe('YYYY-MM-DD'),
  end_date: z.string().describe('YYYY-MM-DD'),
});
// name: 'get_index_prices'
```

### 5.4 结果与格式化

子工具统一 `formatToolResult(payload, [sourceUrl])`。为保持 meta-tool 输出紧凑，在 `formatters.ts` 新增：

```ts
MARKET_DATA_FORMATTERS['get_index_snapshot']  = formatIndexSnapshot;
MARKET_DATA_FORMATTERS['get_index_snapshots'] = formatIndexSnapshots; // 表格
MARKET_DATA_FORMATTERS['get_index_prices']    = formatIndexBars;      // 表格
```

> 键名**必须**与子工具 `name` 完全一致，否则 `get-market-data.ts:224` 取不到 formatter，会回退为原始 JSON。

### 5.5 接入 `get_market_data`

在 `src/tools/finance/get-market-data.ts` 中：

1. 顶部导入：`import { getIndexSnapshot, getIndexSnapshots, getIndexPrices } from './domestic-index.js';`（`:58-64` 区域附近）。
2. 加入 `buildMarketDataTools()`（`:68-86`）。
3. `buildRouterPrompt()` 的 Tool Selection 增加路由规则（`:108-125`），例如：
   - 单个国内指数当前点位 → `get_index_snapshot`
   - “今天 A 股主要指数表现 / 大盘概览” → `get_index_snapshots`
   - 国内指数历史走势/区间涨跌 → `get_index_prices`
   - 并注明：**A 股指数走国内源，不要用 `get_stock_price`**（后者只认美股）。
4. `GET_MARKET_DATA_DESCRIPTION`（`:15-50`）与内联 `description`（`:149-158`）补充“A-share / China domestic indices”。

### 5.6 导出（可选）

`src/tools/finance/index.ts` 增加：
```ts
export { getIndexSnapshot, getIndexSnapshots, getIndexPrices } from './domestic-index.js';
```
仅当其他模块需要引用时添加；`get-market-data.ts` 为规避循环依赖直接从源文件导入。

---

## 6. 配置

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| （无） | — | — | 东方财富/腾讯主链路**无需 API key** |
| `DOMESTIC_INDEX_PROVIDER` | 否 | `eastmoney` | 强制主源：`eastmoney` \| `tencent` |
| `DOMESTIC_INDEX_TIMEOUT_MS` | 否 | `15000` | 单次请求超时 |
| `DOMESTIC_INDEX_UA` | 否 | 内置 Chrome UA | 覆盖 User-Agent |

- 更新 `env.example`，注明国内指数无需 key、以及可选变量。
- 若未来接入 Tushare Pro 等需鉴权源，再引入 `TUSHARE_TOKEN`，并纳入 `src/utils/env.ts` 的 key 校验/交互式录入流程。

---

## 7. 改动清单

| # | 文件 | 类型 | 说明 |
|---|---|---|---|
| 1 | `src/tools/finance/domestic-index-api.ts` | 新增 | provider 客户端：目录、解析、双源、分页、缓存、熔断 |
| 2 | `src/tools/finance/domestic-index.ts` | 新增 | 三个 `DynamicStructuredTool` + 描述 |
| 3 | `src/tools/finance/domestic-index.test.ts` | 新增 | 单元测试（见 §8） |
| 4 | `src/tools/finance/formatters.ts` | 修改 | 新增 3 个 formatter 并注册到 `MARKET_DATA_FORMATTERS` |
| 5 | `src/tools/finance/get-market-data.ts` | 修改 | 导入/组装/路由 prompt/描述 |
| 6 | `src/tools/finance/index.ts` | 修改（可选） | 导出新子工具 |
| 7 | `env.example` | 修改 | 记录可选配置变量 |
| 8 | `src/gateway/heartbeat/prompt.ts` | 修改（可选） | 巡检清单加入 A 股主要指数 |

**无需改动**：`api.ts`、`types.ts`、`utils.ts`、`registry.ts`（扩展 meta-tool 不改变顶层注册）。

**可选路径（若做独立顶层工具）**：在 `registry.ts:48-162` 按 `get_market_data` 模式增加 `RegisteredTool`，并从 `finance/index.ts` 导出 `createGetIndexData` 与 `GET_INDEX_DATA_DESCRIPTION`。

---

## 8. 测试计划

- 框架：Bun 内置测试，文件置于 `src/tools/finance/domestic-index.test.ts`（参考 `api.test.ts`）。
- 单元测试（mock `fetch`，不依赖网络）：
  1. `resolveIndex`：代码 / 前缀代码 / 中文名 / 别名 → 正确 `IndexDefinition`；未知输入返回 `undefined`。
  2. Eastmoney 快照解析：`fltt=2` 响应 → `IndexSnapshot` 字段映射正确（含 `f170` 百分比）。
  3. Eastmoney 批量解析：`data.diff[]` 的 `f2/f3/f4/f12/f13/f14` 映射。
  4. Klines 解析：11 字段行 → `IndexBar[]`；空数组、字段缺失的健壮性。
  5. Tencent UTF-8 回退解析：`~` 分隔字段位映射。
  6. 降级链：主源 500 / 连接断开 → 自动调用回退源。
  7. 熔断：连续失败后进入冷却，冷却期内不发主源请求。
  8. formatter：键名与子工具 `name` 一致；输出为紧凑字符串且含表头。
- 集成手测（需联网，人工执行）：
  - `get_index_snapshot('上证综指')` 返回合理点位与涨跌幅
  - `get_index_snapshots(['上证综指','深证成指','沪深300'])` 返回 3 行
  - `get_index_prices('000300.SH','day','2024-01-01','2024-01-31')` 返回约 22 根日线
- 验证命令：`bun run typecheck` 与 `bun test`。

---

## 9. 实施步骤（里程碑）

1. **M1 客户端**：`domestic-index-api.ts`（目录+解析+Eastmoney 主源），`bun test` 覆盖解析与 `resolveIndex`。
2. **M2 子工具**：`domestic-index.ts` 三工具 + `formatters.ts` 注册。
3. **M3 接入**：`get-market-data.ts` 组装/路由/prompt；手测三类查询。
4. **M4 健壮性**：腾讯回退源、缓存 TTL、熔断、超时；补齐测试。
5. **M5 收尾**：`env.example`、可选 heartbeat 清单、文档更新；`bun run typecheck` + `bun test` 绿。

---

## 10. 风险与注意事项

| 风险 | 影响 | 缓解 |
|---|---|---|
| 接口非官方、无契约 | 随时可能变更/失效 | 双源+回退；解析层容错；集中常量便于改动 |
| 风控断连（非固定 QPS） | 批量请求失败 | 优先批量接口；节流；熔断冷却 30–60s |
| 字段码语义混淆 | 价格放大 100 倍 | 强制 `fltt=2`；单测固定断言数值 |
| 批量与单接口字段码不同 | 映射错误 | 分别实现两套映射，单测覆盖 |
| GBK 编码（腾讯/新浪） | 中文乱码 | `TextDecoder('gbk')`；主源用 UTF-8 规避 |
| 时区/交易日历 | 日期边界、停牌日缺失 | 统一 `Asia/Shanghai`；K 线缺失按“无该交易日”处理，不补零 |
| 合规/再分发 | 法律风险 | 标注来源；商用前获取授权；不缓存再分发原始全量数据 |
| 与美股工具语义冲突 | LLM 误用 `get_stock_price` 查 A 股 | 路由 prompt 明确“A 股指数走国内源” |

---

## 附录 A：示例请求（可直接 curl 验证）

```text
# 实时：上证综指
https://push2.eastmoney.com/api/qt/stock/get?secid=1.000001&fltt=2&invt=2&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f169,f170,f171

# 批量：主要指数概览
https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f13,f14,f2,f3,f4&secids=1.000001,0.399001,1.000300,1.000905,1.000688,1.000852,0.399006

# 历史：上证综指 2024-01-01~2024-01-10 日线
https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&beg=20240101&end=20240110

# 回退：腾讯实时
https://qt.gtimg.cn/q=sh000001,sz399001,sh000300

# 回退：腾讯历史（注意行序 date,open,close,high,low,volume）
https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,2024-01-02,2024-01-10,10,qfq
```

## 附录 B：术语

- **secid**：东方财富的证券内部标识 `{market}.{code}`，市场前缀必填。
- **手**：A 股成交量单位，1 手 = 100 股；指数成交量同样以“手”计。
- **fltt**：float/format 参数，`2` 时价格按真实小数返回。
- **klt**：K 线周期类型（101 日 / 102 周 / 103 月）。
