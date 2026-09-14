import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_24H } from './utils.js';
import { resolveIndex } from './domestic-index-api.js';
import { getIndexWeights, type IndexWeight } from './index-weights-api.js';

// Index constituents for China A-share indices. Eastmoney's datacenter exposes
// the member list (codes only, no weights) per index; names and last prices are
// enriched from the push2 batch-quote endpoint. Constituents change rarely, so
// results are cached for a day. Does NOT import ./api.js (financialdatasets.ai).

export interface IndexConstituent {
  code: string;
  name: string | null;
  weight: number | null;
  price: number | null;
  changePercent: number | null;
}

export interface IndexConstituents {
  symbol: string;
  indexCode: string;
  indexName: string;
  count: number;
  weightsIncluded: boolean;
  weightDate: string | null;
  constituents: IndexConstituent[];
  source: 'eastmoney';
}

export interface Sourced<T> {
  value: T;
  source: 'eastmoney';
  sourceUrl: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CACHE_ENDPOINT = '/domestic-index/constituents/';
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
const ENRICH_CHUNK = 100;
const COMPONENT_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

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

// Shanghai codes start with 6 (stocks) or 9 (B-shares); everything else on the
// A-share universe is Shenzhen/Beijing, which Eastmoney serves under market 0.
function secidFor(code: string): string {
  const market = code.startsWith('6') || code.startsWith('9') ? '1' : '0';
  return `${market}.${code}`;
}

function indexCodeOf(symbol: string): string {
  return symbol.slice(0, 6);
}

function isIndexConstituents(value: unknown): value is IndexConstituents {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.constituents) && v.source === 'eastmoney';
}

async function fetchConstituentCodes(indexCode: string, limit: number): Promise<string[]> {
  const filter = encodeURIComponent(`(INDEX_CODE="${indexCode}")`);
  const url =
    `${COMPONENT_URL}?reportName=RPT_INDEX_COMPONENT&columns=ALL` +
    `&pageSize=${limit}&pageNumber=1&sortColumns=SECURITY_CODE&sortTypes=1&filter=${filter}`;
  const res = await fetchWithTimeout(url, 'https://data.eastmoney.com/');
  if (!res.ok) throw new Error(`Eastmoney index constituents HTTP ${res.status}`);
  const payload = (await res.json()) as { result?: { data?: unknown } | null };
  const list = payload.result?.data;
  if (!Array.isArray(list)) return [];
  const codes: string[] = [];
  for (const row of list as unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const code = toStringOrNull((row as Record<string, unknown>).SECURITY_CODE);
    if (code) codes.push(code);
  }
  return codes;
}

// Best-effort enrichment: a failed quote lookup must not lose the member list.
async function enrichQuotes(codes: string[]): Promise<Map<string, IndexConstituent>> {
  const quotes = new Map<string, IndexConstituent>();
  for (let i = 0; i < codes.length; i += ENRICH_CHUNK) {
    const chunk = codes.slice(i, i + ENRICH_CHUNK);
    if (chunk.length === 0) continue;
    const secids = chunk.map(secidFor).join(',');
    const fields = 'f12,f13,f14,f2,f3';
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get' +
      `?fltt=2&invt=2&fields=${fields}&secids=${secids}`;
    try {
      const res = await fetchWithTimeout(url, 'https://quote.eastmoney.com/');
      if (!res.ok) continue;
      const payload = (await res.json()) as { data?: { diff?: unknown } | null };
      const diff = Array.isArray(payload.data?.diff) ? (payload.data!.diff as unknown[]) : [];
      for (const row of diff) {
        if (typeof row !== 'object' || row === null) continue;
        const rec = row as Record<string, unknown>;
        const code = toStringOrNull(rec.f12);
        if (!code) continue;
        quotes.set(code, {
          code,
          name: toStringOrNull(rec.f14),
          weight: null,
          price: toNullableNumber(rec.f2),
          changePercent: toNullableNumber(rec.f3),
        });
      }
    } catch {
      // ignore chunk failure; names/prices simply stay null
    }
  }
  return quotes;
}

/**
 * Fetch the constituent stocks of a China A-share index. Returns member codes
 * with names, last prices and (for 中证 indices) each constituent's published
 * weight. Weights come from the csindex close-weight workbook; indices that
 * csindex does not publish fall back to Eastmoney's code-only member list.
 */
export async function getIndexConstituents(
  symbol: string,
  limit: number = DEFAULT_LIMIT,
): Promise<Sourced<IndexConstituents>> {
  const def = resolveIndex(symbol);
  if (!def) throw new Error(`Unknown index: ${symbol}`);

  const indexCode = indexCodeOf(def.symbol);
  const pageLimit = Math.min(
    Math.max(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const cacheParams = { indexCode, limit: pageLimit };

  const cached = readCache(CACHE_ENDPOINT, cacheParams, TTL_24H);
  if (cached && isIndexConstituents(cached.data.constituents)) {
    return { value: cached.data.constituents, source: 'eastmoney', sourceUrl: cached.url };
  }

  if (Date.now() < openUntil) {
    throw new Error('Eastmoney index constituents temporarily unavailable (circuit open)');
  }

  try {
    // Prefer the 中证 (csindex) close-weight workbook, which carries both the
    // member list and each constituent's weight. Falls back to Eastmoney (codes
    // only, no weights) for indices csindex does not publish.
    const weightData = await getIndexWeights(indexCode);
    let codes: string[];
    let weightsByCode: Map<string, IndexWeight> | null = null;
    let weightDate: string | null = null;
    if (weightData && weightData.value.weights.length > 0) {
      const limited = weightData.value.weights.slice(0, pageLimit);
      codes = limited.map((w) => w.code);
      weightsByCode = new Map(limited.map((w) => [w.code, w]));
      weightDate = weightData.value.asOfDate;
    } else {
      codes = await fetchConstituentCodes(indexCode, pageLimit);
    }

    const quotes = await enrichQuotes(codes);
    const constituents: IndexConstituent[] = codes.map((code) => {
      const quote = quotes.get(code);
      const weighted = weightsByCode?.get(code);
      return {
        code,
        name: quote?.name ?? weighted?.name ?? null,
        weight: weighted?.weight ?? null,
        price: quote?.price ?? null,
        changePercent: quote?.changePercent ?? null,
      };
    });

    const result: IndexConstituents = {
      symbol: def.symbol,
      indexCode,
      indexName: def.name,
      count: constituents.length,
      weightsIncluded: weightsByCode !== null,
      weightDate,
      constituents,
      source: 'eastmoney',
    };

    failures = 0;
    openUntil = 0;
    const sourceUrl = `https://quote.eastmoney.com/zs${indexCode}.html`;
    writeCache(CACHE_ENDPOINT, cacheParams, { constituents: result }, sourceUrl);
    return { value: result, source: 'eastmoney', sourceUrl };
  } catch (error) {
    failures += 1;
    if (failures >= FAILURE_THRESHOLD) {
      openUntil = Date.now() + COOLDOWN_MS;
      failures = 0;
      logger.warn(`[domestic-index] constituents circuit opened for ${COOLDOWN_MS / 1000}s`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
