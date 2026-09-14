import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { formatMarketCrowding } from './formatters.js';
import {
  getMarketBreadth as fetchMarketBreadth,
  getMarginData as fetchMarginData,
  type MarginData,
  type MarketBreadth,
} from './domestic-market-api.js';

// E5 — market participation / crowding. No new upstream endpoint: it is a pure
// aggregation over market breadth (涨跌家数/涨跌停/成交额) and margin financing
// (两融), producing coarse participation and crowding labels plus the inputs.

export type CrowdingLevel = 'low' | 'medium' | 'high';
export type ParticipationLevel = 'broad-rally' | 'strong' | 'mixed' | 'weak' | 'broad-decline';

export interface MarketCrowding {
  tradeDate: string | null;
  up: number;
  down: number;
  flat: number;
  total: number;
  advanceRatio: number | null;
  limitUp: number | null;
  limitDown: number | null;
  limitUpRatio: number | null;
  limitDownRatio: number | null;
  turnover: number | null;
  participation: { score: number | null; level: ParticipationLevel };
  crowding: { score: number | null; level: CrowdingLevel };
  margin: {
    date: string | null;
    financingBalance: number | null;
    financingBalanceRatio: number | null;
    financingNet: number | null;
    marginBalance: number | null;
    ratioChangePp: number | null;
  } | null;
  notes: string[];
  source: 'eastmoney';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function participationLevel(advanceRatio: number | null): ParticipationLevel {
  if (advanceRatio === null) return 'mixed';
  if (advanceRatio >= 70) return 'broad-rally';
  if (advanceRatio >= 55) return 'strong';
  if (advanceRatio >= 45) return 'mixed';
  if (advanceRatio >= 30) return 'weak';
  return 'broad-decline';
}

function crowdingLevel(score: number): CrowdingLevel {
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

function latestTwoMargin(rows: { financingBalanceRatio: number | null }[]): number | null {
  if (rows.length < 2) return null;
  const newest = rows[0].financingBalanceRatio;
  const oldest = rows[rows.length - 1].financingBalanceRatio;
  if (newest === null || oldest === null) return null;
  return newest - oldest;
}

export function buildMarketCrowding(
  breadth: MarketBreadth,
  margin: MarginData | null,
): MarketCrowding {
  const advanceRatio = breadth.total > 0 ? (breadth.up / breadth.total) * 100 : null;
  const limitUpRatio =
    breadth.total > 0 && breadth.limitUp !== null ? (breadth.limitUp / breadth.total) * 100 : null;
  const limitDownRatio =
    breadth.total > 0 && breadth.limitDown !== null
      ? (breadth.limitDown / breadth.total) * 100
      : null;

  const latestMargin = margin?.latest ?? null;
  const ratioChangePp = margin ? latestTwoMargin(margin.rows) : null;

  const notes: string[] = [];
  let crowdingScore = 0;
  if (limitUpRatio !== null) {
    crowdingScore += clamp(limitUpRatio * 10, 0, 40);
  } else {
    notes.push('涨停家数不可用，拥挤度仅基于两融口径');
  }
  if (latestMargin?.financingBalanceRatio !== null && latestMargin?.financingBalanceRatio !== undefined) {
    crowdingScore += clamp((latestMargin.financingBalanceRatio - 1.5) * 12, 0, 30);
  } else {
    notes.push('融资余额占流通市值不可用');
  }
  if (ratioChangePp !== null) {
    crowdingScore += clamp(ratioChangePp * 6, 0, 30);
  }
  crowdingScore = Math.round(clamp(crowdingScore, 0, 100));

  if (advanceRatio !== null && advanceRatio >= 70 && (breadth.limitUp ?? 0) > 60) {
    notes.push('普涨且涨停家数偏多，短期情绪可能过热');
  }

  return {
    tradeDate: breadth.tradeDate,
    up: breadth.up,
    down: breadth.down,
    flat: breadth.flat,
    total: breadth.total,
    advanceRatio,
    limitUp: breadth.limitUp,
    limitDown: breadth.limitDown,
    limitUpRatio,
    limitDownRatio,
    turnover: breadth.turnover,
    participation: { score: advanceRatio === null ? null : Math.round(advanceRatio), level: participationLevel(advanceRatio) },
    crowding: { score: crowdingScore, level: crowdingLevel(crowdingScore) },
    margin: latestMargin
      ? {
          date: latestMargin.date,
          financingBalance: latestMargin.financingBalance,
          financingBalanceRatio: latestMargin.financingBalanceRatio,
          financingNet: latestMargin.financingNet,
          marginBalance: latestMargin.marginBalance,
          ratioChangePp,
        }
      : null,
    notes,
    source: 'eastmoney',
  };
}

export const MARKET_CROWDING_DESCRIPTION = `
Aggregates China A-share market participation and crowding from market breadth (涨跌家数/涨跌停/两市成交额) and margin financing (两融). Returns a participation label (普涨/偏强/分化/偏弱/普跌), a crowding label (高/中/低) with a 0-100 score built from limit-up ratio, financing balance as a share of free-float market cap, and its change over the window. Use for 市场情绪, 参与度, 拥挤度, 过热, 杠杆水平. Powered by Eastmoney, no API key required.
`.trim();

const MarketCrowdingInputSchema = z.object({
  days: z
    .number()
    .int()
    .positive()
    .max(60)
    .optional()
    .describe('两融窗口天数，默认 20，用于计算融资余额占流通市值的变化（pp）。'),
});

export const getMarketCrowding = new DynamicStructuredTool({
  name: 'get_market_crowding',
  description:
    'China A-share market participation / crowding: breadth-derived participation label plus a crowding score from limit-ups and margin-financing ratio. Key-less (Eastmoney).',
  schema: MarketCrowdingInputSchema,
  func: async (input) => {
    const [breadth, margin] = await Promise.all([
      fetchMarketBreadth(),
      fetchMarginData(input.days ?? 20),
    ]);
    const value = buildMarketCrowding(breadth.value, margin.value);
    return formatToolResult(formatMarketCrowding(value), [breadth.sourceUrl, margin.sourceUrl]);
  },
});
