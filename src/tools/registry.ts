import { StructuredToolInterface } from '@langchain/core/tools';
import { createGetFinancials, createGetMarketData, createReadFilings, createScreenStocks } from './finance/index.js';
import { exaSearch, tavilySearch, langSearch, bingSearch, baiduSearch, WEB_SEARCH_DESCRIPTION, xSearchTool, X_SEARCH_DESCRIPTION, domesticSearchTool, DOMESTIC_SEARCH_DESCRIPTION } from './search/index.js';
import { createWebSearchTool, type WebSearchProvider } from './search/web-search.js';
import { getSetting } from '../utils/config.js';
import { checkApiKeyExists, type SearchProviderId } from '../utils/env.js';
import { skillTool, SKILL_TOOL_DESCRIPTION } from './skill.js';
import { createWebFetch, WEB_FETCH_DESCRIPTION } from './fetch/web-fetch.js';
import { browserTool, BROWSER_DESCRIPTION } from './browser/browser.js';
import { readFileTool, READ_FILE_DESCRIPTION } from './filesystem/read-file.js';
import { writeFileTool, WRITE_FILE_DESCRIPTION } from './filesystem/write-file.js';
import { editFileTool, EDIT_FILE_DESCRIPTION } from './filesystem/edit-file.js';
import { GET_FINANCIALS_DESCRIPTION } from './finance/get-financials.js';
import { getMarketDataDescription } from './finance/get-market-data.js';
import { isFinancialDatasetsConfigured } from './finance/api.js';
import { READ_FILINGS_DESCRIPTION } from './finance/read-filings.js';
import { SCREEN_STOCKS_DESCRIPTION } from './finance/screen-stocks.js';
import { heartbeatTool, HEARTBEAT_TOOL_DESCRIPTION } from './heartbeat/heartbeat-tool.js';
import { cronTool, CRON_TOOL_DESCRIPTION } from './cron/cron-tool.js';
import { memoryGetTool, MEMORY_GET_DESCRIPTION, memorySearchTool, MEMORY_SEARCH_DESCRIPTION, memoryUpdateTool, MEMORY_UPDATE_DESCRIPTION } from './memory/index.js';
import { discoverSkills } from '../skills/index.js';
import { createSpawnSubagent, SPAWN_SUBAGENT_DESCRIPTION } from './subagent/spawn-subagent.js';
import { createAskUserQuestion, ASK_USER_QUESTION_DESCRIPTION } from './ask-user-question/ask-user-question.js';
import { createBash, BASH_TOOL_DESCRIPTION } from './bash/bash-tool.js';

/**
 * A registered tool with its rich description for system prompt injection.
 */
export interface RegisteredTool {
  /** Tool name (must match the tool's name property) */
  name: string;
  /** The actual tool instance */
  tool: StructuredToolInterface;
  /** Rich description for system prompt (includes when to use, when not to use, etc.) */
  description: string;
  /** 1-2 sentence description for token-optimized system prompts. */
  compactDescription: string;
  /** Whether this tool can safely execute concurrently with other concurrent-safe tools. */
  concurrencySafe: boolean;
}

/**
 * Build the ordered web_search fallback chain.
 *
 * Bing (CN) and Baidu need no key and always lead; Exa/Tavily/LangSearch are
 * appended only when a real key (not a `your-...` placeholder) is configured.
 * `WEB_SEARCH_DISABLED=1` opts the whole tool out. Exported for tests/diagnostics.
 */
export function buildWebSearchProviders(): WebSearchProvider[] {
  const providers: WebSearchProvider[] = [];
  if (process.env.WEB_SEARCH_DISABLED === '1') return providers;

  providers.push({ id: 'bing', name: 'Bing', tool: bingSearch });
  providers.push({ id: 'baidu', name: 'Baidu', tool: baiduSearch });
  if (checkApiKeyExists('EXASEARCH_API_KEY')) {
    providers.push({ id: 'exa', name: 'Exa', tool: exaSearch });
  }
  if (checkApiKeyExists('TAVILY_API_KEY')) {
    providers.push({ id: 'tavily', name: 'Tavily', tool: tavilySearch });
  }
  if (checkApiKeyExists('LANGSEARCH_API_KEY')) {
    providers.push({ id: 'langsearch', name: 'LangSearch', tool: langSearch });
  }
  return providers;
}

/**
 * Get all registered tools with their descriptions.
 * Conditionally includes tools based on environment configuration.
 *
 * @param model - The model name (needed for tools that require model-specific configuration)
 * @returns Array of registered tools
 */
export function getToolRegistry(model: string): RegisteredTool[] {
  // financialdatasets.ai-backed tools are only exposed when a real key is
  // configured; otherwise every call would fail, so they stay unregistered.
  const financialDatasetsConfigured = isFinancialDatasetsConfigured();

  const tools: RegisteredTool[] = [
    ...(financialDatasetsConfigured
      ? [
          {
            name: 'get_financials',
            tool: createGetFinancials(model),
            description: GET_FINANCIALS_DESCRIPTION,
            compactDescription: 'Financial statements and metrics. Handles multi-company/multi-metric queries in one call.',
            concurrencySafe: true,
          },
        ]
      : []),
    {
      name: 'get_market_data',
      tool: createGetMarketData(model),
      description: getMarketDataDescription(),
      compactDescription: financialDatasetsConfigured
        ? 'Stock/crypto prices, company news, and insider trades/ownership. Handles multi-asset queries in one call.'
        : 'China A-share domestic index quotes and historical prices (no key).',
      concurrencySafe: true,
    },
    ...(financialDatasetsConfigured
      ? [
          {
            name: 'read_filings',
            tool: createReadFilings(model),
            description: READ_FILINGS_DESCRIPTION,
            compactDescription: 'SEC filings (10-K, 10-Q, 8-K). Extracts and summarizes specific filing sections.',
            concurrencySafe: true,
          },
          {
            name: 'stock_screener',
            tool: createScreenStocks(model),
            description: SCREEN_STOCKS_DESCRIPTION,
            compactDescription: 'Screen stocks by financial criteria (P/E, growth, margins, etc.).',
            concurrencySafe: true,
          },
        ]
      : []),
    {
      name: 'spawn_subagent',
      tool: createSpawnSubagent(model),
      description: SPAWN_SUBAGENT_DESCRIPTION,
      compactDescription: 'Delegate a focused sub-task to an isolated subagent. Emit multiple calls in one turn to run independent sub-tasks in parallel.',
      concurrencySafe: true,
    },
    {
      name: 'ask_user_question',
      tool: createAskUserQuestion(),
      description: ASK_USER_QUESTION_DESCRIPTION,
      compactDescription: 'Ask the user 1-4 multiple-choice questions mid-turn and wait for their answers. CLI only.',
      concurrencySafe: false,
    },
    {
      name: 'web_fetch',
      tool: createWebFetch(model),
      description: WEB_FETCH_DESCRIPTION,
      compactDescription: 'Fetch a URL and answer a prompt about its content (HTML→markdown, fast-model summarized).',
      concurrencySafe: true,
    },
    {
      name: 'browser',
      tool: browserTool,
      description: BROWSER_DESCRIPTION,
      compactDescription: 'JavaScript-rendered pages and interactive navigation. Actions: navigate, snapshot, act, read, close.',
      concurrencySafe: true,
    },
    {
      name: 'read_file',
      tool: readFileTool,
      description: READ_FILE_DESCRIPTION,
      compactDescription: 'Read a local file by path. Returns file content as text.',
      concurrencySafe: true,
    },
    {
      name: 'write_file',
      tool: writeFileTool,
      description: WRITE_FILE_DESCRIPTION,
      compactDescription: 'Create or overwrite a file. Requires user approval.',
      concurrencySafe: false,
    },
    {
      name: 'edit_file',
      tool: editFileTool,
      description: EDIT_FILE_DESCRIPTION,
      compactDescription: 'Edit a file by replacing text. Requires user approval.',
      concurrencySafe: false,
    },
    {
      name: 'heartbeat',
      tool: heartbeatTool,
      description: HEARTBEAT_TOOL_DESCRIPTION,
      compactDescription: 'View or update the periodic heartbeat checklist (.dexter/HEARTBEAT.md).',
      concurrencySafe: true,
    },
    {
      name: 'cron',
      tool: cronTool,
      description: CRON_TOOL_DESCRIPTION,
      compactDescription: 'Manage scheduled cron jobs (create, list, update, delete).',
      concurrencySafe: true,
    },
    {
      name: 'memory_search',
      tool: memorySearchTool,
      description: MEMORY_SEARCH_DESCRIPTION,
      compactDescription: 'Search persistent memory and past conversations for stored facts and preferences.',
      concurrencySafe: true,
    },
    {
      name: 'memory_get',
      tool: memoryGetTool,
      description: MEMORY_GET_DESCRIPTION,
      compactDescription: 'Read specific memory file sections by line range.',
      concurrencySafe: true,
    },
    {
      name: 'memory_update',
      tool: memoryUpdateTool,
      description: MEMORY_UPDATE_DESCRIPTION,
      compactDescription: 'Add, edit, or delete persistent memory entries.',
      concurrencySafe: false,
    },
  ];

  // Build web_search as a fallback chain. Bing (CN) and Baidu are keyless and
  // always first; overseas providers with a real key configured are appended as
  // fallbacks. The user's preferred provider (set via /search) is tried first.
  const allWebSearchProviders = buildWebSearchProviders();

  if (allWebSearchProviders.length > 0) {
    const preferred = getSetting<SearchProviderId | undefined>('webSearchPreferredProvider', undefined);
    const orderedProviders = preferred
      ? [
          ...allWebSearchProviders.filter((p) => p.id === preferred),
          ...allWebSearchProviders.filter((p) => p.id !== preferred),
        ]
      : allWebSearchProviders;

    tools.push({
      name: 'web_search',
      tool: createWebSearchTool(orderedProviders),
      description: WEB_SEARCH_DESCRIPTION,
      compactDescription: 'Search the web (Bing CN / Baidu by default; overseas providers as fallback).',
      concurrencySafe: true,
    });
  }

  if (checkApiKeyExists('X_BEARER_TOKEN')) {
    tools.push({
      name: 'x_search',
      tool: xSearchTool,
      description: X_SEARCH_DESCRIPTION,
      compactDescription: 'Search X/Twitter for tweets, profiles, and threads.',
      concurrencySafe: true,
    });
  }

  // China domestic news/sentiment needs no key, so it is enabled by default;
  // DOMESTIC_SEARCH_DISABLED=1 opts out.
  if (process.env.DOMESTIC_SEARCH_DISABLED !== '1') {
    tools.push({
      name: 'domestic_search',
      tool: domesticSearchTool,
      description: DOMESTIC_SEARCH_DESCRIPTION,
      compactDescription: 'China A-share flash news, Guba retail sentiment, keyword news, and official CNINFO announcements (no key).',
      concurrencySafe: false,
    });
  }

  const availableSkills = discoverSkills();
  if (availableSkills.length > 0) {
    tools.push({
      name: 'skill',
      tool: skillTool,
      description: SKILL_TOOL_DESCRIPTION,
      compactDescription: 'Invoke a specialized skill workflow (e.g., DCF valuation).',
      concurrencySafe: false,
    });
  }

  // bash: Unix/macOS only (uses /bin/sh + POSIX process groups). Channel gating
  // (CLI-only) is handled by CLI_ONLY_TOOLS in Agent.create.
  if (process.platform !== 'win32') {
    tools.push({
      name: 'bash',
      tool: createBash(model),
      description: BASH_TOOL_DESCRIPTION,
      compactDescription: 'Run a shell command (stdout/stderr/exit code). CLI only; every command asks for approval.',
      concurrencySafe: false,
    });
  }

  return tools;
}

/**
 * Build a name → concurrencySafe map for the tool executor.
 */
export function getToolConcurrencyMap(model: string): Map<string, boolean> {
  return new Map(getToolRegistry(model).map(t => [t.name, t.concurrencySafe]));
}

/**
 * Get just the tool instances for binding to the LLM.
 *
 * @param model - The model name
 * @returns Array of tool instances
 */
export function getTools(model: string): StructuredToolInterface[] {
  return getToolRegistry(model).map((t) => t.tool);
}

/**
 * Build the tool descriptions section for the system prompt.
 * Formats each tool's rich description with a header.
 *
 * @param model - The model name
 * @returns Formatted string with all tool descriptions
 */
/**
 * Build compact tool descriptions for token-optimized system prompts.
 * Uses 1-2 sentence descriptions instead of full multi-paragraph ones.
 * The LLM already has full tool schemas via bindTools().
 */
export function buildCompactToolDescriptions(model: string): string {
  return getToolRegistry(model)
    .map((t) => `- **${t.name}**: ${t.compactDescription}`)
    .join('\n');
}
