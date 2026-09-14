import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_24H } from './utils.js';

// Fund identity/profile from Eastmoney's fund search suggest API. Used for
// 基金公司/基金经理解析 (the dedicated FundMNManager* endpoints are gone/404).

export interface FundProfile {
  code: string;
  name: string | null;
  company: string | null;
  manager: string | null;
  fundType: string | null;
  nav: number | null;
  navDate: string | null;
  source: 'eastmoney';
}

export interface Sourced<T> {
  value: T;
  source: 'eastmoney';
  sourceUrl: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CACHE_ENDPOINT = '/domestic-fund/profile/';
const SEARCH_URL = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx';
const SOURCE_URL = 'https://fund.eastmoney.com/';
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;

let failures = 0;
let openUntil = 0;

function getTimeoutMs(): number {
  const raw = Number(process.env.DOMESTIC_FUND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function getUserAgent(): string {
  return process.env.DOMESTIC_FUND_UA || DEFAULT_UA;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': getUserAgent(),
        Referer: SOURCE_URL,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function toNumberOrNull(value: unknown): number | null {
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

export function normalizeFundCode(code: string): string {
  return code.replace(/^(sh|sz|bj)/i, '').replace(/\D/g, '');
}

interface SearchRow {
  CODE?: unknown;
  NAME?: unknown;
  FundBaseInfo?: Record<string, unknown> | null;
}

function parseProfile(code: string, row: SearchRow): FundProfile {
  const base = (row.FundBaseInfo ?? {}) as Record<string, unknown>;
  return {
    code,
    name: toStringOrNull(row.NAME) ?? toStringOrNull(base.SHORTNAME),
    company: toStringOrNull(base.JJGS),
    manager: toStringOrNull(base.JJJL),
    fundType: toStringOrNull(base.FTYPE),
    nav: toNumberOrNull(base.DWJZ),
    navDate: toStringOrNull(base.FSRQ),
    source: 'eastmoney',
  };
}

function isFundProfile(value: unknown): value is FundProfile | null {
  return value === null || (typeof value === 'object' && value !== null);
}

/**
 * Resolves a fund's identity — name, company (基金公司), manager (基金经理),
 * type and latest NAV. Returns null when the code matches no fund.
 */
export async function getFundProfile(code: string): Promise<Sourced<FundProfile | null>> {
  const normalized = normalizeFundCode(code);
  if (!normalized) throw new Error('A 6-digit fund code is required');
  const cacheParams = { code: normalized };

  const cached = readCache(CACHE_ENDPOINT, cacheParams, TTL_24H);
  if (cached && isFundProfile(cached.data.result)) {
    return { value: cached.data.result, source: 'eastmoney', sourceUrl: cached.url };
  }
  if (Date.now() < openUntil) {
    throw new Error('Eastmoney fund data temporarily unavailable (circuit open)');
  }

  const url = `${SEARCH_URL}?m=1&key=${encodeURIComponent(normalized)}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Eastmoney fund search HTTP ${res.status}`);
    const payload = (await res.json()) as { Datas?: unknown };
    const rows = Array.isArray(payload.Datas) ? (payload.Datas as SearchRow[]) : [];
    const exact =
      rows.find((row) => {
        const base = (row.FundBaseInfo ?? {}) as Record<string, unknown>;
        return toStringOrNull(row.CODE) === normalized || toStringOrNull(base.FCODE) === normalized;
      }) ?? rows.find((row) => toStringOrNull(row.NAME)?.includes(normalized));
    const profile = exact ? parseProfile(normalized, exact) : null;
    failures = 0;
    openUntil = 0;
    writeCache(CACHE_ENDPOINT, cacheParams, { result: profile }, SOURCE_URL);
    return { value: profile, source: 'eastmoney', sourceUrl: SOURCE_URL };
  } catch (error) {
    failures += 1;
    if (failures >= FAILURE_THRESHOLD) {
      openUntil = Date.now() + COOLDOWN_MS;
      failures = 0;
      logger.warn(`[domestic-fund] profile circuit opened for ${COOLDOWN_MS / 1000}s`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
