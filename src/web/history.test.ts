import { describe, expect, test } from 'bun:test';
import { buildHistoryFromMessages } from './history.js';
import type { ConversationMessage } from './chat-store.js';

function message(
  role: ConversationMessage['role'],
  content: string,
  timestamp: number,
): ConversationMessage {
  return { id: `${timestamp}`, role, content, timestamp };
}

describe('buildHistoryFromMessages', () => {
  test('rebuilds completed user/assistant turns from persisted messages', () => {
    const history = buildHistoryFromMessages('gpt-5.5', [
      message('user', 'Q1', 1),
      message('assistant', 'A1', 2),
      message('user', 'Q2', 3),
      message('assistant', 'A2', 4),
    ]);

    expect(history.getMessages()).toEqual([
      { id: 0, query: 'Q1', answer: 'A1', summary: null },
      { id: 1, query: 'Q2', answer: 'A2', summary: null },
    ]);
    expect(history.getRecentTurnsAsMessages()).toHaveLength(4);
  });

  test('keeps a trailing unanswered user message', () => {
    const history = buildHistoryFromMessages('gpt-5.5', [
      message('user', 'Q1', 1),
      message('assistant', 'A1', 2),
      message('user', 'pending', 3),
    ]);

    expect(history.getMessages()).toEqual([
      { id: 0, query: 'Q1', answer: 'A1', summary: null },
      { id: 1, query: 'pending', answer: null, summary: null },
    ]);
  });

  test('ignores assistant messages with no preceding user message', () => {
    const history = buildHistoryFromMessages('gpt-5.5', [
      message('assistant', 'orphan', 1),
      message('user', 'Q1', 2),
      message('assistant', 'A1', 3),
    ]);

    expect(history.getMessages()).toEqual([
      { id: 0, query: 'Q1', answer: 'A1', summary: null },
    ]);
  });

  test('handles an empty conversation', () => {
    const history = buildHistoryFromMessages('gpt-5.5', []);
    expect(history.getMessages()).toEqual([]);
    expect(history.hasMessages()).toBe(false);
  });
});
