import {
  InMemoryChatHistory,
  type Message as HistoryMessage,
} from '../utils/in-memory-chat-history.js';
import type { ConversationMessage } from './chat-store.js';

/**
 * Rebuild an InMemoryChatHistory from persisted conversation messages so a run
 * started after a restart (or on a switched conversation) keeps prior context.
 * InMemoryChatHistory has no public loader, so the private store is seeded.
 */
export function buildHistoryFromMessages(
  model: string,
  messages: ConversationMessage[],
): InMemoryChatHistory {
  const history = new InMemoryChatHistory(model);
  seedHistory(history, messages);
  return history;
}

export function seedHistory(
  history: InMemoryChatHistory,
  messages: ConversationMessage[],
): void {
  const rebuilt: HistoryMessage[] = [];
  let pendingQuery: string | null = null;
  let nextId = 0;

  for (const message of messages) {
    if (message.role === 'user') {
      if (pendingQuery !== null) {
        rebuilt.push({ id: nextId++, query: pendingQuery, answer: null, summary: null });
      }
      pendingQuery = message.content;
    } else if (pendingQuery !== null) {
      rebuilt.push({ id: nextId++, query: pendingQuery, answer: message.content, summary: null });
      pendingQuery = null;
    }
  }
  if (pendingQuery !== null) {
    rebuilt.push({ id: nextId++, query: pendingQuery, answer: null, summary: null });
  }

  (history as unknown as { messages: HistoryMessage[] }).messages = rebuilt;
}
