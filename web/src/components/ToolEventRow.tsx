import { useStore } from "../store/useStore";
import type { ToolEventDisplay } from "../store/useStore";
import { getToolResult } from "../api/client";
import type { ToolEndPayload, ToolErrorPayload, ToolResultValue } from "../types";

function formatToolName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolEventRow({ display }: { display: ToolEventDisplay }) {
  const { event, endEvent, progressMessage, expanded, fullResult, loadingResult } = display;
  const toggleExpand = useStore((s) => s.toggleEventExpand);
  const setFullResult = useStore((s) => s.setEventFullResult);
  const setLoadingResult = useStore((s) => s.setEventLoadingResult);

  const startPayload = event.payload as {
    tool?: string;
    args?: Record<string, unknown>;
  };
  const endPayload = endEvent?.payload as
    | Partial<ToolEndPayload & ToolErrorPayload>
    | undefined;

  const isRunning = !display.completed;
  const isError = endEvent?.type === "tool_error";
  const toolName = startPayload.tool ?? "tool";
  const input = startPayload.args;

  const resultValue: ToolResultValue | undefined =
    endEvent?.type === "tool_end" ? (endPayload as ToolEndPayload).result : undefined;
  const storedResult = resultValue && typeof resultValue === "object" ? resultValue : undefined;
  const preview = storedResult?.preview;
  const resultRef = storedResult?.resultRef;
  const result = typeof resultValue === "string" ? resultValue : undefined;
  const errorMessage = endEvent?.type === "tool_error" ? endPayload?.error : undefined;
  const durationMs = endEvent?.type === "tool_end" ? endPayload?.duration : undefined;

  const handleExpand = async () => {
    toggleExpand(display.id);
    if (!expanded && resultRef && !fullResult) {
      setLoadingResult(display.id, true);
      try {
        const res = await getToolResult(resultRef);
        setFullResult(display.id, res.content);
      } catch {
        setFullResult(display.id, "[Failed to load full result]");
      } finally {
        setLoadingResult(display.id, false);
      }
    }
  };

  const statusIcon = isRunning ? (
    <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse-soft" />
  ) : isError ? (
    <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
  ) : (
    <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
  );

  const displayContent = fullResult || preview || result || errorMessage || "";
  const hasMore = resultRef && !fullResult;

  return (
    <div className="animate-fade-in flex gap-3 py-2 group">
      <div className="flex-shrink-0 w-6 h-6 rounded bg-monospace-bg border border-monospace-border flex items-center justify-center mt-0.5">
        <span className="text-[10px] text-ink-tertiary font-mono font-medium">
          {isRunning ? ">" : isError ? "!" : "\u2713"}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold text-ink-secondary font-mono">
            {formatToolName(toolName)}
          </span>
          {statusIcon}
          {durationMs !== undefined && (
            <span className="text-[10px] text-ink-tertiary font-mono">
              {formatDuration(durationMs)}
            </span>
          )}
          {(displayContent || hasMore || input) && (
            <button
              onClick={handleExpand}
              className="text-[10px] text-accent hover:text-accent-dark transition-colors ml-auto opacity-0 group-hover:opacity-100"
            >
              {expanded ? "collapse" : "expand"}
            </button>
          )}
        </div>

        {/* Live progress / input preview (collapsed) */}
        {!expanded && (progressMessage || input) && (
          <div className="font-mono text-[11px] text-ink-tertiary truncate max-w-lg">
            {progressMessage ? (
              progressMessage
            ) : (
              Object.entries(input ?? {})
                .slice(0, 2)
                .map(([k, v]) => (
                  <span key={k} className="mr-3">
                    {k}:{" "}
                    {typeof v === "string"
                      ? v.length > 60
                        ? v.slice(0, 60) + "..."
                        : v
                      : JSON.stringify(v).slice(0, 60)}
                  </span>
                ))
            )}
          </div>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="mt-2 rounded-lg border border-monospace-border bg-monospace-bg p-3">
            {input && (
              <div className="mb-2">
                <div className="text-[10px] font-semibold text-ink-tertiary uppercase tracking-wider mb-1">
                  Input
                </div>
                <pre className="font-mono text-[11px] text-ink-secondary whitespace-pre-wrap break-words overflow-x-auto max-h-40 overflow-y-auto">
                  {JSON.stringify(input, null, 2)}
                </pre>
              </div>
            )}
            {displayContent && (
              <div>
                <div className="text-[10px] font-semibold text-ink-tertiary uppercase tracking-wider mb-1">
                  Result
                </div>
                {loadingResult ? (
                  <div className="text-[11px] text-ink-tertiary font-mono animate-pulse-soft">
                    Loading full result...
                  </div>
                ) : (
                  <pre className="font-mono text-[11px] text-ink-secondary whitespace-pre-wrap break-words overflow-x-auto max-h-60 overflow-y-auto">
                    {displayContent}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
