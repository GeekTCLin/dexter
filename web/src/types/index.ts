/* ─── Wire contract ──────────────────────────────────────────────────────
 * Mirrors the backend contract in src/web/types.ts + src/agent/types.ts.
 *
 * SSE frame:  id: <seq> / event: agent / data: {runId, seq, type, payload}
 * `payload` is the raw agent event object minus its `type` discriminant.
 * `user_question` is a web-only synthesized prompt frame pushed on the same
 * stream. The terminal frame is `event: done` with `{runId, answer}`.
 */

export type ApprovalDecision =
  | "allow-once"
  | "allow-session"
  | "allow-always"
  | "deny";

export type PermissionMode = "allow" | "ask" | "deny";

/** Mirrors src/permissions/types.ts PermissionDecision (UI-facing subset). */
export interface PermissionDecision {
  mode: PermissionMode;
  reason: string;
  command?: string;
  classification?: "read-only" | "mutating" | "unknown";
  matchedRule?: string;
  proposedRule?: string;
  sandboxLevel?: string;
  sessionCacheable?: boolean;
}

export type StreamMode =
  | "requesting"
  | "thinking"
  | "responding"
  | "tool-input"
  | "tool-use";

/** Raw `AgentEvent['type']` discriminants plus the web-only `user_question`. */
export type AgentEventType =
  | "thinking"
  | "tool_start"
  | "tool_progress"
  | "tool_end"
  | "tool_error"
  | "tool_approval"
  | "tool_denied"
  | "tool_limit"
  | "context_cleared"
  | "queue_drain"
  | "microcompact"
  | "compaction"
  | "memory_flush"
  | "memory_recalled"
  | "stream_progress"
  | "done"
  | "user_question";

/* ─── Payloads (the event object minus `type`) ─── */

export interface ThinkingPayload {
  message: string;
}

export interface ToolStartPayload {
  tool: string;
  args: Record<string, unknown>;
  toolCallId?: string;
}

export interface ToolProgressPayload {
  tool: string;
  message: string;
  toolCallId?: string;
}

/** Large tool results are replaced on the wire by this reference envelope. */
export interface StoredToolResult {
  preview: string;
  resultRef: string;
  bytes: number;
}

export type ToolResultValue = string | StoredToolResult;

export interface ToolEndPayload {
  tool: string;
  args: Record<string, unknown>;
  result: ToolResultValue;
  duration: number;
  toolCallId?: string;
}

export interface ToolErrorPayload {
  tool: string;
  error: string;
  toolCallId?: string;
}

export interface ToolApprovalPayload {
  tool: string;
  args: Record<string, unknown>;
  /** Synthesized pending prompt frame awaiting POST /api/runs/:id/approve. */
  pending?: true;
  command?: string;
  decision?: PermissionDecision;
  /** Present on the real AgentEvent once a decision has been made. */
  approved?: ApprovalDecision;
}

export interface ToolDeniedPayload {
  tool: string;
  args: Record<string, unknown>;
  toolCallId?: string;
}

export interface ToolLimitPayload {
  tool: string;
  warning?: string;
  blocked: boolean;
}

export interface ContextClearedPayload {
  clearedCount: number;
  keptCount: number;
}

export interface QueueDrainPayload {
  messageCount: number;
  mergedText: string;
}

export interface MicrocompactPayload {
  cleared: number;
  tokensSaved: number;
}

export interface CompactionPayload {
  phase: "start" | "end";
  success?: boolean;
  preCompactTokens?: number;
  postCompactTokens?: number;
  compactionModel?: string;
}

export interface MemoryFlushPayload {
  phase: "start" | "end";
  filesWritten?: string[];
}

export interface MemoryRecalledPayload {
  filesLoaded: string[];
  tokenCount: number;
}

export interface StreamProgressPayload {
  charDelta: number;
  mode: StreamMode;
  /** Accumulated answer text for the current turn; present only when mode === "responding". */
  text?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface DonePayload {
  answer: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>;
  iterations: number;
  totalTime: number;
  tokenUsage?: TokenUsage;
  tokensPerSecond?: number;
}

export interface UserQuestionPayload {
  questions: Question[];
  pending?: true;
}

/* ─── Questions (mirrors src/tools/ask-user-question/types.ts) ─── */

export interface QuestionOption {
  /** Short label shown in the list and echoed back as the answer. */
  label: string;
  /** One-line explanation of what choosing this option means. */
  description: string;
}

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/* ─── Discriminated SSE event union ─── */

export interface AgentEventPayloads {
  thinking: ThinkingPayload;
  tool_start: ToolStartPayload;
  tool_progress: ToolProgressPayload;
  tool_end: ToolEndPayload;
  tool_error: ToolErrorPayload;
  tool_approval: ToolApprovalPayload;
  tool_denied: ToolDeniedPayload;
  tool_limit: ToolLimitPayload;
  context_cleared: ContextClearedPayload;
  queue_drain: QueueDrainPayload;
  microcompact: MicrocompactPayload;
  compaction: CompactionPayload;
  memory_flush: MemoryFlushPayload;
  memory_recalled: MemoryRecalledPayload;
  stream_progress: StreamProgressPayload;
  done: DonePayload;
  user_question: UserQuestionPayload;
}

export type AgentEvent = {
  [K in AgentEventType]: {
    runId: string;
    seq: number;
    type: K;
    payload: AgentEventPayloads[K];
  };
}[AgentEventType];

/** Terminal `event: done` frame — not an agent frame. */
export interface DoneFrame {
  runId: string;
  answer: string;
}

/* ─── Message Types ─── */

export type MessageRole = "user" | "assistant";

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
}

/* ─── Config Types (mirrors src/web/config-routes.ts ConfigResponse) ─── */

export type SearchProviderId = "exa" | "perplexity" | "tavily" | "langsearch";

export interface DexterConfig {
  provider: string;
  modelId: string;
  models: Array<{ id: string; name: string }>;
  searchProvider: SearchProviderId;
  memoryEnabled: boolean;
  hasApiKey: boolean;
}

/* ─── Connection ─── */

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
