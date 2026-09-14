import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_15M } from './utils.js';
import { decodeGbk } from './domestic-index-api.js';

// Eastmoney industry sectors (行业板块). The board list is a clist query over
// the m:90+t:2 sector universe; a board's members come from a clist over
// b:<BK code>. Responses are GBK-encoded JSON, so they are decoded manually.

export interface IndustryBoard {
  code: string;
  name: string;
  changePercent: number | null;
  up: number | null;
  down: number | null;
  leaderCode: string | null;
  leader: string | null;
}

export interface IndustryMember {
  code: string;
  market: string;
  name: string;
  price: number | null;
  changePercent: number | null;
}

export interface IndustryBoards {
  kind: 'boards';
  boards: IndustryBoard[];
  total: number | null;
  source: 'eastmoney';
}

export interface IndustryMembers {
  kind: 'members';
  board: string;
  boardName: string;
  members: IndustryMember[];
  total: number | null;
  source: 'eastmoney';
}

export type IndustryResult = IndustryBoards | IndustryMembers;

export interface Sourced<T> {
  value: T;
  source: 'eastmoney';
  sourceUrl: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CACHE_ENDPOINT = '/domestic-market/industry/';
const CLIST_URL = 'https://push2.eastmoney.com/api/qt/clist/get';
const BOARDS_FS = 'm:90+t:2';
const BOARD_CODE_RE = /^BK\d+$/i;
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;
const DEFAULT_BOARD_LIMIT = 30;
const DEFAULT_MEMBER_LIMIT = 50;
const MAX_LIMIT = 100;

let failures = 0;
let openUntil = 0;

function getTimeoutMs(): number {
  const raw = Number(process.env.DOMESTIC_MARKET_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function getUserAgent(): string {
  return process.env.DOMESTIC_MARKET_UA || DEFAULT_UA;
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

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : fallback, 1), MAX_LIMIT);
}

interface ClistPayload {
  data?: { total?: unknown; diff?: unknown } | null;
}

// GBK-encoded JSON, so it must be read as bytes and decoded before parsing.
async function fetchClist(
  fs: string,
  fields: string,
  limit: number,
  fid: string,
): Promise<{ total: number | null; rows: Record<string, unknown>[] }> {
  const url =
    `${CLIST_URL}?pn=1&pz=${limit}&po=1&np=1&fltt=2&invt=2&fid=${fid}` +
    `&fs=${encodeURIComponent(fs)}&fields=${fields}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Eastmoney industry HTTP ${res.status}`);
  let payload: ClistPayload;
  try {
    payload = JSON.parse(decodeGbk(await res.arrayBuffer())) as ClistPayload;
  } catch {
    throw new Error('Eastmoney industry returned an unparsable response');
  }
  const diff = Array.isArray(payload.data?.diff) ? (payload.data!.diff as unknown[]) : [];
  const rows = diff.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  );
  return { total: toNullableNumber(payload.data?.total), rows };
}

function isIndustryBoards(value: unknown): value is IndustryBoards {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'boards' && Array.isArray(v.boards);
}

function isIndustryMembers(value: unknown): value is IndustryMembers {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'members' && Array.isArray(v.members);
}

function parseBoard(row: Record<string, unknown>): IndustryBoard | null {
  const code = toStringOrNull(row.f12);
  const name = toStringOrNull(row.f14);
  if (!code || !name) return null;
  const leaderCode = toStringOrNull(row.f140);
  const leader = toStringOrNull(row.f141) ?? toStringOrNull(row.f128);
  return {
    code,
    name,
    changePercent: toNullableNumber(row.f3),
    up: toNullableNumber(row.f104),
    down: toNullableNumber(row.f105),
    leaderCode,
    leader,
  };
}

function parseMember(row: Record<string, unknown>): IndustryMember | null {
  const code = toStringOrNull(row.f12);
  const name = toStringOrNull(row.f14);
  if (!code || !name) return null;
  return {
    code,
    market: toStringOrNull(row.f13) ?? '',
    name,
    price: toNullableNumber(row.f2),
    changePercent: toNullableNumber(row.f3),
  };
}

const BOARD_FIELDS = 'f12,f13,f14,f2,f3,f104,f105,f128,f136,f140,f141';
const CONCEPT_FS = 'm:90+t:3';
const CONCEPT_CACHE_ENDPOINT = '/domestic-market/concept/';
const INDUSTRY_SOURCE_URL = 'https://quote.eastmoney.com/center/boardlist.html#industry_board';
const CONCEPT_SOURCE_URL = 'https://quote.eastmoney.com/center/boardlist.html#concept_board';

async function fetchBoardListRaw(fs: string, limit: number): Promise<IndustryBoards> {
  const { total, rows } = await fetchClist(fs, BOARD_FIELDS, limit, 'f3');
  return {
    kind: 'boards',
    boards: rows.map(parseBoard).filter((b): b is IndustryBoard => b !== null),
    total,
    source: 'eastmoney',
  };
}

async function resolveBoardIn(
  fs: string,
  query: string,
  label: string,
): Promise<{ code: string; name: string }> {
  if (BOARD_CODE_RE.test(query.trim())) {
    return { code: query.trim().toUpperCase(), name: query.trim().toUpperCase() };
  }
  const list = await fetchBoardListRaw(fs, MAX_LIMIT);
  const lower = query.trim().toLowerCase();
  const match = list.boards.find((b) => b.name.includes(query.trim()) || b.name.toLowerCase().includes(lower));
  if (!match) throw new Error(`Unknown ${label} board: ${query}`);
  return { code: match.code, name: match.name };
}

function resolveBoard(query: string): Promise<{ code: string; name: string }> {
  return resolveBoardIn(BOARDS_FS, query, 'industry');
}

function resolveConceptBoard(query: string): Promise<{ code: string; name: string }> {
  return resolveBoardIn(CONCEPT_FS, query, 'concept');
}

async function withCircuit<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (Date.now() < openUntil) {
    throw new Error(`Eastmoney ${label} data temporarily unavailable (circuit open)`);
  }
  try {
    const result = await run();
    failures = 0;
    openUntil = 0;
    return result;
  } catch (error) {
    failures += 1;
    if (failures >= FAILURE_THRESHOLD) {
      openUntil = Date.now() + COOLDOWN_MS;
      failures = 0;
      logger.warn(`[domestic-market] ${label} circuit opened for ${COOLDOWN_MS / 1000}s`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

interface BoardLoadOptions {
  fs: string;
  endpoint: string;
  cacheKind: string;
  sourceUrl: string;
  circuitLabel: string;
  limit: number;
}

async function loadBoards(options: BoardLoadOptions): Promise<Sourced<IndustryBoards>> {
  const cacheParams = { kind: options.cacheKind, limit: options.limit };
  const cached = readCache(options.endpoint, cacheParams, TTL_15M);
  if (cached && isIndustryBoards(cached.data.result)) {
    return { value: cached.data.result, source: 'eastmoney', sourceUrl: cached.url };
  }
  return withCircuit(options.circuitLabel, async () => {
    const result = await fetchBoardListRaw(options.fs, options.limit);
    writeCache(options.endpoint, cacheParams, { result }, options.sourceUrl);
    return { value: result, source: 'eastmoney' as const, sourceUrl: options.sourceUrl };
  });
}

interface MemberLoadOptions {
  endpoint: string;
  cacheKind: string;
  circuitLabel: string;
  query: string;
  limit: number;
  resolve: (query: string) => Promise<{ code: string; name: string }>;
  memberSourceUrl: (code: string) => string;
}

async function loadMembers(options: MemberLoadOptions): Promise<Sourced<IndustryMembers>> {
  const cacheParams = { kind: options.cacheKind, board: options.query, limit: options.limit };
  const cached = readCache(options.endpoint, cacheParams, TTL_15M);
  if (cached && isIndustryMembers(cached.data.result)) {
    return { value: cached.data.result, source: 'eastmoney', sourceUrl: cached.url };
  }
  return withCircuit(options.circuitLabel, async () => {
    const resolved = await options.resolve(options.query);
    const { total, rows } = await fetchClist(
      `b:${resolved.code}`,
      'f12,f13,f14,f2,f3',
      options.limit,
      'f3',
    );
    const result: IndustryMembers = {
      kind: 'members',
      board: resolved.code,
      boardName: resolved.name,
      members: rows.map(parseMember).filter((m): m is IndustryMember => m !== null),
      total,
      source: 'eastmoney',
    };
    const sourceUrl = options.memberSourceUrl(resolved.code);
    writeCache(options.endpoint, cacheParams, { result }, sourceUrl);
    return { value: result, source: 'eastmoney' as const, sourceUrl };
  });
}

/**
 * Eastmoney industry sector list, ranked by daily change percent (descending).
 */
export async function getIndustryBoards(limit: number = DEFAULT_BOARD_LIMIT): Promise<Sourced<IndustryBoards>> {
  return loadBoards({
    fs: BOARDS_FS,
    endpoint: CACHE_ENDPOINT,
    cacheKind: 'boards',
    sourceUrl: INDUSTRY_SOURCE_URL,
    circuitLabel: 'industry',
    limit: clampLimit(limit, DEFAULT_BOARD_LIMIT),
  });
}

/**
 * Member stocks of one Eastmoney industry board, by BK code or board name.
 */
export async function getIndustryMembers(
  board: string,
  limit: number = DEFAULT_MEMBER_LIMIT,
): Promise<Sourced<IndustryMembers>> {
  const trimmed = board.trim();
  if (!trimmed) throw new Error('An industry board name or BK code is required');
  return loadMembers({
    endpoint: CACHE_ENDPOINT,
    cacheKind: 'members',
    circuitLabel: 'industry',
    query: trimmed,
    limit: clampLimit(limit, DEFAULT_MEMBER_LIMIT),
    resolve: resolveBoard,
    memberSourceUrl: (code) => `https://quote.eastmoney.com/bk/90.${code}.html`,
  });
}

/**
 * Eastmoney concept/theme sector list (概念题材), ranked by daily change percent.
 */
export async function getConceptBoards(limit: number = DEFAULT_BOARD_LIMIT): Promise<Sourced<IndustryBoards>> {
  return loadBoards({
    fs: CONCEPT_FS,
    endpoint: CONCEPT_CACHE_ENDPOINT,
    cacheKind: 'concept-boards',
    sourceUrl: CONCEPT_SOURCE_URL,
    circuitLabel: 'concept',
    limit: clampLimit(limit, DEFAULT_BOARD_LIMIT),
  });
}

/**
 * Member stocks of one Eastmoney concept board, by BK code or board name.
 */
export async function getConceptMembers(
  board: string,
  limit: number = DEFAULT_MEMBER_LIMIT,
): Promise<Sourced<IndustryMembers>> {
  const trimmed = board.trim();
  if (!trimmed) throw new Error('A concept board name or BK code is required');
  return loadMembers({
    endpoint: CONCEPT_CACHE_ENDPOINT,
    cacheKind: 'concept-members',
    circuitLabel: 'concept',
    query: trimmed,
    limit: clampLimit(limit, DEFAULT_MEMBER_LIMIT),
    resolve: resolveConceptBoard,
    memberSourceUrl: (code) => `https://quote.eastmoney.com/bk/90.${code}.html`,
  });
}
