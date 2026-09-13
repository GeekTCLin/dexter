import { DynamicStructuredTool } from '@langchain/core/tools';
import { DOMParser, parseHTML } from 'linkedom';
import { z } from 'zod';
import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { formatToolResult } from '../types.js';
import { TTL_15M } from '../finance/utils.js';

// Keyless Bing (China) web search. RSS is preferred because its shape is stable;
// when RSS yields nothing (or is not XML) we fall back to scraping cn.bing.com.
const BING_RSS_URL = 'https://www.bing.com/search';
const BING_HTML_URL = 'https://cn.bing.com/search';
const CACHE_ENDPOINT = '/web-search/bing/';
const MAX_RESULTS = 5;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface WebSearchItem {
  title: string;
  url: string;
  snippet?: string;
}

function getUserAgent(): string {
  return process.env.WEB_SEARCH_UA || DEFAULT_UA;
}

function getTimeoutMs(): number {
  const raw = Number(process.env.WEB_SEARCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': getUserAgent(),
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isVerificationPage(html: string): boolean {
  return /安全验证|请输入验证码|人机验证|Verify you are human|verify you are human/i.test(html);
}

function isWebSearchItem(value: unknown): value is WebSearchItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === 'string' && typeof v.url === 'string';
}

function isWebSearchItemArray(value: unknown): value is WebSearchItem[] {
  return Array.isArray(value) && value.length > 0 && value.every(isWebSearchItem);
}

function dedupe(items: WebSearchItem[]): WebSearchItem[] {
  const seen = new Set<string>();
  const out: WebSearchItem[] = [];
  for (const item of items) {
    if (!item.title || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** Parse Bing's RSS feed (`format=rss`); returns [] when the body is not RSS. */
export function parseBingRss(xml: string): WebSearchItem[] {
  if (!/<rss[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml)) return [];
  let doc: ReturnType<DOMParser['parseFromString']>;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch {
    return [];
  }
  const items = Array.from(doc.querySelectorAll('item')) as Array<{
    querySelector(selector: string): { textContent: string | null } | null;
  }>;
  return dedupe(
    items.map((item) => ({
      title: cleanText(item.querySelector('title')?.textContent),
      url: cleanText(item.querySelector('link')?.textContent),
      snippet: cleanText(item.querySelector('description')?.textContent) || undefined,
    })),
  );
}

/** Parse a cn.bing.com HTML result page (`li.b_algo` blocks). */
export function parseBingHtml(html: string): WebSearchItem[] {
  const { document } = parseHTML(html);
  const nodes = Array.from(document.querySelectorAll('li.b_algo'));
  return dedupe(
    nodes.map((node) => {
      const anchor = node.querySelector('h2 a');
      const snippetNode = node.querySelector('.b_caption p') ?? node.querySelector('p');
      return {
        title: cleanText(anchor?.textContent),
        url: anchor?.getAttribute('href') ?? '',
        snippet: cleanText(snippetNode?.textContent) || undefined,
      };
    }),
  );
}

async function runBingSearch(query: string): Promise<{ results: WebSearchItem[]; url: string }> {
  const encoded = encodeURIComponent(query);

  const rssUrl = `${BING_RSS_URL}?q=${encoded}&format=rss&setlang=zh-CN`;
  const rssText = await fetchText(rssUrl);
  // A verification page is non-XML, so treat it like "no RSS results" and let
  // the HTML endpoint have a try before giving up.
  if (!isVerificationPage(rssText)) {
    const rssResults = parseBingRss(rssText);
    if (rssResults.length > 0) return { results: rssResults, url: rssUrl };
  }

  // RSS empty/non-XML/verification: fall back to the HTML result page.
  const htmlUrl = `${BING_HTML_URL}?q=${encoded}&setlang=zh-CN`;
  const html = await fetchText(htmlUrl);
  if (isVerificationPage(html)) {
    throw new Error('[Bing] Verification page returned');
  }
  return { results: parseBingHtml(html), url: htmlUrl };
}

export const bingSearch = new DynamicStructuredTool({
  name: 'web_search',
  description:
    'Search the web with Bing (China) for current information. Returns up to 5 results with titles, URLs, and snippets. No API key required.',
  schema: z.object({
    query: z.string().describe('The search query to look up on the web'),
  }),
  func: async (input) => {
    const query = input.query.trim();
    if (!query) throw new Error('[Bing] query is required');
    try {
      const cacheParams = { query };
      const cached = readCache(CACHE_ENDPOINT, cacheParams, TTL_15M);
      const cachedResults = cached?.data.results;
      if (isWebSearchItemArray(cachedResults)) {
        return formatToolResult({ results: cachedResults }, cachedResults.map((r) => r.url));
      }

      const { results, url } = await runBingSearch(query);
      if (results.length === 0) {
        throw new Error(`[Bing] No results for query: ${query}`);
      }
      writeCache(CACHE_ENDPOINT, cacheParams, { results }, url);
      return formatToolResult({ results }, results.map((r) => r.url));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Bing] error: ${message}`);
      throw new Error(message.startsWith('[Bing]') ? message : `[Bing] ${message}`);
    }
  },
});
