import { useStore } from "../store/useStore";
import { approveRun } from "../api/client";

export function ApprovalDialog() {
  const pending = useStore((s) => s.pendingApproval);
  const runId = useStore((s) => s.activeRunId);
  const setPending = useStore((s) => s.setPendingApproval);

  if (!pending) return null;

  const description = pending.command ?? pending.decision?.reason;

  const handleApprove = async (
    decision: "allow-once" | "allow-session" | "allow-always"
  ) => {
    if (!runId) return;
    setPending(null);
    try {
      await approveRun(runId, decision);
    } catch {
      // Error will surface via connection banner
    }
  };

  const handleDeny = async () => {
    if (!runId) return;
    setPending(null);
    try {
      await approveRun(runId, "deny");
    } catch {
      // ignore
    }
  };

  return (
    <div className="animate-slide-up border border-amber-200 bg-amber-50 rounded-xl p-4 mx-4 my-2">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-100 border border-amber-200 flex items-center justify-center">
          <span className="text-sm">?</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-amber-900 mb-1">
            Tool Approval Required
          </div>
          <div className="font-mono text-xs text-amber-800 mb-1">
            {pending.tool.replace(/_/g, " ")}
          </div>
          {description && (
            <p className="text-xs text-amber-700 mb-3">{description}</p>
          )}
          {pending.args && Object.keys(pending.args).length > 0 && (
            <pre className="font-mono text-[10px] text-amber-700 bg-amber-100 rounded p-2 mb-3 max-h-24 overflow-auto whitespace-pre-wrap break-words">
              {JSON.stringify(pending.args, null, 2)}
            </pre>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleApprove("allow-once")}
              className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              Allow Once
            </button>
            <button
              onClick={() => handleApprove("allow-session")}
              className="px-3 py-1.5 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors"
            >
              Allow This Session
            </button>
            <button
              onClick={() => handleApprove("allow-always")}
              className="px-3 py-1.5 text-xs font-medium bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            >
              Always Allow
            </button>
            <button
              onClick={handleDeny}
              className="px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
            >
              Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
