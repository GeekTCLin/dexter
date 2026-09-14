import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { formatIndexConstituents } from './formatters.js';
import { getIndexConstituents as fetchIndexConstituents } from './index-constituents-api.js';

export const INDEX_CONSTITUENTS_DESCRIPTION = `
Lists the constituent stocks (成分股) of a China A-share index such as 沪深300, 中证500, 中证1000, 科创50, 创业板指 or 上证50. Returns each member's code, name and last price/change. Accepts an index name, code or secid (e.g. 沪深300, 000300.SH, 1.000300). Note: index weights are not available from this data source. Powered by Eastmoney, no API key required.
`.trim();

const IndexConstituentsInputSchema = z.object({
  symbol: z.string().describe('指数名称、代码或 secid，如 沪深300、000300.SH、1.000300。'),
  limit: z
    .number()
    .int()
    .positive()
    .max(300)
    .optional()
    .describe('最多返回的成分股数量，默认 100，最大 300。'),
});

export const getIndexConstituents = new DynamicStructuredTool({
  name: 'get_index_constituents',
  description:
    'Lists the constituent stocks of a China A-share index (成分股), with code, name and last price. Weights are not available. Key-less (Eastmoney).',
  schema: IndexConstituentsInputSchema,
  func: async (input) => {
    const { value, sourceUrl } = await fetchIndexConstituents(input.symbol, input.limit);
    return formatToolResult(formatIndexConstituents(value), [sourceUrl]);
  },
});
