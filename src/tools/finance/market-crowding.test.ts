import { describe, test, expect } from 'bun:test';
import { buildMarketCrowding } from './market-crowding.js';
import type { MarginData, MarginRow, MarketBreadth } from './domestic-market-api.js';

function breadth(partial: Partial<MarketBreadth>): MarketBreadth {
  return {
    tradeDate: '2026-09-12',
    up: 0,
    down: 0,
    flat: 0,
    total: 0,
    limitUp: null,
    limitDown: null,
    shAmount: null,
    szAmount: null,
    turnover: null,
    source: 'eastmoney',
    ...partial,
  } as MarketBreadth;
}

function marginRow(partial: Partial<MarginRow>): MarginRow {
  return {
    date: '2026-09-12',
    financingBalance: null,
    marginBalance: null,
    financingBuy: null,
    financingRepay: null,
    financingNet: null,
    securitiesLendingBalance: null,
    financingBalanceRatio: null,
    source: 'eastmoney',
    ...partial,
  } as MarginRow;
}

describe('buildMarketCrowding', () => {
  test('computes participation and crowding labels with margin momentum', () => {
    const b = breadth({
      up: 3500,
      down: 1400,
      flat: 100,
      total: 5000,
      limitUp: 200,
      limitDown: 5,
      turnover: 1.5e12,
    });
    const rows = [
      marginRow({ date: '2026-09-12', financingBalanceRatio: 3.0, financingBalance: 1.5e12, financingNet: 1e9 }),
      marginRow({ date: '2026-09-01', financingBalanceRatio: 2.0, financingBalance: 1.4e12 }),
    ];
    const margin = { rows, latest: rows[0] } as MarginData;

    const c = buildMarketCrowding(b, margin);
    expect(c.advanceRatio).toBe(70);
    expect(c.participation.level).toBe('broad-rally');
    expect(c.limitUpRatio).toBeCloseTo(4, 5);
    expect(c.margin?.ratioChangePp).toBeCloseTo(1, 5);
    expect(c.crowding.score).toBe(64);
    expect(c.crowding.level).toBe('high');
    expect(c.notes.some((n) => n.includes('过热'))).toBe(true);
  });

  test('degrades gracefully without margin data', () => {
    const b = breadth({ up: 2000, down: 2000, flat: 1000, total: 5000, limitUp: 20, limitDown: 20 });
    const c = buildMarketCrowding(b, null);
    expect(c.margin).toBeNull();
    expect(c.advanceRatio).toBe(40);
    expect(c.participation.level).toBe('weak');
    expect(c.crowding.level).toBe('low');
    expect(c.notes.length).toBeGreaterThan(0);
  });
});
