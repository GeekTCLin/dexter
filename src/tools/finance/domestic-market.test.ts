import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import { getMarketBreadth, getMarginData } from './domestic-market-api.js';

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

describe('getMarketBreadth', () => {
  test('aggregates breadth counts, limit counts and turnover', async () => {
    handler = (url) => {
      if (url.includes('ulist.np')) {
        return jsonResponse({
          data: {
            diff: [
              { f12: '000001', f104: 1330, f105: 928, f106: 94 },
              { f12: '399001', f104: 1644, f105: 1179, f106: 109 },
            ],
          },
        });
      }
      if (url.includes('getTopicZTPool')) return jsonResponse({ data: { tc: 55 } });
      if (url.includes('getTopicDTPool')) return jsonResponse({ data: { tc: 16 } });
      if (url.includes('secid=1.000001')) return jsonResponse({ data: { f48: 779281246497 } });
      if (url.includes('secid=0.399001')) return jsonResponse({ data: { f48: 500000000000 } });
      return jsonResponse({});
    };

    const { value, source } = await getMarketBreadth();

    expect(source).toBe('eastmoney');
    expect(value.up).toBe(2974);
    expect(value.down).toBe(2107);
    expect(value.flat).toBe(203);
    expect(value.total).toBe(5284);
    expect(value.limitUp).toBe(55);
    expect(value.limitDown).toBe(16);
    expect(value.shAmount).toBe(779281246497);
    expect(value.szAmount).toBe(500000000000);
    expect(value.turnover).toBe(779281246497 + 500000000000);
    expect(value.tradeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('accepts an explicit trading date', async () => {
    handler = (url) => {
      if (url.includes('ulist.np')) return jsonResponse({ data: { diff: [] } });
      if (url.includes('getTopicZTPool')) return jsonResponse({ data: { tc: 0 } });
      if (url.includes('getTopicDTPool')) return jsonResponse({ data: { tc: 0 } });
      return jsonResponse({ data: {} });
    };

    const { value } = await getMarketBreadth('20260911');
    expect(value.tradeDate).toBe('2026-09-11');
    expect(requestedUrls.some((u) => u.includes('date=20260911'))).toBe(true);
  });

  test('throws when the breadth endpoint fails', async () => {
    handler = () => new Response('nope', { status: 500 });

    await expect(getMarketBreadth()).rejects.toThrow();
  });
});

describe('getMarginData', () => {
  test('parses margin history newest-first', async () => {
    handler = () =>
      jsonResponse({
        result: {
          data: [
            {
              DIM_DATE: '2026-09-11',
              RZYE: 1500000000000,
              RZRQYE: 1600000000000,
              RZMRE: 90000000000,
              RZCHE: 85000000000,
              RZJME: 5000000000,
              RQYE: 100000000000,
              RZYEZB: 2.35,
            },
            {
              DIM_DATE: '2026-09-10',
              RZYE: 1495000000000,
              RZRQYE: 1595000000000,
              RZJME: -2000000000,
              RQYE: 99000000000,
              RZYEZB: 2.34,
            },
          ],
        },
      });

    const { value, source } = await getMarginData(2);

    expect(source).toBe('eastmoney');
    expect(value.rows.length).toBe(2);
    expect(value.latest?.date).toBe('2026-09-11');
    expect(value.latest?.financingBalance).toBe(1500000000000);
    expect(value.latest?.financingNet).toBe(5000000000);
    expect(value.latest?.financingBalanceRatio).toBe(2.35);
    expect(requestedUrls.some((u) => u.includes('RPTA_RZRQ_LSHJ'))).toBe(true);
  });

  test('throws when no margin data is returned', async () => {
    handler = () => jsonResponse({ result: { data: null } });

    await expect(getMarginData()).rejects.toThrow();
  });
});
