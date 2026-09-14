import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_15M } from './utils.js';
import { decodeGbk } from './domestic-index-api.js';
import { shanghaiDate } from './domestic-market-api.js';

// E10 — 龙虎榜 / 游资. Daily dragon-tiger board ranking (个股) and the
// seat-level (营业部/游资) trade ranking, plus the limit-up pool with 连板数.
// All key-less Eastmoney datacenter / push2ex endpoints.

export interface DragonTigerStock {
  code: string;
  name: string;
  market: string | null;
  close: number | null;
  changePercent: number | null;
  turnoverRate: number | null;
  buyAmount: number | null;
  sellAmount: number | null;
  netAmount: number | null;
  dealAmountRatio: number | null;
  netRatio: number | null;
  explanation: string | null;
}

export interface DragonTigerSeat {
  name: string;
  code: string | null;
  buyAmount: number | null;
  sellAmount: number | null;
  netAmount: number | null;
  stockCode: string;
  stockName: string;
  changePercent: number | null;
}

export interface DragonTigerData {
  tradeDate: string;
  stocks: DragonTigerStock[];
  seats: DragonTigerSeat[];
  source: 'eastmoney';
}

export interface LimitUpStock {
  code: string;
  name: string;
  market: string | null;
  price: number | null;
  changePercent: number | null;
  amount: number | null;
  turnoverRate: number | null;
  floatMarketCap: number | null;
  limitUpCount: number | null;
  firstLimitTime: string | null;
  lastLimitTime: string | null;
  openTimes: number | null;
  sealAmount: number | null;
  industry: string | null;
}

export interface LimitUpPool {
  tradeDate: string;
  total: number | null;
  stocks: LimitUpStock[];
  source: 'eastmoney';
}

export interface Sourced<T> {
  value: T;
  source: 'eastmoney';
  sourceUrl: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DATACENTER_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const ZT_POOL_URL = 'https://push2ex.eastmoney.com/getTopicZTPool';
const ZT_UT = '7eea3edcaed734bea9cbfc24409ed989';

const DRAGON_TIGER_CACHE_ENDPOINT = '/domestic-market/dragon-tiger/';
const LIMIT_UP_CACHE_ENDPOINT = '/domestic-market/limit-up/';

const DRAGON_TIGER_SOURCE_URL = 'https://data.eastmoney.com/stock/tradedetail.html';
const LIMIT_UP_SOURCE_URL = 'https://quote.eastmoney.com/ztb/detail';

const DRAGON_TIGER_TTL_MS = TTL_15M;
const LIMIT_UP_TTL_MS = 60_000;

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;
const DEFAULT_STOCK_LIMIT = 20;
const DEFAULT_SEAT_LIMIT = 15;
const MAX_LIMIT = 100;
const SEAT_FETCH_LIMIT = 200;

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
        logger.warn(`[dragon-tiger] ${label} circuit opened for ${COOLDOWN_MS / 1000}s`, { message });
      }
    },
  };
}

const dragonTigerCircuit = createCircuit('龙虎榜');
const limitUpCircuit = createCircuit('涨停池');

function getTimeoutMs(): number {
  const raw = Number(process.env.DOMESTIC_MARKET_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function getUserAgent(): string {
  return process.env.DOMESTIC_MARKET_UA || DEFAULT_UA;
}

async function fetchJson(url: string, referer: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': getUserAgent(), Referer: referer },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = decodeGbk(await res.arrayBuffer());
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeTradeDate(value: string | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function dataRows(payload: Record<string, unknown> | null): Record<string, unknown>[] {
  const result = payload?.result;
  if (!result || typeof result !== 'object') return [];
  const data = (result as Record<string, unknown>).data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

async function resolveLatestTradeDate(): Promise<string | null> {
  const url =
    `${DATACENTER_URL}?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=TRADE_DATE&source=WEB&client=WEB` +
    '&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=1&pageNumber=1';
  const rows = dataRows(await fetchJson(url, 'https://data.eastmoney.com/'));
  const raw = rows[0]?.TRADE_DATE;
  const text = typeof raw === 'string' ? raw.slice(0, 10) : null;
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function parseStock(row: Record<string, unknown>): DragonTigerStock | null {
  const code = toStringOrNull(row.SECURITY_CODE);
  const name = toStringOrNull(row.SECURITY_NAME_ABBR);
  if (!code || !name) return null;
  return {
    code,
    name,
    market: toStringOrNull(row.MARKET),
    close: toNullableNumber(row.CLOSE_PRICE),
    changePercent: toNullableNumber(row.CHANGE_RATE),
    turnoverRate: toNullableNumber(row.TURNOVERRATE),
    buyAmount: toNullableNumber(row.BILLBOARD_BUY_AMT),
    sellAmount: toNullableNumber(row.BILLBOARD_SELL_AMT),
    netAmount: toNullableNumber(row.BILLBOARD_NET_AMT),
    dealAmountRatio: toNullableNumber(row.DEAL_AMOUNT_RATIO),
    netRatio: toNullableNumber(row.DEAL_NET_RATIO),
    explanation: toStringOrNull(row.EXPLANATION) ?? toStringOrNull(row.EXPLAIN),
  };
}

function parseSeat(row: Record<string, unknown>): DragonTigerSeat | null {
  const name = toStringOrNull(row.OPERATEDEPT_NAME);
  const stockCode = toStringOrNull(row.SECURITY_CODE);
  const stockName = toStringOrNull(row.SECURITY_NAME_ABBR);
  if (!name || !stockCode || !stockName) return null;
  const buyAmount = toNullableNumber(row.BUY_TOTAL) ?? toNullableNumber(row.BUY_AMT_REAL);
  const sellAmount = toNullableNumber(row.SELL_TOTAL) ?? toNullableNumber(row.SELL_AMT_REAL);
  const netAmount =
    toNullableNumber(row.NET_BUY) ??
    (buyAmount !== null && sellAmount !== null ? buyAmount - sellAmount : null);
  return {
    name,
    code: toStringOrNull(row.OPERATEDEPT_CODE),
    buyAmount,
    sellAmount,
    netAmount,
    stockCode,
    stockName,
    changePercent: toNullableNumber(row.CHANGE_RATE),
  };
}

function isDragonTigerData(value: unknown): value is DragonTigerData {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.tradeDate === 'string' &&
    Array.isArray(rec.stocks) &&
    Array.isArray(rec.seats) &&
    rec.source === 'eastmoney'
  );
}

async function fetchTigerStocks(tradeDate: string, limit: number): Promise<DragonTigerStock[]> {
  const filter = encodeURIComponent(`(TRADE_DATE='${tradeDate}')`);
  const url =
    `${DATACENTER_URL}?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&source=WEB&client=WEB` +
    `&sortColumns=BILLBOARD_NET_AMT&sortTypes=-1&pageSize=${limit}&pageNumber=1&filter=${filter}`;
  const rows = dataRows(await fetchJson(url, 'https://data.eastmoney.com/'));
  return rows.map(parseStock).filter((row): row is DragonTigerStock => row !== null);
}

async function fetchTigerSeats(tradeDate: string, limit: number): Promise<DragonTigerSeat[]> {
  const filter = encodeURIComponent(`(TRADE_DATE='${tradeDate}')`);
  const url =
    `${DATACENTER_URL}?reportName=RPT_OPERATEDEPT_TRADE&columns=ALL` +
    `&sortColumns=BUY_TOTAL&sortTypes=-1&pageSize=${SEAT_FETCH_LIMIT}&pageNumber=1&filter=${filter}`;
  const rows = dataRows(await fetchJson(url, 'https://data.eastmoney.com/'));
  const seats = rows.map(parseSeat).filter((row): row is DragonTigerSeat => row !== null);
  seats.sort((a, b) => (b.netAmount ?? Number.NEGATIVE_INFINITY) - (a.netAmount ?? Number.NEGATIVE_INFINITY));
  return seats.slice(0, limit);
}

export async function getDragonTiger(
  date?: string,
  stockLimit = DEFAULT_STOCK_LIMIT,
  seatLimit = DEFAULT_SEAT_LIMIT,
): Promise<Sourced<DragonTigerData>> {
  const explicit = normalizeTradeDate(date);
  const stocksWanted = clamp(Math.floor(stockLimit) || DEFAULT_STOCK_LIMIT, 1, MAX_LIMIT);
  const seatsWanted = clamp(Math.floor(seatLimit) || DEFAULT_SEAT_LIMIT, 1, MAX_LIMIT);

  if (!explicit) {
    const latest = await resolveLatestTradeDate();
    if (!latest) throw new Error('Unable to resolve latest dragon-tiger trade date');
    return getDragonTiger(latest, stocksWanted, seatsWanted);
  }

  const cacheParams = { tradeDate: explicit, stocks: stocksWanted, seats: seatsWanted };
  const cached = readCache(DRAGON_TIGER_CACHE_ENDPOINT, cacheParams, DRAGON_TIGER_TTL_MS);
  if (cached && isDragonTigerData(cached.data.value)) {
    return { value: cached.data.value, source: 'eastmoney', sourceUrl: cached.url };
  }

  if (!dragonTigerCircuit.available()) {
    throw new Error('Eastmoney 龙虎榜 data temporarily unavailable (circuit open)');
  }

  try {
    const [stocks, seats] = await Promise.all([
      fetchTigerStocks(explicit, stocksWanted),
      fetchTigerSeats(explicit, seatsWanted),
    ]);
    const value: DragonTigerData = { tradeDate: explicit, stocks, seats, source: 'eastmoney' };
    dragonTigerCircuit.success();
    writeCache(DRAGON_TIGER_CACHE_ENDPOINT, cacheParams, { value }, DRAGON_TIGER_SOURCE_URL);
    return { value, source: 'eastmoney', sourceUrl: DRAGON_TIGER_SOURCE_URL };
  } catch (error) {
    dragonTigerCircuit.failure(errorMessage(error));
    throw error;
  }
}

function formatLimitTime(value: unknown): string | null {
  const num = toNullableNumber(value);
  if (num === null) return null;
  const digits = String(Math.floor(num)).padStart(6, '0');
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;
}

function parseLimitUpStock(row: Record<string, unknown>): LimitUpStock | null {
  const code = toStringOrNull(row.c);
  const name = toStringOrNull(row.n);
  if (!code || !name) return null;
  const price = toNullableNumber(row.p);
  return {
    code,
    name,
    market: toStringOrNull(row.m),
    price: price === null ? null : price / 1000,
    changePercent: toNullableNumber(row.zdp),
    amount: toNullableNumber(row.amount),
    turnoverRate: toNullableNumber(row.hs),
    floatMarketCap: toNullableNumber(row.ltsz),
    limitUpCount: toNullableNumber(row.lbc),
    firstLimitTime: formatLimitTime(row.fbt),
    lastLimitTime: formatLimitTime(row.lbt),
    openTimes: toNullableNumber(row.zbc),
    sealAmount: toNullableNumber(row.fund),
    industry: toStringOrNull(row.hybk),
  };
}

function isLimitUpPool(value: unknown): value is LimitUpPool {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.tradeDate === 'string' && Array.isArray(rec.stocks) && rec.source === 'eastmoney';
}

export async function getLimitUpPool(
  date?: string,
  limit = 30,
): Promise<Sourced<LimitUpPool>> {
  const day = normalizeTradeDate(date) ?? shanghaiDate();
  const wanted = clamp(Math.floor(limit) || 30, 1, MAX_LIMIT);
  const cacheParams = { tradeDate: day, limit: wanted };

  const cached = readCache(LIMIT_UP_CACHE_ENDPOINT, cacheParams, LIMIT_UP_TTL_MS);
  if (cached && isLimitUpPool(cached.data.value)) {
    return { value: cached.data.value, source: 'eastmoney', sourceUrl: cached.url };
  }

  if (!limitUpCircuit.available()) {
    throw new Error('Eastmoney 涨停池 temporarily unavailable (circuit open)');
  }

  const ymd = day.replace(/-/g, '');
  const url =
    `${ZT_POOL_URL}?ut=${ZT_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=${wanted}` +
    `&sort=fbt%3Aasc&date=${ymd}`;

  try {
    const payload = await fetchJson(url, 'https://quote.eastmoney.com/');
    const data = payload?.data;
    if (!data || typeof data !== 'object') throw new Error('Eastmoney 涨停池 returned no data');
    const rec = data as Record<string, unknown>;
    const pool = Array.isArray(rec.pool) ? (rec.pool as Record<string, unknown>[]) : [];
    const stocks = pool.map(parseLimitUpStock).filter((row): row is LimitUpStock => row !== null);
    const total = toNullableNumber(rec.tc);
    const value: LimitUpPool = { tradeDate: day, total, stocks, source: 'eastmoney' };
    limitUpCircuit.success();
    writeCache(LIMIT_UP_CACHE_ENDPOINT, cacheParams, { value }, LIMIT_UP_SOURCE_URL);
    return { value, source: 'eastmoney', sourceUrl: LIMIT_UP_SOURCE_URL };
  } catch (error) {
    limitUpCircuit.failure(errorMessage(error));
    throw error;
  }
}
