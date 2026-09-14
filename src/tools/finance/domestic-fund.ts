import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
  formatFundQuotes,
  formatFundNav,
  formatFundHoldings,
  formatFundRankings,
  formatFundProfile,
} from './formatters.js';
import {
  getFundQuotes as fetchFundQuotes,
  getFundNav as fetchFundNav,
  getFundHoldings as fetchFundHoldings,
} from './domestic-fund-api.js';
import { getFundRankings as fetchFundRankings } from './fund-rank-api.js';
import { getFundProfile as fetchFundProfile } from './fund-profile-api.js';

export const FUND_QUOTES_DESCRIPTION = `
Fetches the latest quote for one or more China domestic funds / ETFs (基金、ETF). Returns the net asset value (NAV/单位净值), accumulated NAV, NAV daily change, and — for exchange-traded ETFs/LOFs — the secondary-market price, its daily change and quote date. Accepts a list of 6-digit codes (e.g. 510300 沪深300ETF, 000001 华夏成长混合). Powered by Eastmoney, no API key required.
`.trim();

export const FUND_NAV_DESCRIPTION = `
Retrieves the historical net asset value (NAV) series for a China domestic fund / ETF over a date range, including unit NAV, accumulated NAV and daily change percent. Use for 基金净值走势, 历史净值, 区间收益. Accepts a 6-digit code (e.g. 510300). Powered by Eastmoney, no API key required.
`.trim();

const FundQuotesInputSchema = z.object({
  codes: z
    .array(z.string())
    .min(1)
    .describe("基金/ETF 代码列表，如 ['510300','000001']。"),
});

export const getFundQuotes = new DynamicStructuredTool({
  name: 'get_fund_quotes',
  description:
    'Fetches the latest NAV (单位净值/累计净值) and, for ETFs/LOFs, the exchange-traded price and daily change for one or more China domestic funds. Not for US funds.',
  schema: FundQuotesInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchFundQuotes(input.codes);
    return formatToolResult(formatFundQuotes(value), [sourceUrl]);
  },
});

const FundNavInputSchema = z.object({
  code: z.string().describe("基金/ETF 代码，如 '510300'、'000001'。"),
  start_date: z.string().optional().describe('Start date in YYYY-MM-DD format. Optional.'),
  end_date: z.string().optional().describe('End date in YYYY-MM-DD format. Optional.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('最多返回的净值条数，默认 120，最大 500。'),
});

export const getFundNav = new DynamicStructuredTool({
  name: 'get_fund_nav',
  description:
    'Retrieves the historical NAV (单位净值/累计净值) series for a China domestic fund or ETF over a date range. Use for 基金净值走势 and 区间收益.',
  schema: FundNavInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchFundNav(
      input.code,
      input.start_date,
      input.end_date,
      input.limit,
    );
    return formatToolResult(formatFundNav(value), [sourceUrl]);
  },
});

export const FUND_HOLDINGS_DESCRIPTION = `
Retrieves a China fund's disclosed top holdings (前十大重仓股/持仓明细) for the latest reporting period, including each stock's code, name, share of net asset value, market, position change (增持/减持/新增/不变), change percent and industry. Use for 基金持仓, 重仓股, 基金买了什么, 持仓穿透. Accepts a 6-digit fund code (e.g. 510300 沪深300ETF, 000001 华夏成长混合). Powered by Eastmoney, no API key required.
`.trim();

const FundHoldingsInputSchema = z.object({
  code: z.string().describe("基金/ETF 代码，如 '510300'、'000001'。"),
});

export const getFundHoldings = new DynamicStructuredTool({
  name: 'get_fund_holdings',
  description:
    "China fund disclosed top holdings (前十大重仓股) with weights, position changes and industry. Use for 基金持仓 and 重仓股 look-through.",
  schema: FundHoldingsInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchFundHoldings(input.code);
    return formatToolResult(formatFundHoldings(value), [sourceUrl]);
  },
});

export const FUND_RANKINGS_DESCRIPTION = `
Ranks China open-end funds (基金排行榜) by a chosen return window and optionally by fund type. Returns each fund's code, name, unit/accumulated NAV and returns over 近1月/近3月/近1年/近3年/成立来. Use for 基金排名, 业绩排行, 挑基金. Powered by Eastmoney, no API key required.
`.trim();

const FundRankingsInputSchema = z.object({
  sort: z
    .string()
    .optional()
    .describe('排序字段：rzdf(日)/zzf(近1周)/1yzf(近1月)/3yzf(近3月)/6yzf(近6月)/1nzf(近1年,默认)/2nzf/3nzf/jnzf(今年)/lnzf(成立来)。'),
  fund_type: z
    .string()
    .optional()
    .describe('基金类型：all(默认)/gp(股票)/hh(混合)/zq(债券)/zs(指数)/qdii/fof。'),
  limit: z.number().int().positive().max(50).optional().describe('最多返回数量，默认 20，最大 50。'),
});

export const getFundRankings = new DynamicStructuredTool({
  name: 'get_fund_rankings',
  description:
    'China open-end fund rankings (基金排行榜) by return window and fund type, with NAV and multi-period returns. Key-less (Eastmoney).',
  schema: FundRankingsInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchFundRankings(
      input.sort,
      input.fund_type,
      input.limit,
    );
    return formatToolResult(formatFundRankings(value), [sourceUrl]);
  },
});

export const FUND_PROFILE_DESCRIPTION = `
Looks up a China fund's identity: name, fund company (基金公司), fund manager (基金经理), type and latest NAV. Use for 基金经理, 基金公司, 这只基金是谁管的. Accepts a 6-digit code. Powered by Eastmoney, no API key required.
`.trim();

const FundProfileInputSchema = z.object({
  code: z.string().describe("基金代码，如 '510300'、'000001'。"),
});

export const getFundProfile = new DynamicStructuredTool({
  name: 'get_fund_profile',
  description:
    'China fund profile: company (基金公司), manager (基金经理), type and latest NAV. Key-less (Eastmoney).',
  schema: FundProfileInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchFundProfile(input.code);
    return formatToolResult(formatFundProfile(value, { code: input.code }), [sourceUrl]);
  },
});
