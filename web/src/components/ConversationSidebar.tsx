import { useEffect, useCallback, useRef } from "react";
import { useStore } from "../store/useStore";
import {
  getConversations,
  getConversation,
  createConversation,
} from "../api/client";
import type { ConversationMessage } from "../types";

/* ─── Relative time helper ─── */

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

/* ─── Sidebar content (shared between desktop and mobile) ─── */

function SidebarContent({ onSelect }: { onSelect: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.conversationId);
  const setConversationId = useStore((s) => s.setConversationId);
  const setMessages = useStore((s) => s.setMessages);
  const clearStreamEvents = useStore((s) => s.clearStreamEvents);
  const setCurrentThinking = useStore((s) => s.setCurrentThinking);
  const setCurrentAnswer = useStore((s) => s.setCurrentAnswer);
  const setFinalAnswer = useStore((s) => s.setFinalAnswer);
  const clearStreamingAnswer = useStore((s) => s.clearStreamingAnswer);
  const setIsStreaming = useStore((s) => s.setIsStreaming);
  const setActiveRunId = useStore((s) => s.setActiveRunId);
  const setPendingQuestion = useStore((s) => s.setPendingQuestion);
  const setPendingApproval = useStore((s) => s.setPendingApproval);
  const loadingRef = useRef(false);

  // Load conversation list on mount
  useEffect(() => {
    getConversations()
      .then((list) => useStore.getState().setConversations(list))
      .catch(() => {});
  }, []);

  const handleNewConversation = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    clearStreamEvents();
    setCurrentThinking("");
    setCurrentAnswer("");
    setFinalAnswer("");
    clearStreamingAnswer();
    setIsStreaming(false);
    setActiveRunId(null);
    setPendingQuestion(null);
    setPendingApproval(null);
    onSelect();
  }, [
    setConversationId,
    setMessages,
    clearStreamEvents,
    setCurrentThinking,
    setCurrentAnswer,
    setFinalAnswer,
    clearStreamingAnswer,
    setIsStreaming,
    setActiveRunId,
    setPendingQuestion,
    setPendingApproval,
    onSelect,
  ]);

  const handleSelectConversation = useCallback(
    async (id: string) => {
      if (id === activeId || loadingRef.current) return;
      loadingRef.current = true;

      // Reset streaming state before loading
      setIsStreaming(false);
      setActiveRunId(null);
      setPendingQuestion(null);
      setPendingApproval(null);
      clearStreamEvents();
      setCurrentThinking("");
      setCurrentAnswer("");
      setFinalAnswer("");
      clearStreamingAnswer();

      try {
        const convo = await getConversation(id);
        const msgs: ConversationMessage[] = convo.messages.map((m, i) => ({
          id: m.id ?? `msg-${i}-${m.timestamp}`,
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: m.timestamp,
        }));
        setConversationId(convo.id);
        setMessages(msgs);
      } catch {
        // If loading fails, at least clear the current state
        setConversationId(id);
        setMessages([]);
      } finally {
        loadingRef.current = false;
        onSelect();
      }
    },
    [
      activeId,
      setConversationId,
      setMessages,
      clearStreamEvents,
      setCurrentThinking,
      setCurrentAnswer,
      setFinalAnswer,
      clearStreamingAnswer,
      setIsStreaming,
      setActiveRunId,
      setPendingQuestion,
      setPendingApproval,
      onSelect,
    ]
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
        <span className="text-xs font-semibold text-ink-secondary uppercase tracking-wider">
          对话列表
        </span>
        <button
          onClick={() => {
            createConversation()
              .then((c) => {
                useStore.getState().addConversation(c);
                handleNewConversation();
              })
              .catch(() => handleNewConversation());
          }}
          className="px-2.5 py-1 text-[11px] font-medium text-accent border border-accent/30 rounded-md hover:bg-accent/5 transition-colors"
        >
          + 新对话
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-ink-tertiary">暂无对话记录</p>
          </div>
        ) : (
          <div className="py-1">
            {conversations.map((c) => {
              const isActive = c.id === activeId;
              return (
                <button
                  key={c.id}
                  onClick={() => handleSelectConversation(c.id)}
                  className={`w-full text-left px-4 py-2.5 transition-colors ${
                    isActive
                      ? "bg-accent/8 border-l-2 border-accent"
                      : "border-l-2 border-transparent hover:bg-surface-sunken"
                  }`}
                >
                  <div className="text-xs font-medium text-ink-secondary truncate">
                    {c.title || "新对话"}
                  </div>
                  {c.updatedAt != null && (
                    <div className="text-[10px] text-ink-tertiary mt-0.5">
                      {relativeTime(c.updatedAt)}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Desktop sidebar ─── */

export function ConversationSidebarDesktop() {
  return (
    <div className="hidden md:flex flex-col w-[260px] flex-shrink-0 border-r border-surface-border bg-surface-raised h-full">
      <SidebarContent onSelect={() => {}} />
    </div>
  );
}

/* ─── Mobile drawer ─── */

export function ConversationSidebarMobile() {
  const open = useStore((s) => s.sidebarOpen);
  const setOpen = useStore((s) => s.setSidebarOpen);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, setOpen]);

  // Prevent body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-fade-in"
        onClick={() => setOpen(false)}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="absolute inset-y-0 left-0 w-[280px] max-w-[80vw] bg-surface-raised border-r border-surface-border shadow-xl animate-slide-in-left"
      >
        <SidebarContent onSelect={() => setOpen(false)} />
      </div>
    </div>
  );
}
