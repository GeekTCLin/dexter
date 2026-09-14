import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import * as XLSX from 'xlsx';
import { getIndexConstituents } from './index-constituents-api.js';

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

describe('getIndexConstituents', () => {
  test('parses constituent codes and enriches names and prices', async () => {
    handler = (url) => {
      if (url.includes('RPT_INDEX_COMPONENT')) {
        return jsonResponse({
          result: {
            data: [{ SECURITY_CODE: '600519' }, { SECURITY_CODE: '000858' }],
            count: 2,
          },
        });
      }
      return jsonResponse({
        data: {
          diff: [
            { f12: '600519', f14: '贵州茅台', f2: 1680.5, f3: 1.2 },
            { f12: '000858', f14: '五粮液', f2: 128.3, f3: -0.8 },
          ],
        },
      });
    };

    const result = await getIndexConstituents('000300');

    expect(result.source).toBe('eastmoney');
    expect(result.value.symbol).toBe('000300.SH');
    expect(result.value.indexCode).toBe('000300');
    expect(result.value.indexName).toBe('沪深300');
    expect(result.value.count).toBe(2);
    expect(result.value.weightsIncluded).toBe(false);
    expect(result.value.constituents[0]).toEqual({
      code: '600519',
      name: '贵州茅台',
      weight: null,
      price: 1680.5,
      changePercent: 1.2,
    });
    expect(requestedUrls.some((u) => u.includes('RPT_INDEX_COMPONENT'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('ulist.np/get'))).toBe(true);
  });

  test('throws for an unknown index', async () => {
    handler = () => jsonResponse({});

    await expect(getIndexConstituents('NOT_AN_INDEX')).rejects.toThrow('Unknown index');
  });

  test('throws when the provider errors', async () => {
    handler = () => new Response('boom', { status: 500 });

    await expect(getIndexConstituents('000300')).rejects.toThrow();
  });

  test('uses the csindex close-weight workbook to add weights', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      [
        '日期Date',
        '指数代码 Index Code',
        '指数名称 Index Name',
        '指数英文名称Index Name(Eng)',
        '成份券代码Constituent Code',
        '成份券名称Constituent Name',
        '成份券英文名称Constituent Name(Eng)',
        '交易所Exchange',
        '交易所英文名称Exchange(Eng)',
        '权重(%)weight',
      ],
      [
        '20260831',
        '000300',
        '沪深300',
        'CSI 300',
        '600519',
        '贵州茅台',
        'Kweichow Moutai',
        '上海证券交易所',
        'Shanghai Stock Exchange',
        5.23,
      ],
      [
        '20260831',
        '000300',
        '沪深300',
        'CSI 300',
        '000858',
        '五粮液',
        'Wuliangye',
        '深圳证券交易所',
        'Shenzhen Stock Exchange',
        3.11,
      ],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'w');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xls' });

    handler = (url) => {
      if (url.includes('closeweight')) {
        return new Response(buf, {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.ms-excel' },
        });
      }
      return jsonResponse({
        data: {
          diff: [
            { f12: '600519', f14: '贵州茅台', f2: 1680.5, f3: 1.2 },
            { f12: '000858', f14: '五粮液', f2: 128.3, f3: -0.8 },
          ],
        },
      });
    };

    const result = await getIndexConstituents('000300');

    expect(result.value.weightsIncluded).toBe(true);
    expect(result.value.weightDate).toBe('2026-08-31');
    expect(result.value.count).toBe(2);
    const moutai = result.value.constituents.find((c) => c.code === '600519');
    expect(moutai?.weight).toBe(5.23);
    expect(moutai?.price).toBe(1680.5);
    expect(requestedUrls.some((u) => u.includes('closeweight'))).toBe(true);
  });
});
