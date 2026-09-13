import type { SystemNoticeDisplay } from "../store/useStore";

/**
 * Subtle inline system notice for lifecycle events (context compaction,
 * memory flush, tool limits, etc.). Rendered at the same level as tool
 * rows so chronology is preserved, but visually subordinate — muted
 * color, smaller type, no interactivity.
 */

const ICON_MAP: Record<string, string> = {
  context_cleared: "Cc",
  microcompact: "Mc",
  compaction: "Cc",
  memory_flush: "Mf",
  memory_recalled: "Mr",
  queue_drain: "Qd",
  tool_limit: "Tl",
  tool_denied: "Td",
};

export function LifecycleNotice({ display }: { display: SystemNoticeDisplay }) {
  const icon = ICON_MAP[display.type] ?? "•";

  return (
    <div className="animate-fade-in flex gap-3 py-1.5">
      <div className="flex-shrink-0 w-6 h-6 rounded bg-surface-sunken border border-surface-border flex items-center justify-center">
        <span className="text-[9px] text-ink-tertiary font-mono font-medium select-none">
          {icon}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5 text-[11px] leading-tight min-w-0">
        <span className="text-ink-tertiary font-medium whitespace-nowrap">
          {display.label}
        </span>
        {display.detail && (
          <span className="text-ink-tertiary/60 truncate">{display.detail}</span>
        )}
      </div>
    </div>
  );
}
