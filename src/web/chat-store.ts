import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dexterPath } from '../utils/paths.js';
import { LongTermChatHistory } from '../utils/long-term-chat-history.js';

export type ConversationRole = 'user' | 'assistant';

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const CONVERSATIONS_DIR = dexterPath('conversations');
const DEFAULT_TITLE = '新对话';
const MAX_TITLE_CHARS = 30;
const PLACEHOLDER_TITLES = new Set([DEFAULT_TITLE, 'New conversation']);

/** Conversations untouched for longer than this are swept by cleanup. */
export const CONVERSATION_RETENTION_DAYS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CleanupResult {
  /** Ids of the conversations that were removed. */
  deleted: string[];
  /** Number of conversations left in place. */
  kept: number;
}

let flatHistory: LongTermChatHistory | null = null;

function getFlatHistory(): LongTermChatHistory {
  if (!flatHistory) {
    flatHistory = new LongTermChatHistory();
  }
  return flatHistory;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function conversationPath(id: string): string {
  return join(CONVERSATIONS_DIR, `${sanitizeId(id)}.json`);
}

/** Derive a conversation title from its first user message. */
export function deriveTitle(message: string): string {
  const trimmed = message.replace(/\s+/g, ' ').trim();
  if (!trimmed) return DEFAULT_TITLE;
  return trimmed.length > MAX_TITLE_CHARS ? `${trimmed.slice(0, MAX_TITLE_CHARS)}…` : trimmed;
}

function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title.trim());
}

function normalizeTitle(title?: string): string {
  return title?.trim() ? deriveTitle(title) : DEFAULT_TITLE;
}

async function save(conversation: Conversation): Promise<void> {
  await mkdir(CONVERSATIONS_DIR, { recursive: true });
  await writeFile(conversationPath(conversation.id), JSON.stringify(conversation, null, 2), 'utf-8');
}

/** Create a new conversation whose JSON file is the source of truth. */
export async function createConversation(title?: string): Promise<Conversation> {
  const now = Date.now();
  const conversation: Conversation = {
    id: randomUUID(),
    title: normalizeTitle(title),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await save(conversation);
  return conversation;
}

/** Read a conversation, returning null when it does not exist or is invalid. */
export async function getConversation(id: string): Promise<Conversation | null> {
  try {
    const raw = await readFile(conversationPath(id), 'utf-8');
    const parsed = JSON.parse(raw) as Conversation;
    if (!parsed?.id || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** List conversation summaries, newest first. */
export async function listConversations(): Promise<ConversationSummary[]> {
  let files: string[];
  try {
    files = await readdir(CONVERSATIONS_DIR);
  } catch {
    return [];
  }

  const summaries: ConversationSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const conversation = await getConversation(file.slice(0, -'.json'.length));
    if (!conversation) continue;
    summaries.push({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
    });
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Delete a conversation's JSON file. Returns true when a file was removed. */
export async function deleteConversation(id: string): Promise<boolean> {
  try {
    await unlink(conversationPath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete conversations not updated within the retention window. The flat
 * chat_history.json and memory store are intentionally left untouched: deleting
 * a conversation only forgets this archived thread, not what Dexter has learned.
 */
export async function cleanupConversations(
  maxAgeDays: number = CONVERSATION_RETENTION_DAYS,
  now: number = Date.now(),
): Promise<CleanupResult> {
  const cutoff = now - maxAgeDays * DAY_MS;
  const summaries = await listConversations();
  const deleted: string[] = [];
  for (const summary of summaries) {
    if (summary.updatedAt < cutoff && (await deleteConversation(summary.id))) {
      deleted.push(summary.id);
    }
  }
  return { deleted, kept: summaries.length - deleted.length };
}

/**
 * Append a message to the per-conversation JSON and mirror it to the flat
 * chat_history.json so the CLI `/history` command stays consistent.
 */
export async function appendMessage(
  conversationId: string,
  message: { role: ConversationRole; content: string },
): Promise<Conversation | null> {
  const conversation = await getConversation(conversationId);
  if (!conversation) return null;

  const now = Date.now();
  conversation.messages.push({
    id: randomUUID(),
    role: message.role,
    content: message.content,
    timestamp: now,
  });
  conversation.updatedAt = now;
  const userMessageCount = conversation.messages.filter((entry) => entry.role === 'user').length;
  if (
    message.role === 'user' &&
    userMessageCount === 1 &&
    isPlaceholderTitle(conversation.title)
  ) {
    conversation.title = deriveTitle(message.content);
  }
  await save(conversation);

  try {
    const flat = getFlatHistory();
    if (message.role === 'user') {
      await flat.addUserMessage(message.content);
    } else {
      await flat.updateAgentResponse(message.content);
    }
  } catch {
    // Flat history is best-effort and must not break the web conversation.
  }

  return conversation;
}
