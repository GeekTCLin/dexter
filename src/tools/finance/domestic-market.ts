import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { formatMarketBreadth, formatMarginData } from './formatters.js';
import { getMarketBreadth as fetchMarketBreadth, getMarginData as fetchMarginData } from './domestic-market-api.js';

export const MARKET_BREADTH_DESCRIPTION = `
Fetches whole-market breadth for China A-shares: advancing / declining / flat stock counts (Shanghai + Shenzhen), limit-up (涨停) and limit-down (跌停) counts, and two-market turnover (成交额). Use for 市场情绪, 涨跌家数, 赚钱效应, 涨跌停家数, 两市成交额. Optionally accepts a trading date (YYYYMMDD); defaults to today (Asia/Shanghai). Powered by Eastmoney, no API key required.
`.trim();

export const MARGIN_DATA_DESCRIPTION = `
Fetches China A-share margin-financing (两融) data: total margin balance (融资融券余额), financing balance (融资余额), daily financing buy/repay/net (融资买入/偿还/净买入), securities-lending balance (融券余额), and financing balance as a share of free-float market cap. Use for 杠杆资金, 融资融券, 融资净买入, 市场杠杆水平. Eastmoney publishes this with a T-1/T-2 lag. No API key required.
`.trim();

const MarketBreadthInputSchema = z.object({
  date: z
    .string()
    .optional()
    .describe('交易日，格式 YYYYMMDD，可选；默认取当天（东八区）。'),
});

export const getMarketBreadth = new DynamicStructuredTool({
  name: 'get_market_breadth',
  description:
    'Whole-market breadth for China A-shares: 涨跌家数, 涨停/跌停家数, 两市成交额. Not for US markets.',
  schema: MarketBreadthInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchMarketBreadth(input.date);
    return formatToolResult(formatMarketBreadth(value), [sourceUrl]);
  },
});

const MarginDataInputSchema = z.object({
  days: z
    .number()
    .int()
    .positive()
    .max(60)
    .optional()
    .describe('返回最近多少个交易日的两融数据，默认 10，最大 60。'),
});

export const getMarginData = new DynamicStructuredTool({
  name: 'get_margin_data',
  description:
    'China A-share margin-financing (两融) daily history: 融资余额, 融资净买入, 融券余额, 两融余额. Use for 杠杆资金 and 融资融券.',
  schema: MarginDataInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchMarginData(input.days);
    return formatToolResult(formatMarginData(value), [sourceUrl]);
  },
});
