import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { OllamaEmbeddings } from '@langchain/ollama';
import { OpenAIEmbeddings } from '@langchain/openai';
import { checkApiKeyExists } from '../utils/env.js';
import type { EmbeddingProviderId, MemoryEmbeddingClient } from './types.js';

const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';
const DEFAULT_GEMINI_MODEL = 'gemini-embedding-001';
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';
// Generic OpenAI-compatible endpoints usually ship their own model names, so
// MEMORY_EMBEDDING_MODEL is the intended source; this is only a last resort.
const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'text-embedding-3-small';
const DEFAULT_EMBEDDING_TIMEOUT_MS = 15_000;
const DEFAULT_EMBEDDING_COOLDOWN_MS = 30_000;
const EMBEDDING_BATCH_SIZE = 64;

type ResolvedProvider = Exclude<EmbeddingProviderId, 'auto' | 'none'>;

type DocumentEmbedder = {
  embedDocuments(texts: string[]): Promise<number[][]>;
};

// provider -> epoch ms until which it is considered cooling down after a failure.
// A failed provider is skipped by createEmbeddingClient so callers degrade to
// keyword-only search immediately instead of re-paying the timeout on every query.
const cooldownUntil = new Map<ResolvedProvider, number>();
let clock: () => number = () => Date.now();

// Test-only hooks: advance the clock / clear cooldown state without sleeping.
export const __embeddingTestHooks = {
  setClock(next: (() => number) | null): void {
    clock = next ?? (() => Date.now());
  },
  clearCooldowns(): void {
    cooldownUntil.clear();
  },
  recordFailure(provider: ResolvedProvider): void {
    recordEmbeddingFailure(provider);
  },
};

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export function getEmbeddingTimeoutMs(): number {
  return parseNonNegativeInt(process.env.MEMORY_EMBEDDING_TIMEOUT_MS, DEFAULT_EMBEDDING_TIMEOUT_MS);
}

function getEmbeddingCooldownMs(): number {
  return parseNonNegativeInt(process.env.MEMORY_EMBEDDING_COOLDOWN_MS, DEFAULT_EMBEDDING_COOLDOWN_MS);
}

function hasOpenAiCompatibleConfig(): boolean {
  return Boolean(process.env.MEMORY_EMBEDDING_BASE_URL?.trim());
}

function isCoolingDown(provider: ResolvedProvider): boolean {
  const until = cooldownUntil.get(provider);
  if (until === undefined) {
    return false;
  }
  if (clock() >= until) {
    cooldownUntil.delete(provider);
    return false;
  }
  return true;
}

function recordEmbeddingFailure(provider: ResolvedProvider): void {
  cooldownUntil.set(provider, clock() + getEmbeddingCooldownMs());
}

function clearEmbeddingFailure(provider: ResolvedProvider): void {
  cooldownUntil.delete(provider);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function resolveProvider(preferred: EmbeddingProviderId): ResolvedProvider | null {
  // Placeholder-aware: an empty or `your-...` value counts as unconfigured,
  // matching checkApiKeyExists() in src/utils/env.ts so `.env` placeholders never
  // select a provider. Without this, `OPENAI_API_KEY=your-...` is truthy and
  // auto-selects OpenAI, which then times out instead of degrading to keyword search.
  if (preferred === 'openai' && checkApiKeyExists('OPENAI_API_KEY')) {
    return 'openai';
  }
  if (preferred === 'gemini' && checkApiKeyExists('GOOGLE_API_KEY')) {
    return 'gemini';
  }
  if (preferred === 'openai-compatible' && hasOpenAiCompatibleConfig()) {
    return 'openai-compatible';
  }
  if (preferred === 'ollama') {
    return 'ollama';
  }

  if (preferred === 'auto') {
    // Priority: OpenAI (real key) -> Gemini (real key) -> OpenAI-compatible
    // (MEMORY_EMBEDDING_BASE_URL set) -> Ollama (OLLAMA_BASE_URL set).
    if (checkApiKeyExists('OPENAI_API_KEY')) {
      return 'openai';
    }
    if (checkApiKeyExists('GOOGLE_API_KEY')) {
      return 'gemini';
    }
    if (hasOpenAiCompatibleConfig()) {
      return 'openai-compatible';
    }
    if (process.env.OLLAMA_BASE_URL) {
      return 'ollama';
    }
  }

  return null;
}

async function embedInBatches(
  texts: string[],
  embedBatch: (batch: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const result = await withTimeout(embedBatch(batch), getEmbeddingTimeoutMs(), 'Embedding API timed out');
    vectors.push(...result);
  }
  return vectors;
}

/**
 * Wraps an embedder so that a failed request cools the provider down and a
 * successful one clears that cooldown. The error is re-thrown — callers decide
 * whether to fall back to keyword-only search.
 */
function createEmbedFn(
  provider: ResolvedProvider,
  embeddings: DocumentEmbedder,
): (texts: string[]) => Promise<number[][]> {
  return async (texts: string[]): Promise<number[][]> => {
    try {
      const vectors = await embedInBatches(texts, (batch) => embeddings.embedDocuments(batch));
      clearEmbeddingFailure(provider);
      return vectors;
    } catch (error) {
      recordEmbeddingFailure(provider);
      throw error;
    }
  };
}

/**
 * Reports whether an embedding provider is currently usable for the given
 * setting. `provider` is null when none is configured (or the resolved provider
 * is cooling down after a failure); `reason` explains why in user-facing prose.
 */
export function getEmbeddingStatus(provider: EmbeddingProviderId): { provider: string | null; reason: string | null } {
  if (provider === 'none') {
    return { provider: null, reason: '嵌入提供方已禁用' };
  }
  const resolved = resolveProvider(provider);
  if (!resolved) {
    return { provider: null, reason: '未配置可用嵌入提供方' };
  }
  if (isCoolingDown(resolved)) {
    return { provider: null, reason: `嵌入提供方 ${resolved} 最近调用失败` };
  }
  return { provider: resolved, reason: null };
}

export function createEmbeddingClient(params: {
  provider: EmbeddingProviderId;
  model?: string;
}): MemoryEmbeddingClient | null {
  const resolved = resolveProvider(params.provider);
  if (!resolved) {
    return null;
  }
  if (isCoolingDown(resolved)) {
    return null;
  }

  if (resolved === 'openai') {
    const model = params.model || DEFAULT_OPENAI_MODEL;
    const embeddings = new OpenAIEmbeddings({
      apiKey: process.env.OPENAI_API_KEY,
      model,
    });
    return {
      provider: 'openai',
      model,
      embed: createEmbedFn('openai', embeddings),
    };
  }

  if (resolved === 'gemini') {
    const model = params.model || DEFAULT_GEMINI_MODEL;
    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GOOGLE_API_KEY,
      model,
    });
    return {
      provider: 'gemini',
      model,
      embed: createEmbedFn('gemini', embeddings),
    };
  }

  if (resolved === 'openai-compatible') {
    const model = params.model || process.env.MEMORY_EMBEDDING_MODEL || DEFAULT_OPENAI_COMPATIBLE_MODEL;
    const baseURL = process.env.MEMORY_EMBEDDING_BASE_URL?.trim();
    if (!baseURL) {
      return null;
    }
    // Some self-hosted / intranet endpoints don't validate keys, so default to a
    // placeholder when MEMORY_EMBEDDING_API_KEY is absent.
    const apiKey = process.env.MEMORY_EMBEDDING_API_KEY?.trim() || 'not-needed';
    const embeddings = new OpenAIEmbeddings({
      apiKey,
      model,
      // maxRetries: 0 keeps failures fast so the cooldown kicks in promptly.
      configuration: { baseURL, maxRetries: 0 },
    });
    return {
      provider: 'openai-compatible',
      model,
      embed: createEmbedFn('openai-compatible', embeddings),
    };
  }

  const model = params.model || DEFAULT_OLLAMA_MODEL;
  const embeddings = new OllamaEmbeddings({
    baseUrl: process.env.OLLAMA_BASE_URL,
    model,
  });
  return {
    provider: 'ollama',
    model,
    embed: createEmbedFn('ollama', embeddings),
  };
}

export async function embedSingleQuery(
  client: MemoryEmbeddingClient | null,
  query: string,
): Promise<number[] | null> {
  if (!client) {
    return null;
  }
  const vectors = await withTimeout(
    client.embed([query]),
    getEmbeddingTimeoutMs(),
    'Embedding query timed out',
  );
  return vectors[0] ?? null;
}
