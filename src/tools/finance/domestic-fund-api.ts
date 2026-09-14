import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_15M, TTL_1H } from './utils.js';

// Independent client for China domestic fund / ETF data. Deliberately does NOT
// import ./api.js (which is hardwired to financialdatasets.ai); uses global
// fetch against key-less Eastmoney endpoints.

export interface FundQuote {
  code: string;
  name: string;
  // Net asset value (open-end funds and ETFs both report this).
  nav: number | null;
  accNav: number | null;
  navChangePercent: number | null;
  navDate: string | null;
  // Exchange-traded price (ETFs/LOFs only; null for open-end funds).
  price: number | null;
  priceChangePercent: number | null;
  quoteDate: string | null;
  // NAV-based premium/discount for exchange-traded funds: (price - nav) / nav * 100.
  premiumPercent: number | null;
  source: 'eastmoney';
}

export interface FundNavPoint {
  date: string;
  nav: number;
  accNav: number;
  changePercent: number | null;
}

export interface Sourced<T> {
  value: T;
  source: 'eastmoney';
  sourceUrl: string;
}

export interface FundHolding {
  code: string;
  name: string;
  // Share of net asset value, in percent (e.g. 5.23 means 5.23%).
  weightPercent: number | null;
  // 1 = Shanghai, 2 = Shenzhen.
  market: number | null;
  // 增持 / 减持 / 新增 / 不变
  changeType: string | null;
  changePercent: number | null;
  industry: string | null;
}

export interface FundHoldings {
  code: string;
  // Reporting period (报告期), e.g. "2026-06-30".
  reportDate: string | null;
  stocks: FundHolding[];
  bondCount: number;
  fundOfFundCount: number;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const QUOTES_CACHE_ENDPOINT = '/domestic-fund/quotes/';
const NAV_CACHE_ENDPOINT = '/domestic-fund/nav/';
const HOLDINGS_CACHE_ENDPOINT = '/domestic-fund/holdings/';

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;
const NAV_PAGE_SIZE_DEFAULT = 120;
const NAV_PAGE_SIZE_MAX = 500;

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
        logger.warn(`[domestic-fund] ${label} circuit opened for ${COOLDOWN_MS / 1000}s`, { message });
      }
    },
  };
}

const quotesCircuit = createCircuit('quotes');
const navCircuit = createCircuit('nav');
const holdingsCircuit = createCircuit('holdings');

function getTimeoutMs(): number {
  const raw = Number(process.env.DOMESTIC_FUND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function getUserAgent(): string {
  return process.env.DOMESTIC_FUND_UA || DEFAULT_UA;
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

export function normalizeFundCode(value: string): string {
  return value.trim().replace(/^(sh|sz|bj)/i, '').replace(/\D/g, '');
}

function isFundQuote(value: unknown): value is FundQuote {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && v.source === 'eastmoney';
}

function isFundQuoteArray(value: unknown): value is FundQuote[] {
  return Array.isArray(value) && value.every(isFundQuote);
}

function isFundNavPointArray(value: unknown): value is FundNavPoint[] {
  return (
    Array.isArray(value) &&
    value.every((p) => {
      if (typeof p !== 'object' || p === null) return false;
      const v = p as Record<string, unknown>;
      return typeof v.date === 'string' && typeof v.nav === 'number';
    })
  );
}

function parseQuote(row: Record<string, unknown>): FundQuote {
  const code = normalizeFundCode(String(row.FCODE ?? ''));
  const nav = toNullableNumber(row.NAV);
  const price = toNullableNumber(row.NEWPRICE);
  // Open-end funds report '0' or '-' for the exchange price; normalize to null.
  const tradedPrice = price && price !== 0 ? price : null;
  const premiumPercent =
    tradedPrice !== null && nav !== null && nav !== 0
      ? ((tradedPrice - nav) / nav) * 100
      : null;
  return {
    code,
    name: toStringOrNull(row.SHORTNAME) ?? code,
    nav,
    accNav: toNullableNumber(row.ACCNAV),
    navChangePercent: toNullableNumber(row.NAVCHGRT),
    navDate: toStringOrNull(row.PDATE),
    // Only ETFs/LOFs expose an exchange-traded price; open-end funds report '0'
    // or '-' here, which is normalized to null.
    price: tradedPrice,
    priceChangePercent: tradedPrice !== null ? toNullableNumber(row.CHANGERATIO) : null,
    quoteDate: tradedPrice !== null ? toStringOrNull(row.HQDATE) : null,
    premiumPercent,
    source: 'eastmoney',
  };
}

/**
 * Fetch real-time NAV (and, for ETFs, exchange price) for one or more fund
 * codes in a single batched request.
 */
export async function getFundQuotes(codes: string[]): Promise<Sourced<FundQuote[]>> {
  const normalized = codes.map(normalizeFundCode).filter((c) => c.length > 0);
  if (normalized.length === 0) throw new Error('At least one fund code is required');

  const cacheParams = { codes: [...normalized].sort().join(',') };
  const cached = readCache(QUOTES_CACHE_ENDPOINT, cacheParams, TTL_15M);
  if (cached && isFundQuoteArray(cached.data.quotes)) {
    return { value: cached.data.quotes, source: 'eastmoney', sourceUrl: cached.url };
  }

  if (!quotesCircuit.available()) {
    throw new Error('Eastmoney fund quotes temporarily unavailable (circuit open)');
  }

  const url =
    'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo' +
    `?pageIndex=1&pageSize=${Math.max(normalized.length, 1)}` +
    '&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=dexter' +
    `&Fcodes=${normalized.join(',')}`;

  try {
    const res = await fetchWithTimeout(url, 'https://fund.eastmoney.com/');
    if (!res.ok) throw new Error(`Eastmoney fund quotes HTTP ${res.status}`);
    const payload = (await res.json()) as { Datas?: unknown; ErrCode?: number };
    if (!Array.isArray(payload.Datas)) throw new Error('Eastmoney fund quotes returned no data');

    const quotes = (payload.Datas as unknown[])
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map(parseQuote);

    quotesCircuit.success();
    writeCache(QUOTES_CACHE_ENDPOINT, cacheParams, { quotes }, url);
    return { value: quotes, source: 'eastmoney', sourceUrl: url };
  } catch (error) {
    quotesCircuit.failure(errorMessage(error));
    throw error;
  }
}

/**
 * Fetch the historical NAV series for a fund, optionally bounded by date.
 */
export async function getFundNav(
  code: string,
  startDate?: string,
  endDate?: string,
  limit?: number,
): Promise<Sourced<FundNavPoint[]>> {
  const normalized = normalizeFundCode(code);
  if (!normalized) throw new Error('A fund code is required');

  const pageSize = Math.min(
    Math.max(Number.isFinite(limit) && (limit as number) > 0 ? (limit as number) : NAV_PAGE_SIZE_DEFAULT, 1),
    NAV_PAGE_SIZE_MAX,
  );
  const cacheParams = {
    code: normalized,
    start: startDate ?? '',
    end: endDate ?? '',
    limit: pageSize,
  };

  const cached = readCache(NAV_CACHE_ENDPOINT, cacheParams, TTL_1H);
  if (cached && isFundNavPointArray(cached.data.points)) {
    return { value: cached.data.points, source: 'eastmoney', sourceUrl: cached.url };
  }

  if (!navCircuit.available()) {
    throw new Error('Eastmoney fund NAV temporarily unavailable (circuit open)');
  }

  let url =
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${normalized}` +
    `&pageIndex=1&pageSize=${pageSize}`;
  if (startDate) url += `&startDate=${startDate}`;
  if (endDate) url += `&endDate=${endDate}`;

  try {
    const res = await fetchWithTimeout(url, 'https://fundf10.eastmoney.com/');
    if (!res.ok) throw new Error(`Eastmoney fund NAV HTTP ${res.status}`);
    const payload = (await res.json()) as { Data?: { LSJZList?: unknown } | null };
    const list = payload.Data?.LSJZList;
    if (!Array.isArray(list)) throw new Error('Eastmoney fund NAV returned no data');

    const points: FundNavPoint[] = [];
    for (const row of list) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      const nav = toNullableNumber(r.DWJZ);
      const date = toStringOrNull(r.FSRQ);
      if (nav === null || date === null) continue;
      points.push({
        date,
        nav,
        accNav: toNullableNumber(r.LJJZ) ?? nav,
        changePercent: toNullableNumber(r.JZZZL),
      });
    }

    navCircuit.success();
    writeCache(NAV_CACHE_ENDPOINT, cacheParams, { points }, url);
    return { value: points, source: 'eastmoney', sourceUrl: url };
  } catch (error) {
    navCircuit.failure(errorMessage(error));
    throw error;
  }
}

function isFundHoldings(value: unknown): value is FundHoldings {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && Array.isArray(v.stocks);
}

function parseHolding(row: Record<string, unknown>): FundHolding | null {
  const code = normalizeFundCode(String(row.GPDM ?? ''));
  const name = toStringOrNull(row.GPJC);
  if (!code || !name) return null;
  return {
    code,
    name,
    weightPercent: toNullableNumber(row.JZBL),
    market: toNullableNumber(row.TEXCH),
    changeType: toStringOrNull(row.PCTNVCHGTYPE),
    changePercent: toNullableNumber(row.PCTNVCHG),
    industry: toStringOrNull(row.INDEXNAME),
  };
}

/**
 * Fetch a fund's disclosed top holdings (前十大重仓股) for the latest period.
 */
export async function getFundHoldings(code: string): Promise<Sourced<FundHoldings>> {
  const normalized = normalizeFundCode(code);
  if (!normalized) throw new Error('A fund code is required');

  const cacheParams = { code: normalized };
  const cached = readCache(HOLDINGS_CACHE_ENDPOINT, cacheParams, TTL_1H);
  if (cached && isFundHoldings(cached.data.holdings)) {
    return { value: cached.data.holdings, source: 'eastmoney', sourceUrl: cached.url };
  }

  if (!holdingsCircuit.available()) {
    throw new Error('Eastmoney fund holdings temporarily unavailable (circuit open)');
  }

  const url =
    'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition' +
    `?FCODE=${normalized}&deviceid=dexter&plat=Android&product=EFund&Version=1&appType=ttjj`;

  try {
    const res = await fetchWithTimeout(url, 'https://fundf10.eastmoney.com/');
    if (!res.ok) throw new Error(`Eastmoney fund holdings HTTP ${res.status}`);
    const payload = (await res.json()) as {
      Datas?: { fundStocks?: unknown; fundboods?: unknown; fundfofs?: unknown } | null;
      Expansion?: unknown;
    };
    const stocksRaw = payload.Datas?.fundStocks;
    if (!Array.isArray(stocksRaw)) throw new Error('Eastmoney fund holdings returned no data');

    const stocks = (stocksRaw as unknown[])
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map(parseHolding)
      .filter((holding): holding is FundHolding => holding !== null);

    const holdings: FundHoldings = {
      code: normalized,
      reportDate: toStringOrNull(payload.Expansion),
      stocks,
      bondCount: Array.isArray(payload.Datas?.fundboods)
        ? (payload.Datas!.fundboods as unknown[]).length
        : 0,
      fundOfFundCount: Array.isArray(payload.Datas?.fundfofs)
        ? (payload.Datas!.fundfofs as unknown[]).length
        : 0,
    };

    holdingsCircuit.success();
    writeCache(HOLDINGS_CACHE_ENDPOINT, cacheParams, { holdings }, url);
    return { value: holdings, source: 'eastmoney', sourceUrl: url };
  } catch (error) {
    holdingsCircuit.failure(errorMessage(error));
    throw error;
  }
}
