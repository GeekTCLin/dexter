import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
  getIndexSnapshot as fetchIndexSnapshot,
  getIndexSnapshots as fetchIndexSnapshots,
  getIndexBars,
} from './domestic-index-api.js';
import { getIndexValuation as fetchIndexValuation } from './domestic-index-valuation-api.js';

export const INDEX_SNAPSHOT_DESCRIPTION = `
Fetches a real-time snapshot for a China A-share domestic index (点位、涨跌幅、开高低、成交量/额). Accepts a symbol ('000001.SH'), Eastmoney secid ('1.000001'), Tencent code ('sh000001'), bare code ('000001') or Chinese name/alias ('上证综指', '上证指数', '沪深300'). Powered by Eastmoney with a Tencent fallback.
`.trim();

const IndexSnapshotInputSchema = z.object({
  symbol: z
    .string()
    .describe("指数代码或名称，如 '000001.SH'、'sh000001'、'上证综指'、'沪深300'。"),
});

export const getIndexSnapshot = new DynamicStructuredTool({
  name: 'get_index_snapshot',
  description:
    "Fetches the current quote snapshot for a single China A-share domestic index: latest level, change, change percent, open/high/low, previous close, volume and turnover. Not for US equities.",
  schema: IndexSnapshotInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchIndexSnapshot(input.symbol);
    return formatToolResult(value, [sourceUrl]);
  },
});

const IndexSnapshotsInputSchema = z.object({
  symbols: z
    .array(z.string())
    .min(1)
    .describe("指数代码/名称列表，如 ['上证综指','深证成指','沪深300']，用于主要指数概览。"),
});

export const getIndexSnapshots = new DynamicStructuredTool({
  name: 'get_index_snapshots',
  description:
    'Fetches real-time snapshots for multiple China A-share domestic indices at once (主要指数概览), returning latest level and change percent for each.',
  schema: IndexSnapshotsInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchIndexSnapshots(input.symbols);
    return formatToolResult(value, [sourceUrl]);
  },
});

const IndexPricesInputSchema = z.object({
  symbol: z.string().describe("指数代码或名称，如 '000001.SH'、'上证综指'。"),
  interval: z
    .enum(['day', 'week', 'month'])
    .default('day')
    .describe("K 线周期，'day' 日线 / 'week' 周线 / 'month' 月线，默认 'day'。"),
  start_date: z.string().describe('Start date in YYYY-MM-DD format. Required.'),
  end_date: z.string().describe('End date in YYYY-MM-DD format. Required.'),
});

export const getIndexPrices = new DynamicStructuredTool({
  name: 'get_index_prices',
  description:
    'Retrieves historical K-line (OHLCV) data for a China A-share domestic index over a date range, for daily, weekly or monthly intervals.',
  schema: IndexPricesInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await getIndexBars(
      input.symbol,
      input.interval,
      input.start_date,
      input.end_date,
    );
    return formatToolResult(value, [sourceUrl]);
  },
});

const IndexValuationInputSchema = z.object({
  symbol: z
    .string()
    .describe("指数代码或名称，如 '000300.SH'、'沪深300'、'中证红利'。"),
});

export const INDEX_VALUATION_DESCRIPTION = `
Fetches the current valuation of a China A-share domestic index: PE (TTM), PB, dividend yield, ROE, PEG, the 10-year government bond yield, and the historical percentile of PE and PB. Use for 指数估值/高估低估 queries (e.g. 沪深300估值, 中证500 PE分位). Coverage is best-effort: broad and red-dividend indices such as 沪深300、中证500、中证1000、创业板指、科创50、上证50、中证红利、深证100 are covered; some indices (e.g. 上证综指) and the Beijing exchange are not, in which case the result is null.
`.trim();

export const getIndexValuation = new DynamicStructuredTool({
  name: 'get_index_valuation',
  description:
    'Fetches PE/PB/dividend-yield valuation and historical PE/PB percentiles for a China A-share domestic index. Returns null valuation when the index is not covered. Not for US equities.',
  schema: IndexValuationInputSchema,
  func: async (input) => {
    const result = await fetchIndexValuation(input.symbol);
    if (!result) {
      return formatToolResult(
        {
          symbol: input.symbol,
          valuation: null,
          note: '该指数暂未提供估值数据（可能不在覆盖范围内，或数据源暂不可用）。',
        },
        [],
      );
    }
    return formatToolResult(result.value, [result.sourceUrl]);
  },
});
