import { useAgentStream } from "../hooks/useAgentStream";
import { ChatLog } from "../components/ChatLog";
import { Composer } from "../components/Composer";
import { ConnectionBanner } from "../components/ConnectionBanner";
import {
  ConversationSidebarDesktop,
  ConversationSidebarMobile,
} from "../components/ConversationSidebar";

export function ChatPage() {
  useAgentStream();

  return (
    <div className="flex h-full">
      {/* Desktop sidebar (always visible on md+) */}
      <ConversationSidebarDesktop />

      {/* Mobile drawer sidebar */}
      <ConversationSidebarMobile />

      {/* Main chat area */}
      <div className="flex flex-col flex-1 min-w-0">
        <ConnectionBanner />
        <ChatLog />
        <Composer />
      </div>
    </div>
  );
}
