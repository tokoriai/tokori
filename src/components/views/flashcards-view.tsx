import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpDown,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  GraduationCap,
  Image as ImageIcon,
  LayoutTemplate,
  ListFilter,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { CardComposerDialog } from "@/components/card-composer-dialog";
import { CardTemplateDialog } from "@/components/card-template-dialog";
import { FlashcardViewDialog } from "@/components/flashcard-view-dialog";
import { Pinyin } from "@/components/pinyin";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  collectionSubtree,
  deleteVocab,
  hasReviewedToday,
  listCollections,
  listDueVocab,
  listStudyVocab,
  listVocab,
  listVocabByIds,
  listVocabReviewedToday,
  reviewVocab as dbReviewVocab,
  setVocabStatus as dbSetVocabStatus,
  vocabIdsInCollections,
  type VocabEntry,
  type VocabKind,
  type VocabStatus,
} from "@/lib/db";
import {
  ALL_VOCAB_STATUSES,
  filterVocab,
  intervalDays,
  sortVocab,
  type BrowseSortKey,
  type SortDir,
} from "@/lib/vocab-browse";
import { schedule, type Grade } from "@/lib/fsrs";
import { navigateToTab } from "@/lib/nav-event";
import { useSearch as useDictSearch } from "@/lib/search-context";
import { useSession } from "@/lib/session-context";
import { setStudyActive } from "@/lib/study-active-event";
import { useStudyConfig } from "@/lib/study-config";
import { useTTS } from "@/lib/tts-context";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";
import {
  type ReviewedCardSummary,
  type StudyContext,
  type StudyPlugin,
  type StudySessionStats,
} from "@/lib/study/api";
import {
  clearCustomStudyHandoff,
  orderCustomQueue,
  peekCustomStudyHandoff,
  type CustomStudyHandoff,
} from "@/lib/study/custom-study";
import { pluginsForWorkspace } from "@/lib/study/registry";

type Mode = "review" | "browse";

const ACTIVE_PLUGIN_KEY = "study.activePluginId";

export function FlashcardsView() {
  const { active: workspace } = useWorkspace();
  const [mode, setMode] = useState<Mode>("review");
  // Tracks whether StudyMode is in an active session — i.e. the user
  // has picked a plugin and isn't on the post-session summary screen.
  // We hide the outer header during a session so the plugin's own
  // TopActionBar can be the only thing above the card. Lifted up here
  // (rather than read from inside StudyMode) so the parent layout can
  // react without a context.
  const [sessionActive, setSessionActive] = useState(false);

  // Mirror the active state into the global signal so the shell-level
  // GlobalAddCard FAB knows to hide while a study card is on screen.
  // On unmount we explicitly flip it back to false — leaving the
  // flashcards tab mid-session shouldn't keep the FAB hidden.
  useEffect(() => {
    setStudyActive(sessionActive);
    return () => setStudyActive(false);
  }, [sessionActive]);

  if (!workspace) return null;

  const headerHidden = mode === "review" && sessionActive;

  return (
    <div className="flex h-full flex-col">
      {!headerHidden && (
        <div className="border-b border-border px-8 pt-6 pb-4">
          <div className="mx-auto flex max-w-3xl xl:max-w-4xl 2xl:max-w-5xl 2xl:max-w-6xl items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Flashcards
              </p>
              <h1 className="font-serif text-2xl tracking-tight">
                {mode === "review" ? "Review" : "Browse"}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex gap-1 rounded-full border border-border bg-card p-1">
                {(["review", "browse"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={cn(
                      "rounded-full px-3 py-1 text-[12.5px] capitalize transition-colors",
                      mode === m
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === "review" ? (
        <StudyMode onActiveChange={setSessionActive} />
      ) : (
        <BrowseMode />
      )}
    </div>
  );
}

// ── Study mode — plugin-driven ──
//
// The framework owns plugin selection + ctx wiring. Each plugin owns its own
// study UI. See `src/lib/study/api.ts` for the contract.

function StudyMode({
  onActiveChange,
}: {
  /** Fires when the user enters or leaves an active study session.
   *  "Active" = a plugin has been picked AND the post-session summary
   *  screen isn't showing. The host (FlashcardsView) uses this to hide
   *  its own header during a session, giving the plugin true fullscreen. */
  onActiveChange?: (active: boolean) => void;
}) {
  const { active: workspace } = useWorkspace();
  const session = useSession();
  const tts = useTTS();
  // Per-workspace SRS config feeds the scheduler. The hook returns
  // sane defaults while the row loads, so callers don't need to
  // gate on `loaded`.
  const studyCfg = useStudyConfig(workspace?.id ?? null, workspace?.targetLang ?? "en");
  const [vocab, setVocab] = useState<VocabEntry[] | null>(null);
  const [dueVocab, setDueVocab] = useState<VocabEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [picked, setPicked] = useState<StudyPlugin | null>(null);
  const [summary, setSummary] = useState<StudySessionStats | null>(null);
  // Track the session id that THIS view's plugin started, so we can
  // close it out when the user navigates away mid-session. The
  // unmount effect below reads this ref and calls endIfActive(id) —
  // which is a no-op when the session was replaced or already ended.
  // Manually-started chip sessions are preserved: ensureStarted
  // returns `created: false` for them, so this ref stays null and
  // the cleanup walks away.
  const createdSessionIdRef = useRef<number | null>(null);
  // Drill mode — when true, `ctx.reviewVocab` is short-circuited so
  // grades the user assigns don't move FSRS intervals. Toggled from
  // each plugin's prestart screen. Reset when the user leaves a
  // session so the next pick starts in the default "real review"
  // state.
  const [drillMode, setDrillMode] = useState(false);
  // "Is today's SRS pass fully done?" — true when the user has reviewed
  // at least one card today AND the due queue is empty. The "any review
  // today" half alone is misleading: a user with 100 cards still due
  // hasn't finished today's pass just because they graded one. Feeds
  // the prestart banner + auto-flip of drill mode. Null while the
  // answer is loading so the UI doesn't flicker on session start.
  const [anchoredToday, setAnchoredToday] = useState<boolean | null>(null);
  // Custom-study scope — non-null when this mount was reached via a
  // "study this chapter / collection" handoff. Peeked synchronously so
  // the FIRST pool fetch is already narrowed (no whole-workspace
  // flash), cleared in an effect; both halves are idempotent, which
  // keeps the pair safe under StrictMode's double-invoke (the old
  // pop-and-remove inside the load effect consumed the payload on the
  // first dev mount and silently loaded the entire workspace on the
  // second). The scope lives in state — not re-read from storage — so
  // back-to-back sessions stay narrowed until the user exits via the
  // picker banner or leaves the Flashcards tab.
  const [customScope, setCustomScope] = useState<CustomStudyHandoff | null>(
    () => peekCustomStudyHandoff(),
  );
  useEffect(() => {
    clearCustomStudyHandoff();
  }, []);

  // "Study today's cards again" — once today's SRS pass is fully done,
  // the day's reviewed cards can be re-run as a drill. `restudyToday`
  // swaps the load effect onto that pool; `restudyCount` is the size of
  // the offer shown on the hub (0 = nothing reviewed today / normal
  // day, so no offer).
  const [restudyToday, setRestudyToday] = useState(false);
  const [restudyCount, setRestudyCount] = useState(0);
  // The re-study scope is per-workspace — switching workspaces drops it
  // so the next load is the new workspace's normal daily queue.
  useEffect(() => {
    setRestudyToday(false);
    setRestudyCount(0);
  }, [workspace?.id]);

  /** Leave custom scope and return to the whole-workspace queue. */
  function exitCustomStudy() {
    setCustomScope(null);
    setDrillMode(false);
    setAnchoredToday(null);
    // Null pools = loading state; the load effect re-fires off the
    // customScope dep and fetches the whole-workspace queues.
    setVocab(null);
    setDueVocab(null);
  }

  /** Swap the session pools to today's reviewed cards. Drill comes on
   *  with it — re-grading the same cards twice in a day would distort
   *  FSRS; the prestart toggle stays as the deliberate escape hatch. */
  const startRestudy = useCallback(() => {
    setRestudyToday(true);
    setDrillMode(true);
    // Null pools = loading state; the load effect re-fires off the
    // restudyToday dep and fetches the day's reviewed pool.
    setVocab(null);
    setDueVocab(null);
  }, []);

  /** Leave the re-study queue and return to the whole-workspace state. */
  function exitRestudy() {
    setRestudyToday(false);
    setDrillMode(false);
    setAnchoredToday(null);
    setVocab(null);
    setDueVocab(null);
  }

  // Notify the host whenever active-session state changes. Active means
  // a plugin is mounted AND we're not on the summary screen. Re-fires on
  // unmount with `false` so the host header reappears if the user
  // navigates away from Flashcards mid-session.
  useEffect(() => {
    const active = picked != null && summary == null;
    onActiveChange?.(active);
    return () => {
      onActiveChange?.(false);
    };
  }, [picked, summary, onActiveChange]);

  // Finalize the session record on unmount. Per-card FSRS grades are
  // already persisted inside `ctx.reviewVocab` (each grade hits the
  // DB immediately), but the parent `study_sessions` row stays open
  // with `ended_at = null` if the user leaves the page without going
  // through the "End session" button — leaving "immersion so far" and
  // the consistency heatmap at zero because both read `duration_secs`,
  // which is only computed at `endSession`. So: closing on unmount
  // makes leaving the page === ending the session, and the next visit
  // starts a fresh row.
  //
  // The ref dance is load-bearing. `session` from useSession() is a
  // fresh value object every render; capturing it in a `[]`-deps
  // effect freezes the first-render value (with a no-op `end`,
  // because no session existed yet at mount). Keeping a ref synced
  // every render lets the cleanup reach the *latest* session.end at
  // unmount time.
  //
  // `endIfActive(id)` (gated by the createdSessionIdRef we set inside
  // ensureSessionStarted) means we only end sessions the study screen
  // started itself. A chip-started "writing"/"reading" session that
  // happened to be running when the user popped into Flashcards isn't
  // ours to close.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    return () => {
      const id = createdSessionIdRef.current;
      if (id == null) return;
      createdSessionIdRef.current = null;
      void sessionRef.current.endIfActive(id).catch((err) => {
        console.warn("[flashcards] session.end on unmount failed", err);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const plugins = useMemo(
    () =>
      workspace
        ? pluginsForWorkspace(workspace.targetLang, studyCfg.config.hiddenPlugins)
        : [],
    [workspace, studyCfg.config.hiddenPlugins],
  );

  // Load vocab + due once per workspace. Two modes:
  //
  //   • Whole-workspace (default) — bounded study queue + strict-due
  //     list, the standard daily SRS pass.
  //   • Custom scope — the handoff names a collection; the pool is the
  //     collection subtree's FULL word list (any status, active or
  //     library), because "study this chapter" must include words that
  //     are scheduled for next week, were never pushed into SRS, or are
  //     already mastered. Both ctx pools get the same list so every
  //     plugin — including the ones that pull fillers from `ctx.vocab`
  //     — stays inside the scope. The subtree walk covers children too:
  //     "Custom study HSK 3" drills every lesson sub-collection.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;

    setLoadError(null);
    void (async () => {
      try {
        if (customScope) {
          // Resolve the subtree's vocab ids in a single bulk query
          // rather than one per collection — `vocabIdsInCollections`
          // uses an IN clause so the cost scales with O(memberships)
          // instead of O(collections).
          const cols = await listCollections(workspace.id);
          const subtree = collectionSubtree(cols, customScope.collectionId);
          if (subtree.length === 0) {
            // Collection deleted, or the workspace switched under a
            // scope from the old one. Say so and widen loudly — a
            // silent whole-workspace load here is exactly how "custom"
            // study used to quietly drill the entire workspace.
            if (!cancelled) {
              toast.warning(
                `"${customScope.name}" isn't in this workspace — showing all cards.`,
              );
              setCustomScope(null);
            }
            return;
          }
          const ids = await vocabIdsInCollections(
            workspace.id,
            subtree.map((c) => c.id),
          );
          const pool = orderCustomQueue(await listVocabByIds(workspace.id, ids));
          if (cancelled) return;
          setVocab(pool);
          setDueVocab(pool);
          // Workspace-wide "already anchored today" chrome doesn't
          // apply to a scoped cram — the drill default comes from the
          // launch site instead (GraduationCap buttons promise "no SRS
          // impact"; the post-push "Add & study now" flow wants real
          // reviews). The prestart toggle remains the escape hatch.
          setAnchoredToday(false);
          setDrillMode(customScope.drill);
          return;
        }

        if (restudyToday) {
          // Re-study queue: everything reviewed today, in the order it
          // was first studied. Both pools get the same list (the custom-
          // scope precedent) so every plugin stays inside it.
          const pool = await listVocabReviewedToday(workspace.id);
          if (cancelled) return;
          if (pool.length === 0) {
            // Day rolled over, or the reviewed cards were deleted —
            // nothing to re-run. Fall back to the normal queue loudly.
            toast.warning("Nothing reviewed today to study again.");
            setRestudyToday(false);
            return;
          }
          setVocab(pool);
          setDueVocab(pool);
          // The anchored banner would nag "pass already logged" inside
          // a flow that exists because of that fact — suppress it. The
          // hub's re-study banner carries the context instead.
          setAnchoredToday(false);
          return;
        }

        // Bounded study-queue fetch — only pull cards that could plausibly
        // be reviewed in this session (due reviews + a small reservoir of
        // new cards). On a workspace with 15k+ words a `listVocab` call
        // shipped megabytes of mastered rows we never used and stalled the
        // SQLx pool; this caps the load at 500 rows max.
        const [studyPool, due, anchored] = await Promise.all([
          listStudyVocab(workspace.id, 500),
          listDueVocab(workspace.id, 200),
          hasReviewedToday(workspace.id).catch(() => false),
        ]);
        if (cancelled) return;
        setVocab(studyPool);
        setDueVocab(due);
        // "Fully done today" requires both halves: at least one review
        // today AND no cards still due. Showing the "SRS pass logged"
        // banner just because a single grade landed would mislead a
        // user with a long due queue — they're not done, they've
        // barely started.
        const fullyDoneToday = anchored && due.length === 0;
        setAnchoredToday(fullyDoneToday);
        // Auto-flip drill mode iff today's pass is fully done AND the
        // user hasn't already touched the toggle for this session.
        // Doing this once-per-load (not on every grade) means the user
        // can still flip drill off mid-day for a deliberate re-grade
        // and the override survives across plugin switches.
        if (fullyDoneToday) setDrillMode(true);
        // Size of the "study today's cards again" offer. Only fetched
        // when the pass is fully done — on a normal day the offer
        // doesn't exist, so skip the extra query.
        if (fullyDoneToday) {
          const reviewedToday = await listVocabReviewedToday(
            workspace.id,
          ).catch(() => []);
          if (!cancelled) setRestudyCount(reviewedToday.length);
        } else {
          setRestudyCount(0);
        }
      } catch (err) {
        // Without this catch, a SQL error would leave vocab/dueVocab
        // permanently null and the UI stuck on "Loading vocabulary…"
        // with no signal to the user. Surface it instead.
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[flashcards] failed to load study queue", err);
        setLoadError(msg);
        // Empty queues so the screen leaves the loading state.
        setVocab([]);
        setDueVocab([]);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, retryNonce, customScope, restudyToday]);

  // Auto-restore of the last-used plugin was removed deliberately —
  // re-entering the Flashcards tab should always land on the hub,
  // not silently drop the user back into vocab-recall (or whatever)
  // mid-session. The session row from that previous run still gets
  // finalised by the unmount-end effect below, so progress isn't
  // lost; the user just gets a clean slate on re-entry.

  // End the active session when the user navigates away mid-study.
  // `endIfActive(id)` is a no-op when the session was replaced or
  // already ended via the plugin's natural completion path, so the
  // common case (user finished, clicked End) doesn't double-end.
  // Without this, sessions hang open with `duration_secs = NULL`
  // until the 5-min idle timer or `finalizeStaleSessions` catches
  // them — both worse UX than "you walked away, the timer stops".
  useEffect(() => {
    return () => {
      const id = createdSessionIdRef.current;
      if (id != null) {
        void session.endIfActive(id).catch(() => {
          /* best-effort; the row still gets duration on next stale-finalise */
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ctx: StudyContext | null = useMemo(() => {
    if (!workspace || !vocab || !dueVocab) return null;
    return {
      workspace,
      vocab,
      dueVocab,
      // The re-study queue rides the custom-scope contract: a synthetic
      // scope (no collectionId) tells plugins the pool is user-bounded,
      // so they skip daily caps and the queue is exactly the day's cards.
      customScope: customScope
        ? { collectionId: customScope.collectionId, name: customScope.name }
        : restudyToday
          ? { name: "Today's cards — again" }
          : null,
      restudyToday:
        !restudyToday && !customScope && restudyCount > 0
          ? { count: restudyCount, start: startRestudy }
          : null,
      reviewVocab: async (cardId, grade) => {
        // Drill mode short-circuit: the user is intentionally grading
        // without affecting their SRS schedule (pre-exam cramming,
        // warm-up runs). Resolve cleanly so the plugin's local
        // bookkeeping — grade tallies, card pointer, summary stats —
        // stays identical to a real review.
        if (drillMode) return;
        // Look in both pools — `vocab` is the bounded study queue,
        // `dueVocab` is the strict-due subset. Plugins typically draw
        // from one or the other; either lookup is correct. The
        // fallback exists because an earlier bug had `vocab` empty in
        // hosted mode, which made every grade silently no-op. If a
        // card is in neither pool we surface that loudly instead of
        // pretending the grade landed.
        const card =
          vocab.find((c) => c.id === cardId) ??
          dueVocab.find((c) => c.id === cardId);
        if (!card) {
          console.warn(
            `[flashcards] grade ignored — card ${cardId} not in study pool`,
          );
          return;
        }
        const next = schedule(card, grade as Grade, studyCfg.config.srs);
        await dbReviewVocab({
          id: cardId,
          status: next.status,
          stability: next.stability,
          difficulty: next.difficulty,
          learningStep: next.learningStep,
          dueAt: next.dueAt,
          grade: grade as Grade,
          // Pass the active workspace so HOSTED skips the probe walk
          // (was firing listWorkspaces + a 404-then-retry chain on
          // every single card grade — easily 500 ms+ per click).
          workspaceId: workspace.id,
        });
      },
      setStatus: async (cardId, status) => {
        const card = vocab.find((c) => c.id === cardId);
        if (!card || !workspace) return;
        await dbSetVocabStatus({
          workspaceId: workspace.id,
          word: card.word,
          reading: card.reading,
          gloss: card.gloss,
          status,
        });
      },
      speak: async (text, lang) => {
        await tts.speak(text, lang ?? workspace.targetLang);
      },
      ensureSessionStarted: async (kind) => {
        const { session: s, created } = await session.ensureStarted(kind);
        // Capture the session id WE created so the unmount cleanup
        // below can end it cleanly. If `created === false` (the chip
        // started this session, or another view did) we leave the
        // session alone — the chip owns its lifecycle.
        if (created) createdSessionIdRef.current = s.id;
      },
      // Plugins drive these from their own pause UI so the session clock
      // (and the idle auto-end) freezes while the user is paused.
      pauseSession: session.pause,
      resumeSession: session.resume,
      bump: async (kind) => {
        await session.bump(kind);
      },
      onSessionEnd: (stats) => {
        // Show the summary screen immediately…
        setSummary(stats);
        // …and persist the session row to the DB. Without this call,
        // the row created by `ensureStarted("review")` keeps
        // `duration_secs = NULL`, so the dashboard's "today's
        // immersion so far" and the consistency heatmap (both fed by
        // listSessions → durationSecs) read 0 even after a real
        // session. session.end() runs `endSession(session.id)` which
        // writes `ended_at = now()` and `duration_secs = now -
        // started_at`, matching what the user just saw on screen.
        void session.end().catch((err) => {
          console.warn("[study] session.end failed", err);
        });
      },
      drillMode,
      setDrillMode,
      srsAnchorState:
        anchoredToday == null
          ? "unknown"
          : anchoredToday
            ? "alreadyAnchored"
            : "free",
    };
  }, [
    workspace,
    vocab,
    dueVocab,
    customScope,
    restudyToday,
    restudyCount,
    startRestudy,
    tts,
    session,
    studyCfg.config.srs,
    drillMode,
    anchoredToday,
  ]);

  if (!workspace) return null;

  // Load failed — surface the error instead of hanging on the spinner.
  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="font-serif text-2xl tracking-tight">Couldn&apos;t load flashcards</p>
        <p className="max-w-lg text-[13px] text-muted-foreground">{loadError}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadError(null);
            setVocab(null);
            setDueVocab(null);
            setRetryNonce((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  // Loading vocab snapshot
  if (!ctx) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading vocabulary…
      </div>
    );
  }

  // Session summary screen
  if (summary) {
    // Closing the summary drops back to the plugin picker AND
    // re-fetches the workspace's vocab + due lists. Without the
    // refetch, the just-reviewed cards stay in the captured `vocab`
    // snapshot and a back-to-back session would re-show them as
    // still-due — the SRS write went to disk but the in-memory
    // queue didn't know.
    const closeSummary = () => {
      setSummary(null);
      setPicked(null);
      // Back-to-back custom sessions keep the scope's drill default
      // (the reload below re-applies it anyway); a re-study queue keeps
      // drill armed; outside both, reset to real-review mode as before.
      setDrillMode(customScope?.drill ?? restudyToday);
      // Reset anchor too — the load effect re-fetches it alongside
      // vocab, which is now expected to flip to `true` after a
      // non-drill session has just landed reviews.
      setAnchoredToday(null);
      localStorage.removeItem(ACTIVE_PLUGIN_KEY);
      // Force the load-vocab useEffect to re-fire with fresh data.
      setVocab(null);
      setDueVocab(null);
      setRetryNonce((n) => n + 1);
    };
    return (
      <SessionSummary
        stats={summary}
        plugin={picked}
        scopeName={customScope?.name ?? null}
        onGoBack={closeSummary}
        onChangeMode={closeSummary}
      />
    );
  }

  // Plugin picker (shown when nothing picked yet)
  if (!picked) {
    return (
      <PluginPicker
        plugins={plugins}
        customScope={customScope}
        customCount={vocab?.length ?? 0}
        onExitCustom={exitCustomStudy}
        restudyActive={restudyToday}
        restudyOffer={restudyToday || customScope ? 0 : restudyCount}
        onStartRestudy={startRestudy}
        onExitRestudy={exitRestudy}
        onPick={(p) => {
          setPicked(p);
          localStorage.setItem(ACTIVE_PLUGIN_KEY, p.meta.id);
        }}
      />
    );
  }

  // Active session — fullscreen mount of the picked plugin. The plugin
  // owns its own top bar (TopActionBar with progress + Known/Boost/Block/
  // Pause). We sit a slim "Switch mode" strip above it so the user can
  // bail back to the picker without having to End the session through
  // the Pause overlay — every plugin gets the back path for free,
  // without each one having to grow a button. Mid-session graded cards
  // are already persisted via ctx.reviewVocab, so dropping the queue
  // here just abandons un-graded cards (which is what "switch mode"
  // means anyway).
  const Plugin = picked.StudyView;
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex items-center gap-3 border-b border-border bg-muted/20 px-3 py-1.5">
        <button
          type="button"
          onClick={() => {
            // Freeze the session clock while the user sits on the picker —
            // time on the review home screen isn't study time. The next
            // plugin that calls ensureSessionStarted resumes the same
            // session, so the accrued active seconds stay continuous.
            session.pause();
            setPicked(null);
            // Restore the scope's drill default rather than blanket-off
            // — bailing out of one mode mid-cram (or mid-re-study) must
            // not silently arm SRS writes for the next one.
            setDrillMode(customScope?.drill ?? restudyToday);
            localStorage.removeItem(ACTIVE_PLUGIN_KEY);
          }}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          title="Pick a different study mode (any un-graded cards in this queue are dropped)"
        >
          <ArrowLeft className="size-3.5" />
          Switch mode
        </button>
        <span className="shrink-0 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          {picked.meta.name}
        </span>
        {customScope && (
          <span
            className="inline-flex min-w-0 items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-violet-700 dark:text-violet-300"
            title={`Custom study — only the words in "${customScope.name}" are in this session`}
          >
            <GraduationCap className="size-3 shrink-0" />
            <span className="truncate">Custom · {customScope.name}</span>
          </span>
        )}
        {restudyToday && (
          <span
            className="inline-flex min-w-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-400"
            title="Re-studying everything you reviewed today"
          >
            <RotateCcw className="size-3 shrink-0" />
            Today again
          </span>
        )}
        {drillMode && (
          <span className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
            Drill — no SRS
          </span>
        )}
      </div>
      <Plugin ctx={ctx} />
    </div>
  );
}

function PluginPicker({
  plugins,
  customScope,
  customCount,
  onExitCustom,
  restudyActive,
  restudyOffer,
  onStartRestudy,
  onExitRestudy,
  onPick,
}: {
  plugins: StudyPlugin[];
  /** Non-null when a custom-study scope is active — renders the banner. */
  customScope: CustomStudyHandoff | null;
  /** Size of the scoped pool (drives the banner copy — shared by the
   *  custom-study and re-study banners, both of which scope the pool). */
  customCount: number;
  onExitCustom: () => void;
  /** True while the re-study queue (today's reviewed cards) is active. */
  restudyActive: boolean;
  /** Card count for the "study today's cards again" offer; 0 hides it. */
  restudyOffer: number;
  onStartRestudy: () => void;
  onExitRestudy: () => void;
  onPick: (p: StudyPlugin) => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-8">
      <div className="w-full max-w-2xl space-y-4">
        {restudyActive && (
          <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
              <RotateCcw className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">
                Re-studying today&apos;s cards
              </p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                The session re-runs the {customCount.toLocaleString()} card
                {customCount === 1 ? "" : "s"} you reviewed today — drill mode
                is on, so your SRS schedule won&apos;t move.
              </p>
            </div>
            <button
              type="button"
              onClick={onExitRestudy}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              title="Exit re-study — back to the normal queue"
              aria-label="Exit re-study"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {restudyOffer > 0 && (
          <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">
                Today&apos;s SRS pass is done.
              </p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                Want extra reps? Re-run the {restudyOffer.toLocaleString()}{" "}
                card{restudyOffer === 1 ? "" : "s"} you reviewed today without
                touching your schedule.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onStartRestudy}
              className="shrink-0"
            >
              <RotateCcw className="size-3.5" />
              Study again
            </Button>
          </div>
        )}
        {customScope && (
          <div className="flex items-start gap-3 rounded-2xl border border-violet-500/30 bg-violet-500/5 px-4 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-300">
              <GraduationCap className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">
                Custom study — {customScope.name}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                {customCount === 0
                  ? "This collection has no words yet. Add some, or exit to study everything."
                  : `Only the ${customCount.toLocaleString()} word${customCount === 1 ? "" : "s"} in this collection are in the session${
                      customScope.drill
                        ? " — drill mode is on, so your SRS schedule won't move."
                        : " — grades count toward your SRS schedule."
                    }`}
              </p>
            </div>
            <button
              type="button"
              onClick={onExitCustom}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              title="Exit custom study — back to all cards"
              aria-label="Exit custom study"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        <div className="text-center">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Pick a study mode
          </p>
          <h2 className="mt-1 font-serif text-2xl tracking-tight">
            How do you want to study today?
          </h2>
        </div>
        <ul className="space-y-2">
          {plugins.map((p) => {
            const Icon = p.meta.icon;
            return (
              <li key={p.meta.id}>
                <button
                  onClick={() => onPick(p)}
                  className="group flex w-full items-start gap-3 rounded-2xl border border-border bg-card px-5 py-4 text-left transition-all hover:border-foreground/30 hover:shadow-md"
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-colors group-hover:bg-foreground/10 group-hover:text-foreground">
                    {Icon ? <Icon className="size-4" /> : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{p.meta.name}</div>
                    <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                      {p.meta.description}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="text-center text-[11.5px] text-muted-foreground">
          Want a custom study mode? See <span className="font-mono">src/lib/study/api.ts</span>
          {" "}— plugins are a typed contract, drop a file in{" "}
          <span className="font-mono">src/lib/study/plugins/</span>.
        </p>
      </div>
    </div>
  );
}

/**
 * End-of-session screen.
 *
 * Three layers stacked vertically inside a centered, scrollable column:
 *
 *   1. Celebration confetti — 12 colored dots that float up + fade in
 *      on mount via tw-animate-css utilities + staggered animationDelay.
 *      Pure CSS, no framer-motion dependency, respects motion-safe.
 *   2. Headline + grade tally pills.
 *   3. Per-card list, deduped by word with the LATEST grade winning so
 *      a card you graded "Again" then "Good" the second time it
 *      surfaced shows only as "Good" — matches user intuition.
 *
 * Primary action is "Go back" (returns to the plugin picker). Secondary
 * is "Change mode" which also returns to the picker — kept for now in
 * case we want to differentiate (e.g. start the same mode again) later.
 */
function SessionSummary({
  stats,
  plugin,
  scopeName,
  onGoBack,
  onChangeMode,
}: {
  stats: StudySessionStats;
  plugin: StudyPlugin | null;
  /** Custom-study collection name, when the session was scoped. */
  scopeName: string | null;
  onGoBack: () => void;
  onChangeMode: () => void;
}) {
  // Dedupe reviewedCards by word. A card surfaced twice (graded "Again"
  // then re-queued and graded "Good") should appear once in the list
  // with its final grade — which is naturally the *last* entry in the
  // grading-order array. We walk forward and overwrite a Map so that
  // the latest entry per word wins.
  const dedupedCards = useMemo(() => {
    const byWord = new Map<string, ReviewedCardSummary>();
    for (const c of stats.reviewedCards ?? []) {
      byWord.set(c.word, c);
    }
    return Array.from(byWord.values());
  }, [stats.reviewedCards]);

  // Group by grade so the user can read "what I got right" vs "what
  // tripped me up" at a glance. Order matters — failures up top so they
  // stand out, easy at the bottom because they need least attention.
  const groupedCards = useMemo(() => {
    const groups: Record<Grade, ReviewedCardSummary[]> = {
      again: [],
      hard: [],
      good: [],
      easy: [],
    };
    for (const c of dedupedCards) groups[c.grade].push(c);
    return groups;
  }, [dedupedCards]);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-6 py-10">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center text-center">
        {/* Celebration confetti — 12 colored dots floating up. Each
            uses tw-animate-css fade+slide with a staggered delay so
            they cascade rather than fire all at once. */}
        <ConfettiBurst />

        {/* Headline + meta */}
        <h2
          className="mt-4 font-serif text-3xl tracking-tight animate-in fade-in zoom-in-95 duration-500"
          style={{ animationDelay: "300ms", animationFillMode: "both" }}
        >
          Session done!
        </h2>
        <p
          className="mt-1.5 text-[13.5px] text-muted-foreground animate-in fade-in duration-500"
          style={{ animationDelay: "450ms", animationFillMode: "both" }}
        >
          {stats.cardsReviewed} card{stats.cardsReviewed === 1 ? "" : "s"} ·{" "}
          {Math.max(1, Math.round(stats.durationSecs / 60))} min
          {plugin && ` · ${plugin.meta.name}`}
          {scopeName != null && ` · Custom: ${scopeName}`}
        </p>

        {/* Grade pills */}
        {stats.grades && (
          <div
            className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[11.5px] animate-in fade-in slide-in-from-bottom-2 duration-500"
            style={{ animationDelay: "550ms", animationFillMode: "both" }}
          >
            <GradePill grade="again" count={stats.grades.again} />
            <GradePill grade="hard" count={stats.grades.hard} />
            <GradePill grade="good" count={stats.grades.good} />
            <GradePill grade="easy" count={stats.grades.easy} />
          </div>
        )}

        {/* Word list */}
        {dedupedCards.length > 0 && (
          <div
            className="mt-7 w-full animate-in fade-in slide-in-from-bottom-2 duration-500"
            style={{ animationDelay: "650ms", animationFillMode: "both" }}
          >
            <p className="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              What you studied
            </p>
            <div className="grid gap-3 text-left">
              {(["again", "hard", "good", "easy"] as Grade[]).map((g) => {
                const items = groupedCards[g];
                if (items.length === 0) return null;
                return (
                  <ReviewedGroup key={g} grade={g} items={items} />
                );
              })}
            </div>
          </div>
        )}

        {/* Actions */}
        <div
          className="mt-8 flex flex-wrap items-center justify-center gap-2 animate-in fade-in duration-500"
          style={{ animationDelay: "750ms", animationFillMode: "both" }}
        >
          <Button onClick={onGoBack}>Go back</Button>
          <Button variant="outline" onClick={onChangeMode}>
            Change mode
          </Button>
        </div>
      </div>
    </div>
  );
}

const CONFETTI_COLORS = [
  "bg-rose-400",
  "bg-amber-400",
  "bg-emerald-400",
  "bg-sky-400",
  "bg-violet-400",
  "bg-pink-400",
];

/** A row of 12 colored dots that float up + fade in on mount. Pure
 *  CSS — relies on tw-animate-css utilities so it slots in without
 *  pulling framer-motion just for the celebration moment. Each dot
 *  gets a deterministic-feeling stagger via `animationDelay`. */
function ConfettiBurst() {
  return (
    <div className="pointer-events-none flex h-12 items-end gap-1.5 overflow-visible">
      {Array.from({ length: 12 }, (_, i) => {
        const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        // Mix of slow + quick rises by alternating sizes / delays so it
        // doesn't read as a sterile sequence.
        const size = i % 3 === 0 ? "size-2.5" : "size-2";
        return (
          <span
            key={i}
            className={cn(
              "block rounded-full opacity-0 animate-in fade-in slide-in-from-bottom-8 duration-1000",
              color,
              size,
            )}
            style={{
              animationDelay: `${i * 70}ms`,
              animationFillMode: "forwards",
            }}
          />
        );
      })}
    </div>
  );
}

const GRADE_META: Record<
  Grade,
  { label: string; pillClass: string; chipClass: string; icon: string }
> = {
  again: {
    label: "Again",
    pillClass:
      "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
    chipClass:
      "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
    icon: "↻",
  },
  hard: {
    label: "Hard",
    pillClass:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    chipClass:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    icon: "•",
  },
  good: {
    label: "Good",
    pillClass:
      "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
    chipClass:
      "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
    icon: "✓",
  },
  easy: {
    label: "Easy",
    pillClass:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    chipClass:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    icon: "★",
  },
};

function GradePill({ grade, count }: { grade: Grade; count: number }) {
  const meta = GRADE_META[grade];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-medium",
        meta.pillClass,
      )}
    >
      <span className="text-[11px]">{meta.icon}</span>
      {meta.label} {count}
    </span>
  );
}

function ReviewedGroup({
  grade,
  items,
}: {
  grade: Grade;
  items: ReviewedCardSummary[];
}) {
  const meta = GRADE_META[grade];
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <span
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-full text-[9px]",
            meta.chipClass,
          )}
        >
          {meta.icon}
        </span>
        {meta.label} · {items.length}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((c, i) => (
          <li
            key={`${c.word}-${i}`}
            className="rounded-md border border-border bg-background px-2 py-1 text-[12.5px]"
            title={c.gloss ?? undefined}
          >
            <span className="font-serif text-[14px]">{c.word}</span>
            {c.reading && (
              <span className="ml-1.5 text-[11px] text-muted-foreground">
                {c.reading}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
// ── Browse mode ──

const STATUS_LABEL: Record<VocabStatus, string> = {
  unseen: "Unseen (library)",
  new: "New",
  learning: "Learning",
  review: "Review",
  mastered: "Known",
};

/**
 * After this many rows the table collapses to a preview with a "Show all N"
 * toggle. Big lists make the page feel like a wall of text and slow down the
 * initial paint — 75 is enough that most users see everything they care
 * about and the rest is one click away.
 */
const COLLAPSE_AFTER = 75;

/** What the AlertDialog is currently asking the user to confirm. `null`
 *  means the dialog is closed. Re-using one component for several actions
 *  beats wiring three separate dialogs. */
type PendingConfirm = {
  title: string;
  description: string;
  /** Visible label of the confirm button — defaults to "Delete". */
  actionLabel?: string;
  onConfirm: () => Promise<void> | void;
} | null;

const KIND_FILTERS: ("all" | VocabKind)[] = ["all", "vocab", "sentence", "writing"];
const KIND_LABEL: Record<VocabKind, string> = {
  vocab: "Vocab",
  sentence: "Sentence",
  writing: "Writing",
};

// Default sort direction per column — one click lands the most useful
// order: soonest-due first, newest-added first, longest interval first,
// A→Z for text columns.
const DEFAULT_SORT_DIR: Record<BrowseSortKey, SortDir> = {
  word: "asc",
  type: "asc",
  status: "asc",
  due: "asc",
  interval: "desc",
  added: "desc",
  reviews: "desc",
};

/** Compact day-count label: "12d", "3mo", "1.4y". "—" for zero. */
function fmtDays(days: number): string {
  if (days <= 0) return "—";
  if (days < 31) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  const y = days / 365;
  return `${y < 10 ? y.toFixed(1) : Math.round(y)}y`;
}

/** "just now" / "5m ago" / "3d ago" / "2mo ago" — compact past time. */
function fmtAgo(sec: number, nowSec: number): string {
  const d = Math.max(0, nowSec - sec);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  const days = Math.floor(d / 86_400);
  if (days < 31) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

/** Due-cell text + flags. New / library / unscheduled cards read "—". */
function dueCell(
  card: VocabEntry,
  nowSec: number,
): { text: string; overdue: boolean; muted: boolean } {
  if (card.dueAt == null || card.status === "new" || card.status === "unseen") {
    return { text: "—", overdue: false, muted: true };
  }
  const delta = card.dueAt - nowSec;
  if (delta <= 0) {
    const overdueSecs = -delta;
    if (overdueSecs < 86_400) return { text: "overdue", overdue: true, muted: false };
    return {
      text: `${Math.round(overdueSecs / 86_400)}d overdue`,
      overdue: true,
      muted: false,
    };
  }
  if (delta < 3600) return { text: "due now", overdue: false, muted: false };
  if (delta < 86_400)
    return { text: `in ${Math.floor(delta / 3600)}h`, overdue: false, muted: false };
  return {
    text: `in ${fmtDays(Math.round(delta / 86_400))}`,
    overdue: false,
    muted: false,
  };
}

/** Sortable column header — clicking toggles direction (or switches to
 *  this column at its default direction). Shows a caret when active, a
 *  faint up/down hint otherwise. */
function SortableTh({
  label,
  field,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string;
  field: BrowseSortKey;
  sortKey: BrowseSortKey;
  sortDir: SortDir;
  onSort: (k: BrowseSortKey) => void;
  className?: string;
}) {
  const active = sortKey === field;
  return (
    <th className={cn("px-3 py-2 font-medium", className)}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ChevronUp className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

function BrowseMode() {
  const { active: workspace } = useWorkspace();
  const dictSearch = useDictSearch();
  const [vocab, setVocab] = useState<VocabEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Which statuses to show. Starts as "all"; the advanced filter lets the
  // user drop any (e.g. hide Known + Unseen to focus on active study cards).
  const [statuses, setStatuses] = useState<Set<VocabStatus>>(
    () => new Set(ALL_VOCAB_STATUSES),
  );
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | VocabKind>("all");
  const [sortKey, setSortKey] = useState<BrowseSortKey>("added");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [creating, setCreating] = useState(false);
  // One "now" per render shared by every due / overdue / relative cell.
  const nowSec = Math.floor(Date.now() / 1000);

  // Clicking a column header toggles its direction, or switches to it at
  // the column's default direction (see DEFAULT_SORT_DIR).
  function onSort(field: BrowseSortKey) {
    if (field === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(field);
      setSortDir(DEFAULT_SORT_DIR[field]);
    }
  }

  /** Hand off to the rich dictionary detail page (Search tab). */
  function openInDictionary(word: string) {
    dictSearch.setQuery(word);
    navigateToTab("search");
  }
  const [editing, setEditing] = useState<VocabEntry | null>(null);
  const [flashcard, setFlashcard] = useState<VocabEntry | null>(null);
  // Cards currently in the template-edit modal. Empty array = closed.
  // Length 1 = single-card edit; length > 1 = bulk "Change template".
  const [templateCards, setTemplateCards] = useState<VocabEntry[]>([]);
  // Selected card IDs. A Set keeps add/remove/has at O(1) for big lists.
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  // Whether to show all filtered cards or just the first COLLAPSE_AFTER.
  const [expanded, setExpanded] = useState(false);
  // What the AlertDialog is currently asking the user to confirm.
  const [pending, setPending] = useState<PendingConfirm>(null);

  async function refresh() {
    if (!workspace) return;
    setLoading(true);
    const list = await listVocab(workspace.id);
    setVocab(list);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Optimistic per-row status change. Mirrors the vocab-view dropdown
  // approach so the dot/badge updates instantly without waiting on
  // HOSTED's round-trip; reverts if the write fails.
  async function changeStatus(entry: VocabEntry, next: VocabStatus) {
    if (entry.status === next) return;
    setVocab((prev) =>
      prev.map((v) => (v.id === entry.id ? { ...v, status: next } : v)),
    );
    try {
      await dbSetVocabStatus({
        workspaceId: entry.workspaceId,
        word: entry.word,
        reading: entry.reading,
        gloss: entry.gloss,
        status: next,
      });
    } catch (err) {
      setVocab((prev) =>
        prev.map((v) => (v.id === entry.id ? { ...v, status: entry.status } : v)),
      );
      console.error("[flashcards] status update failed", err);
      toast.error("Couldn't update status");
    }
  }

  const filtered = useMemo(
    () =>
      sortVocab(
        filterVocab(vocab, { search, statuses, kind: kindFilter }),
        sortKey,
        sortDir,
      ),
    [vocab, statuses, search, kindFilter, sortKey, sortDir],
  );

  // Reset expansion + selection when the row SET changes (status / search /
  // type), so we never delete the wrong rows because some are hidden. A
  // sort change only reorders the same set, so it doesn't reset selection.
  useEffect(() => {
    setExpanded(false);
    setSelected(new Set());
  }, [statuses, search, kindFilter]);

  // "Nothing is filtered out" — every status shown, no type filter, no
  // search. Drives the Delete-all wording (whole workspace vs a subset).
  const isUnfiltered =
    statuses.size >= ALL_VOCAB_STATUSES.length &&
    kindFilter === "all" &&
    !search.trim();

  // Visible rows after the collapse rule. Selection logic always operates on
  // *visible* rows so the master checkbox isn't misleading.
  const visible = useMemo(
    () => (expanded ? filtered : filtered.slice(0, COLLAPSE_AFTER)),
    [filtered, expanded],
  );
  const collapsedCount = filtered.length - visible.length;

  // Master-checkbox tri-state across visible rows.
  const visibleSelectedCount = visible.filter((v) => selected.has(v.id)).length;
  const allVisibleSelected =
    visible.length > 0 && visibleSelectedCount === visible.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && visibleSelectedCount < visible.length;

  function toggleOne(id: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function toggleAllVisible(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const v of visible) {
        if (on) next.add(v.id);
        else next.delete(v.id);
      }
      return next;
    });
  }

  async function deleteCards(ids: number[]) {
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => deleteVocab(id)));
    const idSet = new Set(ids);
    setVocab((prev) => prev.filter((v) => !idSet.has(v.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    toast(`Deleted ${ids.length} card${ids.length === 1 ? "" : "s"}`);
  }

  function askDeleteOne(card: VocabEntry) {
    setPending({
      title: `Delete "${card.word}"?`,
      description: "This card will be removed from your vocab list. The action cannot be undone.",
      onConfirm: () => deleteCards([card.id]),
    });
  }
  function askDeleteSelected() {
    if (selected.size === 0) return;
    setPending({
      title: `Delete ${selected.size} card${selected.size === 1 ? "" : "s"}?`,
      description:
        "The selected cards will be permanently removed from your vocab list. This cannot be undone.",
      onConfirm: () => deleteCards(Array.from(selected)),
    });
  }
  function askDeleteAllVisible() {
    if (filtered.length === 0) return;
    setPending({
      title: `Delete all ${filtered.length} card${filtered.length === 1 ? "" : "s"}?`,
      description: isUnfiltered
        ? "This deletes every card in this workspace. Your dictionaries and chat history are unaffected."
        : `Deletes every card matching the current filters${search ? ` and search "${search}"` : ""}. Cards not shown remain.`,
      actionLabel: "Delete all",
      onConfirm: () => deleteCards(filtered.map((v) => v.id)),
    });
  }

  return (
    <>
      <div className="border-b border-border px-8 pt-2 pb-4">
        <div className="mx-auto flex max-w-5xl 2xl:max-w-6xl flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search word, reading, or gloss…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9"
            />
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-full">
                <ListFilter className="size-3.5" />
                {statuses.size >= ALL_VOCAB_STATUSES.length
                  ? "All statuses"
                  : statuses.size === 0
                    ? "No statuses"
                    : `${statuses.size} status${statuses.size === 1 ? "" : "es"}`}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-2">
              <div className="flex items-center justify-between px-1 pb-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Show statuses
                </span>
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setStatuses((prev) =>
                      prev.size >= ALL_VOCAB_STATUSES.length
                        ? new Set()
                        : new Set(ALL_VOCAB_STATUSES),
                    )
                  }
                >
                  {statuses.size >= ALL_VOCAB_STATUSES.length ? "Clear" : "All"}
                </button>
              </div>
              <div className="space-y-0.5">
                {ALL_VOCAB_STATUSES.map((s) => (
                  <label
                    key={s}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-accent/50"
                  >
                    <Checkbox
                      checked={statuses.has(s)}
                      onCheckedChange={(v) =>
                        setStatuses((prev) => {
                          const next = new Set(prev);
                          if (v === true) next.add(s);
                          else next.delete(s);
                          return next;
                        })
                      }
                    />
                    {STATUS_LABEL[s]}
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Select
            value={kindFilter}
            onValueChange={(v) => setKindFilter(v as "all" | VocabKind)}
          >
            <SelectTrigger size="sm" className="h-9 min-w-[120px] rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_FILTERS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k === "all" ? "All types" : KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="ml-auto h-9 rounded-full"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-3.5" />
            New card
          </Button>
          <span className="text-[12px] text-muted-foreground">
            {filtered.length} card{filtered.length === 1 ? "" : "s"}
          </span>
          {/* Delete-all is destructive enough that we keep it visible only
              when the table has rows to delete. Confirms via AlertDialog. */}
          {filtered.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={askDeleteAllVisible}
              className="text-muted-foreground hover:text-destructive"
              title={
                isUnfiltered
                  ? "Delete every card in this workspace"
                  : "Delete every card matching the current filters"
              }
            >
              <Trash2 className="size-3.5" />
              {isUnfiltered ? "Delete all" : "Delete filtered"}
            </Button>
          )}
        </div>
        {/* Bulk action bar — only when something is selected. Appears below
            the filter row so it doesn't shift the layout when empty. */}
        {selected.size > 0 && (
          <div className="mx-auto mt-3 flex max-w-5xl 2xl:max-w-6xl items-center gap-2 rounded-md border border-border bg-accent/40 px-3 py-1.5 text-[12.5px]">
            <span className="font-medium">
              {selected.size} selected
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setTemplateCards(filtered.filter((v) => selected.has(v.id)))
              }
              className="ml-auto h-7"
            >
              <LayoutTemplate className="size-3.5" />
              Change template
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={askDeleteSelected}
              className="h-7"
            >
              <Trash2 className="size-3.5" />
              Delete selected
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              className="h-7 text-muted-foreground"
            >
              Clear
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-5">
        <div className="mx-auto max-w-5xl 2xl:max-w-6xl">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center">
              <Sparkles className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No cards match.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="overflow-x-auto">
              <table className="w-full text-left text-[13.5px]">
                <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="w-10 px-3 py-2 font-medium">
                      <Checkbox
                        checked={
                          allVisibleSelected
                            ? true
                            : someVisibleSelected
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={(v) => toggleAllVisible(v === true)}
                        aria-label="Select all visible"
                      />
                    </th>
                    <SortableTh label="Word" field="word" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                    <th className="px-3 py-2 font-medium">Reading</th>
                    <th className="px-3 py-2 font-medium">Gloss</th>
                    <SortableTh label="Type" field="type" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                    <SortableTh label="Status" field="status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                    <SortableTh label="Due" field="due" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="whitespace-nowrap" />
                    <SortableTh label="Interval" field="interval" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="whitespace-nowrap" />
                    <SortableTh label="Added" field="added" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="whitespace-nowrap" />
                    <th className="w-24 px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => {
                    const due = dueCell(c, nowSec);
                    return (
                    <tr
                      key={c.id}
                      className={cn(
                        "group/row border-t border-border/60 transition-colors hover:bg-accent/30",
                        selected.has(c.id) && "bg-accent/40",
                      )}
                    >
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selected.has(c.id)}
                          onCheckedChange={(v) => toggleOne(c.id, v === true)}
                          aria-label={`Select ${c.word}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-serif text-[16px]">
                        <button
                          type="button"
                          onClick={() => setFlashcard(c)}
                          className="inline-flex items-center gap-1.5 text-left hover:text-brand"
                          title="Open flashcard"
                        >
                          {c.word}
                          {(c.hasImage || c.frontExtra || c.cardNotes) && (
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                              {c.hasImage && <ImageIcon className="size-3" aria-label="has image" />}
                              {c.frontExtra && (
                                <span className="rounded bg-muted px-1 text-[9px] font-mono">cloze</span>
                              )}
                              {c.cardNotes && (
                                <span className="rounded bg-muted px-1 text-[9px]">notes</span>
                              )}
                            </span>
                          )}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {c.reading && (
                          <button
                            type="button"
                            onClick={() => setFlashcard(c)}
                            className="text-left"
                          >
                            <Pinyin raw={c.reading} className="text-[12.5px]" />
                          </button>
                        )}
                      </td>
                      <td className="max-w-[260px] truncate px-3 py-2 text-muted-foreground">
                        <button
                          type="button"
                          onClick={() => setFlashcard(c)}
                          className="block w-full truncate text-left"
                          title={c.gloss ?? undefined}
                        >
                          {c.gloss}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          {KIND_LABEL[c.kind]}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <StatusSelect
                            status={c.status}
                            onChange={(next) => void changeStatus(c, next)}
                          />
                          {!c.isActive && (
                            <span
                              className="rounded-full border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
                              title="In library — not in active SRS yet."
                            >
                              library
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-[12px] tabular-nums">
                        <span
                          className={cn(
                            due.overdue
                              ? "font-medium text-destructive"
                              : due.muted
                                ? "text-muted-foreground/60"
                                : "text-muted-foreground",
                          )}
                        >
                          {due.text}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-[12px] tabular-nums text-muted-foreground">
                        {fmtDays(intervalDays(c))}
                      </td>
                      <td
                        className="whitespace-nowrap px-3 py-2 text-[12px] tabular-nums text-muted-foreground"
                        title={new Date(c.createdAt * 1000).toLocaleString()}
                      >
                        {fmtAgo(c.createdAt, nowSec)}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => openInDictionary(c.word)}
                            title="Open in dictionary"
                          >
                            <BookOpen className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setEditing(c)}
                            title="Edit"
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setTemplateCards([c])}
                            title="Change card layout (front / back)"
                          >
                            <LayoutTemplate className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => askDeleteOne(c)}
                            title="Delete"
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              {/* Collapse footer — only when there's more behind the cut. */}
              {collapsedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="block w-full border-t border-border/60 bg-muted/20 px-3 py-2 text-center text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                >
                  <ChevronDown className="mr-1 inline size-3.5" />
                  Show {collapsedCount} more · {filtered.length} total
                </button>
              )}
              {expanded && filtered.length > COLLAPSE_AFTER && (
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="block w-full border-t border-border/60 bg-muted/20 px-3 py-2 text-center text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                >
                  <ChevronUp className="mr-1 inline size-3.5" />
                  Collapse to first {COLLAPSE_AFTER}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {creating && (
        <CardComposerDialog
          mode="create"
          open
          onClose={() => setCreating(false)}
          onSaved={(created) => {
            setCreating(false);
            // Prepend so it's visible immediately; the sort re-derives it
            // into the right spot. Guard against a double-add.
            setVocab((prev) =>
              prev.some((v) => v.id === created.id) ? prev : [created, ...prev],
            );
          }}
        />
      )}

      {editing != null && (
        <CardComposerDialog
          mode="edit"
          open
          card={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setVocab((prev) => prev.map((v) => (v.id === updated.id ? updated : v)));
          }}
        />
      )}

      <CardTemplateDialog
        open={templateCards.length > 0}
        cards={templateCards}
        onClose={() => setTemplateCards([])}
        onSaved={(ids, layout) => {
          // Patch the local list so the new layout is reflected the
          // next time these rows render — saves a refetch round-trip.
          const idSet = new Set(ids);
          const serialized = layout == null ? null : JSON.stringify(layout);
          setVocab((prev) =>
            prev.map((v) =>
              idSet.has(v.id) ? { ...v, layout: serialized } : v,
            ),
          );
        }}
      />

      <FlashcardViewDialog
        open={flashcard != null}
        card={flashcard}
        onClose={() => setFlashcard(null)}
        onEdit={(c) => {
          setFlashcard(null);
          setEditing(c);
        }}
        onEditLayout={(c) => {
          setFlashcard(null);
          setTemplateCards([c]);
        }}
        onOpenInDictionary={(word) => {
          setFlashcard(null);
          openInDictionary(word);
        }}
      />

      {/* Single AlertDialog reused for one-card / selected / all delete
          flows — beats wiring three separate confirmations. The `pending`
          object carries title/description/onConfirm; null closes the
          dialog. */}
      <AlertDialog
        open={pending != null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const p = pending;
                setPending(null);
                if (p) await p.onConfirm();
              }}
            >
              {pending?.actionLabel ?? "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// "unseen" intentionally not user-pickable from the status picker —
// it's the import-only library state. Once a user touches a card we
// keep it on a normal status (new+).
const STATUS_OPTIONS: VocabStatus[] = ["new", "learning", "review", "mastered"];

const STATUS_STYLES: Record<VocabStatus, string> = {
  unseen:
    "bg-slate-200/40 text-slate-500 dark:text-slate-400 border-slate-300/40",
  new: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30",
  learning:
    "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  review: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30",
  mastered:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
};

/** Per-row status picker — rounded shadcn Select tinted by the active
 *  status so the row still reads at a glance like a status pill while
 *  letting the user reassign it in one click. */
function StatusSelect({
  status,
  onChange,
}: {
  status: VocabStatus;
  onChange: (next: VocabStatus) => void;
}) {
  return (
    <Select value={status} onValueChange={(v) => onChange(v as VocabStatus)}>
      <SelectTrigger
        size="sm"
        className={cn(
          "h-6 min-w-[88px] gap-1 rounded-full border px-2.5 text-[10.5px] font-semibold uppercase tracking-wide [&>svg]:size-3",
          STATUS_STYLES[status],
        )}
      >
        <SelectValue>{status === "mastered" ? "known" : status}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {STATUS_OPTIONS.map((s) => (
          <SelectItem key={s} value={s} className="capitalize">
            {s === "mastered" ? "Known" : s}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
