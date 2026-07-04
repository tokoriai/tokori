/**
 * Background chat streaming.
 *
 * Lifts in-progress assistant streams out of ChatView's local state so a
 * generation keeps running when the user navigates away. The context owns:
 *
 *   • A map of `chatId → { partial, status }` so any mount of ChatView
 *     (or, later, a notification badge) can read whatever's currently
 *     streaming for that chat.
 *   • A set of "unread" chat ids — chats whose most recent assistant
 *     reply landed while the user was somewhere else. Drives the green
 *     dot on the sidebar's recent-chats list.
 *
 * Performance shape (this is load-bearing — see the streaming history):
 * the growing `partial` text is NOT React state. It lives in a ref, and
 * components subscribe to it via `useStreamPartial` (useSyncExternalStore).
 * That way a token append re-renders ONLY the leaf that displays the text,
 * not every consumer of this context (ChatView is huge; re-rendering it
 * ~30×/s was a big chunk of the streaming CPU). The reactive `activeStreamIds`
 * set — which flips only on start / finish / fail — is what drives the
 * "show the streaming bubble" / "generating…" decisions, so those re-render
 * rarely. The Promise lifecycle for the actual `sendChat` call still lives in
 * ChatView's send function — Promises don't care if their caller unmounted.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type StreamStatus = "active" | "done" | "error";

export type ChatStream = {
  chatId: number;
  partial: string;
  status: StreamStatus;
  error?: string;
};

type BackgroundChatContextValue = {
  /** Subscribe to partial-text changes (useSyncExternalStore store). */
  subscribe: (cb: () => void) => () => void;
  /** Current partial text for a chat, or null if nothing is streaming. */
  getPartial: (chatId: number) => string | null;
  /** Chats currently mid-stream. Flips only on start / finish / fail, so
   *  reading this (rather than the partial) keeps a consumer from
   *  re-rendering on every token. */
  activeStreamIds: Set<number>;
  /** Clears any prior partial and marks status=active. */
  start: (chatId: number) => void;
  /** Append a token to the running partial. Cheap — buffered + coalesced. */
  appendToken: (chatId: number, delta: string) => void;
  /** Mark the stream as finished. If `activeChatId` was different at the
   *  time of finish, the chat is added to `unread` so the sidebar shows
   *  a green dot. */
  finish: (chatId: number, full: string) => void;
  fail: (chatId: number, message: string) => void;

  /** Chats with new replies the user hasn't viewed since. */
  unread: Set<number>;
  markRead: (chatId: number) => void;

  /** Chats whose AI-generated title is still being computed. The
   *  sidebar reads this set to render a blurred-skeleton title until
   *  the proper one lands. Backed by a 30s safety timer so a stuck
   *  titler can't pin a chat in skeleton state forever. */
  titlePending: Set<number>;
  markTitlePending: (chatId: number) => void;
  clearTitlePending: (chatId: number) => void;

  /** The chat the user is currently looking at. ChatView reports this on
   *  mount / chat switch so we know which finishes count as "missed". */
  reportActiveChat: (chatId: number | null) => void;
};

const BackgroundChatContext = createContext<BackgroundChatContextValue | null>(
  null,
);

const UNREAD_KEY = "chat.unread";

// Minimum gap between token-buffer flushes. The buffer coalesces all tokens
// that arrive within the window into a single notify. ~30fps is the sweet
// spot for streaming text: indistinguishable from 60fps to the eye, but it
// halves the notify rate. Lower (e.g. 16) for snappier, higher for cheaper.
const MIN_FLUSH_MS = 33;

export function BackgroundChatProvider({ children }: { children: ReactNode }) {
  // Partial text per chat. A ref, not state — see the file header. Mutations
  // notify subscribers (useStreamPartial) without re-rendering this provider.
  const streamsRef = useRef<Map<number, ChatStream>>(new Map());
  const listenersRef = useRef<Set<() => void>>(new Set());

  const subscribe = useCallback((cb: () => void) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  const notify = useCallback(() => {
    for (const cb of listenersRef.current) cb();
  }, []);

  const getPartial = useCallback(
    (chatId: number) => streamsRef.current.get(chatId)?.partial ?? null,
    [],
  );

  // Reactive "is this chat streaming" signal. State (not ref) because it
  // drives ChatView's bubble + the sidebar's "generating…" dot, which must
  // re-render when it flips. It only changes on start / finish / fail.
  const [activeStreamIds, setActiveStreamIds] = useState<Set<number>>(
    () => new Set(),
  );

  // Persist unread chats across reloads so a green dot earned overnight
  // survives a quit + reopen.
  const [unread, setUnread] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(UNREAD_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        const s = new Set<number>();
        for (const v of arr) if (typeof v === "number") s.add(v);
        return s;
      }
      return new Set();
    } catch {
      return new Set();
    }
  });
  // Active chat id is read inside the finish() callback to decide whether
  // a completion should mark the chat as unread. We use a ref so the
  // callback closure always sees the current value without us having to
  // re-create it.
  const activeChatIdRef = useRef<number | null>(null);

  // Persist unread set on every change. Tiny string; cheap.
  useEffect(() => {
    try {
      localStorage.setItem(UNREAD_KEY, JSON.stringify(Array.from(unread)));
    } catch {
      /* localStorage may be denied in private mode */
    }
  }, [unread]);

  // Per-chat token buffer + a single requestAnimationFrame coalescer.
  // setState used to fire on every token (~50/s) which made the chat
  // tree re-segment + re-render its markdown that often. WebKitGTK's
  // renderer would eventually die under that load — observed as a
  // blank webview with no JS error (the renderer process crashed,
  // taking the JS context with it). Coalescing to ~30fps caps the work
  // regardless of token rate, while still feeling instant to the eye.
  const tokenBufferRef = useRef<Map<number, string>>(new Map());
  const flushScheduledRef = useRef<number | null>(null);
  // Timestamp of the last drain, used to rate-limit flushes to MIN_FLUSH_MS.
  const lastFlushAtRef = useRef(0);

  // Cancel any pending token-flush frame on unmount so we don't leak
  // a callback that fires after the provider tree is gone.
  useEffect(() => {
    return () => {
      const id = flushScheduledRef.current;
      if (id == null) return;
      if (typeof cancelAnimationFrame === "function") {
        try {
          cancelAnimationFrame(id);
        } catch {
          window.clearTimeout(id);
        }
      } else {
        window.clearTimeout(id);
      }
      flushScheduledRef.current = null;
    };
  }, []);

  const start = useCallback(
    (chatId: number) => {
      streamsRef.current.set(chatId, { chatId, partial: "", status: "active" });
      setActiveStreamIds((prev) => {
        if (prev.has(chatId)) return prev;
        const next = new Set(prev);
        next.add(chatId);
        return next;
      });
      notify();
    },
    [notify],
  );

  const flushTokens = useCallback(() => {
    flushScheduledRef.current = null;
    lastFlushAtRef.current =
      typeof performance !== "undefined" ? performance.now() : 0;
    const buffered = tokenBufferRef.current;
    if (buffered.size === 0) return;
    tokenBufferRef.current = new Map();
    for (const [chatId, batch] of buffered) {
      if (!batch) continue;
      const cur = streamsRef.current.get(chatId);
      streamsRef.current.set(chatId, {
        chatId,
        partial: (cur?.partial ?? "") + batch,
        status: "active",
      });
    }
    notify();
  }, [notify]);

  const appendToken = useCallback(
    (chatId: number, delta: string) => {
      if (!delta) return;
      const buf = tokenBufferRef.current;
      buf.set(chatId, (buf.get(chatId) ?? "") + delta);
      if (flushScheduledRef.current != null) return;
      // Rate-limit to MIN_FLUSH_MS. If we're already past the window, align
      // the drain to the next animation frame (requestAnimationFrame); if a
      // flush just happened, wait out the remainder on a timer. rAF stops
      // firing in a backgrounded tab, so the timer branch also covers that.
      const elapsed =
        typeof performance !== "undefined"
          ? performance.now() - lastFlushAtRef.current
          : MIN_FLUSH_MS;
      if (elapsed >= MIN_FLUSH_MS && typeof requestAnimationFrame === "function") {
        flushScheduledRef.current = requestAnimationFrame(() => flushTokens());
      } else {
        flushScheduledRef.current = window.setTimeout(
          () => flushTokens(),
          Math.max(0, MIN_FLUSH_MS - elapsed),
        );
      }
    },
    [flushTokens],
  );

  const finish = useCallback(
    (chatId: number, full: string) => {
      // Drop any buffered tokens for this chat — we're about to delete the
      // stream entry anyway. Without this, a stale flush could re-add the
      // partial after we cleared it (rAF fires after the call resolves).
      tokenBufferRef.current.delete(chatId);
      streamsRef.current.delete(chatId);
      notify();
      setActiveStreamIds((prev) => {
        if (!prev.has(chatId)) return prev;
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      });
      // Mark unread iff the user wasn't looking at this chat when it ended.
      if (activeChatIdRef.current !== chatId) {
        setUnread((u) => {
          const n = new Set(u);
          n.add(chatId);
          return n;
        });
      }
      // `full` is currently passed for parity with future caller use (e.g.
      // a toast notification). Today we just consume it via the param so
      // the call site doesn't have to change later.
      void full;
    },
    [notify],
  );

  const fail = useCallback(
    (chatId: number, message: string) => {
      const cur = streamsRef.current.get(chatId);
      streamsRef.current.set(chatId, {
        chatId,
        partial: cur?.partial ?? "",
        status: "error",
        error: message,
      });
      notify();
      setActiveStreamIds((prev) => {
        if (!prev.has(chatId)) return prev;
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      });
    },
    [notify],
  );

  const markRead = useCallback((chatId: number) => {
    setUnread((u) => {
      if (!u.has(chatId)) return u;
      const n = new Set(u);
      n.delete(chatId);
      return n;
    });
  }, []);

  const reportActiveChat = useCallback(
    (chatId: number | null) => {
      activeChatIdRef.current = chatId;
      // Viewing a chat clears its unread badge.
      if (chatId != null) markRead(chatId);
    },
    [markRead],
  );

  // Title-pending tracking. Two pieces of state:
  //   - the Set itself (drives the sidebar's skeleton render)
  //   - a per-chat safety-timeout map so we auto-clear after 30s if
  //     the AI titler never came back (offline, no provider, etc.)
  const [titlePending, setTitlePending] = useState<Set<number>>(
    () => new Set(),
  );
  const titleTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const clearTitlePending = useCallback((chatId: number) => {
    const t = titleTimersRef.current.get(chatId);
    if (t) {
      clearTimeout(t);
      titleTimersRef.current.delete(chatId);
    }
    setTitlePending((prev) => {
      if (!prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.delete(chatId);
      return next;
    });
  }, []);

  const markTitlePending = useCallback(
    (chatId: number) => {
      // If a previous attempt is still pending for this chat, wipe its
      // safety timer before queuing a new one.
      const existing = titleTimersRef.current.get(chatId);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        clearTitlePending(chatId);
      }, 30_000);
      titleTimersRef.current.set(chatId, t);
      setTitlePending((prev) => {
        if (prev.has(chatId)) return prev;
        const next = new Set(prev);
        next.add(chatId);
        return next;
      });
    },
    [clearTitlePending],
  );

  // Clean up all safety timers on provider unmount.
  useEffect(() => {
    return () => {
      for (const t of titleTimersRef.current.values()) clearTimeout(t);
      titleTimersRef.current.clear();
    };
  }, []);

  const value = useMemo<BackgroundChatContextValue>(
    () => ({
      subscribe,
      getPartial,
      activeStreamIds,
      start,
      appendToken,
      finish,
      fail,
      unread,
      markRead,
      titlePending,
      markTitlePending,
      clearTitlePending,
      reportActiveChat,
    }),
    [
      subscribe,
      getPartial,
      activeStreamIds,
      start,
      appendToken,
      finish,
      fail,
      unread,
      markRead,
      titlePending,
      markTitlePending,
      clearTitlePending,
      reportActiveChat,
    ],
  );

  return (
    <BackgroundChatContext.Provider value={value}>
      {children}
    </BackgroundChatContext.Provider>
  );
}

export function useBackgroundChat(): BackgroundChatContextValue {
  const ctx = useContext(BackgroundChatContext);
  if (!ctx)
    throw new Error("useBackgroundChat must be used inside BackgroundChatProvider");
  return ctx;
}

/**
 * Subscribe to the live partial text for one chat. This is the ONLY hook that
 * re-renders on every token, so keep its caller a small leaf (StreamingBubble)
 * — never read it from a heavy component like ChatView. Returns null when
 * nothing is streaming for the chat.
 */
export function useStreamPartial(chatId: number): string | null {
  const { subscribe, getPartial } = useBackgroundChat();
  const getSnapshot = useCallback(
    () => getPartial(chatId),
    [getPartial, chatId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
