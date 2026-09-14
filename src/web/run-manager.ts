import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '../agent/agent.js';
import type { AgentEvent, ApprovalDecision, ToolEndEvent } from '../agent/types.js';
import type { PermissionDecision } from '../permissions/types.js';
import type { Question, UserAnswers } from '../tools/ask-user-question/types.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { getSetting } from '../utils/config.js';
import { getDefaultModelForProvider } from '../utils/model.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../model/llm.js';
import { dexterPath } from '../utils/paths.js';
import { MAX_TOOL_RESULT_CHARS, PREVIEW_CHARS } from '../utils/tool-result-storage.js';
import { toQuestionAnswers } from './answers.js';
import { appendMessage, createConversation, getConversation } from './chat-store.js';
import type { ConversationMessage } from './chat-store.js';
import { buildHistoryFromMessages } from './history.js';
import type { QuestionAnswerInput, SseFrame, WebEventType } from './types.js';

const RUNS_DIR = dexterPath('runs');
const TOOL_RESULTS_DIR = dexterPath('tool-results');

function sanitizeFileId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function runPath(runId: string): string {
  return join(RUNS_DIR, `${sanitizeFileId(runId)}.json`);
}

function toolResultPath(id: string): string {
  return join(TOOL_RESULTS_DIR, `${sanitizeFileId(id)}.json`);
}

interface ApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
  command?: string;
  decision?: PermissionDecision;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

interface PendingQuestion {
  request: { questions: Question[] };
  resolve: (answers: UserAnswers) => void;
}

interface RunState {
  id: string;
  conversationId: string;
  agent?: Agent;
  events: SseFrame[];
  nextSeq: number;
  listeners: Set<(frame: SseFrame) => void>;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
  abortController: AbortController;
  running: boolean;
  completed: boolean;
  finalAnswer: string;
  persistChain: Promise<void>;
}

interface RunConfig {
  model: string;
  provider: string;
  memoryEnabled: boolean;
  requestToolApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  requestUserInput: (request: { questions: Question[] }) => Promise<UserAnswers>;
}

export interface StartRunParams {
  conversationId?: string;
  message: string;
}

export interface StartRunResult {
  runId: string;
  conversationId: string;
}

/**
 * Owns the lifecycle of in-flight agent runs: Agent creation, sequential event
 * buffering for SSE replay, and the resolver bridge for approvals/questions.
 * Modeled on src/gateway/agent-runner.ts:runAgentForMessage.
 */
export class RunManager {
  private readonly runs = new Map<string, RunState>();
  private readonly histories = new Map<string, InMemoryChatHistory>();
  private readonly toolResults = new Map<string, string>();
  private readonly sessionApprovedTools = new Set<string>();

  async startRun(params: StartRunParams): Promise<StartRunResult> {
    let conversationId = params.conversationId;
    let persistedMessages: ConversationMessage[] = [];
    if (conversationId) {
      const existing = await getConversation(conversationId);
      if (existing) {
        persistedMessages = existing.messages;
      } else {
        conversationId = undefined;
      }
    }
    if (!conversationId) {
      const conversation = await createConversation();
      conversationId = conversation.id;
    }

    const provider = getSetting('provider', DEFAULT_PROVIDER);
    const savedModel = getSetting<string | null>('modelId', null);
    const model = savedModel ?? getDefaultModelForProvider(provider) ?? DEFAULT_MODEL;
    const memoryEnabled =
      getSetting<{ enabled?: boolean } | undefined>('memory', undefined)?.enabled ?? true;

    // Rebuild prior context before this turn is persisted so the current user
    // message is not duplicated in history.
    const history = this.getHistory(conversationId, model, persistedMessages);
    await appendMessage(conversationId, { role: 'user', content: params.message });
    history.saveUserQuery(params.message);

    const runId = `r_${randomUUID()}`;
    const run: RunState = {
      id: runId,
      conversationId,
      events: [],
      nextSeq: 0,
      listeners: new Set(),
      pendingApproval: null,
      pendingQuestion: null,
      abortController: new AbortController(),
      running: true,
      completed: false,
      finalAnswer: '',
      persistChain: Promise.resolve(),
    };
    this.runs.set(runId, run);

    const requestToolApproval = (request: ApprovalRequest): Promise<ApprovalDecision> =>
      new Promise((resolve) => {
        run.pendingApproval = { request, resolve };
        this.pushFrame(run, 'tool_approval', { ...request, pending: true });
      });

    const requestUserInput = (request: { questions: Question[] }): Promise<UserAnswers> =>
      new Promise((resolve) => {
        run.pendingQuestion = { request, resolve };
        this.pushFrame(run, 'user_question', { questions: request.questions, pending: true });
      });

    void this.consume(run, params.message, history, {
      model,
      provider,
      memoryEnabled,
      requestToolApproval,
      requestUserInput,
    });

    return { runId, conversationId };
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * Drop everything cached for a deleted conversation. In-flight runs for it are
   * aborted so a late assistant reply is not persisted to a conversation that no
   * longer exists (appendMessage is a no-op once the file is gone).
   */
  forgetConversation(conversationId: string): void {
    this.histories.delete(conversationId);
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId) run.abortController.abort();
    }
  }

  approve(runId: string, decision: ApprovalDecision): boolean {
    const run = this.runs.get(runId);
    if (!run?.pendingApproval) return false;
    const pending = run.pendingApproval;
    run.pendingApproval = null;
    pending.resolve(decision);
    return true;
  }

  answer(runId: string, answers: QuestionAnswerInput[], declined = false): boolean {
    const run = this.runs.get(runId);
    if (!run?.pendingQuestion) return false;
    const pending = run.pendingQuestion;
    run.pendingQuestion = null;
    pending.resolve({
      answers: toQuestionAnswers(pending.request.questions, answers),
      declined,
    });
    return true;
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.abortController.abort();
    if (run.pendingApproval) {
      run.pendingApproval.resolve('deny');
      run.pendingApproval = null;
    }
    if (run.pendingQuestion) {
      run.pendingQuestion.resolve({ answers: [], declined: true });
      run.pendingQuestion = null;
    }
    return true;
  }

  async getToolResult(id: string): Promise<string | null> {
    const cached = this.toolResults.get(id);
    if (cached !== undefined) return cached;
    try {
      const raw = await readFile(toolResultPath(id), 'utf-8');
      const parsed = JSON.parse(raw) as { content?: unknown };
      if (typeof parsed.content === 'string') {
        this.toolResults.set(id, parsed.content);
        return parsed.content;
      }
    } catch {
      // Not persisted or unreadable.
    }
    return null;
  }

  /** True when a run's buffer exists on disk (e.g. from a previous process). */
  async hasPersistedRun(runId: string): Promise<boolean> {
    return (await this.readPersistedFrames(runId)) !== null;
  }

  /** Load a run's persisted SSE buffer, or null when absent/corrupt. */
  async readPersistedFrames(runId: string): Promise<SseFrame[] | null> {
    try {
      const raw = await readFile(runPath(runId), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SseFrame[]) : null;
    } catch {
      return null;
    }
  }

  /** Persisted frames with seq > from, or null when the run is not persisted. */
  async replayPersisted(runId: string, from: number): Promise<SseFrame[] | null> {
    const frames = await this.readPersistedFrames(runId);
    if (!frames) return null;
    return frames.filter((frame) => frame.seq > from);
  }

  /**
   * Replay buffered frames with seq > from, then stream live frames. The replay
   * is synchronous, so no live frame can interleave and be lost or duplicated.
   */
  subscribe(
    runId: string,
    from: number,
    listener: (frame: SseFrame) => void,
  ): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.listeners.add(listener);
    for (const frame of run.events) {
      if (frame.seq > from) listener(frame);
    }
    return () => run.listeners.delete(listener);
  }

  private getHistory(
    conversationId: string,
    model: string,
    persisted: ConversationMessage[],
  ): InMemoryChatHistory {
    const cached = this.histories.get(conversationId);
    if (cached) {
      cached.setModel(model);
      return cached;
    }
    const history = buildHistoryFromMessages(model, persisted);
    this.histories.set(conversationId, history);
    return history;
  }

  private async consume(
    run: RunState,
    message: string,
    history: InMemoryChatHistory,
    config: RunConfig,
  ): Promise<void> {
    let answer = '';
    try {
      const agent = await Agent.create({
        model: config.model,
        modelProvider: config.provider,
        channel: 'web',
        signal: run.abortController.signal,
        memoryEnabled: config.memoryEnabled,
        requestToolApproval: config.requestToolApproval,
        requestUserInput: config.requestUserInput,
        sessionApprovedTools: this.sessionApprovedTools,
      });
      run.agent = agent;

      for await (const event of agent.run(message, history)) {
        this.pushAgentEvent(run, event);
        // Read back the normalized answer so a cancelled run never persists the
        // provider's abort message as the assistant reply.
        if (event.type === 'done') answer = run.finalAnswer;
      }
    } catch (error) {
      if (!run.completed) {
        answer = isAbortError(error, run.abortController.signal)
          ? ''
          : `Error: ${error instanceof Error ? error.message : String(error)}`;
        this.pushDone(run, answer);
      }
    } finally {
      run.running = false;
      if (run.pendingApproval) {
        run.pendingApproval.resolve('deny');
        run.pendingApproval = null;
      }
      if (run.pendingQuestion) {
        run.pendingQuestion.resolve({ answers: [], declined: true });
        run.pendingQuestion = null;
      }
      if (answer) {
        // Persist immediately; InMemoryChatHistory summary generation may call the LLM.
        await appendMessage(run.conversationId, { role: 'assistant', content: answer }).catch(() => {});
        await history.saveAnswer(answer).catch(() => {});
      }
    }
  }

  private pushAgentEvent(run: RunState, event: AgentEvent): void {
    const { type, ...rest } = event;
    let payload: Record<string, unknown> = { ...rest };

    if (type === 'tool_end') {
      const result = (event as ToolEndEvent).result;
      if (typeof result === 'string' && result.length > MAX_TOOL_RESULT_CHARS) {
        const resultRef = randomUUID();
        this.toolResults.set(resultRef, result);
        this.persistToolResult(resultRef, result);
        payload = {
          ...rest,
          result: {
            preview: result.slice(0, PREVIEW_CHARS),
            resultRef,
            bytes: new TextEncoder().encode(result).length,
          },
        };
      }
    }

    if (type === 'done' && run.abortController.signal.aborted) {
      // The provider's abort can surface from the agent as a normal `done` event
      // whose answer is "Error: ... aborted". A cancelled run must show a clean
      // neutral result instead, matching the synthetic done path below.
      payload = { ...payload, answer: '' };
    }

    this.pushFrame(run, type, payload);
    if (type === 'done') {
      run.completed = true;
      run.finalAnswer = typeof payload.answer === 'string' ? payload.answer : '';
    }
  }

  private pushDone(run: RunState, answer: string): void {
    run.completed = true;
    run.finalAnswer = answer;
    this.pushFrame(run, 'done', { answer, toolCalls: [], iterations: 0, totalTime: 0 });
  }

  private pushFrame(run: RunState, type: WebEventType, payload: Record<string, unknown>): void {
    const frame: SseFrame = { runId: run.id, seq: run.nextSeq++, type, payload };
    run.events.push(frame);
    this.persistRun(run);
    for (const listener of run.listeners) listener(frame);
  }

  /**
   * Best-effort persistence of a run's SSE buffer. Writes are serialized so a
   * slow write can never overwrite a newer snapshot. Failures are logged only.
   */
  private persistRun(run: RunState): void {
    let data: string;
    try {
      data = JSON.stringify(run.events);
    } catch (error) {
      console.error(`[web] failed to serialize run ${run.id}:`, error);
      return;
    }
    run.persistChain = run.persistChain
      .then(async () => {
        await mkdir(RUNS_DIR, { recursive: true });
        await writeFile(runPath(run.id), data, 'utf-8');
      })
      .catch((error) => {
        console.error(`[web] failed to persist run ${run.id}:`, error);
      });
  }

  /** Best-effort persistence of a full large tool result. */
  private persistToolResult(id: string, content: string): void {
    void mkdir(TOOL_RESULTS_DIR, { recursive: true })
      .then(() => writeFile(toolResultPath(id), JSON.stringify({ content }), 'utf-8'))
      .catch((error) => {
        console.error(`[web] failed to persist tool result ${id}:`, error);
      });
  }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  // A cancelled run may surface an abort in several shapes: a native AbortError,
  // a provider-specific error whose message contains "abort" (e.g. "The
  // operation was aborted."), or simply because the run's signal is aborted.
  if (signal?.aborted) return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || /abort/i.test(error.message);
  }
  return typeof error === 'string' && /abort/i.test(error);
}

