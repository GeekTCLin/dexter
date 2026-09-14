import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import {
  buildAssetAllocationPlan,
  computeEquityWeight,
  pickBestEtf,
  normalizeRiskLevel,
} from './asset-allocation.js';
import type { EtfMetrics } from './etf-eval-api.js';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function etf(partial: Partial<EtfMetrics>): EtfMetrics {
  return { code: '000000', name: 'x', ...partial } as unknown as EtfMetrics;
}

describe('normalizeRiskLevel', () => {
  test('defaults unknown values to balanced', () => {
    expect(normalizeRiskLevel('aggressive')).toBe('aggressive');
    expect(normalizeRiskLevel('conservative')).toBe('conservative');
    expect(normalizeRiskLevel('nonsense')).toBe('balanced');
    expect(normalizeRiskLevel(undefined)).toBe('balanced');
  });
});

describe('computeEquityWeight', () => {
  test('uses the base weight when no percentile is available', () => {
    expect(computeEquityWeight('balanced', null)).toEqual({
      equityWeightPercent: 60,
      baseEquityPercent: 60,
      valuationTiltPercent: 0,
    });
  });

  test('adds equity when the index is cheap', () => {
    const result = computeEquityWeight('balanced', 20);
    expect(result.valuationTiltPercent).toBeCloseTo(9, 5);
    expect(result.equityWeightPercent).toBeCloseTo(69, 5);
  });

  test('cuts equity when the index is expensive', () => {
    const result = computeEquityWeight('balanced', 90);
    expect(result.valuationTiltPercent).toBeCloseTo(-12, 5);
    expect(result.equityWeightPercent).toBeCloseTo(48, 5);
  });

  test('clamps the tilt and the resulting weight', () => {
    const result = computeEquityWeight('aggressive', 0);
    expect(result.valuationTiltPercent).toBe(15);
    expect(result.equityWeightPercent).toBe(95);
  });

  test('an explicit equity weight overrides the model', () => {
    expect(computeEquityWeight('balanced', 20, 40)).toEqual({
      equityWeightPercent: 40,
      baseEquityPercent: 60,
      valuationTiltPercent: 0,
    });
  });
});

describe('pickBestEtf', () => {
  test('prefers the largest fund', () => {
    const best = pickBestEtf([
      etf({ code: 'a', scale: 100, trackingError: 0.1 }),
      etf({ code: 'b', scale: 300, trackingError: 0.5 }),
    ]);
    expect(best?.code).toBe('b');
  });

  test('breaks scale ties on lower tracking error', () => {
    const best = pickBestEtf([
      etf({ code: 'a', scale: 200, trackingError: 0.9 }),
      etf({ code: 'b', scale: 200, trackingError: 0.2 }),
    ]);
    expect(best?.code).toBe('b');
  });

  test('returns null for an empty list', () => {
    expect(pickBestEtf([])).toBeNull();
  });
});

describe('buildAssetAllocationPlan', () => {
  beforeEach(() => {
    rmSync(dexterPath('cache'), { recursive: true, force: true });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('danjuanfunds.com')) {
        return jsonResponse({
          data: {
            name: '沪深300',
            pe: 12.3,
            pb: 1.4,
            yeild: 2.1,
            pe_percentile: 25,
            pb_percentile: 30,
            roe: 11,
            peg: 1.0,
            bond_yeild: 2.5,
            eva_type: '偏低',
            date: '2026-09-11',
            begin_at: Date.now() - 10 * 365.25 * 24 * 3600 * 1000,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('tilts the balanced plan toward equity when valuation is cheap', async () => {
    const { plan } = await buildAssetAllocationPlan({
      riskLevel: 'balanced',
      coreIndex: '沪深300',
      includeEtf: false,
    });

    expect(plan.baseEquityPercent).toBe(60);
    expect(plan.equityWeightPercent).toBeCloseTo(67.5, 5);
    expect(plan.bondWeightPercent).toBeCloseTo(32.5, 5);
    expect(plan.valuation?.pePercentile).toBe(25);
    expect(plan.satelliteIndexName).toBeNull();
    expect(plan.sleeves.map((s) => s.key)).toEqual(['core', 'bond']);
    expect(plan.sleeves[0].weightPercent).toBeCloseTo(67.5, 5);
    expect(plan.sleeves[1].weightPercent).toBeCloseTo(32.5, 5);
    expect(plan.rationale.length).toBeGreaterThanOrEqual(2);
  });

  test('splits equity into core and satellite sleeves', async () => {
    const { plan } = await buildAssetAllocationPlan({
      riskLevel: 'balanced',
      coreIndex: '沪深300',
      satelliteIndex: '科创50',
      includeEtf: false,
    });

    expect(plan.satelliteIndexName).toBe('科创50');
    expect(plan.sleeves.map((s) => s.key)).toEqual(['core', 'satellite', 'bond']);
    expect(plan.sleeves[0].weightPercent).toBeCloseTo(47.3, 1);
    expect(plan.sleeves[1].weightPercent).toBeCloseTo(20.3, 1);
  });
});
