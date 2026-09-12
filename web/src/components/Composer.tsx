import { useRef, useCallback } from "react";
import { useStore } from "../store/useStore";
import { postChat, cancelRun } from "../api/client";

export function Composer() {
  const input = useStore((s) => s.composerInput);
  const setInput = useStore((s) => s.setComposerInput);
  const isStreaming = useStore((s) => s.isStreaming);
  const activeRunId = useStore((s) => s.activeRunId);
  const conversationId = useStore((s) => s.conversationId);
  const addMessage = useStore((s) => s.addMessage);
  const setActiveRunId = useStore((s) => s.setActiveRunId);
  const setIsStreaming = useStore((s) => s.setIsStreaming);
  const setConversationId = useStore((s) => s.setConversationId);
  const clearStreamEvents = useStore((s) => s.clearStreamEvents);
  const setCurrentThinking = useStore((s) => s.setCurrentThinking);
  const setCurrentAnswer = useStore((s) => s.setCurrentAnswer);
  const setFinalAnswer = useStore((s) => s.setFinalAnswer);
  const clearStreamingAnswer = useStore((s) => s.clearStreamingAnswer);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    // Add user message
    addMessage({
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    });

    setInput("");
    clearStreamEvents();
    setCurrentThinking("");
    setCurrentAnswer("");
    setFinalAnswer("");
    clearStreamingAnswer();

    try {
      const res = await postChat(text, conversationId ?? undefined);
      setConversationId(res.conversationId);
      setActiveRunId(res.runId);
      setIsStreaming(true);
    } catch {
      addMessage({
        id: `error-${Date.now()}`,
        role: "assistant",
        content:
          "Failed to send message. Is the Dexter backend running?",
        timestamp: Date.now(),
      });
    }
  }, [
    input,
    isStreaming,
    conversationId,
    addMessage,
    setInput,
    clearStreamEvents,
    setCurrentThinking,
    setCurrentAnswer,
    setFinalAnswer,
    clearStreamingAnswer,
    setConversationId,
    setActiveRunId,
    setIsStreaming,
  ]);

  const handleCancel = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await cancelRun(activeRunId);
    } catch {
      // ignore
    }
    setIsStreaming(false);
    setActiveRunId(null);
  }, [activeRunId, setIsStreaming, setActiveRunId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  return (
    <div className="border-t border-surface-border bg-surface-raised/80 backdrop-blur-sm">
      <div className="max-w-4xl mx-auto px-4 py-3">
        <div className="flex items-end gap-2 bg-surface-bg border border-surface-border rounded-xl px-3 py-2 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/20 transition-all">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={
              isStreaming
                ? "Dexter is thinking..."
                : "Ask about financial data, companies, filings..."
            }
            disabled={isStreaming}
            rows={1}
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-tertiary resize-none outline-none min-h-[24px] max-h-[160px] py-0.5"
          />
          {isStreaming ? (
            <button
              onClick={handleCancel}
              className="flex-shrink-0 w-8 h-8 rounded-lg bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors"
              title="Cancel"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent text-white flex items-center justify-center hover:bg-accent-dark transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Send"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex items-center justify-between mt-1.5 px-1">
          <span className="text-[10px] text-ink-tertiary">
            Shift+Enter for new line
          </span>
          {isStreaming && activeRunId && (
            <span className="text-[10px] text-ink-tertiary font-mono">
              run: {activeRunId.slice(0, 8)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
