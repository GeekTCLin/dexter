import { createHash } from 'node:crypto';
import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { TTL_15M, TTL_1H } from '../finance/utils.js';

// Independent client for China domestic market news/sentiment/announcements.
// Deliberately does NOT import ./api.js; uses global fetch. All upstream
// endpoints here are UTF-8 (no GBK decoding needed).

export type DomesticSource = 'eastmoney' | 'cls' | 'sina' | 'cninfo';

export interface NewsItem {
  id: string;
  title: string;
  summary?: string;
  content?: string;
  /** Unix epoch seconds. */
  timestamp: number;
  source: DomesticSource;
  url?: string;
  stocks: string[];
  tags: string[];
  /** Engagement proxy (reads/likes/comments) when the source exposes one. */
  heat?: number;
}

export interface AnnouncementItem {
  code: string;
  name: string;
  title: string;
  announcementId: string;
  /** Unix epoch seconds. */
  timestamp: number;
  pdfUrl: string;
  type: string;
  source: DomesticSource;
  url?: string;
}

export type SentimentLabel = 'bullish' | 'bearish' | 'neutral' | 'unknown';

export interface GubaPost {
  postId: string;
  title: string;
  author: string;
  clicks: number;
  forwards: number;
  comments: number;
  publishTime: number;
  lastTime: number;
  sentiment: SentimentLabel;
  url: string;
}

export interface GubaSentiment {
  code: string;
  sort: 'latest' | 'hot';
  total: number;
  bullish: number;
  bearish: number;
  neutral: number;
  posts: GubaPost[];
}

export interface Sourced<T> {
  value: T;
  source: DomesticSource;
  sourceUrl?: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Cache namespaces keep these entries isolated from financialdatasets keys.
const FLASH_CACHE = '/domestic-search/flash/';
const GUBA_CACHE = '/domestic-search/guba/';
const NEWS_CACHE = '/domestic-search/news/';
const ANNOUNCEMENTS_CACHE = '/domestic-search/announcements/';

const CNINFO_TOP_SEARCH_URL = 'http://www.cninfo.com.cn/new/information/topSearch/query';
const CNINFO_QUERY_URL = 'http://www.cninfo.com.cn/new/hisAnnouncement/query';
const CNINFO_HEADERS: Record<string, string> = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Referer: 'http://www.cninfo.com.cn/',
  'X-Requested-With': 'XMLHttpRequest',
};

// Per-source circuit breaker: consecutive failures open a short cooldown so a
// flaky/blocked upstream doesn't stall every subsequent request.
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 45_000;

interface CircuitState {
  failures: number;
  openUntil: number;
}

const circuits: Record<DomesticSource, CircuitState> = {
  eastmoney: { failures: 0, openUntil: 0 },
  cls: { failures: 0, openUntil: 0 },
  sina: { failures: 0, openUntil: 0 },
  cninfo: { failures: 0, openUntil: 0 },
};

function sourceAvailable(source: DomesticSource): boolean {
  return Date.now() >= circuits[source].openUntil;
}

function recordSourceSuccess(source: DomesticSource): void {
  circuits[source].failures = 0;
  circuits[source].openUntil = 0;
}

function recordSourceFailure(source: DomesticSource, message: string): void {
  const state = circuits[source];
  state.failures += 1;
  if (state.failures >= FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + COOLDOWN_MS;
    state.failures = 0;
    logger.warn(`[domestic-search] ${source} circuit opened for ${COOLDOWN_MS / 1000}s`, { message });
  }
}

/** Test/diagnostic helper: clear all per-source circuit breaker state. */
export function resetDomesticSearchCircuits(): void {
  for (const source of Object.keys(circuits) as DomesticSource[]) {
    circuits[source].failures = 0;
    circuits[source].openUntil = 0;
  }
}

function getTimeoutMs(): number {
  const raw = Number(process.env.DOMESTIC_SEARCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function getUserAgent(): string {
  return process.env.DOMESTIC_SEARCH_UA || DEFAULT_UA;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

async function fetchWithTimeout(url: string, options: RequestOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    return await fetch(url, {
      method: options.method ?? 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': getUserAgent(),
        ...options.headers,
      },
      body: options.body,
    });
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toStringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Normalize timestamps: numeric ms vs seconds, "YYYY-MM-DD HH:mm:ss", etc. */
function toEpochSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
    }
    const parsed = Date.parse(trimmed.replace(' ', 'T'));
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  }
  return 0;
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStockCode(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/^(sh|sz|bj)/i, '')
    .replace(/^\d+\./, '');
  const digits = stripped.replace(/\D/g, '');
  return /^\d{6}$/.test(digits) ? digits : '';
}

/** Accepts ["1.600519","sh000001",{code:"600519"}] and flattens to bare codes. */
function normalizeStocks(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string' && value
      ? value.split(',')
      : [];
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const row = asRecord(entry);
      return row ? toStringValue(row.code ?? row.stockid ?? row.stockId ?? row.symbol) : '';
    })
    .map(normalizeStockCode)
    .filter((code) => code.length > 0);
}

function normalizeCode(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return /^\d{6}$/.test(digits) ? digits : '';
}

function clampLimit(value: number, min: number, max: number, fallback: number): number {
  const num = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(num, min), max);
}

function randomTrace(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

async function fetchJson(url: string, options?: RequestOptions): Promise<unknown> {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

async function fetchText(url: string, options?: RequestOptions): Promise<string> {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res.text();
}

// ─── Type guards (cache validation) ──────────────────────────────────────────

function readSource(value: unknown): DomesticSource | null {
  return value === 'eastmoney' || value === 'cls' || value === 'sina' || value === 'cninfo' ? value : null;
}

function isNewsItem(value: unknown): value is NewsItem {
  const v = asRecord(value);
  return !!v && typeof v.title === 'string' && typeof v.timestamp === 'number' && typeof v.source === 'string';
}

function isNewsItemArray(value: unknown): value is NewsItem[] {
  return Array.isArray(value) && value.every(isNewsItem);
}

function isAnnouncementItem(value: unknown): value is AnnouncementItem {
  const v = asRecord(value);
  return !!v && typeof v.title === 'string' && typeof v.announcementId === 'string';
}

function isAnnouncementItemArray(value: unknown): value is AnnouncementItem[] {
  return Array.isArray(value) && value.every(isAnnouncementItem);
}

function isGubaSentiment(value: unknown): value is GubaSentiment {
  const v = asRecord(value);
  return !!v && typeof v.code === 'string' && Array.isArray(v.posts);
}

// ─── Eastmoney 7x24 flash (primary) ──────────────────────────────────────────

async function fetchFlashFromEastmoney(limit: number, sortEnd: string): Promise<Sourced<NewsItem[]>> {
  const pageSize = clampLimit(limit, 1, 50, 20);
  const url =
    'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102' +
    `&sortEnd=${encodeURIComponent(sortEnd)}&pageSize=${pageSize}&req_trace=${randomTrace()}`;
  const payload = asRecord(
    await fetchJson(url, { headers: { Referer: 'https://kuaixun.eastmoney.com/' } }),
  );
  const data = asRecord(payload?.data);
  const items = asArray(data?.fastNewsList)
    .map((entry) => {
      const row = asRecord(entry) ?? {};
      return {
        id: toStringValue(row.code) || toStringValue(row.id),
        title: stripHtml(toStringValue(row.title)),
        summary: stripHtml(toStringValue(row.summary)) || undefined,
        timestamp: toEpochSeconds(row.showTime),
        source: 'eastmoney' as const,
        stocks: normalizeStocks(row.stockList),
        tags: [],
      };
    })
    .filter((item) => item.title.length > 0);
  return { value: items, source: 'eastmoney', sourceUrl: url };
}

// ─── CLS telegraph (flash backup) ────────────────────────────────────────────

/**
 * CLS signing: urlencode-free querystring sorted by key, then md5(sha1(qs)).
 * Exported for tests / debugging.
 */
export function buildClsSign(params: Record<string, string>): string {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  const sha1 = createHash('sha1').update(query).digest('hex');
  return createHash('md5').update(sha1).digest('hex');
}

async function fetchFlashFromCls(limit: number): Promise<Sourced<NewsItem[]>> {
  const params: Record<string, string> = {
    app: 'CailianpressWeb',
    category: '',
    last_time: '',
    os: 'web',
    refresh_type: '1',
    rn: String(clampLimit(limit, 1, 50, 20)),
    sv: '7.7.5',
  };
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join('&');
  const url = `https://www.cls.cn/v1/roll/get_roll_list?${query}&sign=${buildClsSign(params)}`;
  const payload = asRecord(
    await fetchJson(url, { headers: { Referer: 'https://www.cls.cn/telegraph' } }),
  );
  const data = asRecord(payload?.data);
  const items = asArray(data?.roll_data)
    .map((entry) => {
      const row = asRecord(entry) ?? {};
      const id = toStringValue(row.id);
      const brief = stripHtml(toStringValue(row.brief));
      return {
        id,
        title: stripHtml(toStringValue(row.title)) || brief.slice(0, 80),
        summary: brief || undefined,
        content: stripHtml(toStringValue(row.content)) || undefined,
        timestamp: toEpochSeconds(row.ctime),
        source: 'cls' as const,
        url: id ? `https://www.cls.cn/detail/${id}` : undefined,
        stocks: normalizeStocks(row.stock_list),
        tags: asArray(row.subjects)
          .map((subject) => toStringValue(asRecord(subject)?.subject_name))
          .filter((name) => name.length > 0),
        heat: toNumber(row.reading_num) || undefined,
      };
    })
    .filter((item) => item.title.length > 0);
  return { value: items, source: 'cls', sourceUrl: url };
}

// ─── Sina 7x24 (flash backup) ────────────────────────────────────────────────

function parseSinaStocks(ext: unknown): string[] {
  if (typeof ext !== 'string' || !ext.trim()) return [];
  try {
    const parsed = asRecord(JSON.parse(ext));
    return normalizeStocks(parsed?.stocks);
  } catch {
    return [];
  }
}

async function fetchFlashFromSina(limit: number): Promise<Sourced<NewsItem[]>> {
  const pageSize = clampLimit(limit, 1, 100, 20);
  const url = `https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=${pageSize}&zhibo_id=152&tag_id=0&dire=f&dpc=1`;
  const payload = asRecord(
    await fetchJson(url, { headers: { Referer: 'https://finance.sina.com.cn/7x24/' } }),
  );
  const result = asRecord(payload?.result);
  const data = asRecord(result?.data);
  const feed = asRecord(data?.feed);
  const items = asArray(feed?.list)
    .map((entry) => {
      const row = asRecord(entry) ?? {};
      const text = stripHtml(toStringValue(row.rich_text));
      const tag = toStringValue(row.tag);
      return {
        id: toStringValue(row.id),
        title: text.slice(0, 120),
        summary: text || undefined,
        timestamp: toEpochSeconds(row.create_time),
        source: 'sina' as const,
        stocks: parseSinaStocks(row.ext),
        tags: tag ? [tag] : [],
        heat: toNumber(row.like_nums) || toNumber(asRecord(row.comment_list)?.total) || undefined,
      };
    })
    .filter((item) => item.title.length > 0);
  return { value: items, source: 'sina', sourceUrl: url };
}

// ─── Eastmoney Guba sentiment ────────────────────────────────────────────────

function parseSentiment(value: unknown): SentimentLabel {
  // Assumption (unverified): 1 = 看多, 2 = 看空; anything else = neutral.
  const num = toNumber(value);
  if (num === 1) return 'bullish';
  if (num === 2) return 'bearish';
  return 'neutral';
}

async function fetchGubaSentiment(
  code: string,
  sort: 'latest' | 'hot',
  limit: number,
): Promise<Sourced<GubaSentiment>> {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error(`Invalid A-share code: ${code}`);
  const ps = clampLimit(limit, 1, 100, 20);
  const sorttype = sort === 'hot' ? '0' : '1';
  // plat=web&version=300 is mandatory or the API returns "系统繁忙".
  const url =
    `https://gbapi.eastmoney.com/webarticlelist/api/Article/Articlelist?code=${normalized}` +
    `&type=0&sorttype=${sorttype}&p=1&ps=${ps}&plat=web&version=300`;
  const payload = asRecord(
    await fetchJson(url, { headers: { Referer: `https://guba.eastmoney.com/list,${normalized}.html` } }),
  );
  const posts = asArray(payload?.re)
    .map((entry) => {
      const row = asRecord(entry) ?? {};
      const postId = toStringValue(row.post_id);
      return {
        postId,
        title: stripHtml(toStringValue(row.post_title)),
        author: toStringValue(row.user_nickname),
        clicks: toNumber(row.post_click_count),
        forwards: toNumber(row.post_forward_count),
        comments: toNumber(row.post_comment_count),
        publishTime: toEpochSeconds(row.post_publish_time),
        lastTime: toEpochSeconds(row.post_last_time),
        sentiment: parseSentiment(row.bullish_bearish),
        url: `https://guba.eastmoney.com/news,${normalized},${postId}.html`,
      };
    })
    .filter((post) => post.title.length > 0);

  const bullish = posts.filter((post) => post.sentiment === 'bullish').length;
  const bearish = posts.filter((post) => post.sentiment === 'bearish').length;
  return {
    value: {
      code: normalized,
      sort,
      total: toNumber(payload?.count),
      bullish,
      bearish,
      neutral: posts.length - bullish - bearish,
      posts,
    },
    source: 'eastmoney',
    sourceUrl: url,
  };
}

// ─── Eastmoney keyword news search ───────────────────────────────────────────

function stripJsonp(text: string): string {
  const trimmed = text.trim();
  const start = trimmed.indexOf('(');
  const end = trimmed.lastIndexOf(')');
  return start >= 0 && end > start ? trimmed.slice(start + 1, end) : trimmed;
}

async function fetchNewsFromEastmoney(keyword: string, limit: number): Promise<Sourced<NewsItem[]>> {
  const pageSize = clampLimit(limit, 1, 50, 10);
  const param = {
    uid: '',
    keyword,
    type: ['cmsArticleWebOld'],
    client: 'web',
    param: { cmsArticleWebOld: { pageIndex: 1, pageSize } },
  };
  const url =
    'https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery' +
    `&param=${encodeURIComponent(JSON.stringify(param))}`;
  const text = await fetchText(url, { headers: { Referer: 'https://so.eastmoney.com/' } });
  const payload = asRecord(JSON.parse(stripJsonp(text)));
  const result = asRecord(payload?.result);
  const items = asArray(result?.cmsArticleWebOld)
    .map((entry) => {
      const row = asRecord(entry) ?? {};
      const content = stripHtml(toStringValue(row.content));
      const media = toStringValue(row.mediaName);
      return {
        id: toStringValue(row.code),
        title: stripHtml(toStringValue(row.title)),
        summary: content || undefined,
        content: content || undefined,
        timestamp: toEpochSeconds(row.date),
        source: 'eastmoney' as const,
        url: toStringValue(row.url) || undefined,
        stocks: [],
        tags: media ? [media] : [],
      };
    })
    .filter((item) => item.title.length > 0);
  return { value: items, source: 'eastmoney', sourceUrl: url };
}

// ─── CNINFO official announcements ───────────────────────────────────────────

function cninfoHeuristicOrgId(code: string): string {
  // Fallback only (topSearch is the primary path). Real cninfo orgIds are the
  // venue prefix plus the 6-digit code left-padded to 7 digits: 600519 →
  // "gssh0600519", 000001 → "gssz0000001".
  return /^[69]/.test(code) ? `gssh0${code}` : `gssz0${code}`;
}

function extractOrgId(payload: unknown, code: string): string | null {
  const candidates: unknown[] = [];
  if (Array.isArray(payload)) {
    candidates.push(...payload);
  } else {
    const obj = asRecord(payload);
    for (const key of ['keyWord', 'data', 'results', 'list']) {
      const value = obj?.[key];
      if (Array.isArray(value)) candidates.push(...value);
      else {
        const nested = asRecord(value)?.keyWord;
        if (Array.isArray(nested)) candidates.push(...nested);
      }
    }
  }
  for (const candidate of candidates) {
    const row = asRecord(candidate);
    if (!row) continue;
    const orgId = toStringValue(row.orgId ?? row.orgid);
    const rowCode = toStringValue(row.code ?? row.secCode);
    if (orgId && (!rowCode || rowCode === code)) return orgId;
  }
  return null;
}

async function resolveOrgId(code: string): Promise<string | null> {
  const body = `keyWord=${encodeURIComponent(code)}&maxNum=10`;
  try {
    const res = await fetchWithTimeout(CNINFO_TOP_SEARCH_URL, {
      method: 'POST',
      headers: CNINFO_HEADERS,
      body,
    });
    if (res.ok) {
      const orgId = extractOrgId(await res.json(), code);
      if (orgId) return orgId;
    }
  } catch {
    // fall through to the GET variant
  }
  try {
    const res = await fetchWithTimeout(
      `${CNINFO_TOP_SEARCH_URL}?keyWord=${encodeURIComponent(code)}&maxNum=10`,
      { headers: CNINFO_HEADERS },
    );
    if (res.ok) {
      const orgId = extractOrgId(await res.json(), code);
      if (orgId) return orgId;
    }
  } catch {
    // fall through to the heuristic
  }
  return null;
}

async function fetchAnnouncements(
  code: string,
  limit: number,
  days: number,
): Promise<Sourced<AnnouncementItem[]>> {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error(`Invalid A-share code: ${code}`);
  const pageSize = clampLimit(limit, 1, 50, 20);
  const resolved = await resolveOrgId(normalized);
  const orgId = resolved ?? cninfoHeuristicOrgId(normalized);
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const body = [
    'pageNum=1',
    `pageSize=${pageSize}`,
    'column=szse',
    'tabName=fulltext',
    `stock=${normalized},${orgId}`,
    `seDate=${formatDate(start)}~${formatDate(end)}`,
    'isHLtitle=true',
  ].join('&');
  const payload = asRecord(
    await fetchJson(CNINFO_QUERY_URL, { method: 'POST', headers: CNINFO_HEADERS, body }),
  );
  const items = asArray(payload?.announcements)
    .map((entry) => {
      const row = asRecord(entry) ?? {};
      const adjunct = toStringValue(row.adjunctUrl);
      const announcementId = toStringValue(row.announcementId);
      return {
        code: toStringValue(row.secCode) || normalized,
        name: toStringValue(row.secName),
        title: stripHtml(toStringValue(row.announcementTitle)),
        announcementId,
        timestamp: toEpochSeconds(row.announcementTime),
        pdfUrl: adjunct ? `http://static.cninfo.com.cn/${adjunct}` : '',
        type: toStringValue(row.adjunctType),
        source: 'cninfo' as const,
        url: announcementId
          ? `http://www.cninfo.com.cn/new/disclosure/detail?stockCode=${normalized}&announcementId=${announcementId}`
          : undefined,
      };
    })
    .filter((item) => item.title.length > 0);
  return { value: items, source: 'cninfo', sourceUrl: CNINFO_QUERY_URL };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * China A-share 7x24 flash news. Tries Eastmoney → CLS → Sina, falling back on
 * failure. `sortEnd` is Eastmoney's pagination cursor from the previous page.
 */
export async function getFlashNews(limit = 20, sortEnd = ''): Promise<Sourced<NewsItem[]>> {
  const cacheParams = { limit, sortEnd: sortEnd || 'initial' };
  const cached = readCache(FLASH_CACHE, cacheParams, TTL_15M);
  if (cached && isNewsItemArray(cached.data.items)) {
    return { value: cached.data.items, source: readSource(cached.data.source) ?? 'eastmoney', sourceUrl: cached.url };
  }

  const providers: Array<{ source: DomesticSource; run: () => Promise<Sourced<NewsItem[]>> }> = [
    { source: 'eastmoney', run: () => fetchFlashFromEastmoney(limit, sortEnd) },
    { source: 'cls', run: () => fetchFlashFromCls(limit) },
    { source: 'sina', run: () => fetchFlashFromSina(limit) },
  ];

  let lastError: unknown = null;
  for (const provider of providers) {
    if (!sourceAvailable(provider.source)) continue;
    try {
      const result = await provider.run();
      recordSourceSuccess(provider.source);
      writeCache(FLASH_CACHE, cacheParams, { items: result.value, source: result.source }, result.sourceUrl ?? '');
      return result;
    } catch (error) {
      lastError = error;
      recordSourceFailure(provider.source, errorMessage(error));
      logger.warn(`[domestic-search] flash source ${provider.source} failed: ${errorMessage(error)}`);
    }
  }
  throw lastError ?? new Error('All flash news sources are unavailable');
}

/** Eastmoney Guba retail posts for a 6-digit A-share code. */
export async function getGubaSentiment(
  code: string,
  opts: { sort?: 'latest' | 'hot'; limit?: number } = {},
): Promise<Sourced<GubaSentiment>> {
  const sort = opts.sort ?? 'latest';
  const limit = opts.limit ?? 20;
  const normalized = normalizeCode(code);
  const cacheParams = { code: normalized || code, sort, limit };
  const cached = readCache(GUBA_CACHE, cacheParams, TTL_15M);
  if (cached && isGubaSentiment(cached.data.sentiment)) {
    return {
      value: cached.data.sentiment,
      source: readSource(cached.data.source) ?? 'eastmoney',
      sourceUrl: cached.url,
    };
  }
  if (!sourceAvailable('eastmoney')) throw new Error('eastmoney is temporarily unavailable (circuit open)');
  try {
    const result = await fetchGubaSentiment(code, sort, limit);
    recordSourceSuccess('eastmoney');
    writeCache(GUBA_CACHE, cacheParams, { sentiment: result.value, source: result.source }, result.sourceUrl ?? '');
    return result;
  } catch (error) {
    recordSourceFailure('eastmoney', errorMessage(error));
    throw error;
  }
}

/** Keyword news search via Eastmoney's JSONP search endpoint. */
export async function searchDomesticNews(keyword: string, limit = 10): Promise<Sourced<NewsItem[]>> {
  const trimmed = keyword.trim();
  if (!trimmed) throw new Error('keyword is required');
  const cacheParams = { keyword: trimmed, limit };
  const cached = readCache(NEWS_CACHE, cacheParams, TTL_15M);
  if (cached && isNewsItemArray(cached.data.items)) {
    return { value: cached.data.items, source: readSource(cached.data.source) ?? 'eastmoney', sourceUrl: cached.url };
  }
  if (!sourceAvailable('eastmoney')) throw new Error('eastmoney is temporarily unavailable (circuit open)');
  try {
    const result = await fetchNewsFromEastmoney(trimmed, limit);
    recordSourceSuccess('eastmoney');
    writeCache(NEWS_CACHE, cacheParams, { items: result.value, source: result.source }, result.sourceUrl ?? '');
    return result;
  } catch (error) {
    recordSourceFailure('eastmoney', errorMessage(error));
    throw error;
  }
}

/** Official CNINFO announcements for a 6-digit A-share code (last `days`). */
export async function getAnnouncements(
  code: string,
  opts: { limit?: number; days?: number } = {},
): Promise<Sourced<AnnouncementItem[]>> {
  const limit = opts.limit ?? 20;
  const days = opts.days && opts.days > 0 ? opts.days : 90;
  const normalized = normalizeCode(code);
  const cacheParams = { code: normalized || code, limit, days };
  const cached = readCache(ANNOUNCEMENTS_CACHE, cacheParams, TTL_1H);
  if (cached && isAnnouncementItemArray(cached.data.items)) {
    return { value: cached.data.items, source: readSource(cached.data.source) ?? 'cninfo', sourceUrl: cached.url };
  }
  if (!sourceAvailable('cninfo')) throw new Error('cninfo is temporarily unavailable (circuit open)');
  try {
    const result = await fetchAnnouncements(code, limit, days);
    recordSourceSuccess('cninfo');
    writeCache(ANNOUNCEMENTS_CACHE, cacheParams, { items: result.value, source: result.source }, result.sourceUrl ?? '');
    return result;
  } catch (error) {
    recordSourceFailure('cninfo', errorMessage(error));
    throw error;
  }
}

// ─── Licensed (commercial) source extension point ────────────────────────────

/**
 * Adapter shape for a future authoritative licensed source.
 * 后期接入：首选 Tushare Pro / 通联数据（权威授权源优先）。当前不实现具体源。
 */
export interface LicensedSourceAdapter<T> {
  id: string;
  displayName: string;
  fetch(opts: { code?: string; keyword?: string; limit?: number }): Promise<Sourced<T>>;
}

const licensedSources: LicensedSourceAdapter<NewsItem | AnnouncementItem>[] = [];

/** Register a licensed adapter. No-op for now; reserved for future integration. */
export function registerLicensedSource(adapter: LicensedSourceAdapter<NewsItem | AnnouncementItem>): void {
  licensedSources.push(adapter);
}

/** Registered licensed source ids, for diagnostics/prompt descriptions. */
export function listLicensedSources(): string[] {
  return licensedSources.map((adapter) => `${adapter.id}:${adapter.displayName}`);
}

/** Human-readable summary of the free sources and the licensed extension slot. */
export function describeSources(): string {
  const licensed = listLicensedSources();
  const licensedText = licensed.length > 0 ? licensed.join(', ') : '未接入（扩展点已就绪：Tushare Pro / 通联数据）';
  return [
    '免费源: 东方财富快讯(eastmoney) / 财联社(cls) / 新浪财经7x24(sina) / ' +
      '东方财富股吧(eastmoney) / 东财新闻搜索(eastmoney) / 巨潮资讯公告(cninfo, 官方)',
    `授权源: ${licensedText}`,
  ].join('\n');
}
