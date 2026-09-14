---
name: index-valuation
description: Evaluates the valuation level of China A-share indices (指数估值) using PE/PB, dividend yield and historical percentiles. Triggers when user asks whether an index is expensive or cheap, asks for 估值/PE分位/PB分位/股债性价比/定投时机 for 沪深300, 中证500, 中证1000, 创业板指, 科创50, 上证50, 中证红利 and similar indices, or wants an index valuation review.
---

# Index Valuation Skill (指数估值)

## Workflow Checklist

Copy and track progress:
```
Index Valuation Progress:
- [ ] Step 1: Resolve the target index
- [ ] Step 2: Fetch valuation metrics (PE / PB / dividend yield + percentiles)
- [ ] Step 3: Fetch recent price context
- [ ] Step 4: Interpret the percentile level
- [ ] Step 5: Cross-check PE and PB signals
- [ ] Step 6: Present results with caveats and disclaimer
```

## Step 1: Resolve the Target Index

Identify the index from the user request (e.g. 沪深300, 中证500, 中证1000, 创业板指, 科创50, 上证50, 中证红利). Pass its name or code straight to the tool — the tool resolves names, aliases, symbols (`000300.SH`), bare codes (`000300`) and Eastmoney secids (`1.000300`).

If the index is genuinely ambiguous (e.g. user says only "大盘"), ask which index they mean before proceeding.

## Step 2: Fetch Valuation Metrics

Call the `get_market_data` tool with a query such as:

**Query:** `"沪深300 指数估值 PE PB 股息率 历史分位"`

This routes to `get_index_valuation`, which returns:
- `pe`, `pb` — current PE(TTM) and PB
- `dividendYield` — dividend yield (fraction)
- `pePercentile`, `pbPercentile` — historical percentile in `[0, 1]`
- `roe`, `peg`, `bondYield` (10-year China government bond yield)
- `evaluation` — provider's qualitative label (e.g. 低估/适中/高估)
- `valuationDate`, `historyYears`

**If the result is `null`**: the index is not covered by the valuation source. Do not invent numbers — report that valuation data is unavailable for that index and offer price-only context instead. Note that broad SH indices such as 上证综指 (000001) and several newer indices are commonly uncovered.

## Step 3: Fetch Recent Price Context

Call the `get_market_data` tool for price history:

**Query:** `"沪深300 指数最近 1 年走势"`

Or request a snapshot for the latest level. Use this to describe where the index sits relative to its own recent range (e.g. drawdown from a 52-week high) and to confirm the valuation date is current.

## Step 4: Interpret the Percentile Level

Percentiles are fractions of history (0 = cheapest ever, 1 = most expensive ever). Use these bands as a starting point, not a rule:

- **0.00–0.20** — historically cheap (低估区间)
- **0.20–0.40** — below average (偏低)
- **0.40–0.60** — roughly average (适中)
- **0.60–0.80** — above average (偏高)
- **0.80–1.00** — historically expensive (高估区间)

Always state the lookback horizon (`historyYears`) when quoting a percentile — a 0.30 percentile over 5 years is not the same as over 15 years.

## Step 5: Cross-check PE and PB Signals

- If PE and PB percentiles agree, the signal is stronger; say so explicitly.
- If they diverge materially, explain why: PE is earnings-sensitive (cyclical profit swings move it fast), while PB is asset/ROE-sensitive. Dividend yield and ROE help disambiguate.
- Compare the index dividend yield against `bondYield` as a rough 股债性价比 (equity-vs-bond) sanity check; a large positive spread is usually supportive, but do not treat a single reading as a timing signal.

## Step 6: Output Format

Present a concise structured summary:

1. **估值总览** — index name/code, valuation date, PE(TTM), PB, dividend yield
2. **历史分位** — PE percentile and PB percentile with the lookback horizon
3. **定性判断** — cheap / fair / expensive based on Step 4, with the PE-vs-PB cross-check
4. **价格背景** — current level and recent drawdown/range
5. **数据来源与口径** — data source(s) and any missing fields
6. **风险与免责声明**

## Caveats

- Valuation percentiles are backward-looking and can stay extreme for long stretches; cheap can get cheaper.
- Index-level PE/PB can be distorted by loss-making constituents, weighting changes and index methodology revisions.
- Different data providers use different earnings windows (TTM vs MRQ) and history windows, so cross-provider comparisons may not be apples-to-apples.
- This is research support, **not investment advice** (非投资建议). Do not present a valuation reading as a buy/sell recommendation.
