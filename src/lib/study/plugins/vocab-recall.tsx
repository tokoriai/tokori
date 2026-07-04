import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  RocketIcon,
  RotateCcw,
  ScrollText,
  SkipForward,
  Sparkles,
  StopCircle,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import { Pinyin } from "@/components/pinyin";
import { SpeakButton } from "@/components/speak-button";
import { StudyAiDrawer } from "@/components/study/ai-drawer";
import type { LanguageCode } from "@/lib/languages";
import { useWorkspace } from "@/lib/workspace-context";
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
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  deleteVocab,
  getVocabImage,
  listVocab,
  updateVocabFields,
} from "@/lib/db";
import {
  parseExamples,
  serialiseExamples,
  type ExampleSentence,
} from "@/lib/examples";
import { Tokenized } from "@/components/tokenized";
import { languageName } from "@/lib/languages";
import {
  usePluginSetting,
  type Grade,
  type ReviewedCardSummary,
  type StudyPlugin,
  type StudyViewProps,
  type VocabEntry,
} from "@/lib/study/api";
import {
  buildStudySessionQueue,
  UNCAPPED_DAILY_LIMITS,
  useStudyConfig,
} from "@/lib/study-config";
import { gradeIntervalHints } from "@/lib/fsrs";
import {
  BlurReveal,
  FSRS_INTERVAL_HINTS,
  GradeKeyChips,
  GradeRow,
  KeyChip,
  NotesDrawer,
  SideRail,
  YesNoGate,
} from "@/lib/study/card-chrome";
import { useProviderConfigs } from "@/lib/provider-context";
import { useTTS } from "@/lib/tts-context";
import { PrestartShell } from "@/lib/study/prestart";
import { cn } from "@/lib/utils";
import { HOSTED } from "@/lib/build-flags";

// How far ahead a card is re-inserted when it needs to come back later
// in the same session. "Again" grades retry soon; a freshly-introduced
// new card waits longer so its first recall check isn't a freebie taken
// seconds after reading the answer.
const AGAIN_REQUEUE_AHEAD = 5;
const NEW_INTRO_REQUEUE_AHEAD = 10;

const vocabRecall: StudyPlugin = {
  meta: {
    id: "vocab-recall",
    name: "Vocab recall",
    description:
      "Two-step recognition: see the word, recall the meaning, reveal to check.",
    icon: Sparkles,
    // Universal — works for every language. Picked as the default for CJK
    // workspaces (zh/ja/ko) by the language-aware defaults in study-config.
  },
  StudyView,
  Settings: VocabRecallSettings,
};

export default vocabRecall;

function StudyView({ ctx }: StudyViewProps) {
  const { config } = useStudyConfig(ctx.workspace.id, ctx.workspace.targetLang);
  const tts = useTTS();
  const { active: provider, sendChat } = useProviderConfigs();
  // Per-card override map for `cardNotes` — set when the user generates a new
  // example so the UI updates without waiting for a refetch.
  const [cardNotesOverride, setCardNotesOverride] = useState<Record<number, string>>({});

  const initialQueue = useMemo(() => {
    // Build the FULL ready pool — uncapped. The prestart picker below is
    // the user's explicit batch control (they choose 20 / 50 / All every
    // session), so a daily cap shouldn't ceiling it here: capping first
    // meant a 50-card backlog clipped to `dailyNewLimit` (default 20)
    // could only ever offer "All 20", never a real "All vs 20" choice.
    // The pool is already bounded by the study-pool fetch (`listStudyVocab`,
    // ≤500 active cards), so "All" stays sane. Custom-scope crams were
    // uncapped before this too. The dashboard's "due today" badge keeps
    // the daily-paced count.
    return buildStudySessionQueue(ctx.dueVocab, ctx.vocab, UNCAPPED_DAILY_LIMITS);
  }, [ctx.dueVocab, ctx.vocab]);

  // Per-session size override. `null` means "haven't picked yet" — we
  // always show the prestart picker so the user can decide whether to
  // drill without SRS *before* a single grade flows. The picked value
  // is just sliced off the front of `initialQueue`, so it's a one-time
  // choice that doesn't persist to settings.
  const [sessionSize, setSessionSize] = useState<number | null>(null);
  // The slice-of-the-front the user committed to. Recomputed when
  // the picker resolves OR when initialQueue changes (rare — only on
  // workspace switch).
  const sessionStartingQueue = useMemo(() => {
    if (sessionSize == null) return initialQueue;
    return initialQueue.slice(0, sessionSize);
  }, [initialQueue, sessionSize]);

  const [queue, setQueue] = useState<VocabEntry[]>(sessionStartingQueue);
  // Once the user picks a session size, replace the live queue with
  // that slice. We only do this the first time sessionSize transitions
  // from null → number; subsequent grades / boosts keep mutating
  // `queue` directly.
  useEffect(() => {
    if (sessionSize == null) return;
    setQueue(sessionStartingQueue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionSize]);
  const [idx, setIdx] = useState(0);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [grades, setGrades] = useState({ again: 0, hard: 0, good: 0, easy: 0 });
  // Per-card breakdown for the session summary. Stored in grading order
  // so the summary screen can show "what you studied" verbatim. We dedupe
  // by word at summary time — a card graded Again then Good shows only
  // its final grade so the user isn't confused by the same word twice.
  const [reviewedCards, setReviewedCards] = useState<ReviewedCardSummary[]>([]);
  const startedAt = useMemo(() => Math.floor(Date.now() / 1000), []);

  // Optional production-direction round after the recall queue is
  // exhausted. Same words reversed: gloss prompt, recall the word.
  // Doesn't affect FSRS — it's pure self-directed practice — so the
  // user can skip straight to the summary if they don't want it.
  // Phase progression:
  //   "recall"     — the standard SRS round (default).
  //   "promptProd" — recall queue empty, asking "want production too?"
  //   "production" — running the gloss → word round.
  //   "doneFinal"  — production skipped or finished, show summary.
  type Phase = "recall" | "promptProd" | "production" | "doneFinal";
  const [phase, setPhase] = useState<Phase>("recall");
  // Cards for the production round = the recall round's reviewed
  // words, looked up against the full workspace vocab pool so the
  // production round has the example sentences, audio cache, and
  // image data the summary tuple doesn't carry. Deduped by id with
  // the *first* graded entry winning (recall order preserved).
  const productionCards = useMemo(() => {
    const seen = new Set<number>();
    const out: VocabEntry[] = [];
    for (const reviewed of reviewedCards) {
      const full = ctx.vocab.find((v) => v.word === reviewed.word);
      if (!full) continue;
      if (seen.has(full.id)) continue;
      seen.add(full.id);
      out.push(full);
    }
    return out;
  }, [reviewedCards, ctx.vocab]);

  // Side panels: only one takes the right edge at a time. Pause is a separate
  // fullscreen overlay so the user can step away without losing card state.
  const [paused, setPaused] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  // Pending Block confirmation. Lives up here with the other useStates
  // so it sits above any early-return path — moving an early return
  // above a useState would change the hook count between renders and
  // crash with "Rendered more hooks than during the previous render."
  const [pendingBlock, setPendingBlock] = useState<VocabEntry | null>(null);
  const openPanel = (which: "notes" | "ai" | null) => {
    setNotesOpen(which === "notes");
    setAiOpen(which === "ai");
  };
  const anyPanelOpen = notesOpen || aiOpen;

  // Pause-aware elapsed time. The session context owns the canonical
  // clock (we drive ctx.pauseSession / resumeSession below so the
  // sidebar clock + idle timer freeze), and we mirror the paused spans
  // locally so the summary + overlay show *active* study time, never the
  // seconds spent sitting on the pause screen.
  const pausedMsRef = useRef(0);
  const pauseStartRef = useRef<number | null>(null);
  function elapsedActiveSecs() {
    const pausedNow =
      pauseStartRef.current != null ? Date.now() - pauseStartRef.current : 0;
    const ms = Date.now() - startedAt * 1000 - pausedMsRef.current - pausedNow;
    return Math.max(0, Math.floor(ms / 1000));
  }
  function doPause() {
    if (paused) return;
    pauseStartRef.current = Date.now();
    setPaused(true);
    ctx.pauseSession();
  }
  function doResume() {
    if (!paused) return;
    if (pauseStartRef.current != null) {
      pausedMsRef.current += Date.now() - pauseStartRef.current;
      pauseStartRef.current = null;
    }
    setPaused(false);
    ctx.resumeSession();
  }

  // Languages with a separate phonetic reading get the two-step flow
  // (recall the pronunciation, then the meaning).
  const isTwoQuestionLang =
    ctx.workspace.targetLang === "zh" ||
    ctx.workspace.targetLang === "ja" ||
    ctx.workspace.targetLang === "ko";
  // "Pinyin mode" — a persisted, per-session prestart toggle that
  // collapses the two-step CJK flow into one: the reading is shown up
  // front (see `readingHidden` below) and the user only self-checks the
  // meaning, skipping the "do you know the pronunciation?" gate. Off by
  // default, so the standard two-step flow is left exactly as it was.
  // Read-only here — "Pinyin / Furigana / Reading mode" is now set from
  // Settings → Study → Vocab recall (see VocabRecallSettings), not a
  // per-session prestart toggle. The persisted value still drives the
  // flow below.
  const [pinyinMode] = usePluginSetting<boolean>(
    vocabRecall.meta.id,
    "pinyinMode",
    false,
  );
  // CJK uses two stages (pronunciation, then meaning). Latin scripts —
  // and any CJK session with Pinyin mode on — collapse them since the
  // reading is already on screen.
  //   "word" → pronunciation gate → "reading" → meaning gate → "graded"
  //   "graded" → Again/Hard/Good/Easy
  // Yes/No answers bias the suggested grade highlight.
  const useTwoQuestions = isTwoQuestionLang && !pinyinMode;
  type Stage = "word" | "reading" | "graded";
  const initialStage: Stage = "word";
  const [stage, setStage] = useState<Stage>(initialStage);
  const [knewPronunciation, setKnewPronunciation] = useState<boolean | null>(null);
  const [knewMeaning, setKnewMeaning] = useState<boolean | null>(null);

  function resetStages() {
    setStage(initialStage);
    setKnewPronunciation(null);
    setKnewMeaning(null);
  }

  // Keep the session alive while studying — but never fight a manual
  // pause. `ctx` is rebuilt as the session clock ticks; re-running
  // ensureSessionStarted on each rebuild is what keeps the 5-minute
  // idle-timeout from firing on an actively-open study screen (e.g.
  // while the user reads the AI panel). The `paused` guard is the fix:
  // without it, the rebuild that happens the instant we pause would call
  // ensureSessionStarted, which auto-resumes a paused session — so the
  // pause (and the frozen clock) wouldn't stick.
  useEffect(() => {
    if (paused) return;
    void ctx.ensureSessionStarted("review");
  }, [ctx, paused]);

  const card = queue[idx];

  // First-time presentation ("study before the quiz"). A card that has
  // never been graded (lastReview == null — fresh from the chat tool,
  // the popover, an import) opens fully revealed — reading, meaning,
  // audio — with a single "Got it" instead of jumping straight to the
  // "do you know this?" gate, which is unanswerable for a word the
  // user has genuinely never seen. Dismissals are tracked per session
  // so an again-requeue doesn't re-present the same card.
  const [introducedIds, setIntroducedIds] = useState<Set<number>>(
    () => new Set(),
  );
  const introShowing =
    card != null &&
    stage === "word" &&
    card.lastReview == null &&
    !introducedIds.has(card.id);

  function dismissIntro() {
    if (!card) return;
    const introduced = card;
    setIntroducedIds((prev) => {
      const next = new Set(prev);
      next.add(introduced.id);
      return next;
    });
    // Don't quiz a word the instant after revealing it — recalling
    // something you read two seconds ago tests nothing. Re-insert the
    // card ~10 positions later so its first real recall check lands
    // after a spacing gap, then move on to the next card. It's marked
    // introduced above, so when it comes back it opens on the recall
    // gate, not the intro again.
    setQueue((prev) => {
      const next = [...prev];
      const insertAt = Math.min(prev.length, idx + NEW_INTRO_REQUEUE_AHEAD);
      next.splice(insertAt, 0, introduced);
      return next;
    });
    resetStages();
    setIdx((i) => i + 1);
  }

  // Lazy-load the card's image. List queries don't ship `image_data`
  // (the base64 blob is too big to pipe across Tauri's IPC bridge for
  // every card on every page mount), so we fetch it once per active
  // card. Cleared on card change so the next card doesn't briefly
  // flash the previous card's image.
  const [cardImage, setCardImage] = useState<string | null>(null);
  useEffect(() => {
    setCardImage(null);
    if (!card?.hasImage) return;
    let cancelled = false;
    void getVocabImage(card.id)
      .then((bytes) => {
        if (!cancelled) setCardImage(bytes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [card?.id, card?.hasImage]);

  // Suggested grade pre-highlights a button. Yes/Yes → Good; one No → Hard;
  // both No → Again. Easy is never auto-suggested.
  const suggestedGrade = ((): Grade => {
    if (useTwoQuestions) {
      if (knewPronunciation && knewMeaning) return "good";
      if (knewPronunciation === false && knewMeaning === false) return "again";
      if (knewPronunciation === false || knewMeaning === false) return "hard";
      return "good";
    }
    return knewMeaning === false ? "again" : "good";
  })();

  // Live answer-button labels: the real next interval each grade would
  // schedule for THIS card, computed from the same FSRS config the host
  // grades with. Replaces the old static guesses so "Hard" can't promise
  // ~1 day and then resurface in minutes (and a mature review card shows
  // its true multi-week interval, not a new card's).
  const intervalHints = useMemo(
    () => (card ? gradeIntervalHints(card, config.srs) : FSRS_INTERVAL_HINTS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [card?.id, card?.status, card?.stability, card?.lastReview, config.srs],
  );

  // Auto-play TTS the moment the pronunciation is revealed. Normally
  // that's the "reading" stage in CJK two-question mode (when the
  // pinyin first appears) and the "graded" stage everywhere else
  // (script is the reading, so first reveal is the answer card).
  // When the user answers No at the first CJK gate we skip "reading"
  // and jump straight to "graded" — fire there too so the "Done
  // studying" reveal still gets audio, otherwise the student never
  // hears the word for the cards they got wrong.
  useEffect(() => {
    // Don't autoplay until the session is actually running. While the
    // prestart picker is up (`sessionSize == null`) the first card's
    // state is already computed, so without this guard the word would
    // be spoken before the user has even started — and we stay quiet
    // behind the pause overlay too.
    if (sessionSize == null || paused) return;
    if (!card || !config.autoplayAudio) return;
    // First-time intro is a full reveal too — hearing the word during
    // the presentation is half the point of studying it first.
    const isReveal =
      introShowing ||
      (useTwoQuestions
        ? stage === "reading" ||
          (stage === "graded" && knewPronunciation === false)
        : stage === "graded");
    if (!isReveal) return;
    // Route through the TTS context (not speakRaw) so autoplay uses the
    // same provider-key fallback + BCP-47 lang as the manual speak
    // buttons; `silent` keeps it from toasting on every failing card.
    void tts.speak(card.word, ctx.workspace.targetLang, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, stage, config.autoplayAudio, useTwoQuestions, sessionSize]);

  function speakNow() {
    if (!card) return;
    void tts.speak(card.word, ctx.workspace.targetLang);
  }

  function speakSentenceNow() {
    if (!card) return;
    const noteSource =
      cardNotesOverride[card.id] ?? card.cardNotes ?? null;
    const examples = parseExamples(noteSource);
    const first = examples[0];
    if (!first?.target) return;
    void tts.speak(first.target, ctx.workspace.targetLang);
  }

  // Plugin-owned setting: show the small keyboard-hint footer at the
  // bottom-left of the card surface. Default ON for new users; the
  // toggle lives in Settings → Study → Vocab recall, persisted via
  // `usePluginSetting` so it survives reloads. Read here so the
  // StudyView can render the hint bar conditionally.
  const [showKeyboardHints] = usePluginSetting<boolean>(
    vocabRecall.meta.id,
    "showKeyboardHints",
    true,
  );

  // Keyboard shortcuts. Layered so power users can pick the input
  // device that fits their flow:
  //
  //   • Universal:
  //       Space   pause / resume
  //       Esc     close any open panel, or unpause
  //
  //   • Audio (always available when a card is loaded):
  //       ↑ / k   speak the headword
  //       ↓ / j   speak the first example sentence (if any)
  //
  //   • Yes/No gate stages:
  //       y / 1 / → / l   yes
  //       2     / ← / h   no   (capital N stays as the notes panel)
  //       Enter           default-positive (yes)
  //
  //   • Graded stage:
  //       1 / a   again
  //       2 / s   hard
  //       3 / d   good
  //       4 / f   easy
  //       Enter   suggested grade
  //
  //   • Always when no card-grading is on the wire:
  //       n   notes panel · a   AI panel
  //
  // Note that `a` is overloaded: in graded stage it's the Again grade,
  // outside graded it opens the AI panel. The user can always reach
  // AI via the side rail icon, so we lean on the more frequently-
  // used grading shortcut in the moment that matters.
  //
  // Ignored when typing into an input/textarea or when any side panel
  // is open — so the user can type a note or chat with the AI without
  // accidentally advancing the card.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLTextAreaElement) return;

      // Global session controls work even when no card is loaded.
      if (e.key === "Escape") {
        if (notesOpen || aiOpen) {
          e.preventDefault();
          openPanel(null);
          return;
        }
        if (paused) {
          e.preventDefault();
          doResume();
          return;
        }
      }
      // Space toggles pause — but only while a card is actually on
      // screen. Past the queue (production prompt / round / done
      // screens) the pause overlay can't render anyway, and a
      // window-level preventDefault here would swallow the Space
      // those screens' own handlers and Tab-focused buttons rely on.
      if (e.key === " " && card) {
        e.preventDefault();
        if (paused) doResume();
        else doPause();
        return;
      }

      // Card-side shortcuts only fire when no panel is open AND the
      // session isn't paused.
      if (paused || anyPanelOpen) return;
      if (!card) return;

      const k = e.key.toLowerCase();

      // Audio shortcuts — universal across stages so the user can
      // re-hear at any point during the recall flow.
      if (e.key === "ArrowUp" || k === "k") {
        e.preventDefault();
        speakNow();
        return;
      }
      if (e.key === "ArrowDown" || k === "j") {
        e.preventDefault();
        speakSentenceNow();
        return;
      }

      // Graded stage takes priority — `a` here is Again, not AI.
      if (stage === "graded") {
        if (e.key === "Enter") {
          e.preventDefault();
          void grade(suggestedGrade);
          return;
        }
        const gradeMap: Record<string, Grade> = {
          "1": "again",
          "2": "hard",
          "3": "good",
          "4": "easy",
          a: "again",
          s: "hard",
          d: "good",
          f: "easy",
        };
        const g = gradeMap[e.key] ?? gradeMap[k];
        if (g) {
          e.preventDefault();
          void grade(g);
        }
        return;
      }

      // Outside graded — `n` opens notes, `a` opens AI.
      if (k === "n") {
        e.preventDefault();
        openPanel("notes");
        return;
      }
      if (k === "a") {
        e.preventDefault();
        openPanel("ai");
        return;
      }

      // First-time presentation: the advance family dismisses the intro,
      // which re-queues this new word for a recall check ~10 cards later
      // and moves on. No yes/no here — the answer is on screen, so a
      // self-assessment would be meaningless.
      if (introShowing) {
        if (e.key === "Enter" || e.key === "ArrowRight" || k === "l") {
          e.preventDefault();
          dismissIntro();
        }
        return;
      }

      // Y/N gate. Multiple shortcut families: y / 1 / → / l for yes,
      // 2 / ← / h for no (capital N is taken by the notes panel).
      const yes =
        k === "y" ||
        e.key === "1" ||
        e.key === "ArrowRight" ||
        k === "l";
      const no =
        e.key === "2" || e.key === "ArrowLeft" || k === "h";
      if (yes) {
        e.preventDefault();
        answerGate(true);
        return;
      }
      if (no) {
        e.preventDefault();
        answerGate(false);
        return;
      }
      if (e.key === "Enter") {
        // Default-positive: Enter advances as if you knew it.
        e.preventDefault();
        answerGate(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, stage, suggestedGrade, paused, notesOpen, aiOpen, introShowing]);

  if (initialQueue.length === 0) {
    return (
      <EmptyQueue
        restudy={ctx.restudyToday}
        onSessionEnd={() =>
          ctx.onSessionEnd({
            cardsReviewed: 0,
            durationSecs: elapsedActiveSecs(),
          })
        }
      />
    );
  }

  // Prestart picker — always blocks the recall round on the first
  // render so the user can (1) opt to grind a smaller batch without
  // first having to change settings, and (2) flip the drill-mode
  // toggle before any grade flows to FSRS.
  if (sessionSize == null) {
    return (
      <SessionSizePicker
        totalDue={initialQueue.length}
        drillMode={ctx.drillMode}
        setDrillMode={ctx.setDrillMode}
        srsAnchorState={ctx.srsAnchorState}
        onPick={(n) => setSessionSize(n)}
      />
    );
  }

  // Helper — every "we're done now" exit goes through this so the
  // host receives the same stats payload regardless of whether the
  // user finished the production round, skipped it, or never had
  // one offered (e.g. zero cards reviewed). Hoisted out of the
  // !card branch so the production-skip toggle in the top bar can
  // also call it (which it does indirectly via the early-return
  // logic below).
  const finishToSummary = () =>
    ctx.onSessionEnd({
      cardsReviewed: reviewedCount,
      durationSecs: elapsedActiveSecs(),
      grades,
      reviewedCards,
    });

  // Auto-finalize when the recall queue is exhausted AND there's
  // nothing else to show (no production round to offer, or it was
  // skipped). We do this via useEffect-style call inside an IIFE
  // because finishToSummary triggers ctx.onSessionEnd which unmounts
  // the plugin — calling it during render would warn but otherwise
  // behaves correctly. Wrapping in queueMicrotask defers the state
  // change one tick so React doesn't see "setState in render."
  if (!card) {
    const offerProduction =
      phase === "recall" && productionCards.length > 0;

    if (offerProduction) {
      return (
        <ProductionPrompt
          cardCount={productionCards.length}
          onStart={() => setPhase("production")}
          onSkip={finishToSummary}
        />
      );
    }
    if (phase === "production") {
      return (
        <ProductionRound
          cards={productionCards}
          targetLang={ctx.workspace.targetLang}
          autoplayAudio={config.autoplayAudio}
          onLeave={finishToSummary}
        />
      );
    }
    // Recall round ended with zero reviewed cards. Nothing to show
    // in production either — go straight to the summary. queueMicrotask
    // defers the state-update to the next microtask so React doesn't
    // yell about setState-during-render.
    queueMicrotask(() => finishToSummary());
    return <FinalizingPlaceholder />;
  }

  // On No we still walk to `graded` so the user sees the full answer before
  // the card requeues; the "Done — next" button records the failure.
  function answerGate(yes: boolean) {
    if (stage === "word") {
      if (useTwoQuestions) {
        if (!yes) {
          setKnewPronunciation(false);
          // CJK first-gate No: we still don't know whether they
          // know the meaning, but jumping straight to the
          // reveal+done flow is the requested UX. Mark the meaning
          // as also-unknown so suggestedGrade lands on "again".
          setKnewMeaning(false);
          setStage("graded");
          return;
        }
        setKnewPronunciation(yes);
        setStage("reading");
      } else {
        // Non-CJK: there's no separate reading stage; the word stage's
        // Yes/No is about the meaning. Skip straight to graded.
        setKnewMeaning(yes);
        setStage("graded");
      }
      return;
    }
    if (stage === "reading") {
      setKnewMeaning(yes);
      setStage("graded");
    }
    // "graded" stage doesn't accept Yes/No — the user picks a real grade.
  }

  // True when at least one gate answered No — drives a streamlined
  // post-reveal UI with a single "Done" button instead of the four grades.
  const cameFromNo =
    knewPronunciation === false || knewMeaning === false;

  async function grade(g: Grade) {
    if (!card) return;
    await ctx.reviewVocab(card.id, g);
    void ctx.bump("words_seen");
    setGrades((p) => ({ ...p, [g]: p[g] + 1 }));
    setReviewedCount((n) => n + 1);
    setReviewedCards((prev) => [
      ...prev,
      {
        word: card.word,
        reading: card.reading,
        gloss: card.gloss,
        grade: g,
      },
    ]);
    // Again cards re-surface a few positions later in the session.
    if (g === "again") {
      setQueue((prev) => {
        const next = [...prev];
        const insertAt = Math.min(prev.length, idx + AGAIN_REQUEUE_AHEAD);
        next.splice(insertAt, 0, card);
        return next;
      });
    }
    resetStages();
    setIdx((i) => i + 1);
  }

  // Top-bar judgements that bypass the grading flow:
  //   Known — mark mastered, advance.
  //   Boost — mark again and re-insert 5 positions ahead.
  //   Block — delete outright (gated by AlertDialog).
  async function actionKnown() {
    if (!card) return;
    await ctx.setStatus(card.id, "mastered");
    setReviewedCount((n) => n + 1);
    setReviewedCards((prev) => [
      ...prev,
      { word: card.word, reading: card.reading, gloss: card.gloss, grade: "easy" },
    ]);
    resetStages();
    setIdx((i) => i + 1);
    toast.success(`Marked "${card.word}" as known`);
  }

  async function actionBoost() {
    if (!card) return;
    await ctx.reviewVocab(card.id, "again");
    setGrades((p) => ({ ...p, again: p.again + 1 }));
    setReviewedCount((n) => n + 1);
    setReviewedCards((prev) => [
      ...prev,
      { word: card.word, reading: card.reading, gloss: card.gloss, grade: "again" },
    ]);
    // Re-insert this card a few positions ahead so it surfaces again
    // mid-session. If the queue is shorter than that we just append.
    setQueue((prev) => {
      const next = [...prev];
      const insertAt = Math.min(prev.length, idx + AGAIN_REQUEUE_AHEAD);
      next.splice(insertAt, 0, card);
      return next;
    });
    resetStages();
    setIdx((i) => i + 1);
    toast.success(`Boosted "${card.word}" — coming back soon`);
  }

  async function actionBlockConfirmed(target: VocabEntry) {
    await deleteVocab(target.id);
    // Drop the card from the live queue so it never surfaces again this
    // session. We keep idx pointing at the same position — splice causes
    // the next card to slide into place.
    setQueue((prev) => prev.filter((v) => v.id !== target.id));
    resetStages();
    toast(`Blocked "${target.word}"`);
  }

  // Whether the reading is shown right away. The CJK default is "hidden"
  // (drill the reading along with the meaning); other langs default to
  // "shown" since the script + reading are the same thing. Pinyin mode
  // forces it shown — surfacing the reading up front is the whole point.
  const readingHidden = config.readingMode === "hidden" && !pinyinMode;

  return (
    <>
      <TopActionBar
        progress={(idx / Math.max(1, queue.length)) * 100}
        idx={idx}
        total={queue.length}
        onKnown={() => void actionKnown()}
        onBoost={() => void actionBoost()}
        onBlock={() => setPendingBlock(card)}
        onPause={doPause}
      />
      <div
        className={cn(
          "flex flex-1 px-6 py-6",
          // Hosted/tablet: make the card area a scrollable column so a tall
          // card (long examples + grade buttons) is fully reachable on a
          // short touch viewport; `my-auto` on the card below still centers
          // it when it fits. Desktop is untouched — HOSTED is dead-stripped,
          // so it keeps the original centered, non-scrolling layout.
          HOSTED
            ? "min-h-0 flex-col items-center overflow-y-auto"
            : "items-center justify-center",
        )}
      >
        <div className={cn("relative w-full max-w-xl", HOSTED && "my-auto")}>
          {/* Card. Reveal happens in stages — the body widens as we go.
              On non-CJK languages we skip the "reading" stage since the
              script is the reading. */}
          <div className="relative block w-full rounded-2xl border border-border bg-card px-6 py-10 text-center shadow-sm">
            {/* Manual speaker icon — always visible, never auto-fires.
                Sits in the top-right of the card so it's reachable
                without disturbing the focal headword. */}
            <button
              type="button"
              onClick={speakNow}
              className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Play pronunciation"
              title="Play pronunciation"
            >
              <Volume2 className="size-4" />
            </button>
            {cardImage && (
              <img
                src={cardImage}
                alt=""
                className="mx-auto mb-5 max-h-40 rounded-md object-contain"
              />
            )}
            <div className="font-serif text-7xl tracking-tight leading-none">
              {card.word}
            </div>

            {/* Reading: shown immediately when readingMode='shown', when
                we advanced past the "word" stage, or during a first-time
                intro (the whole card is the lesson there). CJK +
                readingMode=hidden gates it behind the first Yes/No
                question otherwise. */}
            {card.reading &&
              (introShowing || !readingHidden || stage !== "word") && (
              <div className="mt-4">
                <Pinyin raw={card.reading} className="text-lg" />
              </div>
            )}

            {/* Meaning + extras: shown at the "graded" stage and during
                the first-time intro reveal. */}
            {(stage === "graded" || introShowing) && (
              <div className="mt-6 space-y-3 border-t border-border/60 pt-5">
                {card.gloss && (
                  <p className="text-[15px] leading-relaxed text-foreground/90">
                    {card.gloss.split(/;\s+/).slice(0, 4).join(" · ")}
                  </p>
                )}
                {config.showExamples && (
                  <ExampleSection
                    card={card}
                    notesOverride={cardNotesOverride[card.id] ?? card.cardNotes}
                    workspaceId={ctx.workspace.id}
                    targetLang={ctx.workspace.targetLang}
                    nativeLang={ctx.workspace.nativeLang}
                    provider={provider}
                    sendChat={sendChat}
                    onNotesChange={(notes) =>
                      setCardNotesOverride((prev) => ({ ...prev, [card.id]: notes }))
                    }
                  />
                )}
                <div className="flex justify-center">
                  <SpeakButton
                    text={card.word}
                    lang={ctx.workspace.targetLang}
                    size="sm"
                    vocabId={card.id}
                    cachedAudioAvailable={card.hasAudio}
                  />
                </div>
              </div>
            )}
          </div>

          {/* First-time intro controls — replace the gate until the
              user has actually studied the card once. */}
          {introShowing && (
            <div className="mt-5 flex flex-col items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-2.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-sky-700 dark:text-sky-400">
                <Sparkles className="size-3" />
                New word — study it first
              </span>
              <Button
                size="lg"
                onClick={dismissIntro}
                className="rounded-full px-8"
              >
                Got it — next card
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                Take in the reading, meaning, and audio · we&apos;ll quiz
                your recall a few cards from now · Enter / →
              </p>
            </div>
          )}

          {/* Stage controls. CJK: word→Yes/No (pronunciation) →
              reading→Yes/No (meaning) → graded. Non-CJK: word→Yes/No
              (meaning) → graded. */}
          {stage === "word" && !introShowing && (
            <YesNoGate
              question={
                useTwoQuestions
                  ? "Do you know how this word is pronounced?"
                  : "Do you know what this word means?"
              }
              onYes={() => answerGate(true)}
              onNo={() => answerGate(false)}
              hint={`yes: → / l / y / 1   ·   no: ← / h / 2   ·   status: ${card.status}`}
            />
          )}
          {stage === "reading" && (
            <YesNoGate
              question="Do you know what it means?"
              onYes={() => answerGate(true)}
              onNo={() => answerGate(false)}
              hint="yes: → / l / y / 1   ·   no: ← / h / 2"
            />
          )}

          {stage === "graded" && cameFromNo && (
            // "I said No" path — the reveal panel above already
            // shows the full answer (reading + meaning). One big
            // "Done — next card" button records the lapse as
            // again-grade and advances. No four-button grade
            // picker here: when the user has already said they
            // didn't know it, surfacing Hard / Good / Easy is just
            // friction. The user can always upgrade to Hard via the
            // separate keyboard shortcut (`2`) if they realised
            // post-reveal that they actually did remember.
            <div className="mt-5 flex flex-col items-center gap-2">
              <Button
                size="lg"
                onClick={() => void grade("again")}
                className="rounded-full px-8"
              >
                Done studying — next card
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                Marks the card as <em>again</em> so it surfaces a few
                cards later · 2 / 3 / 4 to upgrade to Hard / Good /
                Easy if you actually knew it
              </p>
            </div>
          )}
          {stage === "graded" && !cameFromNo && (
            <>
              <GradeRow
                className="mt-5"
                onGrade={(g) => void grade(g)}
                suggested={suggestedGrade}
                hints={intervalHints}
              />
              <p className="mt-3 text-center text-[11px] text-muted-foreground">
                Enter accepts the suggested grade · 1 / 2 / 3 / 4 to grade
                {config.autoplayAudio && (
                  <>
                    {" · "}
                    <Volume2 className="inline size-3" /> auto-play on reveal
                  </>
                )}
              </p>
            </>
          )}
        </div>

      </div>

      {/* ── Floating action rail (right edge) ────────────────────────────
          A trim column of icon buttons for adjuncts to the card flow:
          play audio, ask the AI, take notes. Pause and the destructive
          card actions live in the top bar — those are decisions about
          the queue, not about the card body. */}
      <SideRail
        onSpeak={speakNow}
        onNotes={() => openPanel("notes")}
        onAi={() => openPanel("ai")}
        notesOpen={notesOpen}
        aiOpen={aiOpen}
        notesShortcut="N"
        aiShortcut="A"
      />

      {/* ── Keyboard hint footer (bottom-left) ────────────────────────────
          Subtle reminder of the contextual shortcuts. Toggleable via the
          plugin's own setting (Settings → Study → Vocab recall). Hidden
          completely when the user opts out so it doesn't clutter the
          minimal study surface. */}
      {/* Hidden during the first-time intro — its yes/no chips would
          point at a gate that isn't on screen yet. */}
      {showKeyboardHints && !introShowing && <KeyboardHintBar stage={stage} />}

      {/* Block confirmation — destructive enough to warrant a stop.
          Wired through pendingBlock so the dialog stays mounted across
          card changes without flickering open/closed. */}
      <AlertDialog
        open={pendingBlock != null}
        onOpenChange={(open) => {
          if (!open) setPendingBlock(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Block &ldquo;{pendingBlock?.word}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the card from your vocabulary. It won&rsquo;t
              surface in study sessions again. You can re-add it later
              via the Browse tab if you change your mind.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const target = pendingBlock;
                setPendingBlock(null);
                if (target) await actionBlockConfirmed(target);
              }}
            >
              Block
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Notes drawer ──
          Slide-in from the right; saves to vocab_entries.card_notes via
          updateVocabFields. We keep the existing card.cardNotes shape
          (which the reference rail also reads) so notes typed here show
          up in the rail next session. The drawer pauses card-grading
          shortcuts via anyPanelOpen so typing inside it doesn't advance
          the queue. */}
      <NotesDrawer
        open={notesOpen}
        card={card}
        onClose={() => openPanel(null)}
        onSaved={(updated) => {
          setQueue((prev) => prev.map((v) => (v.id === updated.id ? updated : v)));
        }}
      />

      {/* ── AI drawer ──
          Streaming chat with the user's active provider. Auto-injects the
          current card as system context so questions are answered in
          situ. Has a fullscreen toggle for deeper conversations and is
          dismissable with Escape. */}
      <StudyAiDrawer
        open={aiOpen}
        card={card}
        targetLang={ctx.workspace.targetLang}
        nativeLang={ctx.workspace.nativeLang}
        onClose={() => openPanel(null)}
      />

      {/* ── Pause overlay ──
          Fullscreen take-a-break screen. Doesn't affect the queue — the
          current card is untouched and resumes where it left off. End
          Session ships the partial stats to the host so the summary
          screen still gets accurate numbers. */}
      {paused && (
        <PauseOverlay
          progress={(idx / Math.max(1, queue.length)) * 100}
          reviewedCount={reviewedCount}
          total={queue.length}
          grades={grades}
          activeSecs={elapsedActiveSecs()}
          onResume={doResume}
          onEnd={() =>
            ctx.onSessionEnd({
              cardsReviewed: reviewedCount,
              durationSecs: elapsedActiveSecs(),
              grades,
              reviewedCards,
            })
          }
        />
      )}
    </>
  );
}


// Shown on the answer card. Pulls saved sentences from `card.cardNotes`
// (TOKORI_EXAMPLES_V1 prefix); generated examples are persisted there too so
// they also surface on the dictionary detail page.
function ExampleSection({
  card,
  notesOverride,
  workspaceId,
  targetLang,
  nativeLang,
  provider,
  sendChat,
  onNotesChange,
}: {
  card: VocabEntry;
  notesOverride: string | null | undefined;
  workspaceId: number;
  targetLang: string;
  nativeLang: string;
  provider: ReturnType<typeof useProviderConfigs>["active"];
  sendChat: ReturnType<typeof useProviderConfigs>["sendChat"];
  onNotesChange: (next: string) => void;
}) {
  const examples = useMemo<ExampleSentence[]>(
    () => parseExamples(notesOverride ?? null),
    [notesOverride],
  );
  // The notes blob may be plain free-text (older cards) — preserve it
  // alongside the structured examples so the user doesn't lose
  // anything they handwrote.
  const legacyNote = useMemo(() => {
    const raw = (notesOverride ?? "").trim();
    if (!raw || raw.startsWith("TOKORI_EXAMPLES_V1")) return "";
    return raw;
  }, [notesOverride]);
  const [pickedIdx, setPickedIdx] = useState<number>(-1);
  const [busy, setBusy] = useState(false);
  // Generation mode — three-way toggle to mirror sentence-mining's
  // setup screen:
  //   - "k"     : strict — only known vocab + target. Pure
  //               comprehensible input with the target as the sole
  //               new element.
  //   - "k+1"   : Krashen sweet spot — known vocab + target + ~1
  //               additional new high-frequency word. Default.
  //   - "plain" : no vocab gating, intermediate prose.
  // Held per session in local state — the user usually wants the
  // same mode card-to-card and persisting this would be invisible
  // global state.
  const [aiMode, setAiMode] = useState<"k" | "k+1" | "plain">("k+1");

  // Re-roll the picked example whenever the card or example list
  // changes. This keeps the same sentence stable across re-renders of
  // a single card but rotates between cards / after a generate.
  useEffect(() => {
    if (examples.length === 0) {
      setPickedIdx(-1);
      return;
    }
    setPickedIdx(Math.floor(Math.random() * examples.length));
  }, [card.id, examples.length]);

  const example = pickedIdx >= 0 && pickedIdx < examples.length ? examples[pickedIdx] : null;

  function shuffle() {
    if (examples.length < 2) return;
    let next = pickedIdx;
    while (next === pickedIdx) next = Math.floor(Math.random() * examples.length);
    setPickedIdx(next);
  }

  async function generate() {
    if (!provider) {
      toast.error("Configure a provider in Settings → Providers to generate examples.");
      return;
    }
    setBusy(true);
    try {
      const target = languageName(targetLang as LanguageCode);
      const native = languageName(nativeLang as LanguageCode);
      // Output shape — accept either a single object or an array of
      // one. The parser normalises both, so allowing both in the
      // prompt cuts down on "couldn't parse" errors from models that
      // ignore the array wrapping.
      const jsonShape = `{"target":"<sentence in ${target}>","native":"<translation in ${native}>"}`;
      const outputDirective = `Output ONLY one JSON object of shape ${jsonShape} (or an array containing exactly that object). No code fences, no preamble, no <think> blocks.`;
      let systemPrompt: string;
      if (aiMode === "plain") {
        systemPrompt =
          `You're a ${target} tutor. Write ONE short example sentence that uses the word "${card.word}" naturally. ` +
          `Intermediate-level, concrete and everyday. ${outputDirective}`;
      } else {
        // k or k+1 — both reference the workspace's known vocab. The
        // difference is whether one extra unknown word is allowed
        // alongside the target. Strict (k) is the cleanest cloze drill
        // (target is the only new element); k+1 trades a touch of
        // strictness for naturalness.
        const allowOneNew = aiMode === "k+1";
        const vocab = await listVocab(workspaceId, 1500).catch(
          () => [] as VocabEntry[],
        );
        const mastered = vocab
          .filter((v) => v.status === "mastered")
          .slice(0, 200)
          .map((v) => v.word);
        const learning = vocab
          .filter((v) => v.status === "learning" || v.status === "review")
          .slice(0, 80)
          .map((v) => v.word);
        const lines: string[] = [
          `You're a ${target} tutor. Write ONE short example sentence using the word "${card.word}".`,
          allowOneNew
            ? `Krashen-style "i+1": every other content word should come from the KNOWN list, with at most ONE additional high-frequency new word allowed if its meaning is inferable from context.`
            : `Strict comprehensible input ("k"): every other content word MUST come from the KNOWN list. The target word "${card.word}" should be the ONLY new element in the sentence.`,
          ``,
          `## RULES`,
          `- The sentence MUST contain "${card.word}" verbatim (no conjugation/alteration unless ${target} grammar requires it).`,
          allowOneNew
            ? `- Up to 1 high-frequency new word is OK in addition to the target.`
            : `- No new words other than the target.`,
          `- Function words — particles, pronouns, articles, prepositions, common copulas, measure words — are always allowed.`,
          `- Concrete, everyday situations. 8–18 words.`,
          `- ${outputDirective}`,
        ];
        if (mastered.length > 0) lines.push("", `### KNOWN (mastered)`, mastered.join("、"));
        if (learning.length > 0) lines.push("", `### LEARNING`, learning.join("、"));
        if (mastered.length === 0 && learning.length === 0) {
          lines.push(
            "",
            `### NOTE`,
            `No saved vocab yet — use absolute-beginner (A1) words around "${card.word}".`,
          );
        }
        systemPrompt = lines.join("\n");
      }
      const reply = await sendChat({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: card.word },
        ],
        onToken: () => {},
      });
      const parsed = tryParseJsonArray(reply);
      if (!parsed || parsed.length === 0 || !parsed[0]?.target) {
        // Surface a snippet so the user can tell whether the model
        // refused, returned malformed JSON, or hit a content filter.
        const snippet = reply.slice(0, 160).replace(/\s+/g, " ").trim();
        toast.error("Couldn't parse the AI's response", {
          description: snippet || "(empty reply)",
        });
        return;
      }
      const fresh: ExampleSentence = {
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2),
        target: String(parsed[0].target),
        native: String(parsed[0].native ?? ""),
        source: "ai",
      };
      const next = [...examples, fresh];
      const serialised = serialiseExamples(next);
      onNotesChange(serialised);
      // Persist in the background — don't make the user wait. If it
      // fails the in-memory override still shows the new sentence; the
      // worst case is the next card refresh loses it.
      void updateVocabFields({ id: card.id, cardNotes: serialised }).catch(() => {});
      // Surface the new one immediately.
      setPickedIdx(next.length - 1);
    } catch (err) {
      toast.error("Generation failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 text-left">
      {example ? (
        <div className="rounded-lg border border-border/50 bg-card/40 px-3 py-2">
          <div className="text-[13px] leading-relaxed">
            <Tokenized text={example.target} lang={targetLang as LanguageCode} />
          </div>
          {example.native && (
            <div className="mt-1.5 text-[11.5px] text-muted-foreground">
              {/* Local-only blur — the answer card is a moment of
                  self-testing, so the translation always starts hidden
                  regardless of the global `showTranslations` toggle.
                  Keyed on the example id so a freshly-generated
                  sentence resets to blurred even if the prior one was
                  revealed mid-card. */}
              <BlurReveal
                key={example.id}
                text={example.native}
                hiddenTitle="Click to reveal translation"
              />
            </div>
          )}
        </div>
      ) : (
        <p className="text-[11.5px] text-muted-foreground">
          No example sentences yet. Generate one to start.
        </p>
      )}
      {legacyNote && (
        <p className="whitespace-pre-line text-[11.5px] leading-relaxed text-muted-foreground/80">
          {legacyNote}
        </p>
      )}
      <div className="flex items-center justify-center gap-1.5">
        {examples.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={shuffle}
            className="h-7 px-2 text-[11px]"
            title="Show a different saved example"
          >
            <RotateCcw className="size-3" />
            Another
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={generate}
          disabled={busy || !provider}
          className="h-7 px-2 text-[11px]"
          title={
            !provider
              ? "Configure a provider in Settings → Providers"
              : aiMode === "k"
                ? "Generate using ONLY words you already know"
                : aiMode === "k+1"
                  ? "Generate using your known vocab + ~1 new word"
                  : "Generate without vocab gating (intermediate prose)"
          }
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
          Generate
        </Button>
        {/* Three-way segmented control. Same difficulty axis the
            sentence-mining setup screen exposes, just inline + tiny
            since the answer card has no room for descriptions. */}
        <div className="flex items-center gap-0 rounded-md border border-border/60 p-0.5">
          {(["k", "k+1", "plain"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setAiMode(m)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors",
                aiMode === m
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              title={
                m === "k"
                  ? "k — strict, only words you know"
                  : m === "k+1"
                    ? "k+1 — your vocab + ~1 new word"
                    : "plain — no vocab gating"
              }
            >
              {m}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Robust parser for example-sentence replies. The previous version
// only accepted a JSON array — but reasoning-model providers wrap
// output in <think>…</think>, some chat models return a bare object
// rather than the requested `[{...}]`, and a few prepend natural-
// language preamble despite our "no preamble" instruction. We try, in
// order: strip thinking → drop code fences → look for an array → look
// for a bare object → return the first {target} we can find.
function tryParseJsonArray(raw: string): { target?: string; native?: string }[] | null {
  // Drop chain-of-thought first so its braces don't get matched as JSON.
  const reply = (() => {
    const m = raw.match(/<\/think>\s*/i);
    return m ? raw.slice(m.index! + m[0].length) : raw;
  })();
  const trimmed = reply
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  // 1. Array form — the requested shape.
  const arrStart = trimmed.indexOf("[");
  const arrEnd = trimmed.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* fall through to other shapes */
    }
  }

  // 2. Bare object form — model returned `{"target":...,"native":...}`
  //    instead of wrapping it in an array.
  const objStart = trimmed.indexOf("{");
  const objEnd = trimmed.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(objStart, objEnd + 1));
      if (parsed && typeof parsed === "object") {
        if (Array.isArray((parsed as { examples?: unknown }).examples)) {
          return (parsed as { examples: typeof parsed[] }).examples;
        }
        if (typeof (parsed as { target?: unknown }).target === "string") {
          return [parsed as { target: string; native?: string }];
        }
      }
    } catch {
      /* fall through to last-ditch */
    }
  }

  // 3. Last-ditch — `target` field somewhere as a JSON-string. Pulls
  //    the first {"target":"…","native":"…"} we can find. Handles
  //    models that emit multiple objects glued together without a
  //    surrounding array, or ones that drop a `,` somewhere.
  const fragment = trimmed.match(
    /\{\s*"target"\s*:\s*"([^"]+)"\s*(?:,\s*"native"\s*:\s*"([^"]*)")?\s*\}/,
  );
  if (fragment) {
    return [{ target: fragment[1], native: fragment[2] }];
  }

  return null;
}

function EmptyQueue({
  onSessionEnd,
  restudy,
}: {
  onSessionEnd: () => void;
  /** Host-provided "study today's cards again" offer (see
   *  `StudyContext.restudyToday`). Non-null when today's pass is done
   *  and there's a reviewed pool to re-run as a drill. */
  restudy: { count: number; start: () => void } | null;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ScrollText className="size-5" />
      </div>
      <h2 className="font-serif text-2xl tracking-tight">All caught up.</h2>
      <p className="max-w-md text-[13.5px] text-muted-foreground">
        Nothing due right now and no new cards are queued. Save more words
        from chat or the reader, then come back.
      </p>
      {restudy && (
        <>
          <Button onClick={restudy.start}>
            <RotateCcw className="size-4" />
            Study today&apos;s {restudy.count} card
            {restudy.count === 1 ? "" : "s"} again
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Re-runs everything you reviewed today — drill mode, no SRS
            impact.
          </p>
        </>
      )}
      <Button variant="ghost" size="sm" onClick={onSessionEnd}>
        Leave session
      </Button>
    </div>
  );
}

// What the workspace's target language calls its phonetic reading —
// labels the Pinyin-mode toggle (zh → Pinyin, ja → Furigana, else
// Reading). `noun` is the lowercase sentence form used in the copy.
function readingLabel(lang: string): { title: string; noun: string } {
  if (lang === "zh") return { title: "Pinyin", noun: "pinyin" };
  if (lang === "ja") return { title: "Furigana", noun: "furigana" };
  return { title: "Reading", noun: "the reading" };
}

function SessionSizePicker({
  totalDue,
  drillMode,
  setDrillMode,
  srsAnchorState,
  onPick,
}: {
  totalDue: number;
  drillMode: boolean;
  setDrillMode: (next: boolean) => void;
  srsAnchorState: "unknown" | "free" | "alreadyAnchored";
  onPick: (n: number) => void;
}) {
  const presets: number[] = [];
  if (totalDue > 20) presets.push(20);
  if (totalDue > 50) presets.push(50);
  if (totalDue === 0) {
    return (
      <PrestartShell
        icon={Sparkles}
        pluginName="Vocab recall"
        title="All caught up."
        description="No cards are ready right now. Save more vocab from chat or the reader, or come back when the FSRS intervals roll around."
        drillMode={drillMode}
        setDrillMode={setDrillMode}
        srsAnchorState={srsAnchorState}
      />
    );
  }
  return (
    <PrestartShell
      icon={Sparkles}
      pluginName="Vocab recall"
      title={`${totalDue} cards ready.`}
      description="Pick how many you want to review now. Reviews come first, then new cards — so a smaller batch still gives priority to what's actually due."
      drillMode={drillMode}
      setDrillMode={setDrillMode}
      srsAnchorState={srsAnchorState}
    >
      <div className="flex flex-wrap items-center justify-center gap-2">
        {presets.map((n) => (
          <Button
            key={n}
            variant="outline"
            size="lg"
            onClick={() => onPick(n)}
            className="min-w-[110px]"
          >
            {n} cards
          </Button>
        ))}
        <Button size="lg" onClick={() => onPick(totalDue)} className="min-w-[110px]">
          All {totalDue}
        </Button>
      </div>
      <p className="text-center text-[11px] text-muted-foreground">
        Your daily pace lives under Settings → Study — it drives the
        dashboard&apos;s “due today” count. Here you can clear the whole
        backlog or just a batch.
      </p>
    </PrestartShell>
  );
}

function FinalizingPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      Wrapping up…
    </div>
  );
}

// Bridge screen between recall and the optional production round. Production
// is self-directed practice and doesn't affect FSRS.
function ProductionPrompt({
  cardCount,
  onStart,
  onSkip,
}: {
  cardCount: number;
  onStart: () => void;
  onSkip: () => void;
}) {
  // Keyboard parity with the rest of the round — the recall flow is
  // fully key-driven, so the bridge can't be the one screen that
  // demands a mouse. The advance family (Enter / Space / → / l) takes
  // the primary action, Esc declines to the summary. A focused button
  // (Tab navigation) keeps native activation: hijacking Enter there
  // would fire "start" while "Skip" has focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onSkip();
        return;
      }
      if (
        e.key === "Enter" ||
        e.key === " " ||
        e.key === "ArrowRight" ||
        e.key.toLowerCase() === "l"
      ) {
        e.preventDefault();
        onStart();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStart, onSkip]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-foreground/5">
        <ArrowRight className="size-6 text-foreground/70" />
      </div>
      <h2 className="font-serif text-3xl tracking-tight">Recall round done.</h2>
      <p className="max-w-md text-[13.5px] text-muted-foreground">
        Want to flip it around? Same {cardCount} card{cardCount === 1 ? "" : "s"} —
        you'll see the meaning and try to produce the word. Doesn't affect
        your SRS schedule.
      </p>
      <div className="flex gap-2">
        <Button onClick={onStart}>
          <ArrowRight className="size-4" />
          Start production
        </Button>
        <Button variant="outline" onClick={onSkip}>
          Skip — see summary
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Enter / → to start · Esc to skip
      </p>
    </div>
  );
}

// Production-direction practice, mirroring the recall round's gate flow:
// the gloss is the prompt, the user self-assesses ("Do you know the
// word?"), and the answer reveals either way. Yes → check it + next;
// No → the same "Done studying" reveal the recall round uses, and the
// card re-enters the queue a few positions later. None of it touches
// FSRS — the requeue lives and dies with this round.
function ProductionRound({
  cards,
  targetLang,
  autoplayAudio,
  onLeave,
}: {
  cards: VocabEntry[];
  targetLang: LanguageCode;
  autoplayAudio: boolean;
  onLeave: () => void;
}) {
  const tts = useTTS();
  // Local queue (not the `cards` prop) so missed cards can re-surface
  // mid-round, recall-round style.
  const [queue, setQueue] = useState<VocabEntry[]>(cards);
  const [idx, setIdx] = useState(0);
  // null = gate stage (answer hidden); true/false = revealed, holding
  // the self-assessment so the post-reveal controls can match it.
  const [knewWord, setKnewWord] = useState<boolean | null>(null);
  const card = queue[idx];
  const revealed = knewWord !== null;

  // Show the keyboard hint bar in the production round too — same
  // setting key as the main StudyView, so the toggle in Settings →
  // Study controls both surfaces from one switch.
  const [showKeyboardHints] = usePluginSetting<boolean>(
    vocabRecall.meta.id,
    "showKeyboardHints",
    true,
  );

  // First example sentence (if any). The audio key (↓/j) plays it.
  const firstExample = useMemo(() => {
    const examples = parseExamples(card?.cardNotes ?? null);
    return examples[0] ?? null;
  }, [card?.cardNotes]);

  function speakWord() {
    if (!card) return;
    void tts.speak(card.word, targetLang);
  }
  function speakSentence() {
    if (!firstExample?.target) return;
    void tts.speak(firstExample.target, targetLang);
  }

  function advance() {
    setKnewWord(null);
    setIdx((i) => i + 1);
  }

  // The "No" path (and the post-reveal "I was wrong" escape): the card
  // re-surfaces a few positions later — the same offset the recall round
  // uses for again-grades — or at the end if the queue is shorter.
  function requeueAndAdvance() {
    if (card) {
      setQueue((prev) => {
        const next = [...prev];
        const insertAt = Math.min(prev.length, idx + AGAIN_REQUEUE_AHEAD);
        next.splice(insertAt, 0, card);
        return next;
      });
    }
    advance();
  }

  // Auto-play the word's audio the moment the target is revealed — and
  // only then (the front shows the gloss; there's no target to voice
  // until the gate is answered). Mirrors the recall round, gated on the
  // same `autoplayAudio` study-config switch.
  useEffect(() => {
    if (!card || !revealed || !autoplayAudio) return;
    void tts.speak(card.word, targetLang, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, revealed, autoplayAudio]);

  // Keyboard map. Stage-aware, same key families as the recall round:
  //   • Anywhere: Esc skips the round.
  //   • Gate: y / 1 / → / l = yes · 2 / ← / h = no · Enter / Space =
  //     default-positive yes. Either answer reveals the card.
  //   • Post-reveal: → / l / Enter / Space advance (on the No path
  //     that's "Done studying", which is where the requeue happens);
  //     on the Yes path ← / h is the "I was wrong" escape — requeues
  //     like a No, then advances.
  //   • Post-reveal: ↑/k speaks word, ↓/j speaks sentence. Inert at
  //     the gate — in production direction the word IS the answer,
  //     so pre-reveal audio would leak it mid-self-assessment.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLTextAreaElement) return;

      if (e.key === "Escape") {
        e.preventDefault();
        onLeave();
        return;
      }

      const k = e.key.toLowerCase();

      // Past the last card — the "Production round done" screen. The
      // whole round is key-driven, so the advance family (Enter /
      // Space / → / l) finishes to the summary instead of dead-ending
      // on a mouse-only button.
      if (!card) {
        if (
          e.key === "Enter" ||
          e.key === " " ||
          e.key === "ArrowRight" ||
          k === "l"
        ) {
          e.preventDefault();
          onLeave();
        }
        return;
      }

      if (knewWord === null) {
        // Gate stage.
        const yes =
          k === "y" ||
          e.key === "1" ||
          e.key === "ArrowRight" ||
          k === "l" ||
          e.key === "Enter" ||
          e.key === " ";
        const no = e.key === "2" || e.key === "ArrowLeft" || k === "h";
        if (yes) {
          e.preventDefault();
          setKnewWord(true);
          return;
        }
        if (no) {
          e.preventDefault();
          setKnewWord(false);
        }
        return;
      }

      // Post-reveal. Audio first — fine now the answer is out.
      if (e.key === "ArrowUp" || k === "k") {
        e.preventDefault();
        speakWord();
        return;
      }
      if (e.key === "ArrowDown" || k === "j") {
        e.preventDefault();
        speakSentence();
        return;
      }

      if (
        e.key === "ArrowRight" ||
        k === "l" ||
        e.key === "Enter" ||
        e.key === " "
      ) {
        e.preventDefault();
        if (knewWord) advance();
        else requeueAndAdvance();
        return;
      }
      if (knewWord && (e.key === "ArrowLeft" || k === "h")) {
        e.preventDefault();
        requeueAndAdvance();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knewWord, onLeave, card?.id, idx, firstExample?.target]);

  if (!card) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <h2 className="font-serif text-3xl tracking-tight">Production round done.</h2>
        <p className="text-[13.5px] text-muted-foreground">
          Nice work — every word both ways.
        </p>
        <Button onClick={onLeave}>See summary</Button>
        <p className="text-[11px] text-muted-foreground">
          Enter / → to continue
        </p>
      </div>
    );
  }

  const total = queue.length;
  const progress = total === 0 ? 0 : ((idx + (revealed ? 0.5 : 0)) / total) * 100;

  return (
    <div className="flex h-full flex-col">
      {/* Slim progress bar — mirrors the recall round's TopActionBar
          chrome so the visual rhythm doesn't change between phases. */}
      <div className="border-b border-border px-6 pt-2 pb-3">
        <div className="flex w-full items-center gap-4">
          <p className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {idx + 1} / {total}
          </p>
          <div className="flex-1">
            <Progress value={progress} />
          </div>
          <span className="rounded-full border border-border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Production
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onLeave}
            title="Skip the production round and see the summary"
          >
            <SkipForward className="size-3.5" />
            Skip
          </Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-6 overflow-y-auto">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Recall the word for…
        </p>
        <p className="font-serif text-2xl text-foreground/90">{card.gloss}</p>

        {!revealed ? (
          // Same two-tone gate as the recall round — answer first,
          // then the reveal checks the claim.
          <div className="w-full max-w-sm">
            <YesNoGate
              question="Do you know the word?"
              onYes={() => setKnewWord(true)}
              onNo={() => setKnewWord(false)}
              hint="yes: → / l / y / 1   ·   no: ← / h / 2"
            />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <p className="font-serif text-5xl tracking-tight">
                <Tokenized text={card.word} lang={targetLang} />
              </p>
              <SpeakButton text={card.word} lang={targetLang} />
            </div>
            {/* Chinese already shows pinyin as ruby above the characters
                (Tokenized), so a separate reading line here would just
                duplicate it — keep this only for non-zh readings (kana,
                jamo, romanisations). */}
            {card.reading && targetLang !== "zh" && (
              <Pinyin
                raw={card.reading}
                className="text-[15px] text-muted-foreground"
              />
            )}

            {/* First example sentence — gives the user a chunk of
                connected text to read post-reveal, and pairs with
                the ↓/j shortcut so the audio button isn't the only
                way to hear it. */}
            {firstExample?.target && (
              <div className="mt-1 flex max-w-md flex-col items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
                <div className="flex items-center gap-2">
                  <p className="font-serif text-[17px] leading-snug text-foreground/90">
                    <Tokenized text={firstExample.target} lang={targetLang} />
                  </p>
                  <SpeakButton
                    text={firstExample.target}
                    lang={targetLang}
                    size="sm"
                  />
                </div>
                {firstExample.native && (
                  <p className="text-[12px] text-muted-foreground">
                    {firstExample.native}
                  </p>
                )}
              </div>
            )}

            {knewWord ? (
              // Yes path: primary advance, plus an escape hatch for
              // "the reveal proved me wrong" that requeues like a No.
              <div className="mt-2 flex gap-2">
                <Button variant="outline" onClick={requeueAndAdvance}>
                  I was wrong
                </Button>
                <Button onClick={advance}>Next card</Button>
              </div>
            ) : (
              // No path: the same single-button reveal+done flow the
              // recall round uses — the button records the requeue.
              <div className="mt-2 flex flex-col items-center gap-2">
                <Button
                  size="lg"
                  onClick={requeueAndAdvance}
                  className="rounded-full px-8"
                >
                  Done studying — next card
                </Button>
                <p className="text-center text-[11px] text-muted-foreground">
                  Comes back a few cards later this round
                </p>
              </div>
            )}
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          {!revealed
            ? "Esc to skip the round"
            : knewWord
              ? "→ / Enter next · ← if you were wrong · ↑ / ↓ replay audio · Esc to skip"
              : "→ / Enter done · ↑ / ↓ replay audio · Esc to skip"}
        </p>
      </div>

      {/* Same hint footer the recall round shows. Stage = "production"
          renders the cross with audio + yes/no on the middle row,
          but no grade row (production is yes/no only). */}
      {showKeyboardHints && <ProductionKeyboardHints knewWord={knewWord} />}
    </div>
  );
}

function ProductionKeyboardHints({ knewWord }: { knewWord: boolean | null }) {
  const revealed = knewWord !== null;
  return (
    <div className="hidden md:flex pointer-events-none fixed bottom-3 right-3 z-20 flex-col items-end gap-2 text-muted-foreground/70">
      {/* Same 3-col × 2-row layout as the recall hint bar. ↓ sits in
          the middle of the bottom row so it shares a level with the
          ← / → no/yes pair, which both fire from the same row of
          arrow keys on the keyboard. Audio chips dim at the gate
          (pre-reveal audio would leak the answer); ← / → flip meaning
          per stage, so the labels track it. */}
      <div className="grid grid-cols-3 grid-rows-2 gap-1">
        <span />
        <span className={cn(!revealed && "opacity-40")}>
          <KeyChip k={["↑", "k"]} label="word" />
        </span>
        <span />
        <span className={cn(knewWord === false && "opacity-40")}>
          <KeyChip k={["←", "h"]} label={knewWord ? "wrong" : "no"} />
        </span>
        <span className={cn(!revealed && "opacity-40")}>
          <KeyChip k={["↓", "j"]} label="sentence" />
        </span>
        <KeyChip
          k={["→", "l"]}
          label={knewWord === null ? "yes" : knewWord ? "next" : "done"}
        />
      </div>

      <div className="flex items-center gap-2 text-[9.5px]">
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border/60 bg-muted/30 px-1 py-px font-mono text-[9px] text-muted-foreground/80">
            Space
          </kbd>
          <span className="text-muted-foreground/60">
            {!revealed ? "yes" : knewWord ? "next" : "done"}
          </span>
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border/60 bg-muted/30 px-1 py-px font-mono text-[9px] text-muted-foreground/80">
            Esc
          </kbd>
          <span className="text-muted-foreground/60">skip</span>
        </span>
      </div>
    </div>
  );
}

function TopActionBar({
  progress,
  idx,
  total,
  onKnown,
  onBoost,
  onBlock,
  onPause,
}: {
  progress: number;
  idx: number;
  total: number;
  onKnown: () => void;
  onBoost: () => void;
  onBlock: () => void;
  onPause: () => void;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="border-b border-border px-6 pt-2 pb-3">
        <div className="flex w-full items-center gap-4">
          <p className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {idx + 1} / {total}
          </p>
          <div className="flex-1">
            <Progress value={progress} />
          </div>
          <div className="flex items-center gap-1">
            <TopActionButton
              onClick={onKnown}
              tooltip="Mark as known — skip future reviews."
              className="text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
            >
              <CheckCircle2 className="size-4" />
            </TopActionButton>
            <TopActionButton
              onClick={onBoost}
              tooltip="Boost — re-study this card later in the same session."
              className="text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
            >
              <RocketIcon className="size-4" />
            </TopActionButton>
            <TopActionButton
              onClick={onBlock}
              tooltip="Block — remove this word so it never surfaces again."
              className="text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
            >
              <Ban className="size-4" />
            </TopActionButton>
            <div className="mx-1 h-5 w-px bg-border" />
            <TopActionButton onClick={onPause} tooltip="Pause  ·  Space">
              <Pause className="size-4" />
            </TopActionButton>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function TopActionButton({
  children,
  onClick,
  tooltip,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tooltip: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-center">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function PauseOverlay({
  progress,
  reviewedCount,
  total,
  grades,
  activeSecs,
  onResume,
  onEnd,
}: {
  progress: number;
  reviewedCount: number;
  total: number;
  grades: { again: number; hard: number; good: number; easy: number };
  /** Pause-aware active study seconds — frozen while the overlay shows. */
  activeSecs: number;
  onResume: () => void;
  onEnd: () => void;
}) {
  const minutes = Math.max(1, Math.round(activeSecs / 60));
  const correct = grades.good + grades.easy;
  const accuracy = reviewedCount > 0 ? Math.round((correct / reviewedCount) * 100) : 0;
  return (
    // The overlay covers the custom title bar, so make the backdrop a
    // window drag region — otherwise the window can't be moved while
    // paused. `data-tauri-drag-region` only fires on this exact element,
    // so the Resume / End buttons inside stay clickable.
    <div
      data-tauri-drag-region
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/95 backdrop-blur-sm animate-in fade-in"
    >
      <div className="w-full max-w-md px-8 text-center">
        <p className="text-[11px] font-bold uppercase tracking-wider text-foreground/70">
          Paused
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {reviewedCount} / {total} reviewed
        </p>
        <div className="mt-4">
          <Progress value={progress} />
        </div>

        {reviewedCount > 0 && (
          <div className="mt-6 grid grid-cols-3 gap-3">
            <PauseStat label="Reviewed" value={String(reviewedCount)} />
            <PauseStat label="Accuracy" value={`${accuracy}%`} />
            <PauseStat label="Time" value={`${minutes}m`} />
          </div>
        )}

        <div className="mt-7 flex justify-center gap-2">
          <Button variant="outline" onClick={onEnd}>
            <StopCircle className="size-4" />
            End session
          </Button>
          <Button onClick={onResume}>
            <Play className="size-4" />
            Resume
          </Button>
        </div>

        <p className="mt-5 text-[11px] text-muted-foreground">
          Press <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">Space</kbd> or{" "}
          <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd> to resume
        </p>
      </div>
    </div>
  );
}

function PauseStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <p className="font-serif text-xl tracking-tight">{value}</p>
      <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

function KeyboardHintBar({ stage }: { stage: "word" | "reading" | "graded" }) {
  const showRecall = stage !== "graded";
  return (
    <div className="hidden md:flex pointer-events-none fixed bottom-3 right-3 z-20 flex-col items-end gap-2 text-muted-foreground/70">
      {/* 3 cols × 2 rows. Top row centered on ↑ (word audio). Bottom
          row keeps ↓ (sentence audio) in the middle column so it
          shares a level with ← / → — letting the user read all the
          recall-pair shortcuts in one horizontal sweep. */}
      <div className="grid grid-cols-3 grid-rows-2 gap-1">
        <span />
        <KeyChip k={["↑", "k"]} label="word" />
        <span />
        {showRecall ? (
          <KeyChip k={["←", "h"]} label="no" />
        ) : (
          <span />
        )}
        <KeyChip k={["↓", "j"]} label="sentence" />
        {showRecall ? (
          <KeyChip k={["→", "l"]} label="yes" />
        ) : (
          <span />
        )}
      </div>

      {/* Grade row — only meaningful in graded stage. */}
      {stage === "graded" && <GradeKeyChips />}

      {/* Session controls — always available. */}
      <div className="flex items-center gap-2 text-[9.5px]">
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border/60 bg-muted/30 px-1 py-px font-mono text-[9px] text-muted-foreground/80">
            Space
          </kbd>
          <span className="text-muted-foreground/60">pause</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border/60 bg-muted/30 px-1 py-px font-mono text-[9px] text-muted-foreground/80">
            Esc
          </kbd>
          <span className="text-muted-foreground/60">close</span>
        </span>
      </div>
    </div>
  );
}


function VocabRecallSettings() {
  const { active: workspace } = useWorkspace();
  const lang = workspace?.targetLang ?? "";
  // The pronunciation step only exists for CJK (two-question) languages,
  // so the reading-mode toggle is only meaningful there. Latin-script
  // workspaces just see the keyboard-hints option below.
  const isTwoQuestionLang = lang === "zh" || lang === "ja" || lang === "ko";
  const reading = readingLabel(lang);
  const [pinyinMode, setPinyinMode, pinyinLoaded] = usePluginSetting<boolean>(
    vocabRecall.meta.id,
    "pinyinMode",
    false,
  );
  const [showKeyboardHints, setShowKeyboardHints, loaded] =
    usePluginSetting<boolean>(
      vocabRecall.meta.id,
      "showKeyboardHints",
      true,
    );
  return (
    <div className="space-y-3">
      {isTwoQuestionLang && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={pinyinMode}
            onChange={(e) => setPinyinMode(e.target.checked)}
            disabled={!pinyinLoaded}
            className="mt-1"
          />
          <span>
            <span className="text-[13px] font-medium">
              {reading.title} mode
            </span>
            <span className="block text-[11.5px] text-muted-foreground">
              Show {reading.noun} alongside the word and grade the meaning in
              one step, skipping the “do you know the pronunciation?” gate. Off
              keeps the two-step flow — recall the pronunciation first, then
              the meaning.
            </span>
          </span>
        </label>
      )}
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={showKeyboardHints}
          onChange={(e) => setShowKeyboardHints(e.target.checked)}
          disabled={!loaded}
          className="mt-1"
        />
        <span>
          <span className="text-[13px] font-medium">
            Show keyboard shortcut hints
          </span>
          <span className="block text-[11.5px] text-muted-foreground">
            A small grey footer appears at the bottom-left during a study
            session, listing the active shortcuts (arrow keys, vim-style
            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              hjkl
            </code>
            , and{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              asdf
            </code>{" "}
            grades). Hide once you&apos;ve memorised them.
          </span>
        </span>
      </label>
    </div>
  );
}
