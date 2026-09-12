import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_15M, TTL_24H } from './utils.js';

// Independent client for China A-share index data. Deliberately does NOT import
// ./api.js (which is hardwired to financialdatasets.ai); uses global fetch.

export type IndexInterval = 'day' | 'week' | 'month';
export type IndexSource = 'eastmoney' | 'tencent';

export interface IndexDefinition {
  symbol: string;
  name: string;
  emSecid: string;
  txCode: string;
}

export interface IndexSnapshot {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  amount: number;
  amplitude?: number;
  timestamp: number;
  source: IndexSource;
}

export interface IndexBar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  changePercent: number;
}

export interface Sourced<T> {
  value: T;
  source: IndexSource;
  sourceUrl: string;
}

export const INDEX_CATALOG: IndexDefinition[] = [
  { symbol: '000001.SH', name: '上证综指', emSecid: '1.000001', txCode: 'sh000001' },
  { symbol: '399001.SZ', name: '深证成指', emSecid: '0.399001', txCode: 'sz399001' },
  { symbol: '399006.SZ', name: '创业板指', emSecid: '0.399006', txCode: 'sz399006' },
  { symbol: '000300.SH', name: '沪深300', emSecid: '1.000300', txCode: 'sh000300' },
  { symbol: '000905.SH', name: '中证500', emSecid: '1.000905', txCode: 'sh000905' },
  { symbol: '000688.SH', name: '科创50', emSecid: '1.000688', txCode: 'sh000688' },
  { symbol: '000852.SH', name: '中证1000', emSecid: '1.000852', txCode: 'sh000852' },
  { symbol: '000016.SH', name: '上证50', emSecid: '1.000016', txCode: 'sh000016' },
  { symbol: '000010.SH', name: '上证180', emSecid: '1.000010', txCode: 'sh000010' },
];

const INDEX_ALIASES: Record<string, string> = {
  上证指数: '000001.SH',
  沪指: '000001.SH',
  深成指: '399001.SZ',
};

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EM_SNAPSHOT_FIELDS = 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f169,f170,f171';
const EM_BATCH_FIELDS = 'f12,f13,f14,f2,f3,f4';
const EM_KLINE_FIELDS1 = 'f1,f2,f3,f4,f5,f6';
const EM_KLINE_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';

const KLT: Record<IndexInterval, number> = { day: 101, week: 102, month: 103 };

const SNAPSHOT_TTL_MS = 30_000;

// Cache reuses src/utils/cache.ts readCache/writeCache (signature fits: a
// symbol-keyed entry whose data object holds the parsed payload). Endpoints are
// namespaced so they never collide with financialdatasets cache keys.
const SNAPSHOT_CACHE_ENDPOINT = '/domestic-index/snapshot/';
const SNAPSHOTS_CACHE_ENDPOINT = '/domestic-index/snapshots/';
const BARS_CACHE_ENDPOINT = '/domestic-index/bars/';

const EM_FAILURE_THRESHOLD = 3;
const EM_COOLDOWN_MS = 45_000;

let emConsecutiveFailures = 0;
let emOpenUntil = 0;

function getTimeoutMs(): number {
  const raw = Number(process.env.DOMESTIC_INDEX_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function getUserAgent(): string {
  return process.env.DOMESTIC_INDEX_UA || DEFAULT_UA;
}

function eastmoneyAvailable(): boolean {
  return Date.now() >= emOpenUntil;
}

function recordEastmoneySuccess(): void {
  emConsecutiveFailures = 0;
  emOpenUntil = 0;
}

function recordEastmoneyFailure(message: string): void {
  emConsecutiveFailures += 1;
  if (emConsecutiveFailures >= EM_FAILURE_THRESHOLD) {
    emOpenUntil = Date.now() + EM_COOLDOWN_MS;
    emConsecutiveFailures = 0;
    logger.warn(`[domestic-index] Eastmoney circuit opened for ${EM_COOLDOWN_MS / 1000}s`, { message });
  }
}

function primaryProvider(): IndexSource {
  const forced = process.env.DOMESTIC_INDEX_PROVIDER?.toLowerCase();
  if (forced === 'eastmoney' || forced === 'tencent') return forced;
  return eastmoneyAvailable() ? 'eastmoney' : 'tencent';
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': getUserAgent(),
        Referer: 'https://quote.eastmoney.com/',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function decodeGbk(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function isIndexSnapshot(value: unknown): value is IndexSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.symbol === 'string' && typeof v.price === 'number' && typeof v.source === 'string';
}

function isIndexSnapshotArray(value: unknown): value is IndexSnapshot[] {
  return Array.isArray(value) && value.every(isIndexSnapshot);
}

function isIndexBar(value: unknown): value is IndexBar {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.date === 'string' && typeof v.close === 'number';
}

function isIndexBarArray(value: unknown): value is IndexBar[] {
  return Array.isArray(value) && value.every(isIndexBar);
}

function readSource(value: unknown): IndexSource | null {
  return value === 'eastmoney' || value === 'tencent' ? value : null;
}

export function describeIndexCatalog(): string {
  return INDEX_CATALOG.map((d) => `${d.symbol} ${d.name}`).join(', ');
}

export function resolveIndex(query: string): IndexDefinition | undefined {
  const raw = query.trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();

  const byName = INDEX_CATALOG.find((d) => d.name === raw);
  if (byName) return byName;

  const aliasSymbol = INDEX_ALIASES[raw];
  if (aliasSymbol) return INDEX_CATALOG.find((d) => d.symbol === aliasSymbol);

  const bySymbol = INDEX_CATALOG.find((d) => d.symbol.toLowerCase() === lower);
  if (bySymbol) return bySymbol;

  const bySecid = INDEX_CATALOG.find((d) => d.emSecid.toLowerCase() === lower);
  if (bySecid) return bySecid;

  const byTx = INDEX_CATALOG.find((d) => d.txCode.toLowerCase() === lower);
  if (byTx) return byTx;

  // Bare 6-digit code: 399* is SZSE (market 0), 000* is CSI/SSE (market 1);
  // anything else prefers market 1 then 0.
  if (/^\d{6}$/.test(lower)) {
    const markets = lower.startsWith('399') ? ['0'] : lower.startsWith('000') ? ['1'] : ['1', '0'];
    for (const market of markets) {
      const match = INDEX_CATALOG.find((d) => d.emSecid === `${market}.${lower}`);
      if (match) return match;
    }
  }

  return undefined;
}

function requireIndex(symbol: string): IndexDefinition {
  const def = resolveIndex(symbol);
  if (!def) {
    throw new Error(`Unknown index: ${symbol}. Available indices: ${describeIndexCatalog()}`);
  }
  return def;
}

function parseTencentAssignment(text: string, txCode: string): string[] | null {
  const target = txCode.toLowerCase();
  const re = /v_([a-z0-9]+)="([^"]*)"/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1].toLowerCase() === target) {
      return match[2].split('~');
    }
  }
  return null;
}

function buildTencentSnapshot(def: IndexDefinition, fields: string[]): IndexSnapshot {
  return {
    symbol: def.symbol,
    name: fields[1] || def.name,
    price: toNumber(fields[3]),
    prevClose: toNumber(fields[4]),
    open: toNumber(fields[5]),
    volume: toNumber(fields[6]),
    change: toNumber(fields[31]),
    changePercent: toNumber(fields[32]),
    high: toNumber(fields[33]),
    low: toNumber(fields[34]),
    amount: toNumber(fields[37]),
    timestamp: Math.floor(Date.now() / 1000),
    source: 'tencent',
  };
}

async function fetchEastmoneySnapshot(def: IndexDefinition): Promise<Sourced<IndexSnapshot>> {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${def.emSecid}&fltt=2&invt=2&fields=${EM_SNAPSHOT_FIELDS}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Eastmoney snapshot HTTP ${res.status}`);
  const payload = (await res.json()) as { data?: Record<string, unknown> | null };
  const data = payload.data;
  if (!data) throw new Error(`Eastmoney snapshot returned no data for ${def.symbol}`);

  const snapshot: IndexSnapshot = {
    symbol: def.symbol,
    name: typeof data.f58 === 'string' && data.f58 ? data.f58 : def.name,
    price: toNumber(data.f43),
    change: toNumber(data.f169),
    changePercent: toNumber(data.f170),
    open: toNumber(data.f46),
    high: toNumber(data.f44),
    low: toNumber(data.f45),
    prevClose: toNumber(data.f60),
    volume: toNumber(data.f47),
    amount: toNumber(data.f48),
    amplitude: data.f171 === undefined || data.f171 === null ? undefined : toNumber(data.f171),
    timestamp: toNumber(data.f86),
    source: 'eastmoney',
  };
  return { value: snapshot, source: 'eastmoney', sourceUrl: url };
}

async function fetchTencentSnapshot(def: IndexDefinition): Promise<Sourced<IndexSnapshot>> {
  const url = `https://qt.gtimg.cn/q=${def.txCode}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Tencent snapshot HTTP ${res.status}`);
  const text = decodeGbk(await res.arrayBuffer());
  const fields = parseTencentAssignment(text, def.txCode);
  if (!fields) throw new Error(`Tencent snapshot returned no data for ${def.txCode}`);
  return { value: buildTencentSnapshot(def, fields), source: 'tencent', sourceUrl: url };
}

async function fetchEastmoneySnapshots(defs: IndexDefinition[]): Promise<Sourced<IndexSnapshot[]>> {
  const secids = defs.map((d) => d.emSecid).join(',');
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=${EM_BATCH_FIELDS}&secids=${secids}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Eastmoney batch snapshot HTTP ${res.status}`);
  const payload = (await res.json()) as { data?: { diff?: unknown } | null };
  const diff = payload.data?.diff;
  if (!Array.isArray(diff)) throw new Error('Eastmoney batch snapshot returned no data');

  const timestamp = Math.floor(Date.now() / 1000);
  const snapshots: IndexSnapshot[] = [];
  for (const row of diff) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const code = String(r.f12 ?? '');
    const market = String(r.f13 ?? '');
    const emSecid = `${market}.${code}`;
    const def = defs.find((d) => d.emSecid === emSecid) ?? INDEX_CATALOG.find((d) => d.emSecid === emSecid);
    snapshots.push({
      symbol: def ? def.symbol : code,
      name: typeof r.f14 === 'string' && r.f14 ? r.f14 : def?.name ?? code,
      price: toNumber(r.f2),
      change: toNumber(r.f4),
      changePercent: toNumber(r.f3),
      open: 0,
      high: 0,
      low: 0,
      prevClose: 0,
      volume: 0,
      amount: 0,
      timestamp,
      source: 'eastmoney',
    });
  }
  return { value: snapshots, source: 'eastmoney', sourceUrl: url };
}

async function fetchTencentSnapshots(defs: IndexDefinition[]): Promise<Sourced<IndexSnapshot[]>> {
  const codes = defs.map((d) => d.txCode).join(',');
  const url = `https://qt.gtimg.cn/q=${codes}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Tencent batch snapshot HTTP ${res.status}`);
  const text = decodeGbk(await res.arrayBuffer());

  const snapshots: IndexSnapshot[] = [];
  for (const def of defs) {
    const fields = parseTencentAssignment(text, def.txCode);
    if (fields) snapshots.push(buildTencentSnapshot(def, fields));
  }
  if (snapshots.length === 0) throw new Error('Tencent batch snapshot returned no data');
  return { value: snapshots, source: 'tencent', sourceUrl: url };
}

function parseKlineRow(row: unknown): IndexBar | null {
  if (typeof row !== 'string') return null;
  const parts = row.split(',');
  if (parts.length < 10) return null;
  return {
    date: parts[0],
    open: toNumber(parts[1]),
    close: toNumber(parts[2]),
    high: toNumber(parts[3]),
    low: toNumber(parts[4]),
    volume: toNumber(parts[5]),
    amount: toNumber(parts[6]),
    changePercent: toNumber(parts[8]),
  };
}

async function fetchEastmoneyBars(
  def: IndexDefinition,
  interval: IndexInterval,
  startDate: string,
  endDate: string,
): Promise<Sourced<IndexBar[]>> {
  const beg = startDate.replace(/-/g, '');
  const end = endDate.replace(/-/g, '');
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${def.emSecid}&fields1=${EM_KLINE_FIELDS1}&fields2=${EM_KLINE_FIELDS2}&klt=${KLT[interval]}&fqt=0&beg=${beg}&end=${end}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Eastmoney kline HTTP ${res.status}`);
  const payload = (await res.json()) as { data?: { klines?: unknown } | null };
  const klines = payload.data?.klines;
  if (klines === undefined || klines === null) {
    throw new Error(`Eastmoney kline returned no data for ${def.symbol}`);
  }
  if (!Array.isArray(klines)) throw new Error('Eastmoney kline returned invalid data');
  const bars = klines.map(parseKlineRow).filter((bar): bar is IndexBar => bar !== null);
  return { value: bars, source: 'eastmoney', sourceUrl: url };
}

function pickTencentRows(node: Record<string, unknown>, interval: IndexInterval): unknown[] {
  for (const key of [`qfq${interval}`, interval]) {
    const value = node[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

async function fetchTencentBars(
  def: IndexDefinition,
  interval: IndexInterval,
  startDate: string,
  endDate: string,
): Promise<Sourced<IndexBar[]>> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${def.txCode},${interval},${startDate},${endDate},1000,qfq`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Tencent kline HTTP ${res.status}`);
  const payload = (await res.json()) as { data?: Record<string, unknown> | null };
  const entry = payload.data?.[def.txCode];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Tencent kline returned no data for ${def.txCode}`);
  }
  const rows = pickTencentRows(entry as Record<string, unknown>, interval);

  const bars: IndexBar[] = [];
  let prevClose: number | null = null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const close = toNumber(row[2]);
    const changePercent = prevClose !== null && prevClose !== 0 ? ((close - prevClose) / prevClose) * 100 : 0;
    bars.push({
      date: String(row[0]),
      open: toNumber(row[1]),
      close,
      high: toNumber(row[3]),
      low: toNumber(row[4]),
      volume: toNumber(row[5]),
      amount: 0,
      changePercent,
    });
    prevClose = close;
  }
  return { value: bars, source: 'tencent', sourceUrl: url };
}

function barsTtlMs(endDate: string): number {
  const end = new Date(`${endDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return end < today ? TTL_24H : TTL_15M;
}

export async function getIndexSnapshot(symbol: string): Promise<Sourced<IndexSnapshot>> {
  const def = requireIndex(symbol);
  const cacheParams = { symbol: def.symbol };

  const cached = readCache(SNAPSHOT_CACHE_ENDPOINT, cacheParams, SNAPSHOT_TTL_MS);
  if (cached && isIndexSnapshot(cached.data.snapshot)) {
    const snapshot = cached.data.snapshot;
    return { value: snapshot, source: snapshot.source, sourceUrl: cached.url };
  }

  let result: Sourced<IndexSnapshot>;
  if (primaryProvider() === 'eastmoney') {
    try {
      result = await fetchEastmoneySnapshot(def);
      recordEastmoneySuccess();
    } catch (error) {
      recordEastmoneyFailure(errorMessage(error));
      logger.warn(`[domestic-index] Eastmoney snapshot failed; falling back to Tencent: ${errorMessage(error)}`);
      result = await fetchTencentSnapshot(def);
    }
  } else {
    result = await fetchTencentSnapshot(def);
  }

  writeCache(SNAPSHOT_CACHE_ENDPOINT, cacheParams, { snapshot: result.value }, result.sourceUrl);
  return result;
}

export async function getIndexSnapshots(symbols: string[]): Promise<Sourced<IndexSnapshot[]>> {
  const defs = symbols.map(requireIndex);
  const cacheParams = { symbols: defs.map((d) => d.symbol).join(',') };

  const cached = readCache(SNAPSHOTS_CACHE_ENDPOINT, cacheParams, SNAPSHOT_TTL_MS);
  if (cached && isIndexSnapshotArray(cached.data.snapshots)) {
    const source = readSource(cached.data.source) ?? 'eastmoney';
    return { value: cached.data.snapshots, source, sourceUrl: cached.url };
  }

  let result: Sourced<IndexSnapshot[]>;
  if (primaryProvider() === 'eastmoney') {
    try {
      result = await fetchEastmoneySnapshots(defs);
      recordEastmoneySuccess();
    } catch (error) {
      recordEastmoneyFailure(errorMessage(error));
      logger.warn(`[domestic-index] Eastmoney batch snapshot failed; falling back to Tencent: ${errorMessage(error)}`);
      result = await fetchTencentSnapshots(defs);
    }
  } else {
    result = await fetchTencentSnapshots(defs);
  }

  writeCache(
    SNAPSHOTS_CACHE_ENDPOINT,
    cacheParams,
    { snapshots: result.value, source: result.source },
    result.sourceUrl,
  );
  return result;
}

export async function getIndexBars(
  symbol: string,
  interval: IndexInterval,
  startDate: string,
  endDate: string,
): Promise<Sourced<IndexBar[]>> {
  const def = requireIndex(symbol);
  const cacheParams = { symbol: def.symbol, interval, start: startDate, end: endDate };

  const cached = readCache(BARS_CACHE_ENDPOINT, cacheParams, barsTtlMs(endDate));
  if (cached && isIndexBarArray(cached.data.bars)) {
    const source = readSource(cached.data.source) ?? 'eastmoney';
    return { value: cached.data.bars, source, sourceUrl: cached.url };
  }

  let result: Sourced<IndexBar[]>;
  if (primaryProvider() === 'eastmoney') {
    try {
      result = await fetchEastmoneyBars(def, interval, startDate, endDate);
      recordEastmoneySuccess();
    } catch (error) {
      recordEastmoneyFailure(errorMessage(error));
      logger.warn(`[domestic-index] Eastmoney kline failed; falling back to Tencent: ${errorMessage(error)}`);
      result = await fetchTencentBars(def, interval, startDate, endDate);
    }
  } else {
    result = await fetchTencentBars(def, interval, startDate, endDate);
  }

  writeCache(
    BARS_CACHE_ENDPOINT,
    cacheParams,
    { bars: result.value, source: result.source },
    result.sourceUrl,
  );
  return result;
}
