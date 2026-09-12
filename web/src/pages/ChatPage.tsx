import { useAgentStream } from "../hooks/useAgentStream";
import { ChatLog } from "../components/ChatLog";
import { Composer } from "../components/Composer";
import { ConnectionBanner } from "../components/ConnectionBanner";

export function ChatPage() {
  useAgentStream();

  return (
    <div className="flex flex-col h-screen">
      <ConnectionBanner />
      <ChatLog />
      <Composer />
    </div>
  );
}
