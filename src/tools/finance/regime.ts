import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { readCache, writeCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { formatToolResult } from '../types.js';
import { decodeGbk, getIndexBars, resolveIndex, type IndexBar } from './domestic-index-api.js';
import { getIndexValuation, type IndexValuation } from './domestic-index-valuation-api.js';
import {
  getMarketBreadth,
  getMarginData,
  type MarginData,
  type MarketBreadth,
} from './domestic-market-api.js';
import { buildMarketCrowding, type CrowdingLevel } from './market-crowding.js';
import { formatMarketRegime } from './formatters.js';
import { TTL_24H } from './utils.js';

// E7 — market regime / state identification. Combines four independent reads
// into one risk-on / neutral / risk-off label: index trend (moving averages),
// index valuation percentile (蛋卷), breadth-derived crowding, and a monthly PMI
// macro proxy. Every input degrades to null; the tool still returns a label.

export type RegimeLabel = 'risk-on' | 'neutral' | 'risk-off';
export type TrendLabel = 'up' | 'down' | 'range';

export interface PmiData {
  date: string | null;
  manufacturing: number | null;
  nonManufacturing: number | null;
}

export interface MarketRegime {
  asOf: string | null;
  symbol: string;
  indexName: string | null;
  price: number | null;
  ma20: number | null;
  ma60: number | null;
  ma200: number | null;
  trend: TrendLabel;
  valuationPercentile: number | null;
  crowdingLevel: CrowdingLevel | null;
  pmi: PmiData | null;
  score: number;
  regime: RegimeLabel;
  reasons: string[];
  notes: string[];
  source: 'eastmoney';
}

export interface MarketRegimeInput {
  symbol: string;
  indexName?: string | null;
  bars: IndexBar[];
  valuation: IndexValuation | null;
  breadth: MarketBreadth;
  margin: MarginData | null;
  pmi: PmiData | null;
}

const PMI_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const PMI_CACHE_ENDPOINT = '/domestic-market/pmi/';
const DEFAULT_INDEX = '000300.SH';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

// Average of the last `n` closes, or null when there is not enough history.
export function movingAverage(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  return mean(closes.slice(closes.length - n));
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function classifyTrend(price: number | null, ma20: number | null, ma60: number | null, ma200: number | null): TrendLabel {
  if (price === null) return 'range';
  const aboveLong = ma200 === null ? null : price > ma200;
  const shortVsLong = ma20 !== null && ma60 !== null ? ma20 > ma60 : null;
  if (aboveLong === true && shortVsLong !== false) return 'up';
  if (aboveLong === false && shortVsLong !== true) return 'down';
  return 'range';
}

export function buildMarketRegime(input: MarketRegimeInput): MarketRegime {
  const closes = input.bars.map((bar) => bar.close);
  const price = closes.length > 0 ? closes[closes.length - 1] : null;
  const ma20 = movingAverage(closes, 20);
  const ma60 = movingAverage(closes, 60);
  const ma200 = movingAverage(closes, 200);
  const trend = classifyTrend(price, ma20, ma60, ma200);

  const valuationPercentile = input.valuation?.pePercentile ?? null;
  const crowding = buildMarketCrowding(input.breadth, input.margin);

  const reasons: string[] = [];
  const notes: string[] = [];

  let score = 50;

  if (trend === 'up') {
    score += 20;
    reasons.push('指数位于长期均线上方且中短期均线多头');
  } else if (trend === 'down') {
    score -= 20;
    reasons.push('指数位于长期均线下方且中短期均线空头');
  } else {
    reasons.push('指数趋势中性（均线交织）');
    if (ma200 === null) notes.push('历史K线不足 200 日，长期趋势判断降级');
  }

  if (valuationPercentile !== null) {
    const tilt = clamp((50 - valuationPercentile) * 0.4, -15, 15);
    score += tilt;
    reasons.push(
      valuationPercentile <= 30
        ? `估值处于历史低位（PE 分位 ${valuationPercentile.toFixed(0)}%）`
        : valuationPercentile >= 70
          ? `估值处于历史高位（PE 分位 ${valuationPercentile.toFixed(0)}%）`
          : `估值居中（PE 分位 ${valuationPercentile.toFixed(0)}%）`,
    );
  } else {
    notes.push('缺少指数估值数据');
  }

  if (crowding.crowding.level === 'high') {
    score -= 10;
    reasons.push(`市场拥挤度偏高（评分 ${crowding.crowding.score}）`);
  } else if (crowding.crowding.level === 'low') {
    score += 5;
    reasons.push(`市场拥挤度偏低（评分 ${crowding.crowding.score}）`);
  } else {
    reasons.push(`市场拥挤度中性（评分 ${crowding.crowding.score}）`);
  }

  if (input.pmi && input.pmi.manufacturing !== null) {
    if (input.pmi.manufacturing >= 50) {
      score += 10;
      reasons.push(`制造业PMI ${input.pmi.manufacturing} 处于扩张区间`);
    } else if (input.pmi.manufacturing < 49.5) {
      score -= 10;
      reasons.push(`制造业PMI ${input.pmi.manufacturing} 处于收缩区间`);
    } else {
      reasons.push(`制造业PMI ${input.pmi.manufacturing} 接近荣枯线`);
    }
  } else {
    notes.push('缺少宏观（PMI）数据');
  }

  score = Math.round(clamp(score, 0, 100));
  const regime: RegimeLabel = score >= 65 ? 'risk-on' : score <= 35 ? 'risk-off' : 'neutral';

  const asOf = input.breadth.tradeDate ?? input.valuation?.valuationDate ?? input.bars[input.bars.length - 1]?.date ?? null;

  return {
    asOf,
    symbol: input.symbol,
    indexName: input.indexName ?? input.valuation?.name ?? null,
    price,
    ma20,
    ma60,
    ma200,
    trend,
    valuationPercentile,
    crowdingLevel: crowding.crowding.level,
    pmi: input.pmi,
    score,
    regime,
    reasons,
    notes,
    source: 'eastmoney',
  };
}

function isPmiData(value: unknown): value is PmiData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const okNum = (x: unknown) => x === null || typeof x === 'number';
  return okNum(v.manufacturing) && okNum(v.nonManufacturing);
}

interface PmiPayloadRow {
  REPORT_DATE?: unknown;
  MAKE_INDEX?: unknown;
  NMAKE_INDEX?: unknown;
}

// Monthly PMI proxy for the macro leg. Uses the same datacenter endpoint as the
// other market tools; any failure degrades to null rather than throwing.
async function fetchPmi(): Promise<PmiData | null> {
  const cached = readCache(PMI_CACHE_ENDPOINT, {}, TTL_24H);
  if (cached && isPmiData(cached.data.pmi)) return cached.data.pmi;

  const url =
    `${PMI_URL}?reportName=RPT_ECONOMY_PMI&columns=ALL` +
    '&sortColumns=REPORT_DATE&sortTypes=-1&pageSize=2&pageNumber=1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': process.env.DOMESTIC_MARKET_UA || DEFAULT_UA, Referer: 'https://data.eastmoney.com/' },
    });
    if (!res.ok) throw new Error(`Eastmoney PMI HTTP ${res.status}`);
    const payload = JSON.parse(decodeGbk(await res.arrayBuffer())) as {
      result?: { data?: PmiPayloadRow[] } | null;
    };
    const row = payload.result?.data?.[0];
    if (!row) throw new Error('Eastmoney PMI returned no data');
    const toNum = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const pmi: PmiData = {
      date: typeof row.REPORT_DATE === 'string' ? row.REPORT_DATE.slice(0, 10) : null,
      manufacturing: toNum(row.MAKE_INDEX),
      nonManufacturing: toNum(row.NMAKE_INDEX),
    };
    writeCache(PMI_CACHE_ENDPOINT, {}, { pmi }, url);
    return pmi;
  } catch (error) {
    logger.warn(`[regime] PMI fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const MARKET_REGIME_DESCRIPTION = `
Identifies the China A-share market regime (risk-on / neutral / risk-off) by combining four independent reads: index trend from moving averages (MA20/MA60/MA200), index valuation percentile (蛋卷 PE 分位), breadth-derived crowding (拥挤度), and a monthly PMI macro proxy. Use for 市场状态, 择时, 风险偏好, 该进攻还是防守, regime, 当前市场环境. Returns a 0-100 score with the reasons behind it. Powered by Eastmoney / 蛋卷, no API key required.
`.trim();

const MarketRegimeInputSchema = z.object({
  index: z
    .string()
    .optional()
    .describe("用于判断趋势的宽基指数，如 '沪深300'、'000300.SH'，默认沪深300。"),
});

export const getMarketRegime = new DynamicStructuredTool({
  name: 'get_market_regime',
  description:
    'China A-share market regime (risk-on/neutral/risk-off) from index trend, valuation percentile, crowding and PMI. Key-less (Eastmoney / 蛋卷).',
  schema: MarketRegimeInputSchema,
  func: async (input) => {
    const query = input.index && input.index.trim() ? input.index.trim() : DEFAULT_INDEX;
    const def = resolveIndex(query);
    if (!def) throw new Error(`Unknown index: ${query}`);
    const end = new Date();
    const start = new Date(end.getTime() - 400 * 24 * 60 * 60 * 1000);
    const startDate = formatDate(start);
    const endDate = formatDate(end);

    const [bars, valuation, breadth, margin, pmi] = await Promise.all([
      getIndexBars(def.symbol, 'day', startDate, endDate).catch((error) => {
        logger.warn(`[regime] index bars failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
      getIndexValuation(def.symbol).catch(() => null),
      getMarketBreadth(),
      getMarginData(20).catch(() => null),
      fetchPmi(),
    ]);

    const value = buildMarketRegime({
      symbol: def.symbol,
      indexName: def.name,
      bars: bars?.value ?? [],
      valuation: valuation?.value ?? null,
      breadth: breadth.value,
      margin: margin?.value ?? null,
      pmi,
    });

    const sourceUrls = [breadth.sourceUrl];
    if (bars) sourceUrls.push(bars.sourceUrl);
    if (valuation) sourceUrls.push(valuation.sourceUrl);
    if (margin) sourceUrls.push(margin.sourceUrl);
    return formatToolResult(formatMarketRegime(value), sourceUrls);
  },
});
