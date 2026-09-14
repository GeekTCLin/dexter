import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'fs';
import { dexterPath } from '../../utils/paths.js';
import { getConceptBoards, getConceptMembers } from './industry-api.js';

const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];
let handler: (url: string) => Response | Promise<Response>;

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
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

describe('getConceptBoards', () => {
  test('lists concept boards using the concept clist filter', async () => {
    handler = () =>
      textResponse(
        JSON.stringify({
          data: {
            total: 2,
            diff: [
              { f12: 'BK0999', f14: 'AIConcept', f3: 3.5, f104: 100, f105: 20, f140: '300750', f141: 'CATL' },
              { f12: 'BK1000', f14: 'Robotics', f3: 1.2, f104: 60, f105: 30, f140: '002050', f141: 'Sanhua' },
            ],
          },
        }),
      );

    const result = await getConceptBoards(10);
    expect(result.value.kind).toBe('boards');
    expect(result.value.boards.length).toBe(2);
    expect(result.value.boards[0]).toMatchObject({
      code: 'BK0999',
      name: 'AIConcept',
      changePercent: 3.5,
      up: 100,
      down: 20,
      leaderCode: '300750',
      leader: 'CATL',
    });
    expect(requestedUrls.some((u) => u.includes('m%3A90%2Bt%3A3'))).toBe(true);
  });
});

describe('getConceptMembers', () => {
  test('returns member stocks for a concept board code', async () => {
    handler = (url) => {
      if (url.includes('b%3ABK0999')) {
        return textResponse(
          JSON.stringify({ data: { total: 1, diff: [{ f12: '300750', f13: 0, f14: 'CATL', f2: 180.5, f3: 2.1 }] } }),
        );
      }
      return textResponse(JSON.stringify({ data: { total: 0, diff: [] } }));
    };

    const result = await getConceptMembers('BK0999', 10);
    expect(result.value.kind).toBe('members');
    expect(result.value.board).toBe('BK0999');
    expect(result.value.members[0]).toMatchObject({
      code: '300750',
      market: '0',
      name: 'CATL',
      price: 180.5,
      changePercent: 2.1,
    });
  });

  test('throws for an unknown concept board name', async () => {
    handler = () => textResponse(JSON.stringify({ data: { total: 0, diff: [] } }));
    await expect(getConceptMembers('NOPE', 10)).rejects.toThrow(/Unknown/);
  });
});
