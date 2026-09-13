import { useEffect } from "react";
import { Routes, Route, Link, useLocation } from "react-router-dom";
import { useStore } from "./store/useStore";
import { getConfig } from "./api/client";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";

function Nav() {
  const location = useLocation();
  const isChat = location.pathname === "/";
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);

  return (
    <nav className="fixed top-0 left-0 right-0 z-40 bg-surface-raised/80 backdrop-blur-sm border-b border-surface-border">
      <div className="max-w-4xl mx-auto px-4 h-11 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Mobile sidebar toggle — only on chat page */}
          {isChat && (
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="md:hidden w-8 h-8 flex items-center justify-center rounded-md text-ink-secondary hover:text-ink hover:bg-surface-sunken transition-colors"
              aria-label="切换对话列表"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M2 4h12M2 8h12M2 12h12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
          <Link
            to="/"
            className="flex items-center gap-2 text-ink hover:text-accent transition-colors"
          >
            <span className="text-sm font-display font-bold tracking-tight">
              Dexter
            </span>
            <span className="text-[10px] text-ink-tertiary font-mono">
              研究工作站
            </span>
          </Link>
        </div>
        <div className="flex items-center gap-1">
          <Link
            to="/"
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              isChat
                ? "bg-surface-sunken text-ink"
                : "text-ink-secondary hover:text-ink"
            }`}
          >
            对话
          </Link>
          <Link
            to="/settings"
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              !isChat
                ? "bg-surface-sunken text-ink"
                : "text-ink-secondary hover:text-ink"
            }`}
          >
            设置
          </Link>
        </div>
      </div>
    </nav>
  );
}

export default function App() {
  const setConfig = useStore((s) => s.setConfig);
  const setConnectionStatus = useStore((s) => s.setConnectionStatus);

  // Load config on mount
  useEffect(() => {
    getConfig()
      .then((config) => {
        setConfig(config);
        setConnectionStatus("connected");
      })
      .catch(() => {
        setConnectionStatus("error");
      });
  }, [setConfig, setConnectionStatus]);

  return (
    <div className="min-h-screen bg-surface-bg">
      <Nav />
      <main className="pt-11">
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
