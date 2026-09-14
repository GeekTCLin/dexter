import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import { getIndustryBoards, getIndustryMembers } from './industry-api.js';

const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];
let handler: (url: string) => Response | Promise<Response>;

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
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

const BOARDS_BODY = JSON.stringify({
  data: {
    total: 2,
    diff: [
      {
        f12: 'BK1010',
        f14: 'Agriculture',
        f2: 1234.5,
        f3: 2.1,
        f104: 80,
        f105: 5,
        f140: '000001',
        f141: 'PingAn',
      },
      { f12: 'BK1020', f14: 'Mining', f2: 900, f3: -1.3, f104: 10, f105: 40, f140: '600000' },
    ],
  },
});

const MEMBERS_BODY = JSON.stringify({
  data: {
    total: 1,
    diff: [{ f12: '000001', f13: 0, f14: 'PingAn', f2: 11.5, f3: 0.5 }],
  },
});

describe('getIndustryBoards', () => {
  test('parses the industry board list', async () => {
    handler = () => textResponse(BOARDS_BODY);

    const result = await getIndustryBoards(2);

    expect(result.source).toBe('eastmoney');
    expect(result.value.kind).toBe('boards');
    if (result.value.kind !== 'boards') throw new Error('expected boards');
    expect(result.value.total).toBe(2);
    expect(result.value.boards.length).toBe(2);
    expect(result.value.boards[0]).toEqual({
      code: 'BK1010',
      name: 'Agriculture',
      changePercent: 2.1,
      up: 80,
      down: 5,
      leaderCode: '000001',
      leader: 'PingAn',
    });
    expect(requestedUrls.some((u) => u.includes('clist/get'))).toBe(true);
  });

  test('throws when the provider errors', async () => {
    handler = () => textResponse('boom', 500);

    await expect(getIndustryBoards()).rejects.toThrow();
  });
});

describe('getIndustryMembers', () => {
  test('accepts a BK code directly with a single request', async () => {
    handler = (url) => {
      if (url.includes('fs=b%3ABK1010') || url.includes('fs=b:BK1010')) {
        return textResponse(MEMBERS_BODY);
      }
      return textResponse(BOARDS_BODY);
    };

    const result = await getIndustryMembers('BK1010', 2);

    expect(result.value.kind).toBe('members');
    if (result.value.kind !== 'members') throw new Error('expected members');
    expect(result.value.board).toBe('BK1010');
    expect(result.value.total).toBe(1);
    expect(result.value.members[0]).toEqual({
      code: '000001',
      market: '0',
      name: 'PingAn',
      price: 11.5,
      changePercent: 0.5,
    });
    expect(requestedUrls.length).toBe(1);
  });

  test('resolves a board name before fetching members', async () => {
    handler = (url) => {
      if (url.includes('fs=b%3ABK1010') || url.includes('fs=b:BK1010')) {
        return textResponse(MEMBERS_BODY);
      }
      return textResponse(BOARDS_BODY);
    };

    const result = await getIndustryMembers('Agriculture', 2);

    expect(result.value.kind).toBe('members');
    if (result.value.kind !== 'members') throw new Error('expected members');
    expect(result.value.board).toBe('BK1010');
    expect(requestedUrls.length).toBe(2);
  });

  test('throws for an unknown board name', async () => {
    handler = () => textResponse(BOARDS_BODY);

    await expect(getIndustryMembers('NoSuchBoard')).rejects.toThrow('Unknown industry board');
  });
});
