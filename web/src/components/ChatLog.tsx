import { useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import { MessageItem } from "./MessageItem";
import { ToolEventRow } from "./ToolEventRow";
import { ThinkingRow } from "./ThinkingRow";
import { AnswerBox } from "./AnswerBox";
import { ApprovalDialog } from "./ApprovalDialog";
import { QuestionForm } from "./QuestionForm";

export function ChatLog() {
  const messages = useStore((s) => s.messages);
  const streamEvents = useStore((s) => s.streamEvents);
  const currentThinking = useStore((s) => s.currentThinking);
  const currentAnswer = useStore((s) => s.currentAnswer);
  const finalAnswer = useStore((s) => s.finalAnswer);
  const streamingAnswer = useStore((s) => s.streamingAnswer);
  const isStreaming = useStore((s) => s.isStreaming);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    messages.length,
    streamEvents.length,
    currentThinking,
    currentAnswer,
    finalAnswer,
    streamingAnswer,
  ]);

  const hasContent =
    messages.length > 0 ||
    streamEvents.length > 0 ||
    currentThinking ||
    currentAnswer ||
    finalAnswer ||
    streamingAnswer;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        {!hasContent && (
          <div className="flex flex-col items-center justify-center h-full min-h-[50vh] text-center animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-surface-sunken border border-surface-border flex items-center justify-center mb-6">
              <span className="text-2xl font-display font-bold text-ink-secondary">
                Dx
              </span>
            </div>
            <h1 className="text-display-lg font-display text-ink mb-2">
              Dexter
            </h1>
            <p className="text-sm text-ink-tertiary max-w-sm">
              AI-powered financial research. Ask about companies, markets,
              filings, or investment theses.
            </p>
            <div className="mt-8 grid grid-cols-2 gap-2 max-w-md">
              {[
                "Analyze AAPL's latest 10-K",
                "Compare NVDA vs AMD fundamentals",
                "What's the DCF for MSFT?",
                "Recent insider trading for TSLA",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    useStore.getState().setComposerInput(suggestion);
                  }}
                  className="px-3 py-2 text-xs text-left text-ink-secondary bg-surface-raised border border-surface-border rounded-lg hover:border-accent hover:text-accent transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Rendered messages */}
        {messages.map((msg) => (
          <MessageItem key={msg.id} message={msg} />
        ))}

        {/* Streaming tool events */}
        {streamEvents.map((te) => (
          <ToolEventRow key={te.id} display={te} />
        ))}

        {/* Live thinking */}
        <ThinkingRow />

        {/* Live/final answer */}
        <AnswerBox />

        {/* Approval & Question dialogs */}
        <ApprovalDialog />
        <QuestionForm />

        {/* Streaming indicator */}
        {isStreaming && !currentThinking && !currentAnswer && !finalAnswer && !streamingAnswer && (
          <div className="flex gap-3 py-2 animate-fade-in">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-surface-sunken border border-surface-border flex items-center justify-center">
              <span className="text-[10px] text-ink-tertiary font-mono animate-pulse-soft">
                Dx
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft [animation-delay:0.2s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft [animation-delay:0.4s]" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
