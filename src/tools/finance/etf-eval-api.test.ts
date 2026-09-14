import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import { getEtfEvaluation, parseJbgk } from './etf-eval-api.js';

const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];
let handler: (url: string) => Response | Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DATES = [
  '2026-08-03',
  '2026-08-04',
  '2026-08-05',
  '2026-08-06',
  '2026-08-07',
  '2026-08-10',
  '2026-08-11',
  '2026-08-12',
  '2026-08-13',
  '2026-08-14',
];
const INDEX_CLOSES = [100, 100.5, 101.2, 100.9, 101.5, 102.3, 102.0, 102.8, 103.5, 104.0];
const ETF_NAVS = INDEX_CLOSES.map((c, i) =>
  Number((c * 0.045 * (1 + ((i % 3) - 1) * 0.0004)).toFixed(6)),
);

function klineRows(closes: number[]): string[] {
  return DATES.map(
    (date, i) =>
      `${date},${closes[i]},${closes[i]},${closes[i]},${closes[i]},5000000,2000000000,0,0.1,0.01,2.5`,
  );
}

function routes(url: string): Response | Promise<Response> {
  if (url.includes('FundMNFInfo')) {
    return jsonResponse({
      Datas: [
        {
          FCODE: '510300',
          SHORTNAME: '沪深300ETF华泰柏瑞',
          NAV: 4.5,
          ACCNAV: 4.5,
          NEWPRICE: 4.52,
          CHANGERATIO: 0.1,
          NAVCHGRT: 0.05,
          PDATE: '2026-08-14',
          HQDATE: '2026-08-14',
        },
      ],
    });
  }
  if (url.includes('ulist.np')) {
    return jsonResponse({
      data: {
        diff: [
          {
            f12: '510300',
            f13: 1,
            f14: '沪深300ETF华泰柏瑞',
            f2: 4.52,
            f3: 0.1,
            f20: 106510826611,
            f21: 106510826611,
          },
        ],
      },
    });
  }
  if (url.includes('secid=1.000300')) {
    return jsonResponse({ data: { klines: klineRows(INDEX_CLOSES) } });
  }
  if (url.includes('secid=1.510300')) {
    return jsonResponse({ data: { klines: klineRows(INDEX_CLOSES) } });
  }
  if (url.includes('f10/lsjz')) {
    return jsonResponse({
      Data: {
        LSJZList: DATES.map((date, i) => ({
          FSRQ: date,
          DWJZ: String(ETF_NAVS[i]),
          LJJZ: String(ETF_NAVS[i]),
          JZZZL: '0.1',
        })),
      },
    });
  }
  if (url.includes('jbgk')) {
    return new Response('nope', { status: 500 });
  }
  throw new Error(`Unexpected request: ${url}`);
}

beforeEach(() => {
  requestedUrls = [];
  rmSync(dexterPath('cache'), { recursive: true, force: true });
  handler = routes;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    return handler(url);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('parseJbgk', () => {
  test('extracts fees, tracking target and company from the profile HTML', () => {
    const html =
      '<th>管理费率</th><td>0.15%（每年）</td>' +
      '<th>托管费率</th><td>0.05%（每年）</td>' +
      '<th>跟踪标的</th><td>沪深300指数</td>' +
      '<th>管理人</th><td>华泰柏瑞基金</td>';
    expect(parseJbgk(html)).toEqual({
      managementFeePercent: 0.15,
      custodyFeePercent: 0.05,
      trackingTarget: '沪深300指数',
      company: '华泰柏瑞基金',
    });
  });

  test('returns nulls when the fields are absent', () => {
    expect(parseJbgk('<html></html>')).toEqual({
      managementFeePercent: null,
      custodyFeePercent: null,
      trackingTarget: null,
      company: null,
    });
  });
});

describe('getEtfEvaluation', () => {
  test('evaluates an index-tracking ETF on scale, liquidity and tracking', async () => {
    const { value } = await getEtfEvaluation({
      index: '沪深300',
      codes: ['510300'],
      windowDays: 60,
      includeFees: false,
    });

    expect(value.indexSymbol).toBe('000300.SH');
    expect(value.etfs.length).toBe(1);
    const etf = value.etfs[0];
    expect(etf.code).toBe('510300');
    expect(etf.name).toBe('沪深300ETF华泰柏瑞');
    expect(etf.scale).toBe(106510826611);
    expect(etf.avgAmount).toBe(2_000_000_000);
    expect(etf.avgVolume).toBe(5_000_000);
    expect(etf.premiumPercent).toBeCloseTo(0.4444, 3);
    expect(etf.dataPoints).toBe(9);
    expect(typeof etf.trackingError).toBe('number');
    expect(Number.isFinite(etf.trackingError as number)).toBe(true);
    expect(etf.correlation as number).toBeGreaterThan(0.99);

    expect(requestedUrls.some((u) => u.includes('FundMNFInfo'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('ulist.np'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('secid=1.510300'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('secid=1.000300'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('f10/lsjz'))).toBe(true);
    // include_fees: false must not hit the profile page.
    expect(requestedUrls.some((u) => u.includes('jbgk'))).toBe(false);
  });

  test('still returns metrics when the fee page fails', async () => {
    const { value } = await getEtfEvaluation({
      index: '沪深300',
      codes: ['510300'],
      windowDays: 60,
      includeFees: true,
    });

    expect(value.etfs.length).toBe(1);
    expect(value.etfs[0].managementFeePercent).toBeNull();
    expect(value.etfs[0].custodyFeePercent).toBeNull();
    expect(requestedUrls.some((u) => u.includes('jbgk'))).toBe(true);
  });

  test('throws when neither an index nor codes are supplied', async () => {
    await expect(getEtfEvaluation({})).rejects.toThrow();
  });
});
