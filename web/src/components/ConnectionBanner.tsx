import { useStore } from "../store/useStore";

export function ConnectionBanner() {
  const status = useStore((s) => s.connectionStatus);
  const token = useStore((s) => s.token);

  if (status === "connected") return null;

  const messages: Record<string, { text: string; color: string }> = {
    connecting: {
      text: "正在连接 Dexter 后端…",
      color: "bg-amber-50 text-amber-800 border-amber-200",
    },
    disconnected: {
      text: "连接断开，正在尝试重新连接…",
      color: "bg-orange-50 text-orange-800 border-orange-200",
    },
    error: {
      text: token
        ? "无法连接 Dexter 后端。请确认服务器是否在 3777 端口运行。"
        : "未找到认证令牌。请通过服务器启动横幅中的 ?token=<token> 打开此页面。",
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
