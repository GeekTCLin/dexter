import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { formatAssetAllocation } from './formatters.js';
import { getEtfEvaluation as fetchEtfEvaluation, type EtfMetrics } from './etf-eval-api.js';
import { getIndexValuation as fetchIndexValuation } from './domestic-index-valuation-api.js';

// E9: a rules-based equity/bond + core-satellite allocation model. The weights
// come from a deterministic, testable rule set; the ETF picks reuse the keyless
// index map / ETF evaluation clients. Valuation is best-effort enrichment.

export type RiskLevel = 'conservative' | 'balanced' | 'aggressive';

export interface AllocationSleeve {
  key: 'core' | 'satellite' | 'bond';
  label: string;
  weightPercent: number;
  target: string;
  etfCode: string | null;
  etfName: string | null;
  etfScale: number | null;
}

export interface AllocationValuation {
  symbol: string;
  name: string;
  pe: number | null;
  pePercentile: number | null;
  pbPercentile: number | null;
  evaluation: string | null;
}

export interface AssetAllocationPlan {
  riskLevel: RiskLevel;
  baseEquityPercent: number;
  equityWeightPercent: number;
  bondWeightPercent: number;
  valuationTiltPercent: number;
  coreIndexName: string;
  satelliteIndexName: string | null;
  sleeves: AllocationSleeve[];
  valuation: AllocationValuation | null;
  rationale: string[];
  notes: string[];
}

export interface AssetAllocationOptions {
  riskLevel?: RiskLevel;
  equityWeight?: number;
  coreIndex?: string;
  satelliteIndex?: string;
  includeEtf?: boolean;
  bondCodes?: string[];
}

export interface AssetAllocationResult {
  plan: AssetAllocationPlan;
  sourceUrls: string[];
}

const BASE_EQUITY: Record<RiskLevel, number> = {
  conservative: 30,
  balanced: 60,
  aggressive: 80,
};

const MAX_TILT_PERCENT = 15;
const TILT_SENSITIVITY = 0.3;
const MIN_EQUITY_PERCENT = 5;
const MAX_EQUITY_PERCENT = 95;
const SATELLITE_SHARE = 0.3;
const DEFAULT_BOND_CODES = ['511010', '511260'];

const RISK_LABELS: Record<RiskLevel, string> = {
  conservative: 'conservative（稳健型）',
  balanced: 'balanced（平衡型）',
  aggressive: 'aggressive（进取型）',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeRiskLevel(value: string | undefined): RiskLevel {
  if (value === 'conservative' || value === 'aggressive') return value;
  return 'balanced';
}

// Base equity weight by risk profile, then tilt against the benchmark's PE
// percentile: cheap (low percentile) -> add equity, expensive -> cut equity.
export function computeEquityWeight(
  riskLevel: RiskLevel,
  pePercentile: number | null,
  override?: number,
): { equityWeightPercent: number; baseEquityPercent: number; valuationTiltPercent: number } {
  const baseEquityPercent = BASE_EQUITY[riskLevel];
  if (override !== undefined && Number.isFinite(override)) {
    const equityWeightPercent = clamp(override, MIN_EQUITY_PERCENT, MAX_EQUITY_PERCENT);
    return { equityWeightPercent, baseEquityPercent, valuationTiltPercent: 0 };
  }
  if (pePercentile === null || !Number.isFinite(pePercentile)) {
    return { equityWeightPercent: baseEquityPercent, baseEquityPercent, valuationTiltPercent: 0 };
  }
  const valuationTiltPercent = clamp(
    (50 - pePercentile) * TILT_SENSITIVITY,
    -MAX_TILT_PERCENT,
    MAX_TILT_PERCENT,
  );
  const equityWeightPercent = clamp(
    baseEquityPercent + valuationTiltPercent,
    MIN_EQUITY_PERCENT,
    MAX_EQUITY_PERCENT,
  );
  return { equityWeightPercent, baseEquityPercent, valuationTiltPercent };
}

// Prefer the largest fund; break ties (and missing scale) on lower tracking error.
export function pickBestEtf(etfs: EtfMetrics[]): EtfMetrics | null {
  if (etfs.length === 0) return null;
  return [...etfs].sort((a, b) => {
    const scaleA = a.scale ?? -1;
    const scaleB = b.scale ?? -1;
    if (scaleB !== scaleA) return scaleB - scaleA;
    const teA = a.trackingError ?? Number.POSITIVE_INFINITY;
    const teB = b.trackingError ?? Number.POSITIVE_INFINITY;
    return teA - teB;
  })[0];
}

function toRecommendation(sleeve: AllocationSleeve, etf: EtfMetrics | null): AllocationSleeve {
  if (!etf) return sleeve;
  return { ...sleeve, etfCode: etf.code, etfName: etf.name, etfScale: etf.scale };
}

async function recommendIndexEtf(
  index: string,
  sourceUrls: string[],
): Promise<EtfMetrics | null> {
  try {
    const result = await fetchEtfEvaluation({ index, limit: 3, windowDays: 90, includeFees: false });
    sourceUrls.push(result.sourceUrl);
    return pickBestEtf(result.value.etfs);
  } catch {
    return null;
  }
}

async function recommendCodeEtfs(
  codes: string[],
  sourceUrls: string[],
): Promise<EtfMetrics | null> {
  if (codes.length === 0) return null;
  try {
    const result = await fetchEtfEvaluation({
      codes,
      limit: codes.length,
      windowDays: 90,
      includeFees: false,
    });
    sourceUrls.push(result.sourceUrl);
    return pickBestEtf(result.value.etfs);
  } catch {
    return null;
  }
}

export async function buildAssetAllocationPlan(
  opts: AssetAllocationOptions = {},
): Promise<AssetAllocationResult> {
  const riskLevel = normalizeRiskLevel(opts.riskLevel);
  const coreIndex = opts.coreIndex?.trim() || '沪深300';
  const satelliteIndex = opts.satelliteIndex?.trim() || null;
  const includeEtf = opts.includeEtf !== false;
  const bondCodes = (opts.bondCodes ?? DEFAULT_BOND_CODES).map((c) => c.trim()).filter(Boolean);

  const sourceUrls: string[] = [];

  const valuationResult = await fetchIndexValuation(coreIndex).catch(() => null);
  if (valuationResult) sourceUrls.push(valuationResult.sourceUrl);
  const pePercentile = valuationResult?.value.pePercentile ?? null;

  const { equityWeightPercent, baseEquityPercent, valuationTiltPercent } = computeEquityWeight(
    riskLevel,
    pePercentile,
    opts.equityWeight,
  );
  const bondWeightPercent = Number((100 - equityWeightPercent).toFixed(1));

  const coreShare = satelliteIndex ? 1 - SATELLITE_SHARE : 1;
  const satelliteShare = satelliteIndex ? SATELLITE_SHARE : 0;
  const coreWeight = Number((equityWeightPercent * coreShare).toFixed(1));
  const satelliteWeight = Number((equityWeightPercent * satelliteShare).toFixed(1));

  const sleeves: AllocationSleeve[] = [
    {
      key: 'core',
      label: '核心权益',
      weightPercent: coreWeight,
      target: valuationResult?.value.name ?? coreIndex,
      etfCode: null,
      etfName: null,
      etfScale: null,
    },
  ];
  if (satelliteIndex) {
    sleeves.push({
      key: 'satellite',
      label: '卫星权益',
      weightPercent: satelliteWeight,
      target: satelliteIndex,
      etfCode: null,
      etfName: null,
      etfScale: null,
    });
  }
  sleeves.push({
    key: 'bond',
    label: '债券',
    weightPercent: bondWeightPercent,
    target: '国债/信用债 ETF',
    etfCode: null,
    etfName: null,
    etfScale: null,
  });

  if (includeEtf) {
    const coreEtf = await recommendIndexEtf(coreIndex, sourceUrls);
    sleeves[0] = toRecommendation(sleeves[0], coreEtf);
    if (satelliteIndex) {
      const satelliteEtf = await recommendIndexEtf(satelliteIndex, sourceUrls);
      const idx = sleeves.findIndex((s) => s.key === 'satellite');
      sleeves[idx] = toRecommendation(sleeves[idx], satelliteEtf);
    }
    const bondEtf = await recommendCodeEtfs(bondCodes, sourceUrls);
    const bondIdx = sleeves.findIndex((s) => s.key === 'bond');
    sleeves[bondIdx] = toRecommendation(sleeves[bondIdx], bondEtf);
  }

  const valuation: AllocationValuation | null = valuationResult
    ? {
        symbol: valuationResult.value.symbol,
        name: valuationResult.value.name,
        pe: valuationResult.value.pe,
        pePercentile: valuationResult.value.pePercentile,
        pbPercentile: valuationResult.value.pbPercentile,
        evaluation: valuationResult.value.evaluation,
      }
    : null;

  const rationale: string[] = [
    `风险等级 ${RISK_LABELS[riskLevel]}，基准权益仓位 ${baseEquityPercent}%。`,
  ];
  if (valuation) {
    const pctText = valuation.pePercentile !== null ? `${valuation.pePercentile.toFixed(1)}%` : '—';
    const tiltText =
      valuationTiltPercent === 0
        ? '不调整'
        : `${valuationTiltPercent > 0 ? '+' : ''}${valuationTiltPercent.toFixed(1)}pp`;
    rationale.push(
      `${valuation.name} PE 历史分位 ${pctText}（${valuation.evaluation ?? '—'}），按估值倾斜规则调整 ${tiltText}。`,
    );
  } else {
    rationale.push('未取到基准指数估值，按风险等级基准仓位配置。');
  }
  if (satelliteIndex) {
    rationale.push(
      `权益内部核心/卫星 = ${Math.round(coreShare * 100)}% / ${Math.round(satelliteShare * 100)}%。`,
    );
  } else {
    rationale.push('未指定卫星指数，权益部分全部配置核心宽基。');
  }

  const plan: AssetAllocationPlan = {
    riskLevel,
    baseEquityPercent,
    equityWeightPercent,
    bondWeightPercent,
    valuationTiltPercent,
    coreIndexName: valuation?.name ?? coreIndex,
    satelliteIndexName: satelliteIndex,
    sleeves,
    valuation,
    rationale,
    notes: [
      '配置比例为规则化模型输出，未做均值方差/风险平价优化，也未纳入个人资产负债、现金流与税收。',
      '估值倾斜基于指数 PE 历史分位（蛋卷），分位缺失时退回基准仓位。',
      'ETF 推荐基于规模优先、跟踪误差次优，仅作示例标的，不构成推荐。',
      '本内容仅供研究参考，非投资建议。',
    ],
  };

  return { plan, sourceUrls };
}

export const ASSET_ALLOCATION_DESCRIPTION = `
Builds an equity/bond and core-satellite allocation plan for a China A-share investor. Given a risk level (or an explicit equity weight) and a core index, it sets a rules-based target mix, tilts equity versus bonds using the index's PE valuation percentile, splits equity into core/satellite sleeves, and — when requested — suggests the most liquid/lowest-tracking-error ETF for each sleeve. Use for 资产配置, 股债配置, 核心卫星, 怎么配比, 稳健/平衡/进取组合, 股债比例建议. Key-less. Not investment advice.
`.trim();

const AssetAllocationInputSchema = z.object({
  risk_level: z
    .enum(['conservative', 'balanced', 'aggressive'])
    .optional()
    .describe('风险偏好：conservative/balanced/aggressive，默认 balanced。'),
  equity_weight: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('直接指定权益目标仓位（%），给出后忽略 risk_level 的基准与估值倾斜。'),
  core_index: z
    .string()
    .optional()
    .describe("核心宽基指数，默认 '沪深300'（如 中证500、中证A500）。"),
  satellite_index: z
    .string()
    .optional()
    .describe('卫星指数（可选，如 中证白酒、科创50）；给出后权益按核心 70% / 卫星 30% 拆分。'),
  include_etf: z
    .boolean()
    .optional()
    .describe('是否为每个仓位挑选示例 ETF（需要额外网络请求，默认 true）。'),
  bond_codes: z
    .array(z.string())
    .optional()
    .describe("债券 ETF 候选代码，默认 ['511010','511260']。"),
});

export const getAssetAllocation = new DynamicStructuredTool({
  name: 'get_asset_allocation',
  description:
    'Rules-based equity/bond + core-satellite allocation plan with valuation tilt and optional ETF picks. Key-less.',
  schema: AssetAllocationInputSchema,
  func: async (input) => {
    const { plan, sourceUrls } = await buildAssetAllocationPlan({
      riskLevel: input.risk_level,
      equityWeight: input.equity_weight,
      coreIndex: input.core_index,
      satelliteIndex: input.satellite_index,
      includeEtf: input.include_etf,
      bondCodes: input.bond_codes,
    });
    return formatToolResult(formatAssetAllocation(plan), sourceUrls);
  },
});
