import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_1H } from './utils.js';
import { resolveIndex } from './domestic-index-api.js';

// Maps an index to the ETFs that track it, via Eastmoney's fund search. There
// is no direct "index → ETF" endpoint, so this searches by the index name plus
// the "ETF" keyword and filters the suggesting API's results.

export interface IndexEtf {
  code: string;
  name: string;
  company: string | null;
  manager: string | null;
  fundType: string | null;
  nav: number | null;
  navDate: string | null;
}

export interface IndexEtfMap {
  query: string;
  indexSymbol: string | null;
  indexName: string | null;
  etfs: IndexEtf[];
  source: 'eastmoney';
}

export interface Sourced<T> {
  value: T;
  source: 'eastmoney';
  sourceUrl: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CACHE_ENDPOINT = '/domestic-index/etf-map/';
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;
const DEFAULT_LIMIT = 20;

let failures = 0;
let openUntil = 0;

function getTimeoutMs(): number {
  const raw = Number(process.env.DOMESTIC_MARKET_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function getUserAgent(): string {
  return process.env.DOMESTIC_MARKET_UA || DEFAULT_UA;
}

async function fetchWithTimeout(url: string, referer: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': getUserAgent(),
        Referer: referer,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function isIndexEtfMap(value: unknown): value is IndexEtfMap {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.etfs) && v.source === 'eastmoney';
}

// Keep exchange-traded ETFs only; drop the feeder funds (联接基金) that track
// the same index but are subscribed in cash.
function isTradableEtf(name: string): boolean {
  return name.includes('ETF') && !name.includes('联接');
}

function parseEtf(row: Record<string, unknown>): IndexEtf | null {
  const code = toStringOrNull(row.CODE);
  const name = toStringOrNull(row.NAME);
  if (!code || !name) return null;
  const base = (row.FundBaseInfo && typeof row.FundBaseInfo === 'object'
    ? row.FundBaseInfo
    : {}) as Record<string, unknown>;
  return {
    code,
    name,
    company: toStringOrNull(base.JJGS),
    manager: toStringOrNull(base.JJJL),
    fundType: toStringOrNull(base.FTYPE),
    nav: toNullableNumber(base.DWJZ),
    navDate: toStringOrNull(base.FSRQ),
  };
}

/**
 * Find ETFs tracking an index (accepts an index name/code, or a raw keyword).
 */
export async function getIndexEtfMap(query: string, limit: number = DEFAULT_LIMIT): Promise<Sourced<IndexEtfMap>> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('An index name or code is required');

  const pageLimit = Math.min(Math.max(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT, 1), 50);
  const def = resolveIndex(trimmed);
  const keyword = def ? `${def.name}ETF` : trimmed;

  const cacheParams = { keyword, limit: pageLimit };
  const cached = readCache(CACHE_ENDPOINT, cacheParams, TTL_1H);
  if (cached && isIndexEtfMap(cached.data.map)) {
    return { value: cached.data.map, source: 'eastmoney', sourceUrl: cached.url };
  }

  if (Date.now() < openUntil) {
    throw new Error('Eastmoney fund search temporarily unavailable (circuit open)');
  }

  const url =
    'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx' +
    `?m=1&key=${encodeURIComponent(keyword)}`;

  try {
    const res = await fetchWithTimeout(url, 'https://fund.eastmoney.com/');
    if (!res.ok) throw new Error(`Eastmoney fund search HTTP ${res.status}`);
    const payload = (await res.json()) as { Datas?: unknown };
    const raw = Array.isArray(payload.Datas) ? (payload.Datas as unknown[]) : [];

    const etfs = raw
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map(parseEtf)
      .filter((etf): etf is IndexEtf => etf !== null && isTradableEtf(etf.name))
      .slice(0, pageLimit);

    const map: IndexEtfMap = {
      query: trimmed,
      indexSymbol: def?.symbol ?? null,
      indexName: def?.name ?? null,
      etfs,
      source: 'eastmoney',
    };

    failures = 0;
    openUntil = 0;
    writeCache(CACHE_ENDPOINT, cacheParams, { map }, url);
    return { value: map, source: 'eastmoney', sourceUrl: url };
  } catch (error) {
    failures += 1;
    if (failures >= FAILURE_THRESHOLD) {
      openUntil = Date.now() + COOLDOWN_MS;
      failures = 0;
      logger.warn(`[domestic-index] etf-map circuit opened for ${COOLDOWN_MS / 1000}s`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
