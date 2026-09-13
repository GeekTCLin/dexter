import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import { bingSearch } from './bing.js';
import { baiduSearch } from './baidu.js';

// ---------------------------------------------------------------------------
// Unit tests mock global fetch and clear the on-disk cache between cases so
// stale entries never satisfy a request that should hit the stubbed network.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function xmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

function parseResults(raw: unknown): { results: Array<{ title: string; url: string; snippet?: string }> } {
  const outer = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return (outer as { data: { results: Array<{ title: string; url: string; snippet?: string }> } }).data;
}

beforeEach(() => {
  requestedUrls = [];
  rmSync(dexterPath('cache'), { recursive: true, force: true });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(url);
    return handler(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BING_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
<item><title>贵州茅台最新消息</title><link>https://www.example.com/a</link><description>贵州茅台发布公告 &lt;b&gt;详情&lt;/b&gt;</description></item>
<item><title>A股指数收涨</title><link>https://www.example.com/b</link><description>沪指上涨</description></item>
</channel></rss>`;

const BING_HTML = `<html><body><ol>
<li class="b_algo"><h2><a href="https://cn.example.com/x">茅台股票分析</a></h2><div class="b_caption"><p>茅台近期走势分析</p></div></li>
<li class="b_algo"><h2><a href="https://cn.example.com/y">A股指数行情</a></h2><div class="b_caption"><p>指数今日收涨</p></div></li>
</ol></body></html>`;

const BAIDU_HTML = `<html><body>
<div class="result c-container"><h3><a href="http://www.baidu.com/link?url=abc">贵州茅台股票</a></h3><div class="c-abstract">茅台股票行情_百度股市通</div></div>
<div class="result"><h3><a href="https://finance.example.com/idx">A股指数</a></h3><div class="content-right_8Zs40">上证指数今日收涨</div></div>
</body></html>`;

describe('bingSearch', () => {
  test('parses the RSS feed and strips embedded markup from descriptions', async () => {
    handler = () => xmlResponse(BING_RSS);

    const results = parseResults(await bingSearch.invoke({ query: '贵州茅台' }));

    expect(results.results.length).toBe(2);
    expect(results.results[0].title).toBe('贵州茅台最新消息');
    expect(results.results[0].url).toBe('https://www.example.com/a');
    expect(results.results[0].snippet).toBe('贵州茅台发布公告 详情');
    expect(requestedUrls[0]).toContain('format=rss');
  });

  test('falls back to parsing the HTML result page when RSS is not XML', async () => {
    handler = (url) => {
      if (url.includes('format=rss')) return htmlResponse('<html><body>no rss here</body></html>');
      return htmlResponse(BING_HTML);
    };

    const results = parseResults(await bingSearch.invoke({ query: 'A股 指数' }));

    expect(results.results.length).toBe(2);
    expect(results.results[0].title).toBe('茅台股票分析');
    expect(results.results[0].url).toBe('https://cn.example.com/x');
    expect(requestedUrls.some((u) => u.includes('cn.bing.com'))).toBe(true);
  });

  test('throws when both RSS and HTML return no results', async () => {
    handler = (url) => {
      if (url.includes('format=rss')) return xmlResponse('<rss version="2.0"><channel></channel></rss>');
      return htmlResponse('<html><body><p>没有任何结果</p></body></html>');
    };

    await expect(bingSearch.invoke({ query: '不存在的查询' })).rejects.toThrow('[Bing] No results');
  });

  test('throws on a verification page', async () => {
    handler = () => htmlResponse('<html><body>安全验证 请输入验证码</body></html>');

    await expect(bingSearch.invoke({ query: '贵州茅台' })).rejects.toThrow('[Bing] Verification page');
  });
});

describe('baiduSearch', () => {
  test('parses Baidu SERP blocks and preserves redirect links', async () => {
    handler = () => htmlResponse(BAIDU_HTML);

    const results = parseResults(await baiduSearch.invoke({ query: '贵州茅台' }));

    expect(results.results.length).toBe(2);
    expect(results.results[0].title).toBe('贵州茅台股票');
    // Redirect links are intentionally left unresolved for web_fetch to follow.
    expect(results.results[0].url).toBe('http://www.baidu.com/link?url=abc');
    expect(results.results[0].snippet).toBe('茅台股票行情_百度股市通');
    expect(results.results[1].snippet).toBe('上证指数今日收涨');
    expect(requestedUrls[0]).toContain('wd=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0');
  });

  test('throws when no result blocks are present', async () => {
    handler = () => htmlResponse('<html><body><p>抱歉，没有找到相关结果</p></body></html>');

    await expect(baiduSearch.invoke({ query: '不存在的查询' })).rejects.toThrow('[Baidu] No results');
  });

  test('throws on a verification page', async () => {
    handler = () => htmlResponse('<html><body>请输入验证码 人机验证</body></html>');

    await expect(baiduSearch.invoke({ query: '贵州茅台' })).rejects.toThrow('[Baidu] Verification page');
  });
});
