import { useEffect, useRef, useCallback } from "react";
import { useStore } from "../store/useStore";
import { buildSSEUrl, getConversations } from "../api/client";
import type { AgentEvent, AgentEventType, DoneFrame } from "../types";

/* ─── Lifecycle event → human-readable label ─── */

function classifyLifecycleEvent(event: AgentEvent): { label: string; detail?: string } | null {
  const { type, payload } = event;

  switch (type) {
    case "context_cleared": {
      const p = payload as { clearedCount: number; keptCount: number };
      return {
        label: "上下文已清理",
        detail: `保留 ${p.keptCount} 条，清除 ${p.clearedCount} 条`,
      };
    }
    case "microcompact": {
      const p = payload as { cleared: number; tokensSaved: number };
      return {
        label: "已微压缩",
        detail: `清除 ${p.cleared} 条，节省 ${p.tokensSaved} tokens`,
      };
    }
    case "compaction": {
      const p = payload as {
        phase: "start" | "end";
        success?: boolean;
        preCompactTokens?: number;
        postCompactTokens?: number;
      };
      if (p.phase === "start") {
        return { label: "开始压缩上下文" };
      }
      return {
        label: "上下文压缩完成",
        detail:
          p.success && p.preCompactTokens != null && p.postCompactTokens != null
            ? `${p.preCompactTokens} → ${p.postCompactTokens} tokens`
            : p.success === false
              ? "压缩失败"
              : undefined,
      };
    }
    case "memory_flush": {
      const p = payload as { phase: "start" | "end"; filesWritten?: string[] };
      if (p.phase === "start") {
        return { label: "正在写回记忆" };
      }
      return {
        label: "记忆已写回",
        detail: p.filesWritten ? `写入 ${p.filesWritten.length} 个文件` : undefined,
      };
    }
    case "memory_recalled": {
      const p = payload as { filesLoaded: string[]; tokenCount: number };
      return {
        label: "已加载记忆",
        detail: `${p.filesLoaded.length} 个文件，${p.tokenCount} tokens`,
      };
    }
    case "queue_drain": {
      const p = payload as { messageCount: number };
      return {
        label: "队列已合并",
        detail: `${p.messageCount} 条消息`,
      };
    }
    case "tool_limit": {
      const p = payload as { warning?: string };
      return {
        label: "工具警告",
        detail: p.warning,
      };
    }
    case "tool_denied": {
      const p = payload as { tool: string };
      return {
        label: "工具被拒绝",
        detail: p.tool,
      };
    }
    default:
      return null;
  }
}

/** Refresh the conversation list (fire-and-forget). */
function refreshConversations() {
  getConversations()
    .then((list) => useStore.getState().setConversations(list))
    .catch(() => {});
}

/**
 * Subscribes to a run's SSE stream and maps the backend AgentEvent vocabulary
 * onto the UI state:
 *   thinking                                  → ThinkingRow
 *   tool_start / tool_progress / tool_end /
 *     tool_error                              → ToolEventRow
 *   tool_approval (pending)                   → ApprovalDialog
 *   user_question (pending)                   → QuestionForm
 *   stream_progress                           → typing indicator (isStreaming)
 *   done                                      → final answer
 */
export function useAgentStream() {
  const runId = useStore((s) => s.activeRunId);
  const isActive = useStore((s) => s.isStreaming);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeqRef = useRef<number>(0);
  const activeRunRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!runId || !isActive) {
      cleanup();
      return;
    }

    // A new run restarts seq numbering — never resume with a stale cursor.
    if (activeRunRef.current !== runId) {
      activeRunRef.current = runId;
      lastSeqRef.current = 0;
    }

    const url = buildSSEUrl(runId, lastSeqRef.current || undefined);
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      useStore.getState().setConnectionStatus("connected");
    };

    es.onerror = () => {
      useStore.getState().setConnectionStatus("error");
      es.close();
      // Auto-reconnect after 3s, resuming from the last received seq so the
      // server replays only missed frames instead of duplicating the whole run.
      reconnectTimer.current = setTimeout(() => {
        if (useStore.getState().isStreaming && useStore.getState().activeRunId === runId) {
          // Trigger re-render by toggling
          useStore.getState().setIsStreaming(false);
          requestAnimationFrame(() => useStore.getState().setIsStreaming(true));
        }
      }, 3000);
    };

    // Handle "agent" events
    const handleAgent = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as AgentEvent;
        lastSeqRef.current = Math.max(lastSeqRef.current, data.seq);
        const s = useStore.getState();

        switch (data.type) {
          case "thinking": {
            s.setCurrentThinking(data.payload.message);
            // Pre-tool reasoning is also emitted with mode:'responding'; drop the
            // stale draft so only the final responding stream survives.
            s.clearStreamingAnswer();
            break;
          }

          case "tool_start": {
            // Thinking phase is over once tools begin; free the typing indicator.
            s.setCurrentThinking("");
            s.clearStreamingAnswer();
            s.addToolStart(data);
            break;
          }

          case "tool_progress": {
            s.updateToolProgress(data);
            break;
          }

          case "tool_end":
          case "tool_error": {
            s.completeTool(data);
            s.setCurrentThinking("");
            break;
          }

          case "tool_approval": {
            // Only the synthesized prompt frame opens the dialog; the resolved
            // AgentEvent carries `approved` and needs no UI.
            if (data.payload.pending) {
              s.setPendingApproval({
                tool: data.payload.tool,
                args: data.payload.args,
                command: data.payload.command,
                decision: data.payload.decision,
              });
            }
            break;
          }

          case "user_question": {
            if (data.payload.pending) {
              s.setPendingQuestion({ questions: data.payload.questions });
            }
            break;
          }

          case "stream_progress": {
            // `text` carries the accumulated answer for the current turn and is
            // only present while responding; other progress modes omit it.
            if (data.payload.text !== undefined) {
              s.setStreamingAnswer(data.payload.text);
            }
            s.setIsStreaming(true);
            break;
          }

          case "done": {
            s.setFinalAnswer(data.payload.answer);
            s.clearStreamingAnswer();
            s.setCurrentThinking("");
            break;
          }

          default: {
            // Lifecycle bookkeeping events → subtle system notices in the chat.
            const lifecycle = classifyLifecycleEvent(data);
            if (lifecycle) {
              s.addSystemEvent({
                id: `sys-${data.seq}`,
                seq: data.seq,
                type: data.type as AgentEventType,
                label: lifecycle.label,
                detail: lifecycle.detail,
              });
            }
            break;
          }
        }
      } catch {
        // Malformed event, ignore
      }
    };

    // Handle "done" events (terminal frame: {runId, answer})
    const handleDone = (e: MessageEvent) => {
      let terminalAnswer = "";
      try {
        const data = JSON.parse(e.data) as DoneFrame;
        terminalAnswer = data.answer ?? "";
      } catch {
        // ignore
      }
      const s = useStore.getState();
      // Commit the finished turn into the transcript so it survives the next
      // send. The live answer slots are cleared here and re-cleared on send.
      const answer = terminalAnswer || s.finalAnswer;
      if (answer.trim()) {
        s.addMessage({
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: answer,
          timestamp: Date.now(),
        });
      }
      s.setFinalAnswer("");
      s.setCurrentAnswer("");
      s.setIsStreaming(false);
      s.setActiveRunId(null);
      s.setCurrentThinking("");
      s.clearStreamingAnswer();
      s.setConnectionStatus("connected");
      // Refresh the conversation list so new/updated conversations appear.
      refreshConversations();
    };

    es.addEventListener("agent", handleAgent);
    es.addEventListener("done", handleDone);

    return () => {
      es.removeEventListener("agent", handleAgent);
      es.removeEventListener("done", handleDone);
      cleanup();
    };
  }, [runId, isActive, cleanup]);

  return { esRef };
}
