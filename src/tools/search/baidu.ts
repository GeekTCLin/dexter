import { DynamicStructuredTool } from '@langchain/core/tools';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { formatToolResult } from '../types.js';
import { TTL_15M } from '../finance/utils.js';

// Keyless Baidu web search. Baidu serves UTF-8 HTML; redirect links
// (www.baidu.com/link?url=... or m.baidu.com/from=...) are intentionally
// preserved for web_fetch to follow rather than resolved here.
const BAIDU_URL = 'https://www.baidu.com/s';
const CACHE_ENDPOINT = '/web-search/baidu/';
const MAX_RESULTS = 5;

// Baidu blocks the desktop Chrome UA with a verification page; a mobile UA
// consistently gets real results (verified 2026-09). WEB_SEARCH_UA overrides.
const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

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

/** Parse a Baidu SERP (`div.result` / `div.result.c-container` blocks). */
export function parseBaiduHtml(html: string): WebSearchItem[] {
  const { document } = parseHTML(html);
  const nodes = Array.from(document.querySelectorAll('div.result, div.result.c-container'));
  const seen = new Set<string>();
  const out: WebSearchItem[] = [];
  for (const node of nodes) {
    const anchor = node.querySelector('h3 a');
    const url = anchor?.getAttribute('href') ?? '';
    const title = cleanText(anchor?.textContent);
    if (!title || !url || seen.has(url)) continue;
    const snippetNode =
      node.querySelector('.c-abstract') ??
      node.querySelector('.content-right_8Zs40') ??
      node.querySelector('[class*=abstract]');
    seen.add(url);
    out.push({ title, url, snippet: cleanText(snippetNode?.textContent) || undefined });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

export const baiduSearch = new DynamicStructuredTool({
  name: 'web_search',
  description:
    'Search the web with Baidu for current information (China-focused). Returns up to 5 results with titles, URLs, and snippets. No API key required.',
  schema: z.object({
    query: z.string().describe('The search query to look up on the web'),
  }),
  func: async (input) => {
    const query = input.query.trim();
    if (!query) throw new Error('[Baidu] query is required');
    try {
      const cacheParams = { query };
      const cached = readCache(CACHE_ENDPOINT, cacheParams, TTL_15M);
      const cachedResults = cached?.data.results;
      if (isWebSearchItemArray(cachedResults)) {
        return formatToolResult({ results: cachedResults }, cachedResults.map((r) => r.url));
      }

      const url = `${BAIDU_URL}?wd=${encodeURIComponent(query)}&rn=10&ie=utf-8`;
      const html = await fetchText(url);
      if (isVerificationPage(html)) {
        throw new Error('[Baidu] Verification page returned');
      }
      const results = parseBaiduHtml(html);
      if (results.length === 0) {
        throw new Error(`[Baidu] No results for query: ${query}`);
      }
      writeCache(CACHE_ENDPOINT, cacheParams, { results }, url);
      return formatToolResult({ results }, results.map((r) => r.url));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Baidu] error: ${message}`);
      throw new Error(message.startsWith('[Baidu]') ? message : `[Baidu] ${message}`);
    }
  },
});
