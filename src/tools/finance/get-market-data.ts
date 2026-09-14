import { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { AIMessage, ToolCall } from '@langchain/core/messages';
import { z } from 'zod';
import { callLlm } from '../../model/llm.js';
import { formatToolResult } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';
import { withTimeout, SUB_TOOL_TIMEOUT_MS } from './utils.js';
import { MARKET_DATA_FORMATTERS } from './formatters.js';
import { isFinancialDatasetsConfigured } from './api.js';

/**
 * Rich description for the get_market_data tool when financialdatasets.ai is
 * configured. Used in the system prompt to guide the LLM.
 */
export const GET_MARKET_DATA_DESCRIPTION = `
Intelligent meta-tool for retrieving market data including prices, news, and insider activity. Takes a natural language query and automatically routes to appropriate market data sources.

## When to Use

- Current stock price snapshots (price, market cap, volume, 52-week high/low)
- Historical stock prices over date ranges
- Available stock ticker lookup
- Current cryptocurrency price snapshots
- Historical cryptocurrency prices over date ranges
- Available crypto ticker lookup
- Multi-asset price comparisons
- Company news and recent headlines
- Broad market news (macro, rates, earnings, geopolitics)
- Insider trading activity
- Insider ownership statements (SEC Forms 3/5 — what insiders hold)
- Institutional holdings (SEC 13F — who holds a security, what a filer holds)
- Beneficial ownership and activist stakes (SEC 13D/13G — 5%+ owners, activist positions)
- Price move explanations ("why did X go up/down" → combines price + news)
- China A-share domestic index snapshots (上证综指, 深证成指, 创业板指, 沪深300, 中证500, 科创50, 中证1000, 上证50, 上证180)
- Major China A-share index overviews ("今天大盘怎么样")
- Historical China A-share domestic index prices (daily/weekly/monthly K-line)
- China A-share index valuation (PE/PB/股息率 and their historical percentiles; 估值、高估/低估、分位)

## When NOT to Use

- Company financials like income statements, balance sheets, cash flow (use get_financials)
- Financial metrics and key ratios (use get_financials)
- SEC filings (use read_filings)
- Stock screening by criteria (use stock_screener)
- General web searches (use web_search)

## Usage Notes

- Call ONCE with the complete natural language query - the tool handles complexity internally
- Handles ticker resolution automatically (Apple -> AAPL, Bitcoin -> BTC)
- Handles date inference (e.g., "last month", "past year", "YTD")
- For "what ticker is X?" queries, this tool can look up available tickers
- Returns structured JSON data with source URLs for verification
`.trim();

/**
 * Rich description for the get_market_data tool when financialdatasets.ai is
 * NOT configured. It only advertises the key-free China A-share index
 * capability, and never references tools that are not registered in that state.
 */
export const GET_MARKET_DATA_DESCRIPTION_INDEX_ONLY = `
Intelligent meta-tool for retrieving China A-share domestic market index data. Takes a natural language query and automatically routes to the appropriate index data source.

## When to Use

- China A-share domestic index snapshots (上证综指, 深证成指, 创业板指, 沪深300, 中证500, 科创50, 中证1000, 上证50, 上证180)
- Major China A-share index overviews ("今天大盘怎么样")
- Historical China A-share domestic index prices (daily/weekly/monthly K-line)
- China A-share index valuation (PE/PB/股息率 and their historical percentiles; 估值、分位)

## When NOT to Use

- General web searches (use web_search)
- Questions that don't require external financial data (answer directly from knowledge)

## Usage Notes

- Call ONCE with the complete natural language query - the tool handles complexity internally
- Handles index name/alias resolution (上证综指, 沪深300, 000001.SH)
- Handles date inference (e.g., "last month", "past year", "YTD")
- Returns structured JSON data with source URLs for verification
`.trim();

/**
 * Select the rich get_market_data description for the current configuration.
 */
export function getMarketDataDescription(): string {
  return isFinancialDatasetsConfigured()
    ? GET_MARKET_DATA_DESCRIPTION
    : GET_MARKET_DATA_DESCRIPTION_INDEX_ONLY;
}

/** Format snake_case tool name to Title Case for progress messages */
function formatSubToolName(name: string): string {
  return name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Import market data tools directly (avoid circular deps with index.ts)
import { getStockPrice, getStockPrices, getStockTickers } from './stock-price.js';
import { getCryptoPriceSnapshot, getCryptoPrices, getCryptoTickers } from './crypto.js';
import { getCompanyNews } from './news.js';
import { createGetInsiderTrades, getInsiderNames } from './insider_trades.js';
import { getInsiderOwnership } from './insider_ownership.js';
import { getInstitutionalHoldings } from './institutional_holdings.js';
import { getBeneficialOwnership } from './beneficial_ownership.js';
import { getIndexSnapshot, getIndexSnapshots, getIndexPrices, getIndexValuation } from './domestic-index.js';

// All market data tools available for routing. Built per-instance because
// get_insider_trades needs the model for its LLM name-resolution fallback.
function buildMarketDataTools(model: string): StructuredToolInterface[] {
  // China A-share domestic indices are key-free, so they are always bound.
  const indexTools = [getIndexSnapshot, getIndexSnapshots, getIndexPrices, getIndexValuation];

  // U.S. equities/crypto go through financialdatasets.ai and require the API
  // key; without it they fail on every call, so they are never bound.
  if (!isFinancialDatasetsConfigured()) {
    return indexTools;
  }

  return [
    // Stock Prices
    getStockPrice,
    getStockPrices,
    getStockTickers,
    // Crypto Prices
    getCryptoPriceSnapshot,
    getCryptoPrices,
    getCryptoTickers,
    // News & Activity
    getCompanyNews,
    createGetInsiderTrades(model),
    getInsiderNames,
    getInsiderOwnership,
    getInstitutionalHoldings,
    getBeneficialOwnership,
    // China A-share Domestic Indices
    ...indexTools,
  ];
}

/**
 * Names of the sub-tools get_market_data may route to under the current
 * configuration. Exposed so callers/tests can assert the enabled capability
 * set without invoking the router LLM.
 */
export function getMarketDataSubToolNames(model: string): string[] {
  return buildMarketDataTools(model).map((t) => t.name);
}

// Build the router system prompt for market data
function buildRouterPrompt(): string {
  // Without the financialdatasets.ai key, the U.S./crypto sub-tools are not
  // bound, so the router prompt must not mention them or their tickers.
  if (!isFinancialDatasetsConfigured()) {
    return `You are a market data routing assistant.
Current date: ${getCurrentDate()}

Given a user's natural language query about market data, call the appropriate tool(s).

## Guidelines

1. **Date Inference**: Use schema-supported filters for date ranges:
   - "last month" → start_date 1 month ago, end_date today
   - "past year" → start_date 1 year ago, end_date today
   - "YTD" → start_date Jan 1 of current year, end_date today
   - "2024" → start_date 2024-01-01, end_date 2024-12-31

2. **Tool Selection**:
   - For a single China A-share domestic index quote (上证综指, 深证成指, 沪深300, 中证500, 科创50, 中证1000, etc.) → get_index_snapshot
   - For "今天A股主要指数 / 大盘概览" or an overview of major China indices → get_index_snapshots
   - For China domestic index history, trend or range performance (日/周/月 K线) → get_index_prices
   - For China domestic index valuation (PE/PB/股息率、历史分位、高估低估) → get_index_valuation
   - A-share / China domestic indices MUST use the get_index_* tools, NEVER get_stock_price (which only covers US equities).

3. **Efficiency**:
   - For current/latest price, use snapshot tools (not historical with limit 1)
   - For comparisons between assets, call the same tool for each ticker
   - Use the smallest date range that answers the question

Note: 美股/加密数据未配置 (U.S. equities and crypto are not configured), so only China A-share domestic indices are supported.

Call the appropriate tool(s) now.`;
  }

  return `You are a market data routing assistant.
Current date: ${getCurrentDate()}

Given a user's natural language query about market data, call the appropriate tool(s).

## Guidelines

1. **Ticker Resolution**: Convert company/crypto names to ticker symbols:
   - Apple → AAPL, Tesla → TSLA, Microsoft → MSFT, Amazon → AMZN
   - Google/Alphabet → GOOGL, Meta/Facebook → META, Nvidia → NVDA
   - Bitcoin → BTC, Ethereum → ETH, Solana → SOL

2. **Date Inference**: Use schema-supported filters for date ranges:
   - "last month" → start_date 1 month ago, end_date today
   - "past year" → start_date 1 year ago, end_date today
   - "YTD" → start_date Jan 1 of current year, end_date today
   - "2024" → start_date 2024-01-01, end_date 2024-12-31

3. **Tool Selection**:
   - For a current stock quote/snapshot (price, market cap, volume) → get_stock_price
   - For historical stock prices over a date range → get_stock_prices
   - For "what stocks are available" or ticker lookup → get_stock_tickers
   - For a current crypto price/snapshot → get_crypto_price_snapshot
   - For historical crypto prices over a date range → get_crypto_prices
   - For "what cryptos are available" or crypto ticker lookup → get_crypto_tickers
   - For company-specific news, catalysts, recent announcements → get_company_news with ticker
   - For broad market news (macro, rates, earnings, geopolitics) → get_company_news without ticker
   - For insider buying/selling activity → get_insider_trades (the name filter accepts common names like 'Jensen Huang' and resolves them to the SEC spelling internally; do NOT make a separate lookup call)
   - For "who are the insiders at X" or to list a company's insiders by name → get_insider_names with ticker
   - For what insiders OWN (positions and holdings, initial Form 3 statements, annual Form 5 statements, options/RSUs held) → get_insider_ownership
   - For who holds a stock (largest holders, 13F holders of X) → get_institutional_holdings with ticker
   - For a specific manager's portfolio (Citadel, Berkshire, BlackRock, etc.) → get_institutional_holdings with filer_name (the tool resolves name → CIK internally; do NOT make a separate lookup call)
   - For 5%+ owners of a company or activist stakes ("who owns X", "any activists in X") → get_beneficial_ownership with ticker (add type=activist for activists only)
   - For a specific activist's or 5%+ owner's stakes across companies (Saba, Elliott, Icahn, etc.) → get_beneficial_ownership with filer_name (resolves name → CIK internally)
   - For "why did X go up/down" → combine get_stock_price + get_company_news
   - For "what's happening in the markets" → get_company_news without ticker
   - For a single China A-share domestic index quote (上证综指, 深证成指, 沪深300, 中证500, 科创50, 中证1000, etc.) → get_index_snapshot
   - For "今天A股主要指数 / 大盘概览" or an overview of major China indices → get_index_snapshots
   - For China domestic index history, trend or range performance (日/周/月 K线) → get_index_prices
   - For China domestic index valuation (PE/PB/股息率、历史分位、高估低估) → get_index_valuation
   - A-share / China domestic indices MUST use the get_index_* tools, NEVER get_stock_price (which only covers US equities).

4. **Efficiency**:
   - For current/latest price, use snapshot tools (not historical with limit 1)
   - For comparisons between assets, call the same tool for each ticker
   - Use the smallest date range that answers the question

Call the appropriate tool(s) now.`;
}

// Input schema for the get_market_data tool
const GetMarketDataInputSchema = z.object({
  query: z.string().describe('Natural language query about market data, prices, news, or insider activity'),
});

/**
 * Create a get_market_data tool configured with the specified model.
 * Uses native LLM tool calling for routing queries to market data tools.
 */
export function createGetMarketData(model: string): DynamicStructuredTool {
  const marketDataTools = buildMarketDataTools(model);
  const marketDataToolMap = new Map(marketDataTools.map(t => [t.name, t]));
  return new DynamicStructuredTool({
    name: 'get_market_data',
    // Only advertise the capabilities that are actually bound; U.S./crypto
    // sub-tools are absent when financialdatasets.ai is not configured.
    description: isFinancialDatasetsConfigured()
      ? `Intelligent meta-tool for retrieving market data including prices, news, and insider activity. Takes a natural language query and automatically routes to appropriate market data tools. Use for:
- Current and historical stock prices
- Current and historical cryptocurrency prices
- China A-share domestic index quotes, historical prices, and valuation (PE/PB/股息率、历史分位)
- Stock and crypto ticker lookup
- Company news and recent headlines
- Broad market news (omit ticker)
- Insider trading activity
- Insider ownership statements (Forms 3/5)
- Institutional holdings (SEC 13F)
- Beneficial ownership and activist stakes (SEC 13D/13G)`
      : `Intelligent meta-tool for retrieving China A-share domestic index data. Takes a natural language query and automatically routes to appropriate index tools. Use for:
- China A-share domestic index quotes (实时快照、批量概览)
- China A-share domestic index historical prices (日/周/月 K线)
- China A-share domestic index valuation (PE/PB/股息率、历史分位)`,
    schema: GetMarketDataInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;

      // 1. Call LLM with market data tools bound (native tool calling)
      onProgress?.('Fetching market data...');
      const { response } = await callLlm(input.query, {
        model,
        systemPrompt: buildRouterPrompt(),
        tools: marketDataTools,
      });
      const aiMessage = response as AIMessage;

      // 2. Check for tool calls
      const toolCalls = aiMessage.tool_calls as ToolCall[];
      if (!toolCalls || toolCalls.length === 0) {
        return formatToolResult({ error: 'No tools selected for query' }, []);
      }

      // 3. Execute tool calls in parallel
      const toolNames = [...new Set(toolCalls.map(tc => formatSubToolName(tc.name)))];
      onProgress?.(`Fetching from ${toolNames.join(', ')}...`);
      const results = await Promise.all(
        toolCalls.map(async (tc) => {
          try {
            const tool = marketDataToolMap.get(tc.name);
            if (!tool) {
              throw new Error(`Tool '${tc.name}' not found`);
            }
            const rawResult = await withTimeout(tool.invoke(tc.args), SUB_TOOL_TIMEOUT_MS, tc.name);
            const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
            const parsed = JSON.parse(result);
            return {
              tool: tc.name,
              args: tc.args,
              data: parsed.data,
              sourceUrls: parsed.sourceUrls || [],
              error: null,
            };
          } catch (error) {
            return {
              tool: tc.name,
              args: tc.args,
              data: null,
              sourceUrls: [],
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })
      );

      // 4. Combine results
      const successfulResults = results.filter((r) => r.error === null);
      const failedResults = results.filter((r) => r.error !== null);

      // Collect all source URLs
      const allUrls = results.flatMap((r) => r.sourceUrls);

      // Build combined data structure
      const combinedData: Record<string, unknown> = {};

      for (const result of successfulResults) {
        // Use tool name as key, or tool_ticker for multiple calls to same tool
        const ticker = (result.args as Record<string, unknown>).ticker as string | undefined;
        const key = ticker ? `${result.tool}_${ticker}` : result.tool;
        const formatter = MARKET_DATA_FORMATTERS[result.tool];
        combinedData[key] = formatter
          ? formatter(result.data, result.args as Record<string, unknown>)
          : result.data;
      }

      // Add errors if any
      if (failedResults.length > 0) {
        combinedData._errors = failedResults.map((r) => ({
          tool: r.tool,
          args: r.args,
          error: r.error,
        }));
      }

      return formatToolResult(combinedData, allUrls);
    },
  });
}
