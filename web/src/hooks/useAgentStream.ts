import { useEffect, useRef, useCallback } from "react";
import { useStore } from "../store/useStore";
import { buildSSEUrl } from "../api/client";
import type { AgentEvent, DoneFrame } from "../types";

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

          default:
            // Lifecycle bookkeeping events (context_cleared, microcompact,
            // compaction, memory_*, queue_drain, tool_denied, tool_limit) have
            // no dedicated UI component; they are intentionally not rendered.
            break;
        }
      } catch {
        // Malformed event, ignore
      }
    };

    // Handle "done" events (terminal frame: {runId, answer})
    const handleDone = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as DoneFrame;
        if (data.answer) {
          useStore.getState().setFinalAnswer(data.answer);
        }
      } catch {
        // ignore
      }
      const s = useStore.getState();
      s.setIsStreaming(false);
      s.setActiveRunId(null);
      s.setCurrentThinking("");
      s.clearStreamingAnswer();
      s.setConnectionStatus("connected");
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
