import { afterEach, describe, expect, test } from 'bun:test';
import { getApiKey, getChatModel } from './llm.js';
import { resolveProvider } from '../providers.js';

const API_KEY_VAR = 'OPENAI_API_KEY';
const originalApiKey = process.env[API_KEY_VAR];

function setApiKey(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[API_KEY_VAR];
  } else {
    process.env[API_KEY_VAR] = value;
  }
}

describe('getApiKey placeholder handling', () => {
  afterEach(() => setApiKey(originalApiKey));

  test('treats a `your-...` placeholder as missing', () => {
    setApiKey('your-openai-api-key');
    expect(() => getApiKey(API_KEY_VAR)).toThrow(
      `[LLM] ${API_KEY_VAR} not found in environment variables`,
    );
  });

  test('treats an empty value as missing', () => {
    setApiKey('');
    expect(() => getApiKey(API_KEY_VAR)).toThrow(
      `[LLM] ${API_KEY_VAR} not found in environment variables`,
    );
  });

  test('accepts a real value', () => {
    setApiKey('sk-test-real-key');
    expect(getApiKey(API_KEY_VAR)).toBe('sk-test-real-key');
  });
});

describe('OpenAI API routing', () => {
  test('uses the Responses API for the GPT-5.6 family', () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    try {
      for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
        const llm = getChatModel(model) as { useResponsesApi?: boolean };
        expect(llm.useResponsesApi).toBe(true);
      }
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });
});

describe('OpenCode Go routing', () => {
  test('routes opencode-go/* to the Go gateway and strips the prefix', () => {
    const previousApiKey = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'test-key';

    try {
      expect(resolveProvider('opencode-go/glm-5.3').id).toBe('opencode-go');
      expect(resolveProvider('opencode-go/deepseek-v4.1-flash').fastModel).toBe(
        'opencode-go/deepseek-v4-flash',
      );
      const llm = getChatModel('opencode-go/glm-5.3') as unknown as { model?: string };
      expect(llm.model).toBe('glm-5.3');
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENCODE_API_KEY;
      } else {
        process.env.OPENCODE_API_KEY = previousApiKey;
      }
    }
  });
});
