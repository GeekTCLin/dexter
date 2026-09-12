import { useStore } from "../store/useStore";

export function ConnectionBanner() {
  const status = useStore((s) => s.connectionStatus);
  const token = useStore((s) => s.token);

  if (status === "connected") return null;

  const messages: Record<string, { text: string; color: string }> = {
    connecting: {
      text: "Connecting to Dexter backend...",
      color: "bg-amber-50 text-amber-800 border-amber-200",
    },
    disconnected: {
      text: "Connection lost. Attempting to reconnect...",
      color: "bg-orange-50 text-orange-800 border-orange-200",
    },
    error: {
      text: token
        ? "Cannot reach Dexter backend. Ensure the server is running on port 3777."
        : "No auth token found. Open this page with ?token=<token> from the server startup banner.",
      color: "bg-red-50 text-red-800 border-red-200",
    },
  };

  const msg = messages[status];
  if (!msg) return null;

  return (
    <div
      className={`animate-slide-up border-b px-4 py-2.5 text-sm font-medium ${msg.color}`}
    >
      <div className="max-w-4xl mx-auto flex items-center gap-2">
        {status === "connecting" && (
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse-soft" />
        )}
        {status === "error" && (
          <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
        )}
        <span>{msg.text}</span>
      </div>
    </div>
  );
}
