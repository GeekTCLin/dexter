/**
 * Rich description for the web_search tool.
 * Used in the system prompt to guide the LLM on when and how to use this tool.
 */
export const WEB_SEARCH_DESCRIPTION = `
Search the web for current information on any topic.
By default this uses keyless China-accessible sources (Bing CN and Baidu); if Exa, Tavily, or LangSearch API keys are configured they are used as supplementary/fallback providers. Returns up to 5 search results with titles, URLs, and content snippets.

## When to Use

- Historical stock prices for equities (use get_market_data)
- Factual questions about entities (companies, people, organizations) where status can change
- Current events, breaking news, recent developments
- Technology updates, product announcements, industry trends
- Verifying claims about real-world state (public/private, active/defunct, current leadership)
- Research on topics outside of structured financial data

## When NOT to Use

- Structured financial data (company financials, SEC filings, key ratios - use get_financials instead)
- Pure conceptual/definitional questions ("What is a DCF?")

## Usage Notes

- Provide specific, well-formed search queries for best results
- Returns up to 5 results with URLs and content snippets
- Use for supplementary research when get_financials doesn't cover the topic
`.trim();

export { bingSearch } from './bing.js';
export { baiduSearch } from './baidu.js';
export { tavilySearch } from './tavily.js';
export { exaSearch } from './exa.js';
export { langSearch } from './langsearch.js';
export { xSearchTool, X_SEARCH_DESCRIPTION } from './x-search.js';
export { domesticSearchTool, DOMESTIC_SEARCH_DESCRIPTION } from './domestic-search.js';
