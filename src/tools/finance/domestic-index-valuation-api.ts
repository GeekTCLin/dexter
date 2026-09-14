import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_1H } from './utils.js';
import { resolveIndex } from './domestic-index-api.js';

// Index valuation (PE / PB / dividend yield + historical percentiles) sourced
// from 蛋卷基金 (danjuanfunds.com), a free, key-less endpoint. This is a
// best-effort enrichment: not every index is covered, so callers must treat a
// null result as "no valuation published" rather than an error.

export interface IndexValuation {
  symbol: string;
  name: string;
  pe: number | null;
  pb: number | null;
  dividendYield: number | null;
  pePercentile: number | null;
  pbPercentile: number | null;
  roe: number | null;
  peg: number | null;
  bondYield: number | null;
  evaluation: string | null;
  valuationDate: string | null;
  historyYears: number | null;
  source: 'danjuan';
}

export interface SourcedValuation {
  value: IndexValuation;
  source: 'danjuan';
  sourceUrl: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const VALUATION_CACHE_ENDPOINT = '/domestic-index/valuation/';

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;

let consecutiveFailures = 0;
let openUntil = 0;

function getTimeoutMs(): number {
  const raw = Number(process.env.DOMESTIC_INDEX_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function getUserAgent(): string {
  return process.env.DOMESTIC_INDEX_UA || DEFAULT_UA;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': getUserAgent() },
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
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Danjuan mixes second- and millisecond-based timestamps.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function yearsBetween(beginAt: unknown, endAt: unknown): number | null {
  const start = toDate(beginAt);
  if (!start) return null;
  const end = toDate(endAt) ?? new Date();
  const years = (end.getTime() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return years > 0 ? Math.round(years * 10) / 10 : null;
}

// Danjuan keys an index as its exchange prefix plus the 6-digit code, e.g.
// SH000300. Beijing codes are not covered, so they short-circuit to null.
function danjuanCode(symbol: string): string | null {
  const match = symbol.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (!match) return null;
  if (match[2] === 'BJ') return null;
  return `${match[2]}${match[1]}`;
}

function isIndexValuation(value: unknown): value is IndexValuation {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.symbol === 'string' && typeof v.name === 'string' && v.source === 'danjuan';
}

function parseValuation(symbol: string, data: Record<string, unknown>, sourceUrl: string): SourcedValuation {
  const value: IndexValuation = {
    symbol,
    name: toStringOrNull(data.name) ?? symbol,
    pe: toNullableNumber(data.pe),
    pb: toNullableNumber(data.pb),
    dividendYield: toNullableNumber(data.yeild),
    pePercentile: toNullableNumber(data.pe_percentile),
    pbPercentile: toNullableNumber(data.pb_percentile),
    roe: toNullableNumber(data.roe),
    peg: toNullableNumber(data.peg),
    bondYield: toNullableNumber(data.bond_yeild),
    evaluation: toStringOrNull(data.eva_type),
    valuationDate: toStringOrNull(data.date),
    historyYears: yearsBetween(data.begin_at, data.date),
    source: 'danjuan',
  };
  return { value, source: 'danjuan', sourceUrl };
}

/**
 * Fetch the current PE/PB valuation and historical percentile for a China
 * A-share index. Returns `null` when the index is not covered by the provider
 * or the provider is temporarily unavailable — never throw for those cases.
 */
export async function getIndexValuation(symbol: string): Promise<SourcedValuation | null> {
  const def = resolveIndex(symbol);
  if (!def) return null;

  const cacheParams = { symbol: def.symbol };
  const cached = readCache(VALUATION_CACHE_ENDPOINT, cacheParams, TTL_1H);
  if (cached && isIndexValuation(cached.data.valuation)) {
    return { value: cached.data.valuation, source: 'danjuan', sourceUrl: cached.url };
  }

  if (Date.now() < openUntil) return null;

  const code = danjuanCode(def.symbol);
  if (!code) return null;

  const url = `https://danjuanfunds.com/djapi/index_eva/detail/${code}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Danjuan HTTP ${res.status}`);
    const payload = (await res.json()) as { data?: Record<string, unknown> | null };
    const data = payload.data;
    // `result_code: 0` with no `data` means "index not covered".
    if (!data || typeof data !== 'object') return null;

    consecutiveFailures = 0;
    openUntil = 0;

    const result = parseValuation(def.symbol, data, url);
    writeCache(VALUATION_CACHE_ENDPOINT, cacheParams, { valuation: result.value }, url);
    return result;
  } catch (error) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      openUntil = Date.now() + COOLDOWN_MS;
      consecutiveFailures = 0;
    }
    logger.warn(
      `[domestic-index-valuation] failed for ${def.symbol}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
