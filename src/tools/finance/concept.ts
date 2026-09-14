import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { formatIndustryBoards } from './formatters.js';
import { getConceptBoards as fetchConceptBoards, getConceptMembers as fetchConceptMembers } from './industry-api.js';

export const CONCEPT_BOARDS_DESCRIPTION = `
Lists China A-share concept/theme sectors (概念题材) ranked by daily change percent, with each board's name, code, change, advancing/declining counts and leading stock. When a board is supplied (BK code such as BK0493 or a name such as 人工智能), instead returns that board's member stocks with price and change. Use for 概念板块, 题材轮动, 概念热度, 题材涨幅榜, 概念成分股. Powered by Eastmoney, no API key required.
`.trim();

const ConceptBoardsInputSchema = z.object({
  board: z
    .string()
    .optional()
    .describe('可选：概念板块代码（如 BK0493）或名称（如 人工智能）。留空则返回概念板块行情列表。'),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('最多返回数量，列表默认 30，成分股默认 50，最大 100。'),
});

export const getConceptBoards = new DynamicStructuredTool({
  name: 'get_concept_boards',
  description:
    'China A-share concept/theme sector (概念题材) list ranked by daily change, or — given a board code/name — that board\'s member stocks. Key-less (Eastmoney).',
  schema: ConceptBoardsInputSchema,
  func: async (input) => {
    const result = input.board
      ? await fetchConceptMembers(input.board, input.limit)
      : await fetchConceptBoards(input.limit);
    return formatToolResult(formatIndustryBoards(result.value, { kind: 'concept' }), [result.sourceUrl]);
  },
});
