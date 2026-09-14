import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { formatIndustryBoards } from './formatters.js';
import {
  getIndustryBoards as fetchIndustryBoards,
  getIndustryMembers as fetchIndustryMembers,
} from './industry-api.js';

export const INDUSTRY_BOARDS_DESCRIPTION = `
Lists China A-share industry sectors (行业板块) ranked by daily change percent, with each board's name, code, change, advancing/declining counts and leading stock. When a board is supplied (BK code such as BK1010 or a name such as 农林牧渔), instead returns that board's member stocks with price and change. Use for 行业表现, 板块轮动, 行业涨幅榜, 板块成分股. Powered by Eastmoney, no API key required.
`.trim();

const IndustryBoardsInputSchema = z.object({
  board: z
    .string()
    .optional()
    .describe('可选：板块代码（如 BK1010）或名称（如 农林牧渔）。留空则返回行业板块行情列表。'),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('最多返回数量，列表默认 30，成分股默认 50，最大 100。'),
});

export const getIndustryBoards = new DynamicStructuredTool({
  name: 'get_industry_boards',
  description:
    'China A-share industry sector (行业板块) list ranked by daily change, or — given a board code/name — that board\'s member stocks. Key-less (Eastmoney).',
  schema: IndustryBoardsInputSchema,
  func: async (input) => {
    const result = input.board
      ? await fetchIndustryMembers(input.board, input.limit)
      : await fetchIndustryBoards(input.limit);
    return formatToolResult(formatIndustryBoards(result.value), [result.sourceUrl]);
  },
});
