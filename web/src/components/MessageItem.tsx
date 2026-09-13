import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ConversationMessage } from "../types";

export function MessageItem({ message }: { message: ConversationMessage }) {
  const isUser = message.role === "user";

  return (
    <div
      className={`animate-slide-up flex gap-3 ${
        isUser ? "flex-row-reverse" : ""
      }`}
    >
      {/* Avatar */}
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold border ${
          isUser
            ? "bg-accent text-white border-accent"
            : "bg-surface-sunken text-ink-secondary border-surface-border"
        }`}
      >
        {isUser ? "你" : "Dx"}
      </div>

      {/* Content */}
      <div
        className={`flex-1 min-w-0 max-w-[85%] ${
          isUser ? "flex flex-col items-end" : ""
        }`}
      >
        <div
          className={`inline-block rounded-xl px-4 py-3 ${
            isUser
              ? "bg-accent text-white rounded-br-sm"
              : "bg-surface-raised border border-surface-border rounded-bl-sm shadow-sm"
          }`}
        >
          {isUser ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {message.content}
            </p>
          ) : (
            <div className="markdown-body text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
        <div className="text-[10px] text-ink-tertiary mt-1 px-1">
          {new Date(message.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
    </div>
  );
}
