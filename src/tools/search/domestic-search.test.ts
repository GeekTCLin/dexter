import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import {
  buildClsSign,
  getFlashNews,
  getGubaSentiment,
  searchDomesticNews,
  getAnnouncements,
  resetDomesticSearchCircuits,
} from './domestic-search-api.js';

// ---------------------------------------------------------------------------
// Unit tests mock global fetch and clear the on-disk cache between cases so
// stale entries never satisfy a request that should hit the stubbed network.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];
let requestedInits: Array<RequestInit | undefined> = [];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function serverError(): Response {
  return new Response('server error', { status: 500 });
}

beforeEach(() => {
  requestedUrls = [];
  requestedInits = [];
  resetDomesticSearchCircuits();
  rmSync(dexterPath('cache'), { recursive: true, force: true });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(url);
    requestedInits.push(init);
    return handler(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getFlashNews', () => {
  test('parses the Eastmoney 7x24 list and supports sortEnd pagination', async () => {
    handler = () =>
      jsonResponse({
        data: {
          sortEnd: 'CURSOR_2',
          fastNewsList: [
            {
              title: '央行开展逆回购操作',
              summary: '净投放1000亿元',
              showTime: '2026-09-13 09:30:00',
              code: '20260913001',
              stockList: ['1.600519', '0.000001'],
            },
            {
              title: '沪指高开',
              summary: '高开0.3%',
              showTime: '2026-09-13 09:25:00',
              code: '20260913002',
              stockList: [],
            },
          ],
        },
      });

    const result = await getFlashNews(5);

    expect(result.source).toBe('eastmoney');
    expect(result.value.length).toBe(2);
    expect(result.value[0].title).toBe('央行开展逆回购操作');
    expect(result.value[0].stocks).toEqual(['600519', '000001']);
    expect(result.value[0].timestamp).toBeGreaterThan(0);

    // Pagination cursor from the previous page must ride along in sortEnd.
    await getFlashNews(5, 'CURSOR_1');
    expect(requestedUrls.some((u) => u.includes('sortEnd=CURSOR_1'))).toBe(true);
  });

  test('builds the CLS signature as md5(sha1(sorted querystring))', () => {
    const params = {
      app: 'CailianpressWeb',
      category: '',
      last_time: '',
      os: 'web',
      refresh_type: '1',
      rn: '20',
      sv: '7.7.5',
    };
    const sortedQuery = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key as keyof typeof params]}`)
      .join('&');
    const expected = createHash('md5')
      .update(createHash('sha1').update(sortedQuery).digest('hex'))
      .digest('hex');

    expect(buildClsSign(params)).toBe(expected);
    expect(buildClsSign(params)).toHaveLength(32);
  });

  test('parses CLS roll_data and sends a signature', async () => {
    handler = (url) => {
      if (url.includes('cls.cn')) {
        return jsonResponse({
          data: {
            roll_data: [
              {
                id: 123456,
                title: '国常会部署经济工作',
                brief: '部署下一阶段经济工作',
                content: '<p>会议全文内容</p>',
                ctime: 1757727000,
                reading_num: 100,
                stock_list: ['600519'],
                subjects: [{ subject_name: '宏观' }],
              },
            ],
          },
        });
      }
      return serverError();
    };

    const result = await getFlashNews(5);

    expect(result.source).toBe('cls');
    expect(result.value[0].id).toBe('123456');
    expect(result.value[0].content).toBe('会议全文内容');
    expect(result.value[0].stocks).toEqual(['600519']);
    expect(result.value[0].tags).toEqual(['宏观']);
    expect(result.value[0].timestamp).toBe(1757727000);
    const clsUrl = requestedUrls.find((u) => u.includes('cls.cn')) ?? '';
    expect(clsUrl).toContain('sign=');
  });

  test('parses the Sina 7x24 feed and extracts stocks from ext JSON', async () => {
    handler = (url) => {
      if (url.includes('zhibo.sina.com.cn')) {
        return jsonResponse({
          result: {
            data: {
              feed: {
                list: [
                  {
                    id: 999,
                    rich_text: '<p>某公司发布重要公告</p>',
                    create_time: '2026-09-13 08:00:00',
                    like_nums: 3,
                    comment_list: { total: 2 },
                    tag: '公司',
                    ext: JSON.stringify({ stocks: [{ stockid: 'sh600519' }] }),
                  },
                ],
              },
            },
          },
        });
      }
      return serverError();
    };

    const result = await getFlashNews(5);

    expect(result.source).toBe('sina');
    expect(result.value[0].title).toBe('某公司发布重要公告');
    expect(result.value[0].stocks).toEqual(['600519']);
    expect(result.value[0].heat).toBe(3);

    // Fallback chain tried Eastmoney then CLS first.
    expect(requestedUrls.some((u) => u.includes('np-listapi.eastmoney.com'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('cls.cn'))).toBe(true);
  });

  test('falls back from Eastmoney (HTTP 500) to CLS for flash news', async () => {
    handler = (url) => {
      if (url.includes('np-listapi.eastmoney.com')) return serverError();
      if (url.includes('cls.cn')) {
        return jsonResponse({
          data: {
            roll_data: [{ id: 1, title: '快讯标题', brief: '摘要', ctime: 1757727000, stock_list: [] }],
          },
        });
      }
      return serverError();
    };

    const result = await getFlashNews(3);

    expect(result.source).toBe('cls');
    expect(result.value[0].title).toBe('快讯标题');
    expect(requestedUrls.some((u) => u.includes('cls.cn'))).toBe(true);
  });
});

describe('getGubaSentiment', () => {
  test('parses Guba posts, marks the unreliable legacy flag as unknown, and always sends plat=web&version=300', async () => {
    handler = () =>
      jsonResponse({
        count: 42,
        re: [
          {
            post_id: 554433,
            post_title: '茅台还能拿吗',
            user_nickname: '散户甲',
            post_click_count: 100,
            post_forward_count: 1,
            post_comment_count: 5,
            post_publish_time: '2026-09-13 10:00:00',
            post_last_time: '2026-09-13 10:05:00',
            // Live-observed value: Guba's bullish_bearish is always 0.
            bullish_bearish: 0,
          },
        ],
      });

    const result = await getGubaSentiment('600519', { sort: 'hot', limit: 5 });

    expect(result.source).toBe('eastmoney');
    expect(result.value.code).toBe('600519');
    expect(result.value.total).toBe(42);
    expect(result.value.posts[0].url).toBe('https://guba.eastmoney.com/news,600519,554433.html');
    expect(result.value.posts[0].sentiment).toBe('unknown');
    expect(result.value.bullish).toBe(0);
    expect(result.value.bearish).toBe(0);
    expect(result.value.posts[0].clicks).toBe(100);
    expect(result.value.posts[0].comments).toBe(5);

    const url = requestedUrls[0];
    expect(url).toContain('plat=web');
    expect(url).toContain('version=300');
    expect(url).toContain('sorttype=0');
  });
});

describe('searchDomesticNews', () => {
  test('unwraps the Eastmoney JSONP envelope and strips <em> highlight tags', async () => {
    const payload = {
      result: {
        cmsArticleWebOld: [
          {
            date: '2026-09-13 11:00:00',
            code: 'ART1',
            title: '贵州<em>茅台</em>发布公告',
            content: '公司公告内容',
            mediaName: '证券时报',
            url: 'https://finance.eastmoney.com/a/ART1.html',
          },
        ],
      },
    };
    handler = (url) => {
      if (url.includes('search-api-web.eastmoney.com')) {
        return new Response(`jQuery(${JSON.stringify(payload)})`, {
          status: 200,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
      return serverError();
    };

    const result = await searchDomesticNews('贵州茅台', 5);

    expect(result.source).toBe('eastmoney');
    expect(result.value[0].title).toBe('贵州茅台发布公告');
    expect(result.value[0].tags).toEqual(['证券时报']);
    expect(result.value[0].url).toBe('https://finance.eastmoney.com/a/ART1.html');
    expect(result.value[0].timestamp).toBeGreaterThan(0);
  });
});

describe('getAnnouncements', () => {
  test('posts to CNINFO and resolves orgId via heuristic when topSearch is unavailable', async () => {
    handler = (url) => {
      if (url.includes('topSearch')) return jsonResponse([]);
      return jsonResponse({
        announcements: [
          {
            secCode: '600519',
            secName: '贵州茅台',
            announcementId: '1223456',
            announcementTitle: '贵州茅台2026年半年度报告',
            announcementTime: 1757727000000,
            adjunctUrl: 'finalpage/2026-09-13/1223456.PDF',
            adjunctType: 'PDF',
          },
        ],
      });
    };

    const result = await getAnnouncements('600519', { limit: 5 });

    expect(result.source).toBe('cninfo');
    expect(result.value[0].announcementId).toBe('1223456');
    expect(result.value[0].pdfUrl).toBe('http://static.cninfo.com.cn/finalpage/2026-09-13/1223456.PDF');
    expect(result.value[0].timestamp).toBe(1757727000);

    const queryIndex = requestedUrls.findIndex((u) => u.includes('hisAnnouncement/query'));
    expect(queryIndex).toBeGreaterThan(-1);
    expect(String(requestedInits[queryIndex]?.body)).toContain('stock=600519,gssh0600519');
    expect(String(requestedInits[queryIndex]?.body)).toContain('pageSize=5');
  });

  test('uses orgId returned by CNINFO topSearch when available', async () => {
    handler = (url) => {
      if (url.includes('topSearch')) return jsonResponse({ keyWord: [{ code: '600519', orgId: 'gssh0600519' }] });
      return jsonResponse({ announcements: [] });
    };

    await getAnnouncements('600519', { limit: 5 });

    const queryIndex = requestedUrls.findIndex((u) => u.includes('hisAnnouncement/query'));
    expect(queryIndex).toBeGreaterThan(-1);
    expect(String(requestedInits[queryIndex]?.body)).toContain('stock=600519,gssh0600519');
  });

  test('throws (does not silently return empty) when topSearch is down for a non-main-board code', async () => {
    handler = (url) => {
      if (url.includes('topSearch')) throw new Error('network down');
      return jsonResponse({ announcements: [] });
    };

    await expect(getAnnouncements('300750', { limit: 5 })).rejects.toThrow(
      /Unable to resolve the CNINFO orgId for 300750/,
    );

    // Must not fabricate an orgId and hit the query endpoint with it.
    expect(requestedUrls.some((u) => u.includes('hisAnnouncement/query'))).toBe(false);
  });

  test('still resolves a main-board code via the heuristic when topSearch is down', async () => {
    handler = (url) => {
      if (url.includes('topSearch')) throw new Error('network down');
      return jsonResponse({ announcements: [] });
    };

    await getAnnouncements('600519', { limit: 5 });

    const queryIndex = requestedUrls.findIndex((u) => u.includes('hisAnnouncement/query'));
    expect(queryIndex).toBeGreaterThan(-1);
    expect(String(requestedInits[queryIndex]?.body)).toContain('stock=600519,gssh0600519');
  });
});
