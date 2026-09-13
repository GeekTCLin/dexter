import type { AgentEvent, ApprovalDecision } from '../agent/types.js';
import type { PermissionDecision } from '../permissions/types.js';

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

/**
 * One answer in POST /api/runs/:runId/answer: a single label, all selected
 * labels, or a partial QuestionAnswer carrying selected/label/otherText/notes.
 */
export interface AnswerSelection {
  label?: string;
  selected?: string[];
  otherText?: string;
  notes?: string;
  header?: string;
  question?: string;
}

export type QuestionAnswerInput = string | string[] | AnswerSelection;

/** POST /api/runs/:runId/answer body. */
export interface AnswerBody {
  answers: QuestionAnswerInput[];
  declined?: boolean;
}

/** Approval request surfaced to the UI. */
export interface PendingApprovalInfo {
  tool: string;
  args: Record<string, unknown>;
  command?: string;
  decision?: PermissionDecision;
}
