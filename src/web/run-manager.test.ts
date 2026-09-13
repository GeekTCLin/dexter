import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunManager } from './run-manager.js';
import type { AgentEvent } from '../agent/types.js';
import type { SseFrame } from './types.js';
import { MAX_TOOL_RESULT_CHARS } from '../utils/tool-result-storage.js';

const LARGE_RESULT = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 50);

let originalCwd: string;
let tempDir: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(join(tmpdir(), 'dexter-run-manager-'));
  process.chdir(tempDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
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
  mock.module('../agent/agent.js', () => ({
    Agent: class MockAgent {
      static async create(): Promise<MockAgent> {
        return new MockAgent();
      }

      async *run(): AsyncGenerator<AgentEvent> {
        yield {
          type: 'tool_end',
          tool: 'financial_search',
          args: {},
          result: LARGE_RESULT,
          duration: 1,
        };
        yield { type: 'done', answer: '', toolCalls: [], iterations: 1, totalTime: 1 };
      }
    },
  }));
});

afterEach(() => {
  mock.restore();
});

async function waitForDone(runId: string, timeoutMs = 3000): Promise<SseFrame[]> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const frames = await new RunManager().readPersistedFrames(runId);
    if (frames?.some((frame) => frame.type === 'done')) return frames;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

describe('RunManager durable buffers', () => {
  test('persists frames and large tool results for replay after restart', async () => {
    const manager = new RunManager();
    const { runId } = await manager.startRun({ message: 'hello' });
    const frames = await waitForDone(runId);

    expect(frames.some((frame) => frame.type === 'tool_end')).toBe(true);
    expect(frames.some((frame) => frame.type === 'done')).toBe(true);

    const toolEnd = frames.find((frame) => frame.type === 'tool_end');
    const result = toolEnd?.payload.result as {
      preview: string;
      resultRef: string;
      bytes: number;
    };
    expect(result.bytes).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);
    expect(result.preview).toHaveLength(2000);

    // A fresh manager simulates a restart: nothing in memory, disk still serves.
    const restarted = new RunManager();
    expect(restarted.hasRun(runId)).toBe(false);
    expect(await restarted.hasPersistedRun(runId)).toBe(true);
    expect(await restarted.getToolResult(result.resultRef)).toBe(LARGE_RESULT);

    const from = frames[0].seq;
    const replayed = await restarted.replayPersisted(runId, from);
    expect(replayed?.length).toBe(frames.length - 1);
    expect(replayed?.every((frame) => frame.seq > from)).toBe(true);
    expect(await restarted.replayPersisted('r_missing', -1)).toBeNull();
  });
});
