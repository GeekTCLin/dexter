import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { formatEtfEvaluation } from './formatters.js';
import { getEtfEvaluation as fetchEtfEvaluation } from './etf-eval-api.js';

export const ETF_EVALUATION_DESCRIPTION = `
Compares the exchange-traded ETFs that track a China index on the metrics that drive fund selection: fund size (规模), secondary-market liquidity (日均成交额/换手), annualized tracking error, cumulative tracking difference and return correlation versus the index, live premium/discount (折溢价率), and management/custody fees. Use for 选哪只ETF, ETF横向比较, 跟踪误差, 哪只ETF流动性最好, 沪深300 ETF 哪个好. Accepts an index name/code (e.g. 沪深300), or explicit ETF codes. Powered by Eastmoney, no API key required.
`.trim();

const EtfEvaluationInputSchema = z.object({
  index: z
    .string()
    .optional()
    .describe("指数名称或代码，如 '沪深300'、'000300'、'中证500'。与 codes 二选一。"),
  codes: z
    .array(z.string())
    .optional()
    .describe("ETF 代码列表，如 ['510300','159919']。与 index 二选一。"),
  window_days: z
    .number()
    .int()
    .positive()
    .max(250)
    .optional()
    .describe('评价窗口（自然日），默认 90，最小 20，最大 250。'),
  limit: z
    .number()
    .int()
    .positive()
    .max(30)
    .optional()
    .describe('最多评价的 ETF 数量，默认 10，最大 30。'),
  include_fees: z
    .boolean()
    .optional()
    .describe('是否抓取管理费率/托管费率/跟踪标的（较慢，默认 true）。'),
});

export const getEtfEvaluation = new DynamicStructuredTool({
  name: 'get_etf_evaluation',
  description:
    'Compares the ETFs tracking a China index (or given ETF codes) on scale, liquidity, tracking error/difference, correlation, premium/discount and fees. Key-less (Eastmoney).',
  schema: EtfEvaluationInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchEtfEvaluation({
      index: input.index,
      codes: input.codes,
      windowDays: input.window_days,
      limit: input.limit,
      includeFees: input.include_fees,
    });
    return formatToolResult(formatEtfEvaluation(value), [sourceUrl]);
  },
});
