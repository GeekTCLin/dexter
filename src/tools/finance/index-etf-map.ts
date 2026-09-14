import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { formatIndexEtfMap } from './formatters.js';
import { getIndexEtfMap as fetchIndexEtfMap } from './index-etf-map-api.js';

export const INDEX_ETF_MAP_DESCRIPTION = `
Maps a China index to the exchange-traded ETFs that track it, so a view on an index can be expressed through a tradable fund. Returns each ETF's code, name, fund company, manager, type and latest NAV. Use for 指数对应哪些ETF, 跟踪指数的ETF, 用什么ETF买某个指数, 沪深300 ETF 列表. Accepts an index name or code (e.g. 沪深300, 000300, 中证500). Powered by Eastmoney fund search, no API key required.
`.trim();

const IndexEtfMapInputSchema = z.object({
  index: z.string().describe("指数名称或代码，如 '沪深300'、'000300'、'中证500'。"),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('最多返回的 ETF 数量，默认 20，最大 50。'),
});

export const getIndexEtfMap = new DynamicStructuredTool({
  name: 'get_index_etf_map',
  description:
    'Maps a China index (e.g. 沪深300) to the exchange-traded ETFs that track it, with code, name, company and latest NAV. No key required.',
  schema: IndexEtfMapInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchIndexEtfMap(input.index, input.limit);
    return formatToolResult(formatIndexEtfMap(value), [sourceUrl]);
  },
});
