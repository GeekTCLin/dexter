import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import { getDragonTiger, getLimitUpPool } from './dragon-tiger-api.js';

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

describe('getDragonTiger', () => {
  test('returns net-buy ranked stocks and active seats for a date', async () => {
    handler = (url) => {
      if (url.includes('RPT_DAILYBILLBOARD_DETAILSNEW')) {
        return jsonResponse({
          result: {
            data: [
              {
                TRADE_DATE: '2026-09-11 00:00:00',
                SECURITY_CODE: '002909',
                SECURITY_NAME_ABBR: 'StockA',
                MARKET: 'SZ',
                CLOSE_PRICE: 10.5,
                CHANGE_RATE: -10.0134,
                TURNOVERRATE: 5.2,
                BILLBOARD_BUY_AMT: 120000000,
                BILLBOARD_SELL_AMT: 20000000,
                BILLBOARD_NET_AMT: 100000000,
                DEAL_AMOUNT_RATIO: 12.3,
                DEAL_NET_RATIO: 3.4,
                EXPLANATION: 'reason',
              },
            ],
          },
        });
      }
      if (url.includes('RPT_OPERATEDEPT_TRADE')) {
        return jsonResponse({
          result: {
            data: [
              {
                OPERATEDEPT_NAME: 'SeatA',
                OPERATEDEPT_CODE: '1',
                TRADE_DATE: '2026-09-11',
                SECURITY_CODE: '002909',
                SECURITY_NAME_ABBR: 'StockA',
                CHANGE_RATE: -10.0134,
                BUY_TOTAL: 80000000,
                SELL_TOTAL: 10000000,
                NET_BUY: 70000000,
                RANK: 1,
              },
              {
                OPERATEDEPT_NAME: 'SeatB',
                OPERATEDEPT_CODE: '2',
                TRADE_DATE: '2026-09-11',
                SECURITY_CODE: '002909',
                SECURITY_NAME_ABBR: 'StockA',
                CHANGE_RATE: -10.0134,
                BUY_TOTAL: 60000000,
                SELL_TOTAL: 10000000,
                NET_BUY: 50000000,
                RANK: 2,
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const { value } = await getDragonTiger('2026-09-11', 20, 15);
    expect(value.tradeDate).toBe('2026-09-11');
    expect(value.stocks[0]).toMatchObject({
      code: '002909',
      name: 'StockA',
      market: 'SZ',
      netAmount: 100000000,
      changePercent: -10.0134,
    });
    expect(value.seats[0].name).toBe('SeatA');
    expect(value.seats[1].name).toBe('SeatB');
    expect(requestedUrls.some((u) => u.includes('RPT_DAILYBILLBOARD_DETAILSNEW'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('RPT_OPERATEDEPT_TRADE'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('TRADE_DATE'))).toBe(true);
  });
});

describe('getLimitUpPool', () => {
  test('returns the limit-up pool with 连板 and 封板 time', async () => {
    handler = (url) => {
      if (url.includes('getTopicZTPool')) {
        return jsonResponse({
          data: {
            tc: 40,
            qdate: 20260914,
            pool: [
              {
                c: '000001',
                m: 0,
                n: 'StockB',
                p: 12340,
                zdp: 10.02,
                amount: 500000000,
                ltsz: 100000000000,
                hs: 3.1,
                lbc: 2,
                fbt: 92500,
                lbt: 145959,
                fund: 200000000,
                zbc: 1,
                hybk: 'Bank',
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const { value } = await getLimitUpPool('2026-09-14', 30);
    expect(value.tradeDate).toBe('2026-09-14');
    expect(value.total).toBe(40);
    expect(value.stocks[0]).toMatchObject({
      code: '000001',
      name: 'StockB',
      price: 12.34,
      limitUpCount: 2,
      firstLimitTime: '09:25:00',
      lastLimitTime: '14:59:59',
      industry: 'Bank',
    });
    expect(requestedUrls.some((u) => u.includes('getTopicZTPool'))).toBe(true);
  });
});
