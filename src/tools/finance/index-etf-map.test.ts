import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import { getIndexEtfMap } from './index-etf-map-api.js';

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

describe('getIndexEtfMap', () => {
  test('resolves the index and keeps ETFs, dropping feeder funds', async () => {
    handler = () =>
      jsonResponse({
        Datas: [
          {
            CODE: '510300',
            NAME: '沪深300ETF华泰柏瑞',
            FundBaseInfo: { JJGS: '华泰柏瑞基金', JJJL: '张三', FTYPE: '指数型-股票', DWJZ: 4.552, FSRQ: '2026-09-14' },
          },
          {
            CODE: '000051',
            NAME: '华夏沪深300ETF联接A',
            FundBaseInfo: { JJGS: '华夏基金', JJJL: '李四', FTYPE: '指数型-股票', DWJZ: 1.23, FSRQ: '2026-09-14' },
          },
        ],
      });

    const { value, source } = await getIndexEtfMap('沪深300');

    expect(source).toBe('eastmoney');
    expect(value.indexSymbol).toBe('000300.SH');
    expect(value.indexName).toBe('沪深300');
    expect(value.etfs.length).toBe(1);
    expect(value.etfs[0]).toEqual({
      code: '510300',
      name: '沪深300ETF华泰柏瑞',
      company: '华泰柏瑞基金',
      manager: '张三',
      fundType: '指数型-股票',
      nav: 4.552,
      navDate: '2026-09-14',
    });
    // The search keyword is the index name plus the ETF suffix.
    expect(requestedUrls.some((u) => u.includes(encodeURIComponent('沪深300ETF')))).toBe(true);
  });

  test('falls back to a raw keyword when the query is not a known index', async () => {
    handler = () => jsonResponse({ Datas: [] });

    const { value } = await getIndexEtfMap('某个不存在的词');

    expect(value.indexSymbol).toBeNull();
    expect(value.indexName).toBeNull();
    expect(value.etfs.length).toBe(0);
    expect(requestedUrls.some((u) => u.includes(encodeURIComponent('某个不存在的词')))).toBe(true);
  });

  test('throws when the search endpoint fails', async () => {
    handler = () => new Response('nope', { status: 500 });

    await expect(getIndexEtfMap('沪深300')).rejects.toThrow();
  });
});
