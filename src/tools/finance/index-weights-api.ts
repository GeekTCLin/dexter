import * as XLSX from 'xlsx';
import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_24H } from './utils.js';

// Real index constituent weights come from the official China Securities Index
// (中证指数) close-weight XLS files, which are the only keyless source that
// publishes weights. Eastmoney's datacenter report (RPT_INDEX_COMPONENT) only
// lists member codes without weights, so this module supplements it. Coverage is
// limited to 中证 indices (6-digit codes) — Shenzhen 国证 indices are not served
// here and resolve to null so callers can fall back to the code-only path.
// Does NOT import ./api.js (financialdatasets.ai).

export interface IndexWeight {
  code: string;
  name: string | null;
  weight: number | null;
}

export interface IndexWeights {
  indexCode: string;
  asOfDate: string | null;
  weights: IndexWeight[];
}

export interface Sourced<T> {
  value: T;
  source: 'csindex';
  sourceUrl: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const WEIGHT_URL_BASE =
  'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/closeweight/';
const CACHE_ENDPOINT = '/domestic-index/weights/';
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;

let failures = 0;
let openUntil = 0;

function getTimeoutMs(): number {
  const raw = Number(process.env.DOMESTIC_MARKET_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
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

function toStringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toCode(value: unknown): string | null {
  const text = toStringOrNull(value);
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(0, 6) : null;
}

// Row 0 date is stored as YYYYMMDD (string or number).
function formatDate(value: unknown): string | null {
  const text = toStringOrNull(value);
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function isIndexWeights(value: unknown): value is IndexWeights {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.weights) && typeof v.indexCode === 'string';
}

// Column layout of the close-weight file:
// 0 date | 1 indexCode | 2 indexNameCn | 3 indexNameEn | 4 constituentCode |
// 5 constituentNameCn | 6 constituentNameEn | 7 exchangeCn | 8 exchangeEn |
// 9 weight(%)   -- weight is already a percentage (0.433 => 0.433%).
function parseWeightRows(rows: unknown[][]): {
  asOfDate: string | null;
  weights: IndexWeight[];
} {
  let asOfDate: string | null = null;
  const weights: IndexWeight[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const code = toCode(row[4]);
    if (!code) continue;
    if (!asOfDate) asOfDate = formatDate(row[0]);
    weights.push({
      code,
      name: toStringOrNull(row[5]),
      weight: toNullableNumber(row[9]),
    });
  }
  return { asOfDate, weights };
}

/**
 * Fetch the official close-weight constituent table for a 中证 index. Returns
 * null when the index is not covered (e.g. 国证 indices), the file is
 * unavailable, or the circuit is open — weights are an optional enrichment and
 * callers should fall back to the code-only constituent path.
 */
export async function getIndexWeights(
  indexCode: string,
): Promise<Sourced<IndexWeights> | null> {
  const cacheParams = { indexCode };
  const cached = readCache(CACHE_ENDPOINT, cacheParams, TTL_24H);
  if (cached && isIndexWeights(cached.data.weights)) {
    return { value: cached.data.weights, source: 'csindex', sourceUrl: cached.url };
  }

  if (Date.now() < openUntil) return null;

  const url = `${WEIGHT_URL_BASE}${indexCode}closeweight.xls`;
  try {
    const res = await fetchWithTimeout(url, 'https://www.csindex.com.cn/');
    if (!res.ok) return null;

    const buffer = await res.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return null;
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return null;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
    });
    const { asOfDate, weights } = parseWeightRows(rows);
    if (weights.length === 0) return null;

    failures = 0;
    openUntil = 0;
    const value: IndexWeights = { indexCode, asOfDate, weights };
    writeCache(CACHE_ENDPOINT, cacheParams, { weights: value }, url);
    return { value, source: 'csindex', sourceUrl: url };
  } catch (error) {
    failures += 1;
    if (failures >= FAILURE_THRESHOLD) {
      openUntil = Date.now() + COOLDOWN_MS;
      failures = 0;
      logger.warn(`[domestic-index] weights circuit opened for ${COOLDOWN_MS / 1000}s`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}
