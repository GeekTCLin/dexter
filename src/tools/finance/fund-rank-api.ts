import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_1H } from './utils.js';
import { decodeGbk } from './domestic-index-api.js';

// Eastmoney open-end fund ranking table (基金排行榜). The endpoint returns a
// JS snippet (`var rankData = {datas:[...],...};`) encoded in GBK, so it is
// read as bytes, decoded, then scraped with a small regex.

export interface FundRankRow {
  code: string;
  name: string;
  navDate: string | null;
  nav: number | null;
  accNav: number | null;
  dayGrowth: number | null;
  week1: number | null;
  month1: number | null;
  month3: number | null;
  month6: number | null;
  year1: number | null;
  year2: number | null;
  year3: number | null;
  year5: number | null;
  sinceInception: number | null;
  inceptionDate: string | null;
}

export interface FundRankings {
  sort: string;
  fundType: string;
  total: number | null;
  rows: FundRankRow[];
  source: 'eastmoney';
}

export interface Sourced<T> {
  value: T;
  source: 'eastmoney';
  sourceUrl: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CACHE_ENDPOINT = '/domestic-fund/rankings/';
const RANK_URL = 'https://fund.eastmoney.com/data/rankhandler.aspx';
const SOURCE_URL = 'https://fund.eastmoney.com/data/fundranking.html';
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const SORT_KEYS = new Set([
  'rzdf',
  'zzf',
  '1yzf',
  '3yzf',
  '6yzf',
  '1nzf',
  '2nzf',
  '3nzf',
  'jnzf',
  'lnzf',
]);
const FUND_TYPES = new Set(['all', 'gp', 'hh', 'zq', 'zs', 'qdii', 'fof']);

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

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStr(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  const n = Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : fallback;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

export function normalizeRankSort(sort: string | undefined): string {
  const trimmed = (sort ?? '').trim().toLowerCase();
  return SORT_KEYS.has(trimmed) ? trimmed : '1nzf';
}

export function normalizeFundType(fundType: string | undefined): string {
  const trimmed = (fundType ?? '').trim().toLowerCase();
  return FUND_TYPES.has(trimmed) ? trimmed : 'all';
}

// Each datas entry is a comma-joined record. Column order (confirmed against
// live samples): 0 code, 1 name, 2 pinyin, 3 date, 4 nav, 5 accNav,
// 6 day, 7 week1, 8 month1, 9 month3, 10 month6, 11 year1, 12 year2,
// 13 year3, 14 year5, 15 sinceInception, 16 inceptionDate, then fees.
function parseRankRow(raw: string): FundRankRow | null {
  const parts = raw.split(',');
  const code = toStr(parts[0]);
  const name = toStr(parts[1]);
  if (!code || !name) return null;
  return {
    code,
    name,
    navDate: toStr(parts[3]),
    nav: toNumberOrNull(parts[4]),
    accNav: toNumberOrNull(parts[5]),
    dayGrowth: toNumberOrNull(parts[6]),
    week1: toNumberOrNull(parts[7]),
    month1: toNumberOrNull(parts[8]),
    month3: toNumberOrNull(parts[9]),
    month6: toNumberOrNull(parts[10]),
    year1: toNumberOrNull(parts[11]),
    year2: toNumberOrNull(parts[12]),
    year3: toNumberOrNull(parts[13]),
    year5: toNumberOrNull(parts[14]),
    sinceInception: toNumberOrNull(parts[15]),
    inceptionDate: toStr(parts[16]),
  };
}

function parseRankPayload(text: string): { rows: FundRankRow[]; total: number | null } {
  const arrayMatch = /datas:\s*\[(.*?)\]/s.exec(text);
  const rows: FundRankRow[] = [];
  if (arrayMatch?.[1]) {
    const quoted = arrayMatch[1].match(/"([^"]*)"/g) ?? [];
    for (const entry of quoted) {
      const parsed = parseRankRow(entry.slice(1, -1));
      if (parsed) rows.push(parsed);
    }
  }
  const totalMatch = /allRecords:\s*(\d+)/.exec(text);
  return { rows, total: totalMatch?.[1] ? Number(totalMatch[1]) : null };
}

function isFundRankings(value: unknown): value is FundRankings {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.rows);
}

/**
 * Ranks China open-end funds by a chosen return window (default: 近1年).
 * `sort` uses Eastmoney's keys (rzdf/zzf/1yzf/3yzf/6yzf/1nzf/2nzf/3nzf/jnzf/lnzf);
 * `fundType` filters by 类型 (all/gp/hh/zq/zs/qdii/fof).
 */
export async function getFundRankings(
  sort?: string,
  fundType?: string,
  limit: number = DEFAULT_LIMIT,
): Promise<Sourced<FundRankings>> {
  const sc = normalizeRankSort(sort);
  const ft = normalizeFundType(fundType);
  const pageLimit = clampLimit(limit, DEFAULT_LIMIT);
  const cacheParams = { sort: sc, fundType: ft, limit: pageLimit };

  const cached = readCache(CACHE_ENDPOINT, cacheParams, TTL_1H);
  if (cached && isFundRankings(cached.data.result)) {
    return { value: cached.data.result, source: 'eastmoney', sourceUrl: cached.url };
  }
  if (Date.now() < openUntil) {
    throw new Error('Eastmoney fund rankings temporarily unavailable (circuit open)');
  }

  const url =
    `${RANK_URL}?op=ph&dt=kf&ft=${ft}&sd=&ed=&sc=${sc}&st=desc` +
    `&pi=1&pn=${pageLimit}&v=${Math.random()}`;

  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Eastmoney fund rankings HTTP ${res.status}`);
    const text = decodeGbk(await res.arrayBuffer());
    const { rows, total } = parseRankPayload(text);
    if (rows.length === 0 && !/rankData/.test(text)) {
      throw new Error('Eastmoney fund rankings returned an unparsable response');
    }
    const result: FundRankings = { sort: sc, fundType: ft, total, rows, source: 'eastmoney' };
    failures = 0;
    openUntil = 0;
    writeCache(CACHE_ENDPOINT, cacheParams, { result }, SOURCE_URL);
    return { value: result, source: 'eastmoney', sourceUrl: SOURCE_URL };
  } catch (error) {
    failures += 1;
    if (failures >= FAILURE_THRESHOLD) {
      openUntil = Date.now() + COOLDOWN_MS;
      failures = 0;
      logger.warn(`[domestic-fund] rankings circuit opened for ${COOLDOWN_MS / 1000}s`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
