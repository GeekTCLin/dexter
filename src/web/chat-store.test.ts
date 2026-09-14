import { afterAll, beforeAll, describe, expect, test, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendMessage,
  cleanupConversations,
  CONVERSATION_RETENTION_DAYS,
  createConversation,
  deleteConversation,
  deriveTitle,
  getConversation,
  listConversations,
} from './chat-store.js';

const DEFAULT_TITLE = '新对话';

let originalCwd: string;
let tempDir: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(join(tmpdir(), 'dexter-chat-store-'));
  process.chdir(tempDir);
  mock.module('../utils/long-term-chat-history.js', () => ({
    LongTermChatHistory: class {
      async addUserMessage(): Promise<void> {}
      async updateAgentResponse(): Promise<void> {}
      getMessages(): unknown[] {
        return [];
      }
      getMessageStrings(): string[] {
        return [];
      }
    },
  }));
});

afterAll(() => {
  mock.restore();
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('deriveTitle', () => {
  test('uses the first 30 characters', () => {
    expect(deriveTitle('a'.repeat(40))).toBe(`${'a'.repeat(30)}…`);
  });

  test('collapses whitespace', () => {
    expect(deriveTitle('  hello   world  ')).toBe('hello world');
  });

  test('falls back when the message is blank', () => {
    expect(deriveTitle('   ')).toBe(DEFAULT_TITLE);
  });
});

describe('conversations', () => {
  test('derive the title from the first user message', async () => {
    const conversation = await createConversation();
    expect(conversation.title).toBe(DEFAULT_TITLE);
    expect(conversation.messages).toHaveLength(0);

    await appendMessage(conversation.id, { role: 'user', content: 'b'.repeat(50) });
    await appendMessage(conversation.id, { role: 'assistant', content: 'answer' });
    await appendMessage(conversation.id, { role: 'user', content: 'a later question' });

    const loaded = await getConversation(conversation.id);
    expect(loaded?.title).toBe(`${'b'.repeat(30)}…`);
    expect(loaded?.messages).toHaveLength(3);
    expect(loaded?.messages[0]).toMatchObject({ role: 'user', content: 'b'.repeat(50) });
    expect(typeof loaded?.messages[0].timestamp).toBe('number');
  });

  test('normalizes an explicit title', async () => {
    const conversation = await createConversation('  My   Title  ');
    expect(conversation.title).toBe('My Title');
  });

  test('lists summaries with messageCount, newest first', async () => {
    const first = await createConversation();
    await appendMessage(first.id, { role: 'user', content: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createConversation();
    await appendMessage(second.id, { role: 'user', content: 'second' });

    const list = await listConversations();
    const summary = list.find((entry) => entry.id === first.id);
    expect(summary).toMatchObject({ id: first.id, title: 'first', messageCount: 1 });
    expect(typeof summary?.createdAt).toBe('number');
    expect(typeof summary?.updatedAt).toBe('number');

    const indexSecond = list.findIndex((entry) => entry.id === second.id);
    const indexFirst = list.findIndex((entry) => entry.id === first.id);
    expect(indexSecond).toBeLessThan(indexFirst);
  });
});

describe('cleanup', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  test('keeps conversations inside the retention window', async () => {
    const conversation = await createConversation();
    await appendMessage(conversation.id, { role: 'user', content: 'recent' });

    const result = await cleanupConversations(CONVERSATION_RETENTION_DAYS);
    expect(result.deleted).not.toContain(conversation.id);
    expect(await getConversation(conversation.id)).not.toBeNull();
  });

  test('deletes conversations past the retention window', async () => {
    const conversation = await createConversation();
    await appendMessage(conversation.id, { role: 'user', content: 'stale' });

    const future = Date.now() + (CONVERSATION_RETENTION_DAYS + 1) * DAY_MS;
    const result = await cleanupConversations(CONVERSATION_RETENTION_DAYS, future);
    expect(result.deleted).toContain(conversation.id);
    expect(await getConversation(conversation.id)).toBeNull();
  });

  test('deleteConversation removes a single conversation', async () => {
    const conversation = await createConversation();
    expect(await deleteConversation(conversation.id)).toBe(true);
    expect(await getConversation(conversation.id)).toBeNull();
    expect(await deleteConversation(conversation.id)).toBe(false);
  });
});
