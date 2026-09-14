import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_15M, TTL_24H } from './utils.js';
import { decodeGbk, getIndexBars, resolveIndex, type IndexBar } from './domestic-index-api.js';
import { getFundNav, getFundQuotes, normalizeFundCode } from './domestic-fund-api.js';
import { getIndexEtfMap } from './index-etf-map-api.js';

// Evaluates and compares the ETFs that track a given index (or a caller-supplied
// set of ETF codes) on the dimensions that matter for fund selection: scale,
// secondary-market liquidity, tracking quality versus the benchmark, live
// premium/discount, and fees. Deliberately independent of ./api.js; key-less
// Eastmoney endpoints only.

export interface EtfMetrics {
  code: string;
  name: string;
  company: string | null;
  // Latest NAV / exchange price / NAV-based premium (percent).
  nav: number | null;
  navDate: string | null;
  price: number | null;
  premiumPercent: number | null;
  // Fund size (净资产规模) in CNY, from push2 f20/f21.
  scale: number | null;
  // Liquidity over the evaluation window.
  avgAmount: number | null;
  avgVolume: number | null;
  avgTurnoverPercent: number | null;
  // Tracking quality versus the benchmark index, over the same window.
  trackingError: number | null;
  trackingDifference: number | null;
  correlation: number | null;
  dataPoints: number;
  // Best-effort fees / target parsed from the fund profile page.
  managementFeePercent: number | null;
  custodyFeePercent: number | null;
  trackingTarget: string | null;
}

export interface EtfEvaluation {
  query: string;
  indexSymbol: string | null;
  indexName: string | null;
  windowDays: number;
  startDate: string;
  endDate: string;
  etfs: EtfMetrics[];
  source: 'eastmoney';
}

export interface EtfEvaluationOptions {
  index?: string;
  codes?: string[];
  windowDays?: number;
  limit?: number;
  includeFees?: boolean;
}

export interface SourcedEvaluation {
  value: EtfEvaluation;
  source: 'eastmoney';
  sourceUrl: string;
}

export interface EtfFeeInfo {
  managementFeePercent: number | null;
  custodyFeePercent: number | null;
  trackingTarget: string | null;
  company: string | null;
}

interface SeriesPoint {
  date: string;
  value: number;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EVAL_CACHE_ENDPOINT = '/domestic-index/etf-eval/';
const BARS_CACHE_ENDPOINT = '/domestic-index/etf-bars/';
const SCALE_CACHE_ENDPOINT = '/domestic-index/etf-scale/';
const FEE_CACHE_ENDPOINT = '/domestic-fund/etf-fee/';

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const MIN_WINDOW_DAYS = 20;
const MAX_WINDOW_DAYS = 250;

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
        logger.warn(`[etf-eval] ${label} circuit opened for ${COOLDOWN_MS / 1000}s`, { message });
      }
    },
  };
}

const evalCircuit = createCircuit('eval');
const barsCircuit = createCircuit('bars');
const scaleCircuit = createCircuit('scale');
const feeCircuit = createCircuit('fee');

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Exchange ETFs live on SH (market 1) for 5xxxxx/6xxxxx codes and on SZ
// (market 0) otherwise. This is the one mapping resolveIndex cannot give us,
// because its bare-code heuristic defaults 159919 (a Shenzhen ETF) to SH.
export function etfSecid(code: string): string {
  const normalized = normalizeFundCode(code);
  const market = normalized.startsWith('5') || normalized.startsWith('6') ? '1' : '0';
  return `${market}.${normalized}`;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function stddevSample(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - avg) * (v - avg), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const ma = a.slice(0, n).reduce((acc, v) => acc + v, 0) / n;
  const mb = b.slice(0, n).reduce((acc, v) => acc + v, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

export interface TrackingResult {
  trackingError: number | null;
  trackingDifference: number | null;
  correlation: number | null;
  dataPoints: number;
}

// Align two daily series by date, take simple returns on the overlapping days,
// then measure the dispersion (annualized) and cumulative gap of the excess
// return, plus the return correlation.
export function computeTracking(etf: SeriesPoint[], index: SeriesPoint[]): TrackingResult {
  const indexByDate = new Map(index.map((p) => [p.date, p.value]));
  const sorted = [...etf].sort((a, b) => a.date.localeCompare(b.date));

  const etfReturns: number[] = [];
  const indexReturns: number[] = [];
  let prevEtf: number | null = null;
  let prevIndex: number | null = null;
  for (const point of sorted) {
    const indexValue = indexByDate.get(point.date);
    if (prevEtf !== null && prevIndex !== null && indexValue !== undefined && prevEtf !== 0 && prevIndex !== 0) {
      etfReturns.push(point.value / prevEtf - 1);
      indexReturns.push(indexValue / prevIndex - 1);
    }
    if (indexValue !== undefined) prevIndex = indexValue;
    prevEtf = point.value;
  }

  const dataPoints = etfReturns.length;
  if (dataPoints < 2) {
    return { trackingError: null, trackingDifference: null, correlation: null, dataPoints };
  }

  const diffs = etfReturns.map((r, i) => r - indexReturns[i]);
  const diffStd = stddevSample(diffs);
  const trackingError = diffStd === null ? null : diffStd * Math.sqrt(252) * 100;

  let etfCum = 1;
  let indexCum = 1;
  for (let i = 0; i < dataPoints; i += 1) {
    etfCum *= 1 + etfReturns[i];
    indexCum *= 1 + indexReturns[i];
  }
  const trackingDifference = (etfCum - indexCum) * 100;

  return {
    trackingError,
    trackingDifference,
    correlation: pearson(etfReturns, indexReturns),
    dataPoints,
  };
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function windowRange(windowDays: number): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

function parseKlineRow(row: unknown): IndexBar | null {
  if (typeof row !== 'string') return null;
  const parts = row.split(',');
  if (parts.length < 7) return null;
  return {
    date: parts[0],
    open: Number(parts[1]) || 0,
    close: Number(parts[2]) || 0,
    high: Number(parts[3]) || 0,
    low: Number(parts[4]) || 0,
    volume: Number(parts[5]) || 0,
    amount: Number(parts[6]) || 0,
    changePercent: Number(parts[8]) || 0,
  };
}

function isIndexBarArray(value: unknown): value is IndexBar[] {
  return (
    Array.isArray(value) &&
    value.every(
      (bar) =>
        typeof bar === 'object' &&
        bar !== null &&
        typeof (bar as Record<string, unknown>).date === 'string',
    )
  );
}

// Daily price bars for a single ETF, used for liquidity (amount/volume) and as a
// fallback return series when NAV history is unavailable.
async function fetchEtfBars(code: string, startDate: string, endDate: string): Promise<IndexBar[]> {
  const secid = etfSecid(code);
  const cacheParams = { secid, start: startDate, end: endDate };
  const cached = readCache(BARS_CACHE_ENDPOINT, cacheParams, TTL_15M);
  if (cached && isIndexBarArray(cached.data.bars)) return cached.data.bars;

  if (!barsCircuit.available()) {
    throw new Error('Eastmoney ETF kline temporarily unavailable (circuit open)');
  }

  const beg = startDate.replace(/-/g, '');
  const end = endDate.replace(/-/g, '');
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    `?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6` +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    `&klt=101&fqt=0&beg=${beg}&end=${end}`;

  try {
    const res = await fetchWithTimeout(url, 'https://quote.eastmoney.com/');
    if (!res.ok) throw new Error(`Eastmoney ETF kline HTTP ${res.status}`);
    const payload = (await res.json()) as { data?: { klines?: unknown } | null };
    const klines = payload.data?.klines;
    if (klines === undefined || klines === null) {
      throw new Error(`Eastmoney ETF kline returned no data for ${code}`);
    }
    if (!Array.isArray(klines)) throw new Error('Eastmoney ETF kline returned invalid data');
    const bars = klines.map(parseKlineRow).filter((bar): bar is IndexBar => bar !== null);
    barsCircuit.success();
    writeCache(BARS_CACHE_ENDPOINT, cacheParams, { bars }, url);
    return bars;
  } catch (error) {
    barsCircuit.failure(errorMessage(error));
    throw error;
  }
}

function isScaleMap(value: unknown): value is Record<string, number | null> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => v === null || typeof v === 'number',
  );
}

// Batch fund size (净资产规模) via push2 f20 (falling back to f21). f116 is not
// usable here: Eastmoney returns "-" for ETFs.
async function fetchScales(codes: string[]): Promise<Record<string, number | null>> {
  if (codes.length === 0) return {};
  const secids = codes.map(etfSecid).join(',');
  const cacheParams = { codes: [...codes].sort().join(',') };
  const cached = readCache(SCALE_CACHE_ENDPOINT, cacheParams, TTL_15M);
  if (cached && isScaleMap(cached.data.scales)) return cached.data.scales;

  if (!scaleCircuit.available()) {
    throw new Error('Eastmoney ETF scale temporarily unavailable (circuit open)');
  }

  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2' +
    `&fields=f12,f13,f14,f2,f3,f20,f21&secids=${secids}`;

  try {
    const res = await fetchWithTimeout(url, 'https://quote.eastmoney.com/');
    if (!res.ok) throw new Error(`Eastmoney ETF scale HTTP ${res.status}`);
    const payload = (await res.json()) as { data?: { diff?: unknown } | null };
    const diff = payload.data?.diff;
    if (!Array.isArray(diff)) throw new Error('Eastmoney ETF scale returned no data');

    const scales: Record<string, number | null> = {};
    for (const row of diff) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      const code = normalizeFundCode(String(r.f12 ?? ''));
      if (!code) continue;
      scales[code] = toNullableNumber(r.f20) ?? toNullableNumber(r.f21);
    }
    scaleCircuit.success();
    writeCache(SCALE_CACHE_ENDPOINT, cacheParams, { scales }, url);
    return scales;
  } catch (error) {
    scaleCircuit.failure(errorMessage(error));
    throw error;
  }
}

// Parse the "fund basic profile" (基金基本概况) page. The table rows are
// `<th>管理费率</th><td>0.15%（每年）</td>` pairs; keeping this pure makes it
// unit-testable without emulating GBK bytes.
export function parseJbgk(html: string): EtfFeeInfo {
  const cell = (label: string): string | null => {
    const match = html.match(new RegExp(`<th>\\s*${label}\\s*</th>\\s*<td>([^<]*)</td>`));
    return match ? match[1].trim() : null;
  };
  const fee = (label: string): number | null => {
    const text = cell(label);
    if (text === null) return null;
    const parsed = Number(text.replace(/[^\d.]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    managementFeePercent: fee('管理费率'),
    custodyFeePercent: fee('托管费率'),
    trackingTarget: cell('跟踪标的'),
    company: cell('管理人'),
  };
}

async function fetchFeeInfo(code: string): Promise<EtfFeeInfo> {
  const cacheParams = { code };
  const cached = readCache(FEE_CACHE_ENDPOINT, cacheParams, TTL_24H);
  if (cached && typeof cached.data.fee === 'object' && cached.data.fee !== null) {
    return cached.data.fee as unknown as EtfFeeInfo;
  }

  if (!feeCircuit.available()) {
    throw new Error('Eastmoney fund profile temporarily unavailable (circuit open)');
  }

  const url = `https://fundf10.eastmoney.com/jbgk_${code}.html`;
  try {
    const res = await fetchWithTimeout(url, `https://fund.eastmoney.com/${code}.html`);
    if (!res.ok) throw new Error(`Eastmoney fund profile HTTP ${res.status}`);
    const html = decodeGbk(await res.arrayBuffer());
    const info = parseJbgk(html);
    feeCircuit.success();
    writeCache(FEE_CACHE_ENDPOINT, cacheParams, { fee: info }, url);
    return info;
  } catch (error) {
    feeCircuit.failure(errorMessage(error));
    throw error;
  }
}

function toSeriesPoints(points: { date: string; nav: number }[]): SeriesPoint[] {
  return points.map((p) => ({ date: p.date, value: p.nav }));
}

function barsToSeries(bars: IndexBar[]): SeriesPoint[] {
  return bars.map((b) => ({ date: b.date, value: b.close }));
}

export async function getEtfEvaluation(opts: EtfEvaluationOptions): Promise<SourcedEvaluation> {
  const indexQuery = opts.index?.trim() || '';
  const inputCodes = (opts.codes ?? []).map(normalizeFundCode).filter((c) => c.length > 0);
  if (!indexQuery && inputCodes.length === 0) {
    throw new Error('Provide an index name/code or at least one ETF code');
  }

  const windowDays = clamp(
    Number.isFinite(opts.windowDays) && (opts.windowDays as number) > 0
      ? Math.floor(opts.windowDays as number)
      : DEFAULT_WINDOW_DAYS,
    MIN_WINDOW_DAYS,
    MAX_WINDOW_DAYS,
  );
  const limit = clamp(
    Number.isFinite(opts.limit) && (opts.limit as number) > 0
      ? Math.floor(opts.limit as number)
      : DEFAULT_LIMIT,
    1,
    MAX_LIMIT,
  );
  const includeFees = opts.includeFees !== false;
  const { startDate, endDate } = windowRange(windowDays);

  const cacheParams = {
    index: indexQuery,
    codes: [...inputCodes].sort().join(','),
    window: windowDays,
    limit,
    fees: includeFees ? 1 : 0,
  };

  const cached = readCache(EVAL_CACHE_ENDPOINT, cacheParams, TTL_15M);
  if (cached && typeof cached.data.evaluation === 'object' && cached.data.evaluation !== null) {
    return {
      value: cached.data.evaluation as unknown as EtfEvaluation,
      source: 'eastmoney',
      sourceUrl: cached.url,
    };
  }

  if (!evalCircuit.available()) {
    throw new Error('ETF evaluation temporarily unavailable (circuit open)');
  }

  let indexDef = indexQuery ? resolveIndex(indexQuery) : undefined;
  let codes = inputCodes;
  let queryLabel = indexQuery || inputCodes.join(',');
  let indexName = indexDef?.name ?? null;
  let indexSymbol = indexDef?.symbol ?? null;

  let sourceUrl = '';

  try {
    if (codes.length === 0) {
      const map = await getIndexEtfMap(indexQuery, limit);
      codes = map.value.etfs.map((etf) => etf.code).slice(0, limit);
      queryLabel = map.value.query;
      indexName = map.value.indexName;
      indexSymbol = map.value.indexSymbol;
      sourceUrl = map.sourceUrl;
    }

    if (codes.length === 0) {
      const empty: EtfEvaluation = {
        query: queryLabel,
        indexSymbol,
        indexName,
        windowDays,
        startDate,
        endDate,
        etfs: [],
        source: 'eastmoney',
      };
      evalCircuit.success();
      writeCache(EVAL_CACHE_ENDPOINT, cacheParams, { evaluation: empty }, sourceUrl);
      return { value: empty, source: 'eastmoney', sourceUrl };
    }

    // Quotations and scale are batched; fees and per-ETF price bars are not.
    const [quotes, scales] = await Promise.all([
      getFundQuotes(codes)
        .then((res) => {
          sourceUrl = sourceUrl || res.sourceUrl;
          return res.value;
        })
        .catch((error) => {
          logger.warn(`[etf-eval] quotes failed: ${errorMessage(error)}`);
          return [];
        }),
      fetchScales(codes).catch((error) => {
        logger.warn(`[etf-eval] scale failed: ${errorMessage(error)}`);
        return {} as Record<string, number | null>;
      }),
    ]);

    const feeMap = new Map<string, EtfFeeInfo>();
    if (includeFees) {
      const feeResults = await Promise.all(
        codes.map((code) =>
          fetchFeeInfo(code)
            .then((fee) => ({ code, fee }))
            .catch(() => ({ code, fee: null })),
        ),
      );
      for (const { code, fee } of feeResults) {
        if (fee) feeMap.set(code, fee);
      }
    }

    // Without an explicit index, best-effort derive it from an ETF's disclosed
    // tracking target so tracking metrics can still be computed.
    if (!indexDef) {
      for (const fee of feeMap.values()) {
        const derived = fee.trackingTarget ? resolveIndex(fee.trackingTarget) : undefined;
        if (derived) {
          indexDef = derived;
          indexName = derived.name;
          indexSymbol = derived.symbol;
          break;
        }
      }
    }

    let indexSeries: SeriesPoint[] = [];
    if (indexDef) {
      const indexBars = await getIndexBars(indexDef.symbol, 'day', startDate, endDate)
        .then((res) => {
          sourceUrl = sourceUrl || res.sourceUrl;
          return res.value;
        })
        .catch((error) => {
          logger.warn(`[etf-eval] index bars failed: ${errorMessage(error)}`);
          return [] as IndexBar[];
        });
      indexSeries = barsToSeries(indexBars);
    }

    const quoteByCode = new Map(quotes.map((q) => [q.code, q]));
    const etfs: EtfMetrics[] = [];

    for (const code of codes) {
      const [barsResult, navResult] = await Promise.all([
        fetchEtfBars(code, startDate, endDate).catch((error) => {
          logger.warn(`[etf-eval] ETF bars failed for ${code}: ${errorMessage(error)}`);
          return [] as IndexBar[];
        }),
        getFundNav(code, startDate, endDate, windowDays + 20)
          .then((res) => res.value)
          .catch((error) => {
            logger.warn(`[etf-eval] ETF NAV failed for ${code}: ${errorMessage(error)}`);
            return [];
          }),
      ]);

      const quote = quoteByCode.get(code);
      const scale = scales[code] ?? null;
      const amounts = barsResult.map((b) => b.amount).filter((v) => v > 0);
      const volumes = barsResult.map((b) => b.volume).filter((v) => v > 0);
      const avgAmount = mean(amounts);
      const avgVolume = mean(volumes);
      const avgTurnoverPercent =
        scale && avgAmount !== null && scale > 0 ? (avgAmount / scale) * 100 : null;

      const tracking = computeTracking(
        navResult.length >= 2 ? toSeriesPoints(navResult) : barsToSeries(barsResult),
        indexSeries,
      );
      const fee = feeMap.get(code);

      etfs.push({
        code,
        name: quote?.name ?? code,
        company: fee?.company ?? null,
        nav: quote?.nav ?? null,
        navDate: quote?.navDate ?? null,
        price: quote?.price ?? null,
        premiumPercent: quote?.premiumPercent ?? null,
        scale,
        avgAmount,
        avgVolume,
        avgTurnoverPercent,
        trackingError: tracking.trackingError,
        trackingDifference: tracking.trackingDifference,
        correlation: tracking.correlation,
        dataPoints: tracking.dataPoints,
        managementFeePercent: fee?.managementFeePercent ?? null,
        custodyFeePercent: fee?.custodyFeePercent ?? null,
        trackingTarget: fee?.trackingTarget ?? null,
      });
    }

    const evaluation: EtfEvaluation = {
      query: queryLabel,
      indexSymbol,
      indexName,
      windowDays,
      startDate,
      endDate,
      etfs,
      source: 'eastmoney',
    };

    evalCircuit.success();
    const resolvedUrl = sourceUrl || 'https://fund.eastmoney.com/';
    writeCache(EVAL_CACHE_ENDPOINT, cacheParams, { evaluation }, resolvedUrl);
    return { value: evaluation, source: 'eastmoney', sourceUrl: resolvedUrl };
  } catch (error) {
    evalCircuit.failure(errorMessage(error));
    throw error;
  }
}
