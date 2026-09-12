import { create } from "zustand";
import type {
  AgentEvent,
  ConversationMessage,
  ConnectionStatus,
  DexterConfig,
  PermissionDecision,
  Question,
} from "../types";

export interface ToolEventDisplay {
  /** Stable key: the toolCallId when present, else a synthesized fallback. */
  id: string;
  /** The tool_start event (or the terminal event when no start was seen). */
  event: AgentEvent;
  completed: boolean;
  /** tool_end / tool_error, merged into the row's lifecycle. */
  endEvent?: AgentEvent;
  progressMessage?: string;
  expanded: boolean;
  fullResult?: string;
  loadingResult: boolean;
}

const toolNameOf = (event: AgentEvent): string | undefined =>
  (event.payload as { tool?: string }).tool;

/** Locate the row for a tool lifecycle event, by toolCallId when available. */
function findToolIndex(
  events: ToolEventDisplay[],
  toolCallId: string | undefined,
  tool: string | undefined
): number {
  if (toolCallId) {
    const byId = events.findIndex((te) => te.id === toolCallId);
    if (byId !== -1) return byId;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const te = events[i];
    if (te && !te.completed && toolNameOf(te.event) === tool) return i;
  }
  return -1;
}

interface PendingApproval {
  tool: string;
  args: Record<string, unknown>;
  command?: string;
  decision?: PermissionDecision;
}

interface DexterState {
  /* ─── Token ─── */
  token: string | null;
  setToken: (token: string) => void;

  /* ─── Connection ─── */
  connectionStatus: ConnectionStatus;
  setConnectionStatus: (s: ConnectionStatus) => void;

  /* ─── Config ─── */
  config: DexterConfig | null;
  setConfig: (c: DexterConfig) => void;

  /* ─── Conversation ─── */
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  messages: ConversationMessage[];
  addMessage: (msg: ConversationMessage) => void;
  clearMessages: () => void;

  /* ─── Active Run ─── */
  activeRunId: string | null;
  setActiveRunId: (id: string | null) => void;
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;

  /* ─── Stream Events ─── */
  streamEvents: ToolEventDisplay[];
  addToolStart: (e: Extract<AgentEvent, { type: "tool_start" }>) => void;
  updateToolProgress: (e: Extract<AgentEvent, { type: "tool_progress" }>) => void;
  completeTool: (
    e: Extract<AgentEvent, { type: "tool_end" } | { type: "tool_error" }>
  ) => void;
  toggleEventExpand: (id: string) => void;
  setEventFullResult: (id: string, result: string) => void;
  setEventLoadingResult: (id: string, loading: boolean) => void;
  clearStreamEvents: () => void;

  /* ─── Thinking ─── */
  currentThinking: string;
  setCurrentThinking: (t: string) => void;

  /* ─── Answer ─── */
  currentAnswer: string;
  setCurrentAnswer: (a: string) => void;
  finalAnswer: string;
  setFinalAnswer: (a: string) => void;
  /** Live draft of the answer being streamed for the current turn. */
  streamingAnswer: string;
  setStreamingAnswer: (a: string) => void;
  clearStreamingAnswer: () => void;

  /* ─── Approval ─── */
  pendingApproval: PendingApproval | null;
  setPendingApproval: (a: PendingApproval | null) => void;

  /* ─── Question ─── */
  pendingQuestion: { questions: Question[] } | null;
  setPendingQuestion: (q: { questions: Question[] } | null) => void;

  /* ─── Composer ─── */
  composerInput: string;
  setComposerInput: (s: string) => void;
}

export const useStore = create<DexterState>((set) => ({
  /* Token */
  token: sessionStorage.getItem("dexter-token"),
  setToken: (token) => {
    sessionStorage.setItem("dexter-token", token);
    set({ token });
  },

  /* Connection */
  connectionStatus: "connecting",
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

  /* Config */
  config: null,
  setConfig: (config) => set({ config }),

  /* Conversation */
  conversationId: null,
  setConversationId: (conversationId) => set({ conversationId }),
  messages: [],
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  clearMessages: () => set({ messages: [], conversationId: null }),

  /* Active Run */
  activeRunId: null,
  setActiveRunId: (activeRunId) => set({ activeRunId }),
  isStreaming: false,
  setIsStreaming: (isStreaming) => set({ isStreaming }),

  /* Stream Events */
  streamEvents: [],
  addToolStart: (e) =>
    set((s) => {
      const toolCallId = e.payload.toolCallId ?? `tool-${e.seq}`;
      if (s.streamEvents.some((te) => te.id === toolCallId)) return s;
      return {
        streamEvents: [
          ...s.streamEvents,
          {
            id: toolCallId,
            event: e,
            completed: false,
            expanded: false,
            loadingResult: false,
          },
        ],
      };
    }),
  updateToolProgress: (e) =>
    set((s) => {
      const toolCallId = e.payload.toolCallId;
      const idx = findToolIndex(s.streamEvents, toolCallId, e.payload.tool);
      if (idx === -1) return s;
      return {
        streamEvents: s.streamEvents.map((te, i) =>
          i === idx ? { ...te, progressMessage: e.payload.message } : te
        ),
      };
    }),
  completeTool: (e) =>
    set((s) => {
      const payload = e.payload as { toolCallId?: string; tool: string };
      const idx = findToolIndex(s.streamEvents, payload.toolCallId, payload.tool);
      if (idx === -1) {
        // No matching start (e.g. replay began mid-tool): keep a standalone row.
        const id = payload.toolCallId ?? `tool-${e.seq}`;
        return {
          streamEvents: [
            ...s.streamEvents,
            {
              id,
              event: e,
              completed: true,
              endEvent: e,
              expanded: false,
              loadingResult: false,
            },
          ],
        };
      }
      return {
        streamEvents: s.streamEvents.map((te, i) =>
          i === idx ? { ...te, completed: true, endEvent: e } : te
        ),
      };
    }),
  toggleEventExpand: (id) =>
    set((s) => ({
      streamEvents: s.streamEvents.map((te) =>
        te.id === id ? { ...te, expanded: !te.expanded } : te
      ),
    })),
  setEventFullResult: (id, fullResult) =>
    set((s) => ({
      streamEvents: s.streamEvents.map((te) =>
        te.id === id ? { ...te, fullResult } : te
      ),
    })),
  setEventLoadingResult: (id, loadingResult) =>
    set((s) => ({
      streamEvents: s.streamEvents.map((te) =>
        te.id === id ? { ...te, loadingResult } : te
      ),
    })),
  clearStreamEvents: () => set({ streamEvents: [] }),

  /* Thinking */
  currentThinking: "",
  setCurrentThinking: (currentThinking) => set({ currentThinking }),

  /* Answer */
  currentAnswer: "",
  setCurrentAnswer: (currentAnswer) => set({ currentAnswer }),
  finalAnswer: "",
  setFinalAnswer: (finalAnswer) =>
    set({ finalAnswer, currentAnswer: "", streamingAnswer: "" }),
  streamingAnswer: "",
  setStreamingAnswer: (streamingAnswer) => set({ streamingAnswer }),
  clearStreamingAnswer: () => set({ streamingAnswer: "" }),

  /* Approval */
  pendingApproval: null,
  setPendingApproval: (pendingApproval) => set({ pendingApproval }),

  /* Question */
  pendingQuestion: null,
  setPendingQuestion: (pendingQuestion) => set({ pendingQuestion }),

  /* Composer */
  composerInput: "",
  setComposerInput: (composerInput) => set({ composerInput }),
}));
