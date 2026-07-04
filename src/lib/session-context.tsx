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
  bumpSession,
  deleteSession,
  endSession,
  finalizeStaleSessions,
  startSession,
  updateSession,
  type StudySession,
} from "./db";
import { useWorkspace } from "./workspace-context";

/** Built-in session kinds. The string is what's persisted to
 *  `study_sessions.kind`; downstream views (goals, habits) match on
 *  it. Custom kinds (user-typed) are stored verbatim — the type stays
 *  `string` rather than a tight union so a custom value flows through. */
export type SessionKind = string;

type SessionContextValue = {
  active: StudySession | null;
  /** True when an active session is currently paused — elapsed is
   *  frozen and the auto-idle timer is suspended. */
  paused: boolean;
  /** Seconds the user has actually been running this session
   *  (sum of all non-paused segments). Drives the chip's clock. */
  activeSecs: number;
  /** Start a session of the given kind, or resume the existing one
   *  (the existing session's kind is preserved — switch via the
   *  sidebar chip). Returns the session AND a `created` flag —
   *  `true` if this call started a fresh session, `false` if it
   *  returned the already-running one. Study views use the flag to
   *  decide whether they OWN the session and should end it on
   *  unmount; manually-started chip sessions stay alive because the
   *  view sees `created: false` and skips the cleanup. */
  ensureStarted: (
    kind?: SessionKind,
  ) => Promise<{ session: StudySession; created: boolean }>;
  /** End the active session ONLY if its id matches the supplied
   *  number. No-op when the active session was replaced or already
   *  ended. Used by study views in their unmount cleanup so two
   *  back-to-back navigations don't end each other's sessions. */
  endIfActive: (sessionId: number) => Promise<void>;
  /** Pause the running session. No-op if no session is active OR
   *  the session is already paused. */
  pause: () => void;
  /** Resume a paused session. No-op if no session OR not paused. */
  resume: () => void;
  end: () => Promise<void>;
  /** Discard the active session — deletes its row outright instead of
   *  saving it, for sessions started by accident or not worth logging.
   *  No-op when nothing is running; throws (leaving the session
   *  running) if the delete fails, so callers can surface the error. */
  discard: () => Promise<void>;
  bump: (field: "words_seen" | "words_saved", by?: number) => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

/** Auto-end the session after this many ms of no activity. Pause
 *  suspends the timer — a paused session never auto-ends until the
 *  user resumes (then idles again) or explicitly stops. */
const IDLE_END_MS = 5 * 60 * 1000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const { active: workspace } = useWorkspace();
  const [session, setSession] = useState<StudySession | null>(null);

  // ── Pause-aware timing ───────────────────────────────────────────
  // The DB row's wall-clock `endedAt - startedAt` doesn't have to
  // equal `durationSecs` when the user paused. We track the active
  // (non-paused) elapsed in `activeSecs`, advance it via a 1-Hz tick
  // while running, and freeze on pause. On `end()` we patch the row
  // with the accumulated activeSecs so the rest of the app's totals
  // reflect *active* study time, not chair time.
  const [activeSecs, setActiveSecs] = useState(0);
  // Ms timestamp when the current running segment started, or null
  // when paused. We keep this in a ref AND mirror it as a boolean in
  // `paused` state for re-rendering — the ref ducks stale-closure
  // bugs in the tick handler.
  const runningSinceRef = useRef<number | null>(null);
  const [paused, setPaused] = useState(false);
  // Captures whether the user ever paused this session. When true,
  // `end()` writes durationSecs explicitly via `updateSession`
  // instead of relying on the wall-clock `endSession` path.
  const everPausedRef = useRef(false);

  const idleTimerRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const startingRef = useRef<Promise<StudySession> | null>(null);
  // Latest `end` for `ensureStarted` to call when switching activities.
  // `end` is defined below ensureStarted, so we reach it through a ref
  // (kept current by the effect after `end`) to avoid the ordering /
  // circular-dependency tangle of putting `end` in ensureStarted's deps.
  const endRef = useRef<(() => Promise<void>) | null>(null);

  function clearIdle() {
    if (idleTimerRef.current != null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }

  function clearTick() {
    if (tickRef.current != null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  const scheduleIdleEnd = useCallback(() => {
    clearIdle();
    idleTimerRef.current = window.setTimeout(() => {
      void end();
    }, IDLE_END_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Start the 1-Hz tick that drives `activeSecs`. Called on
   *  start + resume. */
  const startTick = useCallback(() => {
    clearTick();
    tickRef.current = window.setInterval(() => {
      if (runningSinceRef.current == null) return;
      const elapsedMs = Date.now() - runningSinceRef.current;
      const segmentSecs = Math.max(0, Math.floor(elapsedMs / 1000));
      // `runningSinceRef` resets every pause/resume, so the segment
      // count starts from 0 each resume. Add the accumulated prior
      // segments to keep the displayed total monotonic.
      setActiveSecs((prev) => {
        // The interval may fire after the segment moved on by more
        // than 1 second (browser sleep, throttling). Compute the
        // new total from scratch each tick so we don't drift.
        const accumulatedBefore = prev - lastSegmentSecsRef.current;
        lastSegmentSecsRef.current = segmentSecs;
        return Math.max(accumulatedBefore, 0) + segmentSecs;
      });
    }, 1000);
  }, []);

  // Tracks how much of `activeSecs` came from the *current* segment.
  // Subtracting this on each tick gives us the "accumulated before
  // this segment" baseline.
  const lastSegmentSecsRef = useRef(0);

  const ensureStarted = useCallback(
    async (
      kind: SessionKind = "writing",
    ): Promise<{ session: StudySession; created: boolean }> => {
      if (!workspace) throw new Error("No workspace");
      if (session) {
        if (kind && kind !== session.kind) {
          // A different activity than the one running — the previous
          // session is over. Save it (end() persists its accumulated
          // active time) and fall through to start a fresh session with
          // a reset timer, rather than folding the new activity's time
          // into the old session's clock. Switching speaking → review
          // after leaving mid-session is the case this fixes.
          await endRef.current?.();
          // falls through to the create path below
        } else {
          // Same kind — resume if paused, else just bump the idle timer.
          // `created: false` tells the caller they don't own this
          // session; its lifecycle is someone else's responsibility.
          if (paused) {
            runningSinceRef.current = Date.now();
            lastSegmentSecsRef.current = 0;
            setPaused(false);
            startTick();
          }
          scheduleIdleEnd();
          return { session, created: false };
        }
      }
      if (startingRef.current) {
        // Another caller is already mid-create; piggyback on their
        // promise. Whoever called first counts as the creator.
        const s = await startingRef.current;
        return { session: s, created: false };
      }
      startingRef.current = (async () => {
        const s = await startSession({ workspaceId: workspace.id, kind });
        setSession(s);
        setActiveSecs(0);
        setPaused(false);
        everPausedRef.current = false;
        runningSinceRef.current = Date.now();
        lastSegmentSecsRef.current = 0;
        startTick();
        scheduleIdleEnd();
        return s;
      })();
      try {
        const s = await startingRef.current;
        return { session: s, created: true };
      } finally {
        startingRef.current = null;
      }
    },
    [workspace, session, paused, scheduleIdleEnd, startTick],
  );

  const endIfActive = useCallback(
    async (sessionId: number) => {
      if (!session || session.id !== sessionId) return;
      await end();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session],
  );

  const pause = useCallback(() => {
    if (!session || runningSinceRef.current == null) return;
    // Freeze the clock on the current segment's contribution.
    const elapsedMs = Date.now() - runningSinceRef.current;
    const segmentSecs = Math.max(0, Math.floor(elapsedMs / 1000));
    setActiveSecs((prev) => Math.max(prev, segmentSecs + (prev - lastSegmentSecsRef.current)));
    runningSinceRef.current = null;
    lastSegmentSecsRef.current = 0;
    setPaused(true);
    everPausedRef.current = true;
    clearTick();
    clearIdle();
  }, [session]);

  const resume = useCallback(() => {
    if (!session || runningSinceRef.current != null) return;
    runningSinceRef.current = Date.now();
    lastSegmentSecsRef.current = 0;
    setPaused(false);
    startTick();
    scheduleIdleEnd();
  }, [session, scheduleIdleEnd, startTick]);

  const end = useCallback(async () => {
    clearIdle();
    clearTick();
    if (!session) return;
    // Lock in any in-flight segment before persisting.
    let finalSecs = activeSecs;
    if (runningSinceRef.current != null) {
      const elapsedMs = Date.now() - runningSinceRef.current;
      const segmentSecs = Math.max(0, Math.floor(elapsedMs / 1000));
      finalSecs = (activeSecs - lastSegmentSecsRef.current) + segmentSecs;
    }
    runningSinceRef.current = null;
    lastSegmentSecsRef.current = 0;
    setPaused(false);
    if (everPausedRef.current && finalSecs > 0) {
      // Paused at least once — wall-clock end != active time. Patch
      // the row with the accumulated active seconds so totals are
      // honest. `updateSession` also re-derives ended_at from
      // started_at + durationSecs.
      try {
        await updateSession({ id: session.id, durationSecs: finalSecs });
      } catch {
        // Fall back to the wall-clock endSession path — the session
        // still gets closed even if the patch fails.
        await endSession(session.id);
      }
    } else {
      await endSession(session.id);
    }
    setSession(null);
    setActiveSecs(0);
    everPausedRef.current = false;
  }, [session, activeSecs]);

  const discard = useCallback(async () => {
    if (!session) return;
    // Delete FIRST, tear down after — if the delete fails the session
    // keeps ticking unharmed and the error propagates to the caller,
    // instead of leaving a frozen half-dead chip behind.
    await deleteSession(session.id);
    clearIdle();
    clearTick();
    runningSinceRef.current = null;
    lastSegmentSecsRef.current = 0;
    setPaused(false);
    setSession(null);
    setActiveSecs(0);
    everPausedRef.current = false;
  }, [session]);

  // Keep the ref ensureStarted reads pointed at the latest `end` so the
  // "switch activity → save old + start fresh" path always calls the
  // current closure.
  useEffect(() => {
    endRef.current = end;
  }, [end]);

  const bump = useCallback(
    async (field: "words_seen" | "words_saved", by = 1) => {
      // No-op when no session is active. `bump` is "I'm engaged with
      // the current activity" — it shouldn't *start* a study session.
      // The chat view, click-to-define popover, and search all fire
      // bumps on user input; silently auto-starting a "writing"
      // session every time the user typed or clicked a word made the
      // timer feel possessed. Manual chip-starts still get bumped
      // here. Plugins that need a session to exist for grading call
      // ensureSessionStarted explicitly (see flashcards-view ctx).
      if (!session) return;
      await bumpSession(session.id, field, by);
      // bump = activity → reset idle, but only if currently running.
      // A bump while paused shouldn't silently resume the timer.
      if (runningSinceRef.current != null) scheduleIdleEnd();
    },
    [session, scheduleIdleEnd],
  );

  // ── Auto-pause while the window is inactive ──────────────────────
  // Study time should be active-window time: alt-tabbing away or
  // minimizing freezes the clock, focusing back resumes it. Only an
  // AUTO pause auto-resumes — a pause the user chose stays paused
  // until they resume it themselves (runningSinceRef is already null
  // when blur fires, so we never claim their pause as ours).
  const autoPausedRef = useRef(false);
  useEffect(() => {
    autoPausedRef.current = false;
  }, [session?.id]);
  useEffect(() => {
    const onInactive = () => {
      if (!session || runningSinceRef.current == null) return;
      autoPausedRef.current = true;
      pause();
    };
    const onActive = () => {
      if (!autoPausedRef.current) return;
      autoPausedRef.current = false;
      resume();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onInactive();
      else onActive();
    };
    window.addEventListener("blur", onInactive);
    window.addEventListener("focus", onActive);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onInactive);
      window.removeEventListener("focus", onActive);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [session, pause, resume]);

  // End session if workspace switches.
  useEffect(() => {
    return () => {
      if (session) void endSession(session.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Close out any study_sessions rows left open by earlier app
  // versions (or a hard quit) so the Skill balance radar picks them
  // up. Capped to a sensible per-session duration inside
  // finalizeStaleSessions so a session that was started days ago
  // doesn't suddenly claim huge hours. Runs once per workspace; the
  // sessions table is small (typically <1k rows) so this is cheap.
  useEffect(() => {
    if (!workspace) return;
    void finalizeStaleSessions(workspace.id).catch((err) => {
      console.warn("[session] finalizeStaleSessions failed", err);
    });
  }, [workspace?.id]);

  // End on tab close.
  useEffect(() => {
    const onUnload = () => {
      if (session) void endSession(session.id);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [session]);

  return (
    <SessionContext.Provider
      value={{
        active: session,
        paused,
        activeSecs,
        ensureStarted,
        endIfActive,
        pause,
        resume,
        end,
        discard,
        bump,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
