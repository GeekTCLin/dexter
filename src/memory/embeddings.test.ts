import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  __embeddingTestHooks,
  createEmbeddingClient,
  getEmbeddingStatus,
  getEmbeddingTimeoutMs,
} from './embeddings.js';

// Every key these tests mutate. Saved before each test and restored afterwards so
// the real environment (and `.env`) is left untouched.
const MANAGED_KEYS = [
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'OLLAMA_BASE_URL',
  'MEMORY_EMBEDDING_BASE_URL',
  'MEMORY_EMBEDDING_API_KEY',
  'MEMORY_EMBEDDING_MODEL',
  'MEMORY_EMBEDDING_TIMEOUT_MS',
  'MEMORY_EMBEDDING_COOLDOWN_MS',
] as const;

let originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalEnv = {};
  for (const key of MANAGED_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  __embeddingTestHooks.setClock(null);
  __embeddingTestHooks.clearCooldowns();
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  __embeddingTestHooks.setClock(null);
  __embeddingTestHooks.clearCooldowns();
});

describe('resolveProvider placeholder handling (P0)', () => {
  test('auto does not pick openai for a `your-...` placeholder key', () => {
    process.env.OPENAI_API_KEY = 'your-openai-api-key';
    process.env.GOOGLE_API_KEY = 'your-google-api-key';

    expect(createEmbeddingClient({ provider: 'auto' })).toBeNull();
    expect(getEmbeddingStatus('auto')).toEqual({ provider: null, reason: '未配置可用嵌入提供方' });
  });

  test('auto does not pick openai for an empty key', () => {
    process.env.OPENAI_API_KEY = '';
    process.env.GOOGLE_API_KEY = '';

    expect(createEmbeddingClient({ provider: 'auto' })).toBeNull();
  });

  test('explicit openai with a placeholder key resolves to nothing', () => {
    process.env.OPENAI_API_KEY = 'your-openai-api-key';

    expect(createEmbeddingClient({ provider: 'openai' })).toBeNull();
  });

  test('auto picks openai when a real key is present', () => {
    process.env.OPENAI_API_KEY = 'sk-test-real-key';

    const client = createEmbeddingClient({ provider: 'auto' });
    expect(client).not.toBeNull();
    expect(client?.provider).toBe('openai');
    expect(client?.model).toBe('text-embedding-3-small');
  });

  test('auto still picks ollama when only OLLAMA_BASE_URL is set', () => {
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

    const client = createEmbeddingClient({ provider: 'auto' });
    expect(client?.provider).toBe('ollama');
  });
});

describe('openai-compatible provider', () => {
  test('is enabled by MEMORY_EMBEDDING_BASE_URL and reports its provider/model', () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = 'https://api.siliconflow.cn/v1';
    process.env.MEMORY_EMBEDDING_MODEL = 'BAAI/bge-m3';

    const client = createEmbeddingClient({ provider: 'openai-compatible' });
    expect(client).not.toBeNull();
    expect(client?.provider).toBe('openai-compatible');
    expect(client?.model).toBe('BAAI/bge-m3');
  });

  test('explicit setting model overrides MEMORY_EMBEDDING_MODEL', () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = 'https://api.siliconflow.cn/v1';
    process.env.MEMORY_EMBEDDING_MODEL = 'env-model';

    const client = createEmbeddingClient({ provider: 'openai-compatible', model: 'settings-model' });
    expect(client?.model).toBe('settings-model');
  });

  test('falls back to a default model when MEMORY_EMBEDDING_MODEL is unset', () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = 'https://api.siliconflow.cn/v1';

    const client = createEmbeddingClient({ provider: 'openai-compatible' });
    expect(client?.model).toBe('text-embedding-3-small');
  });

  test('missing API key falls back to a placeholder and still creates a client', () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = 'http://127.0.0.1:8000/v1';

    expect(createEmbeddingClient({ provider: 'openai-compatible' })).not.toBeNull();
  });

  test('is not enabled when MEMORY_EMBEDDING_BASE_URL is unset', () => {
    expect(createEmbeddingClient({ provider: 'openai-compatible' })).toBeNull();
  });

  test('auto prefers openai-compatible over ollama but after openai/gemini', () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = 'https://api.siliconflow.cn/v1';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    expect(createEmbeddingClient({ provider: 'auto' })?.provider).toBe('openai-compatible');

    process.env.OPENAI_API_KEY = 'sk-test-real-key';
    expect(createEmbeddingClient({ provider: 'auto' })?.provider).toBe('openai');
  });
});

describe('failure cooldown (P1)', () => {
  test('a failed provider is skipped by createEmbeddingClient, then recovers after the window', () => {
    process.env.MEMORY_EMBEDDING_BASE_URL = 'http://127.0.0.1:1/v1';

    const client = createEmbeddingClient({ provider: 'openai-compatible' });
    expect(client).not.toBeNull();

    // Simulates the wrapper recording a failed embed call (no network access).
    __embeddingTestHooks.recordFailure('openai-compatible');

    expect(createEmbeddingClient({ provider: 'openai-compatible' })).toBeNull();
    expect(getEmbeddingStatus('openai-compatible').provider).toBeNull();

    // Jump past the cooldown window instead of sleeping.
    __embeddingTestHooks.setClock(() => Date.now() + 120_000);
    expect(createEmbeddingClient({ provider: 'openai-compatible' })).not.toBeNull();
    expect(getEmbeddingStatus('openai-compatible').provider).toBe('openai-compatible');
  });
});

describe('getEmbeddingTimeoutMs (P1)', () => {
  test('defaults to 15000 when unset', () => {
    expect(getEmbeddingTimeoutMs()).toBe(15_000);
  });

  test('parses a valid value', () => {
    process.env.MEMORY_EMBEDDING_TIMEOUT_MS = '500';
    expect(getEmbeddingTimeoutMs()).toBe(500);
  });

  test('falls back to 15000 for non-numeric and negative values', () => {
    process.env.MEMORY_EMBEDDING_TIMEOUT_MS = 'abc';
    expect(getEmbeddingTimeoutMs()).toBe(15_000);

    process.env.MEMORY_EMBEDDING_TIMEOUT_MS = '-1';
    expect(getEmbeddingTimeoutMs()).toBe(15_000);
  });
});
