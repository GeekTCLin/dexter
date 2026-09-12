import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store/useStore";

export function AnswerBox() {
  const currentAnswer = useStore((s) => s.currentAnswer);
  const finalAnswer = useStore((s) => s.finalAnswer);
  const streamingAnswer = useStore((s) => s.streamingAnswer);
  const isStreaming = useStore((s) => s.isStreaming);

  const answer = streamingAnswer || finalAnswer || currentAnswer;
  if (!answer) return null;

  return (
    <div className="animate-slide-up flex gap-3">
      {/* Avatar */}
      <div className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold border bg-surface-sunken text-ink-secondary border-surface-border">
        Dx
      </div>

      {/* Answer content */}
      <div className="flex-1 min-w-0 max-w-[85%]">
        <div className="bg-surface-raised border border-surface-border rounded-xl rounded-bl-sm shadow-sm px-4 py-3">
          <div className="markdown-body text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {answer}
            </ReactMarkdown>
            {isStreaming && !finalAnswer && (
              <span className="inline-block w-1.5 h-4 bg-accent ml-0.5 animate-stream-cursor" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
