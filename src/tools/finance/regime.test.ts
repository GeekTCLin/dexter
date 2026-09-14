import { describe, test, expect } from 'bun:test';
import { buildMarketRegime, movingAverage } from './regime.js';
import type { IndexBar } from './domestic-index-api.js';
import type { IndexValuation } from './domestic-index-valuation-api.js';
import type { MarginData, MarginRow, MarketBreadth } from './domestic-market-api.js';

function bars(closes: number[]): IndexBar[] {
  return closes.map((c, i) => ({
    date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c,
    close: c,
    high: c,
    low: c,
    volume: 0,
    amount: 0,
    changePercent: 0,
  }));
}

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

function valuation(pePercentile: number): IndexValuation {
  return {
    symbol: '000300.SH',
    name: 'CSI300',
    pe: 12,
    pb: 1.4,
    dividendYield: 2.5,
    pePercentile,
    pbPercentile: 18,
    roe: 11,
    peg: 1,
    bondYield: 2,
    evaluation: 'mid',
    valuationDate: '2026-09-12',
    historyYears: 10,
    source: 'danjuan',
  } as IndexValuation;
}

describe('movingAverage', () => {
  test('averages the last n closes or returns null', () => {
    expect(movingAverage([1, 2, 3, 4], 2)).toBe(3.5);
    expect(movingAverage([1, 2], 3)).toBeNull();
  });
});

describe('buildMarketRegime', () => {
  test('flags a risk-on regime when trend, valuation and PMI are supportive', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i * 0.5);
    const r = buildMarketRegime({
      symbol: '000300.SH',
      indexName: 'CSI300',
      bars: bars(closes),
      valuation: valuation(20),
      breadth: breadth({ up: 3500, down: 1400, flat: 100, total: 5000, limitUp: 20, limitDown: 20 }),
      margin: null,
      pmi: { date: '2026-08-01', manufacturing: 50.5, nonManufacturing: 51 },
    });

    expect(r.trend).toBe('up');
    expect(r.regime).toBe('risk-on');
    expect(r.score).toBeGreaterThanOrEqual(65);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.ma200).not.toBeNull();
  });

  test('flags a risk-off regime when trend, valuation and PMI are weak', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 300 - i * 0.5);
    const latest = marginRow({ date: '2026-09-12', financingBalanceRatio: 3.0 });
    const older = marginRow({ date: '2026-09-01', financingBalanceRatio: 2.0 });
    const margin = { rows: [latest, older], latest } as MarginData;

    const r = buildMarketRegime({
      symbol: '000300.SH',
      indexName: 'CSI300',
      bars: bars(closes),
      valuation: valuation(90),
      breadth: breadth({ up: 1000, down: 3900, flat: 100, total: 5000, limitUp: 500, limitDown: 5 }),
      margin,
      pmi: { date: '2026-08-01', manufacturing: 48.0, nonManufacturing: 49 },
    });

    expect(r.trend).toBe('down');
    expect(r.crowdingLevel).toBe('high');
    expect(r.regime).toBe('risk-off');
    expect(r.score).toBeLessThanOrEqual(35);
  });

  test('degrades gracefully to neutral when data is missing', () => {
    const r = buildMarketRegime({
      symbol: '000300.SH',
      bars: bars([100, 101, 102]),
      valuation: null,
      breadth: breadth({ up: 2500, down: 2500, flat: 0, total: 5000 }),
      margin: null,
      pmi: null,
    });

    expect(r.trend).toBe('range');
    expect(r.regime).toBe('neutral');
    expect(r.valuationPercentile).toBeNull();
    expect(r.notes.some((n) => n.includes('估值'))).toBe(true);
    expect(r.notes.some((n) => n.includes('宏观'))).toBe(true);
  });
});
