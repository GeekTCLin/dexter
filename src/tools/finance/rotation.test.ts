import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import { buildValuationRotation, DEFAULT_ROTATION_UNIVERSE } from './rotation.js';

const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];
let handler: (url: string) => Response | Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALUATIONS: Record<string, Record<string, unknown>> = {
  SH000300: { name: 'CSI300', pe: 12.3, pb: 1.4, yeild: 2.5, pe_percentile: 60, pb_percentile: 55, roe: 11, peg: 1.0, bond_yeild: 2.0, eva_type: 'mid', date: '2026-09-12', begin_at: '2015-01-01' },
  SH000928: { name: 'Energy', pe: 8.1, pb: 0.9, yeild: 4.2, pe_percentile: 20, pb_percentile: 18, roe: 9, peg: 0.8, bond_yeild: 2.0, eva_type: 'low', date: '2026-09-12', begin_at: '2015-01-01' },
};

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

describe('buildValuationRotation', () => {
  test('sorts by PE percentile ascending and skips uncovered indices', async () => {
    handler = (url) => {
      const code = Object.keys(VALUATIONS).find((key) => url.includes(key));
      if (code) return jsonResponse({ data: VALUATIONS[code] });
      return jsonResponse({ data: null });
    };

    const { value, sourceUrls } = await buildValuationRotation([
      '000300.SH',
      '000928.SH',
      '000905.SH',
    ]);

    expect(value.requested).toBe(3);
    expect(value.rows.map((r) => r.symbol)).toEqual(['000928.SH', '000300.SH']);
    expect(value.rows[0].pePercentile).toBe(20);
    expect(value.rows[1].pePercentile).toBe(60);
    expect(sourceUrls.length).toBe(2);
  });

  test('applies the limit after sorting', async () => {
    handler = (url) => {
      const code = Object.keys(VALUATIONS).find((key) => url.includes(key));
      return jsonResponse({ data: code ? VALUATIONS[code] : null });
    };

    const { value } = await buildValuationRotation(['000300.SH', '000928.SH'], 1);
    expect(value.rows.length).toBe(1);
    expect(value.rows[0].symbol).toBe('000928.SH');
  });

  test('default universe includes broad-market and industry indices', () => {
    expect(DEFAULT_ROTATION_UNIVERSE).toContain('000300.SH');
    expect(DEFAULT_ROTATION_UNIVERSE).toContain('000928.SH');
    expect(DEFAULT_ROTATION_UNIVERSE.length).toBeGreaterThan(10);
  });
});
