import { createContext, useContext, type ReactNode } from "react";
import type { ToolCall } from "./tools";

/**
 * Chat-side actions exposed to deeply-nested components (e.g. markdown
 * CodeBlock, the inline PendingActionCard). Lets content rendered inside an
 * assistant reply reach back into the chat container — a CSV code block can
 * open the vocab import dialog, and a proposed tool call can be run or
 * discarded straight from the message bubble.
 */
export type ChatActions = {
  importCsv: (csv: string) => void;
  /** Run the pending tool calls parsed from an assistant message, append
   *  result blocks to its content, and refresh it in the message list. */
  confirmToolCalls: (
    messageId: number,
    content: string,
    calls: ToolCall[],
  ) => Promise<void>;
  /** Strip the pending tool blocks from an assistant message without
   *  running them (the "Dismiss" path). */
  dismissToolCalls: (messageId: number, content: string) => Promise<void>;
};

const ChatActionsContext = createContext<ChatActions | null>(null);

export function ChatActionsProvider({
  value,
  children,
}: {
  value: ChatActions;
  children: ReactNode;
}) {
  return (
    <ChatActionsContext.Provider value={value}>
      {children}
    </ChatActionsContext.Provider>
  );
}

export function useChatActions(): ChatActions | null {
  return useContext(ChatActionsContext);
}
