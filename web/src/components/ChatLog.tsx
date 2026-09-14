import { useEffect, useRef, useMemo } from "react";
import { useStore } from "../store/useStore";
import { MessageItem } from "./MessageItem";
import { ToolEventRow } from "./ToolEventRow";
import { ThinkingRow } from "./ThinkingRow";
import { AnswerBox } from "./AnswerBox";
import { ApprovalDialog } from "./ApprovalDialog";
import { QuestionForm } from "./QuestionForm";
import { LifecycleNotice } from "./LifecycleNotice";

export function ChatLog() {
  const messages = useStore((s) => s.messages);
  const streamEvents = useStore((s) => s.streamEvents);
  const systemEvents = useStore((s) => s.systemEvents);
  const currentThinking = useStore((s) => s.currentThinking);
  const currentAnswer = useStore((s) => s.currentAnswer);
  const finalAnswer = useStore((s) => s.finalAnswer);
  const streamingAnswer = useStore((s) => s.streamingAnswer);
  const isStreaming = useStore((s) => s.isStreaming);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Merge tool events and system notices into a single timeline sorted by seq.
  const timeline = useMemo(() => {
    type Entry = {
      key: string;
      seq: number;
      kind: "tool" | "system";
      toolId?: string;
      systemDisplay?: import("../store/useStore").SystemNoticeDisplay;
    };

    const entries: Entry[] = [];

    for (const te of streamEvents) {
      entries.push({
        key: te.id,
        seq: te.event.seq,
        kind: "tool",
        toolId: te.id,
      });
    }

    for (const se of systemEvents) {
      entries.push({
        key: se.id,
        seq: se.seq,
        kind: "system",
        systemDisplay: se,
      });
    }

    entries.sort((a, b) => a.seq - b.seq);
    return entries;
  }, [streamEvents, systemEvents]);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    messages.length,
    streamEvents.length,
    systemEvents.length,
    currentThinking,
    currentAnswer,
    finalAnswer,
    streamingAnswer,
  ]);

  const hasContent =
    messages.length > 0 ||
    streamEvents.length > 0 ||
    systemEvents.length > 0 ||
    currentThinking ||
    currentAnswer ||
    finalAnswer ||
    streamingAnswer;

  // A finished assistant turn is committed into `messages`, while its tool calls
  // live in the timeline. Render that trailing answer below the timeline so the
  // tool/websearch log stays above the reply instead of being pushed underneath.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const trailingAssistant =
    lastMessage && lastMessage.role === "assistant" ? lastMessage : null;
  const leadingMessages = trailingAssistant
    ? messages.slice(0, -1)
    : messages;

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
              AI 驱动的金融研究助手。可以查询公司、市场、财报或投资主题。
            </p>
            <div className="mt-8 grid grid-cols-2 gap-2 max-w-md">
              {[
                "分析 AAPL 最新 10-K 报告",
                "对比 NVDA 与 AMD 基本面",
                "MSFT 的 DCF 估值是多少？",
                "TSLA 近期内部人交易",
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

        {/* Rendered messages (the current turn's answer is rendered after the timeline) */}
        {leadingMessages.map((msg) => (
          <MessageItem key={msg.id} message={msg} />
        ))}

        {/* Merged timeline: tool events + lifecycle notices, sorted by seq */}
        {timeline.map((entry) => {
          if (entry.kind === "tool") {
            const te = streamEvents.find((s) => s.id === entry.toolId);
            return te ? <ToolEventRow key={entry.key} display={te} /> : null;
          }
          return entry.systemDisplay ? (
            <LifecycleNotice
              key={entry.key}
              display={entry.systemDisplay}
            />
          ) : null;
        })}

        {/* Completed turn's answer, kept below its tool calls */}
        {trailingAssistant && (
          <MessageItem key={trailingAssistant.id} message={trailingAssistant} />
        )}

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
