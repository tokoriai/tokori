import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createChat as dbCreateChat,
  deleteChat as dbDeleteChat,
  listChats,
  renameChat as dbRenameChat,
  type Chat,
} from "./db";
import { useWorkspace } from "./workspace-context";

type ChatListContextValue = {
  chats: Chat[];
  activeChatId: number | null;
  setActiveChatId: (id: number | null) => void;
  refresh: () => Promise<void>;
  newChat: () => Promise<Chat>;
  rename: (id: number, title: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
  loading: boolean;
};

const ChatListContext = createContext<ChatListContextValue | null>(null);

const ACTIVE_KEY = "chat.activeId";

export function ChatListProvider({ children }: { children: ReactNode }) {
  const { active: workspace } = useWorkspace();
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeChatId, setActiveChatIdState] = useState<number | null>(() => {
    const raw = localStorage.getItem(ACTIVE_KEY);
    return raw ? Number(raw) : null;
  });

  // Mirror activeChatId in a ref so `refresh` (memoised on workspace
  // alone) can read the latest value without re-creating itself when
  // the active chat changes — re-creating would invalidate every
  // consumer's effect deps that depend on `refresh`.
  const activeChatIdRef = useRef(activeChatId);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const setActiveChatId = useCallback((id: number | null) => {
    setActiveChatIdState(id);
    activeChatIdRef.current = id;
    if (id == null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, String(id));
  }, []);

  const refresh = useCallback(async () => {
    if (!workspace) {
      setChats([]);
      return;
    }
    const list = await listChats(workspace.id);
    // Hide chats that have never been used. A "New chat" row gets
    // inserted the moment the user clicks the + button, so without
    // this filter the recent list fills up with empty rows from
    // every accidental click. Two exemptions:
    //   • The currently active chat — when the user just clicked
    //     New chat and is about to type, we want it visible at the
    //     top instead of disappearing for one render.
    //   • Chats whose `messageCount` is undefined — rows returned
    //     from createChat/renameChat that didn't bring a count
    //     along. We treat that as "unknown, default include" so we
    //     never accidentally hide a chat we don't have evidence to
    //     hide.
    const current = activeChatIdRef.current;
    const filtered = list.filter(
      (c) =>
        c.messageCount === undefined ||
        c.messageCount > 0 ||
        c.id === current,
    );
    setChats(filtered);
    // If the previously-active chat is gone (e.g. workspace
    // switched, chat deleted out of band), fall through to the
    // newest visible chat or null.
    if (current == null) return;
    const stillExists = filtered.some((c) => c.id === current);
    if (!stillExists) {
      const next = filtered[0]?.id ?? null;
      setActiveChatIdState(next);
      activeChatIdRef.current = next;
    }
  }, [workspace]);

  // Load on workspace change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        await refresh();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const newChat = useCallback(async (): Promise<Chat> => {
    if (!workspace) throw new Error("No active workspace");
    const c = await dbCreateChat(workspace.id, "New chat");
    setChats((prev) => [c, ...prev]);
    setActiveChatId(c.id);
    return c;
  }, [workspace, setActiveChatId]);

  const rename = useCallback(async (id: number, title: string) => {
    await dbRenameChat(id, title);
    setChats((prev) =>
      prev
        .map((c) => (c.id === id ? { ...c, title, updatedAt: Math.floor(Date.now() / 1000) } : c))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    );
  }, []);

  const remove = useCallback(
    async (id: number) => {
      await dbDeleteChat(id);
      setChats((prev) => prev.filter((c) => c.id !== id));
      setActiveChatIdState((current) => (current === id ? null : current));
    },
    [],
  );

  return (
    <ChatListContext.Provider
      value={{
        chats,
        activeChatId,
        setActiveChatId,
        refresh,
        newChat,
        rename,
        remove,
        loading,
      }}
    >
      {children}
    </ChatListContext.Provider>
  );
}

export function useChatList() {
  const ctx = useContext(ChatListContext);
  if (!ctx) throw new Error("useChatList must be used inside ChatListProvider");
  return ctx;
}
