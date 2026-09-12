import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import {
  resolveIndex,
  getIndexSnapshot,
  getIndexSnapshots,
  getIndexBars,
} from './domestic-index-api.js';

// ---------------------------------------------------------------------------
// Unit tests mock global fetch and clear the on-disk cache between cases so
// stale entries never satisfy a request that should hit the stubbed network.
// ---------------------------------------------------------------------------

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

describe('resolveIndex', () => {
  test('resolves a full symbol, secid, tencent code, name and alias', () => {
    expect(resolveIndex('000001.SH')?.name).toBe('上证综指');
    expect(resolveIndex('1.000001')?.symbol).toBe('000001.SH');
    expect(resolveIndex('sh000001')?.symbol).toBe('000001.SH');
    expect(resolveIndex('上证综指')?.symbol).toBe('000001.SH');
    expect(resolveIndex('上证指数')?.symbol).toBe('000001.SH');
    expect(resolveIndex('  沪深300  ')?.symbol).toBe('000300.SH');
  });

  test('applies the bare-code market ambiguity rule', () => {
    expect(resolveIndex('000001')?.symbol).toBe('000001.SH');
    expect(resolveIndex('399001')?.symbol).toBe('399001.SZ');
    expect(resolveIndex('000300')?.symbol).toBe('000300.SH');
  });

  test('returns undefined for unknown input', () => {
    expect(resolveIndex('NOT_AN_INDEX')).toBeUndefined();
    expect(resolveIndex('')).toBeUndefined();
  });
});

describe('getIndexSnapshot', () => {
  test('parses an Eastmoney single-snapshot response', async () => {
    handler = () =>
      jsonResponse({
        rc: 0,
        data: {
          f43: 3888.11,
          f44: 3912.32,
          f45: 3852.03,
          f46: 3910.92,
          f47: 579123145,
          f48: 958186336970.1,
          f57: '000001',
          f58: '上证指数',
          f60: 3934.4,
          f86: 1789114292,
          f169: -46.29,
          f170: -1.18,
          f171: 1.53,
        },
      });

    const result = await getIndexSnapshot('上证综指');

    expect(result.source).toBe('eastmoney');
    expect(result.value.symbol).toBe('000001.SH');
    expect(result.value.name).toBe('上证指数');
    expect(result.value.price).toBe(3888.11);
    expect(result.value.change).toBe(-46.29);
    expect(result.value.changePercent).toBe(-1.18);
    expect(result.value.open).toBe(3910.92);
    expect(result.value.high).toBe(3912.32);
    expect(result.value.low).toBe(3852.03);
    expect(result.value.prevClose).toBe(3934.4);
    expect(result.value.volume).toBe(579123145);
    expect(result.value.amount).toBe(958186336970.1);
    expect(result.value.amplitude).toBe(1.53);
    expect(result.value.timestamp).toBe(1789114292);
    expect(result.sourceUrl).toContain('push2.eastmoney.com');
  });
});

describe('getIndexSnapshots', () => {
  test('parses the Eastmoney batch field map (f2/f3/f4/f5/f6/f12..f18)', async () => {
    handler = () =>
      jsonResponse({
        rc: 0,
        data: {
          diff: [
            {
              f12: '000001',
              f13: 1,
              f14: '上证指数',
              f2: 3888.11,
              f3: -1.18,
              f4: -46.29,
              f5: 579123145,
              f6: 958186336970.1,
              f15: 3912.32,
              f16: 3852.03,
              f17: 3910.92,
              f18: 3934.4,
            },
            { f12: '000300', f13: 1, f14: '沪深300', f2: 4500.5, f3: 0.85, f4: 38.1 },
          ],
        },
      });

    const result = await getIndexSnapshots(['000001.SH', '000300.SH']);

    expect(result.source).toBe('eastmoney');
    expect(result.value.length).toBe(2);
    const first = result.value.find((s) => s.symbol === '000001.SH');
    expect(first?.price).toBe(3888.11);
    expect(first?.change).toBe(-46.29);
    expect(first?.changePercent).toBe(-1.18);
    expect(first?.name).toBe('上证指数');
    expect(first?.open).toBe(3910.92);
    expect(first?.high).toBe(3912.32);
    expect(first?.low).toBe(3852.03);
    expect(first?.prevClose).toBe(3934.4);
    expect(first?.volume).toBe(579123145);
    expect(first?.amount).toBe(958186336970.1);
    const second = result.value.find((s) => s.symbol === '000300.SH');
    expect(second?.price).toBe(4500.5);
    expect(second?.changePercent).toBe(0.85);
    expect(result.sourceUrl).toContain('ulist.np/get');
  });
});

describe('getIndexBars', () => {
  test('parses an 11-field Eastmoney kline row', async () => {
    handler = () =>
      jsonResponse({
        rc: 0,
        data: {
          klines: [
            '2024-01-02,2972.78,2962.28,2976.27,2962.28,304141793,345950729194.60,0.47,-0.43,-12.65,0.63',
          ],
        },
      });

    const result = await getIndexBars('000001.SH', 'day', '2024-01-01', '2024-01-10');

    expect(result.source).toBe('eastmoney');
    expect(result.value.length).toBe(1);
    expect(result.value[0]).toEqual({
      date: '2024-01-02',
      open: 2972.78,
      close: 2962.28,
      high: 2976.27,
      low: 2962.28,
      volume: 304141793,
      amount: 345950729194.6,
      changePercent: -0.43,
    });
    expect(result.sourceUrl).toContain('push2his.eastmoney.com');
  });

  test('returns an empty array for an empty kline array', async () => {
    handler = () => jsonResponse({ rc: 0, data: { klines: [] } });

    const result = await getIndexBars('000001.SH', 'day', '2024-01-01', '2024-01-10');

    expect(result.value).toEqual([]);
  });
});

describe('provider fallback', () => {
  test('falls back to Tencent when Eastmoney returns HTTP 500', async () => {
    const fields = new Array<string>(38).fill('0');
    fields[1] = '上证指数';
    fields[3] = '3100.00';
    fields[4] = '3050.00';
    fields[5] = '3060.00';
    fields[6] = '123456';
    fields[31] = '50.00';
    fields[32] = '1.64';
    fields[33] = '3120.00';
    fields[34] = '3040.00';
    fields[37] = '999999';
    const tencentBody = `v_sh000001="${fields.join('~')}";`;

    handler = (url) => {
      if (url.includes('push2.eastmoney.com')) {
        return new Response('server error', { status: 500 });
      }
      return new Response(tencentBody, { status: 200 });
    };

    const result = await getIndexSnapshot('sh000001');

    expect(result.source).toBe('tencent');
    expect(result.value.price).toBe(3100);
    expect(result.value.change).toBe(50);
    expect(result.value.changePercent).toBe(1.64);
    // Tencent turnover (fields[37]) is in 万元 and must be normalized to 元 (×10000).
    expect(result.value.amount).toBe(9_999_990_000);
    expect(requestedUrls.some((u) => u.includes('qt.gtimg.cn'))).toBe(true);
  });
});
