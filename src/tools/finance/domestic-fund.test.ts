import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import { getFundQuotes, getFundNav, getFundHoldings, normalizeFundCode } from './domestic-fund-api.js';
import { getFundRankings, normalizeRankSort, normalizeFundType } from './fund-rank-api.js';
import { getFundProfile } from './fund-profile-api.js';

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

describe('normalizeFundCode', () => {
  test('strips exchange prefixes and non-digits', () => {
    expect(normalizeFundCode('sh510300')).toBe('510300');
    expect(normalizeFundCode(' 000001 ')).toBe('000001');
    expect(normalizeFundCode('sz159915')).toBe('159915');
  });
});

describe('getFundQuotes', () => {
  test('parses an ETF and an open-end fund from a batched response', async () => {
    handler = () =>
      jsonResponse({
        ErrCode: 0,
        Success: true,
        Datas: [
          {
            FCODE: '510300',
            SHORTNAME: '沪深300ETF华泰柏瑞',
            PDATE: '2026-09-11',
            NAV: 4.5489,
            ACCNAV: 1.87,
            NAVCHGRT: 0.57,
            NEWPRICE: 4.552,
            CHANGERATIO: -0.59,
            HQDATE: '2026-09-14',
          },
          {
            FCODE: '000001',
            SHORTNAME: '华夏成长混合',
            PDATE: '2026-09-11',
            NAV: 1.234,
            ACCNAV: 3.456,
            NAVCHGRT: -0.2,
            NEWPRICE: 0,
            CHANGERATIO: 0,
          },
        ],
      });

    const result = await getFundQuotes(['510300', '000001']);

    expect(result.source).toBe('eastmoney');
    expect(result.value.length).toBe(2);

    const etf = result.value.find((q) => q.code === '510300');
    expect(etf?.nav).toBe(4.5489);
    expect(etf?.navChangePercent).toBe(0.57);
    expect(etf?.price).toBe(4.552);
    expect(etf?.priceChangePercent).toBe(-0.59);
    expect(etf?.quoteDate).toBe('2026-09-14');

    const openEnd = result.value.find((q) => q.code === '000001');
    expect(openEnd?.name).toBe('华夏成长混合');
    expect(openEnd?.nav).toBe(1.234);
    // Open-end funds report '0' for the exchange price, normalized to null.
    expect(openEnd?.price).toBeNull();
    expect(openEnd?.priceChangePercent).toBeNull();
    expect(requestedUrls.some((u) => u.includes('fundmobapi.eastmoney.com') && u.includes('510300'))).toBe(true);
  });
});

describe('getFundNav', () => {
  test('parses the LSJZList into NAV points', async () => {
    handler = () =>
      jsonResponse({
        ErrCode: 0,
        TotalCount: 2,
        Data: {
          FundType: '股票指数',
          LSJZList: [
            { FSRQ: '2026-09-11', DWJZ: '4.5489', LJJZ: '1.8700', JZZZL: '0.57' },
            { FSRQ: '2026-09-10', DWJZ: '4.5231', LJJZ: '1.8650', JZZZL: '-0.42' },
          ],
        },
      });

    const result = await getFundNav('510300', '2026-09-01', '2026-09-11');

    expect(result.source).toBe('eastmoney');
    expect(result.value.length).toBe(2);
    expect(result.value[0]).toEqual({
      date: '2026-09-11',
      nav: 4.5489,
      accNav: 1.87,
      changePercent: 0.57,
    });
    const requestUrl = requestedUrls.find((u) => u.includes('/f10/lsjz'));
    expect(requestUrl).toContain('fundCode=510300');
    expect(requestUrl).toContain('startDate=2026-09-01');
    expect(requestUrl).toContain('endDate=2026-09-11');
  });

  test('throws when the provider returns no NAV list', async () => {
    handler = () => jsonResponse({ ErrCode: 0, Data: null });

    await expect(getFundNav('510300')).rejects.toThrow();
  });
});

describe('getFundHoldings', () => {
  test('parses disclosed top holdings and the report period', async () => {
    handler = () =>
      jsonResponse({
        ErrCode: 0,
        Success: true,
        Expansion: '2026-06-30',
        Datas: {
          fundStocks: [
            {
              GPDM: '600519',
              GPJC: '贵州茅台',
              JZBL: '5.23',
              TEXCH: '1',
              PCTNVCHGTYPE: '减持',
              PCTNVCHG: '-0.42',
              INDEXNAME: '白酒',
            },
            {
              GPDM: '000858',
              GPJC: '五粮液',
              JZBL: '3.11',
              TEXCH: '2',
              PCTNVCHGTYPE: '新增',
              PCTNVCHG: '100',
              INDEXNAME: '白酒',
            },
          ],
          fundboods: [{ BDM: 'x' }],
          fundfofs: [],
        },
      });

    const result = await getFundHoldings('510300');

    expect(result.source).toBe('eastmoney');
    expect(result.value.code).toBe('510300');
    expect(result.value.reportDate).toBe('2026-06-30');
    expect(result.value.stocks.length).toBe(2);
    expect(result.value.stocks[0]).toEqual({
      code: '600519',
      name: '贵州茅台',
      weightPercent: 5.23,
      market: 1,
      changeType: '减持',
      changePercent: -0.42,
      industry: '白酒',
    });
    expect(result.value.bondCount).toBe(1);
    expect(result.value.fundOfFundCount).toBe(0);
    expect(requestedUrls.some((u) => u.includes('FundMNInverstPosition') && u.includes('FCODE=510300'))).toBe(true);
  });

  test('throws when no holdings are returned', async () => {
    handler = () => jsonResponse({ ErrCode: 0, Datas: { fundStocks: null } });

    await expect(getFundHoldings('510300')).rejects.toThrow();
  });
});

describe('getFundRankings', () => {
  const ROW =
    '510300,HS300ETF,HS300ETF,2026-09-14,4.552,1.87,0.15,-1.49,-4.45,30.78,93.21,166.01,284.35,201.51,120,710.67,2017-01-25';

  test('parses the rankhandler payload and defaults to 1nzf/all', async () => {
    handler = () =>
      new Response(
        `var rankData = {datas:["${ROW}"],allRecords:9731,pageIndex:1,pageNum:20};`,
        { status: 200 },
      );

    const result = await getFundRankings();

    expect(result.source).toBe('eastmoney');
    expect(result.value.sort).toBe('1nzf');
    expect(result.value.fundType).toBe('all');
    expect(result.value.total).toBe(9731);
    expect(result.value.rows[0]).toEqual({
      code: '510300',
      name: 'HS300ETF',
      navDate: '2026-09-14',
      nav: 4.552,
      accNav: 1.87,
      dayGrowth: 0.15,
      week1: -1.49,
      month1: -4.45,
      month3: 30.78,
      month6: 93.21,
      year1: 166.01,
      year2: 284.35,
      year3: 201.51,
      year5: 120,
      sinceInception: 710.67,
      inceptionDate: '2017-01-25',
    });
    const requestUrl = requestedUrls.find((u) => u.includes('rankhandler.aspx'));
    expect(requestUrl).toContain('sc=1nzf');
    expect(requestUrl).toContain('ft=all');
  });

  test('normalizes unknown sort and fund type inputs', () => {
    expect(normalizeRankSort('BOGUS')).toBe('1nzf');
    expect(normalizeRankSort('2nzf')).toBe('2nzf');
    expect(normalizeFundType('bogus')).toBe('all');
    expect(normalizeFundType('gp')).toBe('gp');
  });
});

describe('getFundProfile', () => {
  test('parses the fund company, manager and latest NAV', async () => {
    handler = () =>
      jsonResponse({
        Datas: [
          {
            CODE: '510300',
            NAME: 'HS300ETF',
            FundBaseInfo: {
              FCODE: '510300',
              SHORTNAME: 'HS300ETF',
              JJGS: 'Huatai-PB Fund',
              JJJL: 'Zhang San',
              FTYPE: 'Index',
              DWJZ: 4.552,
              FSRQ: '2026-09-14',
            },
          },
        ],
      });

    const result = await getFundProfile('510300');

    expect(result.source).toBe('eastmoney');
    expect(result.value).toEqual({
      code: '510300',
      name: 'HS300ETF',
      company: 'Huatai-PB Fund',
      manager: 'Zhang San',
      fundType: 'Index',
      nav: 4.552,
      navDate: '2026-09-14',
      source: 'eastmoney',
    });
  });

  test('returns null when no matching fund is found', async () => {
    handler = () =>
      jsonResponse({
        Datas: [
          {
            CODE: '000001',
            NAME: 'OtherFund',
            FundBaseInfo: { FCODE: '000001', SHORTNAME: 'OtherFund' },
          },
        ],
      });

    const result = await getFundProfile('510300');

    expect(result.value).toBeNull();
  });
});
