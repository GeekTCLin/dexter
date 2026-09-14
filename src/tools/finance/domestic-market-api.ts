import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_1H } from './utils.js';

// Independent client for China domestic market-wide data (market breadth and
// margin financing). Uses key-less Eastmoney endpoints and does NOT import
// ./api.js (which is hardwired to financialdatasets.ai).

export interface MarketBreadth {
  tradeDate: string | null;
  up: number;
  down: number;
  flat: number;
  total: number;
  limitUp: number | null;
  limitDown: number | null;
  shAmount: number | null;
  szAmount: number | null;
  turnover: number | null;
  source: 'eastmoney';
}

export interface MarginRow {
  date: string;
  // All balances/amounts are in CNY (yuan).
  financingBalance: number | null; // 融资余额 RZYE
  marginBalance: number | null; // 融资融券余额 RZRQYE
  financingBuy: number | null; // 融资买入额 RZMRE
  financingRepay: number | null; // 融资偿还额 RZCHE
  financingNet: number | null; // 融资净买入 RZJME
  securitiesLendingBalance: number | null; // 融券余额 RQYE
  financingBalanceRatio: number | null; // 融资余额占流通市值% RZYEZB
  source: 'eastmoney';
}

export interface MarginData {
  rows: MarginRow[];
  latest: MarginRow | null;
}

export interface Sourced<T> {
  value: T;
  source: 'eastmoney';
  sourceUrl: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BREADTH_CACHE_ENDPOINT = '/domestic-market/breadth/';
const MARGIN_CACHE_ENDPOINT = '/domestic-market/margin/';

// Breadth is intraday-sensitive; margin is published once a day.
const BREADTH_TTL_MS = 60_000;

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;

const SH_INDEX_SECID = '1.000001';
const SZ_INDEX_SECID = '0.399001';
const ZT_UT = '7eea3edcaed734bea9cbfc24409ed989';

interface Circuit {
  available(): boolean;
  success(): void;
  failure(label: string): void;
}

function createCircuit(label: string): Circuit {
  let failures = 0;
  let openUntil = 0;
  return {
    available: () => Date.now() >= openUntil,
    success: () => {
      failures = 0;
      openUntil = 0;
    },
    failure: (message: string) => {
      failures += 1;
      if (failures >= FAILURE_THRESHOLD) {
        openUntil = Date.now() + COOLDOWN_MS;
        failures = 0;
        logger.warn(`[domestic-market] ${label} circuit opened for ${COOLDOWN_MS / 1000}s`, { message });
      }
    },
  };
}

const breadthCircuit = createCircuit('breadth');
const marginCircuit = createCircuit('margin');

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

// Today's date (Asia/Shanghai) as YYYY-MM-DD; the ZT/DT pools are keyed by
// trading day, so the caller's clock timezone must not leak in.
function shanghaiDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

interface UlRow {
  f12?: unknown;
  f13?: unknown;
  f104?: unknown;
  f105?: unknown;
  f106?: unknown;
}

async function fetchBreadthCounts(): Promise<{ up: number; down: number; flat: number }> {
  const fields = 'f1,f2,f3,f4,f12,f13,f14,f104,f105,f106';
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get' +
    `?fltt=2&invt=2&fields=${fields}&secids=${SH_INDEX_SECID},${SZ_INDEX_SECID}`;
  const res = await fetchWithTimeout(url, 'https://quote.eastmoney.com/');
  if (!res.ok) throw new Error(`Eastmoney breadth HTTP ${res.status}`);
  const payload = (await res.json()) as { data?: { diff?: unknown } | null };
  const diff = Array.isArray(payload.data?.diff) ? (payload.data!.diff as UlRow[]) : [];
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const row of diff) {
    up += toNullableNumber(row.f104) ?? 0;
    down += toNullableNumber(row.f105) ?? 0;
    flat += toNullableNumber(row.f106) ?? 0;
  }
  return { up, down, flat };
}

// Best-effort: on holidays the pool is empty and `tc` may be absent → null.
async function fetchLimitCount(topic: 'ZT' | 'DT', tradeDate: string): Promise<number | null> {
  const url =
    `https://push2ex.eastmoney.com/getTopic${topic}Pool` +
    `?ut=${ZT_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=${tradeDate}`;
  try {
    const res = await fetchWithTimeout(url, 'https://quote.eastmoney.com/');
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: { tc?: unknown } | null };
    const tc = toNullableNumber(payload.data?.tc);
    return tc ?? 0;
  } catch {
    return null;
  }
}

async function fetchIndexAmount(secid: string): Promise<number | null> {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fltt=2&invt=2&fields=f48`;
  try {
    const res = await fetchWithTimeout(url, 'https://quote.eastmoney.com/');
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: { f48?: unknown } | null };
    return toNullableNumber(payload.data?.f48);
  } catch {
    return null;
  }
}

function isMarketBreadth(value: unknown): value is MarketBreadth {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.up === 'number' && typeof v.down === 'number' && v.source === 'eastmoney';
}

/**
 * Fetch whole-market breadth: advancing/declining/flat counts (Shanghai +
 * Shenzhen), limit-up/limit-down counts, and two-market turnover.
 */
export async function getMarketBreadth(date?: string): Promise<Sourced<MarketBreadth>> {
  const cacheParams = { date: date ?? '' };
  const cached = readCache(BREADTH_CACHE_ENDPOINT, cacheParams, BREADTH_TTL_MS);
  if (cached && isMarketBreadth(cached.data.breadth)) {
    return { value: cached.data.breadth, source: 'eastmoney', sourceUrl: cached.url };
  }

  if (!breadthCircuit.available()) {
    throw new Error('Eastmoney market breadth temporarily unavailable (circuit open)');
  }

  const tradeDate = (date && /^\d{8}$/.test(date) ? date : shanghaiDate().replace(/-/g, ''));

  try {
    const { up, down, flat } = await fetchBreadthCounts();
    const [limitUp, limitDown, shAmount, szAmount] = await Promise.all([
      fetchLimitCount('ZT', tradeDate),
      fetchLimitCount('DT', tradeDate),
      fetchIndexAmount(SH_INDEX_SECID),
      fetchIndexAmount(SZ_INDEX_SECID),
    ]);

    const breadth: MarketBreadth = {
      tradeDate: `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`,
      up,
      down,
      flat,
      total: up + down + flat,
      limitUp,
      limitDown,
      shAmount,
      szAmount,
      turnover: shAmount === null && szAmount === null ? null : (shAmount ?? 0) + (szAmount ?? 0),
      source: 'eastmoney',
    };

    breadthCircuit.success();
    const sourceUrl = 'https://quote.eastmoney.com/center/gridlist.html';
    writeCache(BREADTH_CACHE_ENDPOINT, cacheParams, { breadth }, sourceUrl);
    return { value: breadth, source: 'eastmoney', sourceUrl };
  } catch (error) {
    breadthCircuit.failure(errorMessage(error));
    throw error;
  }
}

function parseMarginRow(row: Record<string, unknown>): MarginRow | null {
  const date = toStringOrNull(row.DIM_DATE);
  if (!date) return null;
  return {
    date,
    financingBalance: toNullableNumber(row.RZYE),
    marginBalance: toNullableNumber(row.RZRQYE),
    financingBuy: toNullableNumber(row.RZMRE),
    financingRepay: toNullableNumber(row.RZCHE),
    financingNet: toNullableNumber(row.RZJME),
    securitiesLendingBalance: toNullableNumber(row.RQYE),
    financingBalanceRatio: toNullableNumber(row.RZYEZB),
    source: 'eastmoney',
  };
}

function isMarginRowArray(value: unknown): value is MarginRow[] {
  return (
    Array.isArray(value) &&
    value.every((r) => {
      if (typeof r !== 'object' || r === null) return false;
      const v = r as Record<string, unknown>;
      return typeof v.date === 'string' && v.source === 'eastmoney';
    })
  );
}

/**
 * Fetch the daily margin-financing (两融) history, newest first. Eastmoney
 * publishes this with a T-1/T-2 lag.
 */
export async function getMarginData(days: number = 10): Promise<Sourced<MarginData>> {
  const pageSize = Math.min(Math.max(Number.isFinite(days) && days > 0 ? Math.floor(days) : 10, 1), 60);
  const cacheParams = { days: pageSize };

  const cached = readCache(MARGIN_CACHE_ENDPOINT, cacheParams, TTL_1H);
  if (cached && isMarginRowArray(cached.data.rows)) {
    const rows = cached.data.rows;
    return { value: { rows, latest: rows[0] ?? null }, source: 'eastmoney', sourceUrl: cached.url };
  }

  if (!marginCircuit.available()) {
    throw new Error('Eastmoney margin data temporarily unavailable (circuit open)');
  }

  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get' +
    '?reportName=RPTA_RZRQ_LSHJ&columns=ALL&sortColumns=dim_date&sortTypes=-1' +
    `&pageSize=${pageSize}&pageNumber=1`;

  try {
    const res = await fetchWithTimeout(url, 'https://data.eastmoney.com/');
    if (!res.ok) throw new Error(`Eastmoney margin HTTP ${res.status}`);
    const payload = (await res.json()) as { result?: { data?: unknown } | null };
    const list = payload.result?.data;
    if (!Array.isArray(list)) throw new Error('Eastmoney margin returned no data');

    const rows = (list as unknown[])
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map(parseMarginRow)
      .filter((row): row is MarginRow => row !== null);

    marginCircuit.success();
    writeCache(MARGIN_CACHE_ENDPOINT, cacheParams, { rows }, url);
    return { value: { rows, latest: rows[0] ?? null }, source: 'eastmoney', sourceUrl: url };
  } catch (error) {
    marginCircuit.failure(errorMessage(error));
    throw error;
  }
}
