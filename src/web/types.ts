import type { AgentEvent, ApprovalDecision } from '../agent/types.js';
import type { PermissionDecision } from '../permissions/types.js';
import type { QuestionAnswer } from '../tools/ask-user-question/types.js';

/** Event types carried on the wire. Agent events plus web-only interactive prompts. */
export type WebEventType = AgentEvent['type'] | 'user_question';

/** One SSE frame as defined by doc §4. */
export interface SseFrame {
  runId: string;
  seq: number;
  type: WebEventType;
  payload: Record<string, unknown>;
}

/** POST /api/chat body. */
export interface ChatRequestBody {
  conversationId?: string;
  message: string;
}

/** POST /api/chat response. */
export interface ChatResponse {
  runId: string;
  conversationId: string;
}

/** POST /api/runs/:runId/approve body. */
export interface ApproveBody {
  decision: ApprovalDecision;
}

/** POST /api/runs/:runId/answer body. */
export interface AnswerBody {
  answers: Array<string | QuestionAnswer>;
  declined?: boolean;
}

/** Approval request surfaced to the UI. */
export interface PendingApprovalInfo {
  tool: string;
  args: Record<string, unknown>;
  command?: string;
  decision?: PermissionDecision;
}
