import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
  getFlashNews,
  getGubaSentiment,
  searchDomesticNews,
  getAnnouncements,
} from './domestic-search-api.js';

const schema = z.object({
  command: z
    .enum(['flash', 'sentiment', 'news', 'announcements'])
    .describe(
      'flash: 7x24 A-share flash news; sentiment: Guba retail posts for a stock; ' +
        'news: keyword news search; announcements: official CNINFO filings',
    ),
  query: z
    .string()
    .optional()
    .describe(
      'news: the search keyword; sentiment/announcements: a 6-digit A-share code ' +
        '(used when `code` is not provided)',
    ),
  code: z
    .string()
    .optional()
    .describe('6-digit A-share code (e.g. "600519"); preferred over `query` for sentiment/announcements'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .default(15)
    .describe('Maximum number of results to return (default: 15)'),
  sort: z
    .enum(['latest', 'hot'])
    .optional()
    .default('latest')
    .describe('Sort order for sentiment posts (default: latest)'),
});

function sourceUrls(url: string | undefined): string[] | undefined {
  return url ? [url] : undefined;
}

export const domesticSearchTool = new DynamicStructuredTool({
  name: 'domestic_search',
  description:
    'Search China domestic (A-share) market news, retail sentiment, keyword news, and official ' +
    'CNINFO announcements. Free sources, no API key required.',
  schema,
  func: async (input) => {
    try {
      const limit = input.limit ?? 15;

      if (input.command === 'flash') {
        const result = await getFlashNews(limit);
        return formatToolResult(
          { items: result.value, source: result.source },
          sourceUrls(result.sourceUrl),
        );
      }

      if (input.command === 'sentiment') {
        const code = input.code ?? input.query;
        if (!code) throw new Error('query or code is required for sentiment command');
        const result = await getGubaSentiment(code, { sort: input.sort ?? 'latest', limit });
        return formatToolResult({ ...result.value, source: result.source }, sourceUrls(result.sourceUrl));
      }

      if (input.command === 'news') {
        if (!input.query) throw new Error('query is required for news command');
        const result = await searchDomesticNews(input.query, limit);
        return formatToolResult(
          { items: result.value, source: result.source },
          sourceUrls(result.sourceUrl),
        );
      }

      if (input.command === 'announcements') {
        const code = input.code ?? input.query;
        if (!code) throw new Error('query or code is required for announcements command');
        const result = await getAnnouncements(code, { limit });
        return formatToolResult(
          { items: result.value, source: result.source },
          sourceUrls(result.sourceUrl),
        );
      }

      throw new Error(`Unknown command: ${input.command}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[domestic_search] ${message}`);
    }
  },
});

export const DOMESTIC_SEARCH_DESCRIPTION = `
Search China domestic (A-share) market news, retail sentiment, keyword news, and official filings.
China-market only. Uses free public endpoints — no API key required.

## When to Use

- A-share 7x24 flash news / breaking headlines (command: flash)
- Retail investor sentiment on a specific A-share from Eastmoney Guba (command: sentiment)
- Keyword news search on Chinese market topics or companies (command: news)
- Official listed-company announcements from CNINFO (command: announcements)

## When NOT to Use

- US / global equities or non-China markets (use x_search or web_search instead)
- Structured financial statements or prices (use get_financials / get_market_data)
- SEC filings (use read_filings)

## Commands

- **flash**: latest China 7x24 market flash news. No arguments beyond \`limit\`.
- **sentiment**: Eastmoney Guba retail posts and bullish/bearish counts. Requires \`code\` (or \`query\`) as a 6-digit A-share code; \`sort\` = latest | hot.
- **news**: keyword news search. Requires \`query\` (the keyword). Optional \`limit\`.
- **announcements**: official CNINFO announcements. Requires \`code\` (or \`query\`) as a 6-digit A-share code.

## Sources & Freshness

- Flash: Eastmoney 7x24 (primary) → CLS telegraph → Sina 7x24 (fallbacks). ~15 min cache.
- Sentiment / news: Eastmoney. ~15 min cache.
- Announcements: CNINFO (official). ~1 hour cache.

## Compliance Notes

- Eastmoney / CLS / Sina / Guba endpoints are non-official public interfaces and may rate-limit or change without notice.
- CNINFO is the official disclosure channel and is authoritative for announcements.
- Licensed authoritative sources (e.g. Tushare Pro / 通联数据) are reserved as a future plug-in and are not enabled here.
`.trim();
