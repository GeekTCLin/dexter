import { useStore } from "../store/useStore";

export function ThinkingRow() {
  const thinking = useStore((s) => s.currentThinking);

  if (!thinking) return null;

  return (
    <div className="animate-fade-in flex gap-3 py-2">
      <div className="flex-shrink-0 w-6 h-6 rounded bg-surface-sunken border border-surface-border flex items-center justify-center">
        <span className="text-[10px] text-ink-tertiary font-mono">T</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-ink-tertiary uppercase tracking-wider mb-1">
          Thinking
        </div>
        <p className="font-mono text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-words">
          {thinking}
          <span className="inline-block w-1.5 h-3 bg-accent ml-0.5 animate-stream-cursor" />
        </p>
      </div>
    </div>
  );
}
