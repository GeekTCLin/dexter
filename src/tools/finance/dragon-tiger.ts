import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { formatDragonTiger, formatLimitUpPool } from './formatters.js';
import {
  getDragonTiger as fetchDragonTiger,
  getLimitUpPool as fetchLimitUpPool,
} from './dragon-tiger-api.js';

export const DRAGON_TIGER_DESCRIPTION = `
Daily China A-share 龙虎榜 (dragon-tiger board): the stocks that hit the disclosure threshold ranked by net buy (净买入), with buy/sell amounts, turnover, change and the disclosure reason, plus the most active 营业部/游资 seats (营业部交易明细) for the same day ranked by net buy. Use for 龙虎榜, 游资, 营业部, 资金席位, 净买入排名. Optionally pass a trade date (YYYY-MM-DD or YYYYMMDD); defaults to the latest available. Powered by Eastmoney, no API key required.
`.trim();

export const LIMIT_UP_POOL_DESCRIPTION = `
Daily China A-share 涨停池 (limit-up pool): every limit-up stock with 连板数 (consecutive limit-ups), 封板时间 (first/last seal time), 炸板次数 (open times), 封单额, 换手率 and 行业, plus the total limit-up count. Use for 涨停板, 连板, 打板, 封单, 短线情绪, 涨停家数. Optionally pass a trade date; defaults to the latest trading day. Powered by Eastmoney, no API key required.
`.trim();

const DragonTigerInputSchema = z.object({
  date: z.string().optional().describe('交易日，YYYY-MM-DD 或 YYYYMMDD；默认最近一个交易日。'),
  limit: z.number().int().positive().max(100).optional().describe('龙虎榜个股条数，默认 20。'),
  seat_limit: z.number().int().positive().max(100).optional().describe('营业部/游资条数，默认 15。'),
});

const LimitUpInputSchema = z.object({
  date: z.string().optional().describe('交易日，YYYY-MM-DD 或 YYYYMMDD；默认最近一个交易日。'),
  limit: z.number().int().positive().max(100).optional().describe('返回的涨停股条数，默认 30。'),
});

export const getDragonTiger = new DynamicStructuredTool({
  name: 'get_dragon_tiger',
  description:
    'Daily China A-share 龙虎榜: net-buy ranked stocks plus the most active 营业部/游资 seats for the day. Key-less (Eastmoney).',
  schema: DragonTigerInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchDragonTiger(input.date, input.limit ?? 20, input.seat_limit ?? 15);
    return formatToolResult(formatDragonTiger(value), [sourceUrl]);
  },
});

export const getLimitUpPool = new DynamicStructuredTool({
  name: 'get_limit_up_pool',
  description:
    'Daily China A-share 涨停池: limit-up stocks with 连板数/封板时间/炸板次数/封单额 and the total limit-up count. Key-less (Eastmoney).',
  schema: LimitUpInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchLimitUpPool(input.date, input.limit ?? 30);
    return formatToolResult(formatLimitUpPool(value), [sourceUrl]);
  },
});
