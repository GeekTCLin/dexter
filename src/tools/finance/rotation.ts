import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { formatValuationRotation } from './formatters.js';
import { getIndexValuation as fetchIndexValuation } from './domestic-index-valuation-api.js';

// E4 — index / industry valuation rotation. Ranks a universe of broad-market and
// 中证全指 industry indices by valuation percentile to surface rotation clues.
// Danjuan does not cover every index; uncovered ones are skipped gracefully.

export interface RotationRow {
  symbol: string;
  name: string;
  pe: number | null;
  pb: number | null;
  pePercentile: number | null;
  pbPercentile: number | null;
  dividendYield: number | null;
  evaluation: string | null;
  valuationDate: string | null;
}

export interface ValuationRotation {
  rows: RotationRow[];
  requested: number;
  source: 'danjuan';
}

export const DEFAULT_ROTATION_UNIVERSE = [
  '000300.SH',
  '000905.SH',
  '000852.SH',
  '000016.SH',
  '000688.SH',
  '399006.SZ',
  '000928.SH',
  '000929.SH',
  '000930.SH',
  '000931.SH',
  '000932.SH',
  '000933.SH',
  '000934.SH',
  '000935.SH',
  '000936.SH',
  '000937.SH',
];

export async function buildValuationRotation(
  symbols: string[],
  limit?: number,
): Promise<{ value: ValuationRotation; sourceUrls: string[] }> {
  const unique = Array.from(new Set(symbols.map((s) => s.trim()).filter((s) => s.length > 0)));
  const results = await Promise.all(
    unique.map(async (symbol) => ({
      symbol,
      result: await fetchIndexValuation(symbol).catch(() => null),
    })),
  );

  const rows: RotationRow[] = [];
  const sourceUrls: string[] = [];
  for (const { result } of results) {
    if (!result) continue;
    if (result.sourceUrl) sourceUrls.push(result.sourceUrl);
    const v = result.value;
    rows.push({
      symbol: v.symbol,
      name: v.name,
      pe: v.pe,
      pb: v.pb,
      pePercentile: v.pePercentile,
      pbPercentile: v.pbPercentile,
      dividendYield: v.dividendYield,
      evaluation: v.evaluation,
      valuationDate: v.valuationDate,
    });
  }

  rows.sort((a, b) => {
    const pa = a.pePercentile ?? Number.POSITIVE_INFINITY;
    const pb = b.pePercentile ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return a.symbol.localeCompare(b.symbol);
  });

  const limited =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;

  return { value: { rows: limited, requested: unique.length, source: 'danjuan' }, sourceUrls };
}

export const VALUATION_ROTATION_DESCRIPTION = `
Ranks a universe of China broad-market and 中证全指 industry indices by valuation percentile (蛋卷 PE/PB 分位), sorted cheapest-first, to surface valuation rotation clues (相对估值/轮动). Returns code, name, PE, PB, PE/PB percentile, dividend yield and 估值状态 per index, plus cheapest/richest hints. Use for 估值轮动, 行业相对估值, 哪个行业便宜, 行业估值分位. Powered by Danjuan, no API key required.
`.trim();

const ValuationRotationInputSchema = z.object({
  symbols: z
    .array(z.string())
    .optional()
    .describe('自定义指数代码列表（如 [\'000300.SH\',\'000905.SH\']）。留空则用默认宽基 + 中证全指行业指数池。'),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('最多返回数量（按 PE 分位从低到高），默认返回全部覆盖到的指数。'),
});

export const getValuationRotation = new DynamicStructuredTool({
  name: 'get_valuation_rotation',
  description:
    'Ranks China broad-market + 中证全指 industry indices by valuation percentile (cheapest first) for rotation clues. Key-less (Danjuan).',
  schema: ValuationRotationInputSchema,
  func: async (input) => {
    const symbols =
      input.symbols && input.symbols.length > 0 ? input.symbols : DEFAULT_ROTATION_UNIVERSE;
    const { value, sourceUrls } = await buildValuationRotation(symbols, input.limit);
    return formatToolResult(
      formatValuationRotation(value),
      sourceUrls.length > 0 ? sourceUrls : ['https://danjuanfunds.com/'],
    );
  },
});
