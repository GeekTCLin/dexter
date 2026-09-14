import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import { getIndexValuation } from './domestic-index-valuation-api.js';

// Index valuation is best-effort: covered indices map through, uncovered or
// unreachable ones return null rather than throwing.

const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];
let handler: (url: string) => Response | Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  requestedUrls = [];
  rmSync(dexterPath('cache'), { recursive: true, force: true });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    return handler(url);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getIndexValuation', () => {
  test('maps a covered danjuan payload into an IndexValuation', async () => {
    handler = () =>
      jsonResponse({
        result_code: 0,
        data: {
          index_code: 'SH000300',
          name: '沪深300',
          pe: 12.34,
          pb: 1.23,
          pe_percentile: 0.42,
          pb_percentile: 0.31,
          roe: 10.5,
          yeild: 0.028,
          peg: 0.9,
          eva_type: '适中',
          bond_yeild: 0.021,
          begin_at: '2014-01-01',
          date: '2026-09-14',
        },
      });

    const result = await getIndexValuation('000300.SH');

    expect(result).not.toBeNull();
    expect(result?.source).toBe('danjuan');
    expect(result?.value.symbol).toBe('000300.SH');
    expect(result?.value.name).toBe('沪深300');
    expect(result?.value.pe).toBe(12.34);
    expect(result?.value.pb).toBe(1.23);
    expect(result?.value.pePercentile).toBe(0.42);
    expect(result?.value.pbPercentile).toBe(0.31);
    expect(result?.value.dividendYield).toBe(0.028);
    expect(result?.value.bondYield).toBe(0.021);
    expect(result?.value.evaluation).toBe('适中');
    expect(result?.value.valuationDate).toBe('2026-09-14');
    expect(result?.value.historyYears).toBeGreaterThan(10);
    expect(result?.sourceUrl).toContain('danjuanfunds.com');
    expect(requestedUrls.some((u) => u.includes('SH000300'))).toBe(true);
  });

  test('returns null when the provider publishes no data for the index', async () => {
    handler = () => jsonResponse({ result_code: 0 });

    const result = await getIndexValuation('000001.SH');

    expect(result).toBeNull();
  });

  test('returns null without fetching when the input is not an index', async () => {
    handler = () => jsonResponse({ result_code: 0 });

    const result = await getIndexValuation('NOT_AN_INDEX');

    expect(result).toBeNull();
    expect(requestedUrls).toEqual([]);
  });

  test('returns null for Beijing indices, which danjuan does not cover', async () => {
    handler = () => jsonResponse({ result_code: 0 });

    const result = await getIndexValuation('899050.BJ');

    expect(result).toBeNull();
    expect(requestedUrls).toEqual([]);
  });
});
