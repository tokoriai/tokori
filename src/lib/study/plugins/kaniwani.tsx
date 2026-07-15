import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  Volume2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Pinyin } from "@/components/pinyin";
import { SpeakButton } from "@/components/speak-button";
import { StudyAiDrawer } from "@/components/study/ai-drawer";
import { deleteVocab } from "@/lib/db";
import {
  prettyPinyin,
  readingKey,
  tonePermutedReadings,
} from "@/lib/pinyin";
import {
  BlurReveal,
  GradeKeyChips,
  GradeRow,
  KeyChip,
  NotesDrawer,
  SideRail,
  YesNoGate,
} from "@/lib/study/card-chrome";
import {
  PauseOverlay,
  SessionTopBarControls,
  useActiveSessionTime,
} from "@/lib/study/session-controls";
import {
  clearSnapshot,
  loadSnapshot,
  rehydrate,
  saveSnapshot,
  type SessionSnapshot,
} from "@/lib/study/session-state";
import {
  buildStudySessionQueue,
  UNCAPPED_DAILY_LIMITS,
} from "@/lib/study-config";
import { useTTS } from "@/lib/tts-context";
import type {
  Grade,
  LanguageCode,
  ReviewedCardSummary,
  StudyPlugin,
  StudyViewProps,
  VocabEntry,
} from "@/lib/study/api";
import { PrestartShell } from "@/lib/study/prestart";
import { cn } from "@/lib/utils";

/**
 * Typed-recall study mode — modelled on the original Kaniwani.
 *
 * Each card walks through a *plan* of mixed stages. The plan is built
 * fresh per card so a session feels varied: type the pinyin from the
 * meaning, type the meaning from the character, type the character
 * from audio, and so on. New cards (status="new") get a lesson-style
 * intro stage first, where the character, reading, meaning, and a
 * single auto-played pronunciation are all shown before any typing is
 * required — Kaniwani's "Lessons" phase, adapted for the way our SRS
 * already gates new items.
 *
 * Stage palette lives in `PALETTE_BY_LANG`; adding a language is a few
 * lines, not a fork of the component. Per-language stages cover the
 * three axes the user is actually trying to learn:
 *   - Character → reading / meaning  (recognition)
 *   - Meaning   → reading / character (production)
 *   - Audio     → character / reading (listening)
 *
 * Wrong attempts on any stage count toward the FSRS grade; clearing
 * the plan with 0 errors = easy, 1 = good, ≥ 2 = again. Skipping a
 * stage (no data on the card, or user opt-out) doesn't count as a
 * mistake.
 */

type StageKind =
  /** Show character + reading + meaning + auto-play audio. User
   *  confirms with "Got it" — no typing. Prepended automatically for
   *  cards in `new` status. */
  | "intro"
  /** Show the gloss; user types `word` or `reading`. */
  | "promptGloss"
  /** Show the character; user types `reading` or `gloss`. */
  | "promptCharacter"
  /** Auto-play the audio; user types `word` or `reading`. The
   *  listening drill — works even when the user has no script input
   *  method enabled (they can answer in pinyin / romaji). */
  | "promptAudio"
  /** Show the character; user picks the correct tone permutation
   *  from 4 options. Inserted automatically after a type-pinyin
   *  stage (zh only) so "type the syllables" → "pick the tones"
   *  becomes a single recall flow on the same card. */
  | "pickTones"
  /** Show the character; ask "Do you know the meaning?" — no typing,
   *  self-assessment. On No: reveal gloss, count as mistake. On Yes:
   *  reveal gloss, ask "How well?" with Hard/Good/Easy buttons. This
   *  mirrors a classic flashcard for the meaning axis where typing
   *  English glosses is low-signal recall (the user knows the meaning
   *  but doesn't know which exact sense the dictionary chose). */
  | "selfAssessGloss";

type AnswerField = "reading" | "word" | "gloss";

type StageDef = {
  kind: StageKind;
  /** Which field on the vocab row contains the correct answer. */
  answerField: AnswerField;
  /** Short label shown above the prompt. */
  label: string;
  /** Placeholder text for the input. */
  placeholder: string;
  /** Strip tone marks before comparing (zh pinyin). */
  stripTones?: boolean;
  /** Also accept the card's reading (stripped to tone-less form) as
   *  a correct answer — used on `word`-answer stages so a learner
   *  who hasn't drilled the characters yet can still type the
   *  pinyin and progress. zh-only by convention. */
  acceptReadingAlternate?: boolean;
};

// Stage palette per supported language. The planner picks a randomised
// subset for each card so the user sees a different mix every time —
// the variety is the point.
const PALETTE_BY_LANG: Partial<Record<LanguageCode, StageDef[]>> = {
  zh: [
    // Recognition: from character ──────────────────────────────────
    {
      kind: "promptCharacter",
      answerField: "reading",
      label: "Read aloud — type the pinyin",
      placeholder: "ni hao",
      stripTones: true,
    },
    {
      kind: "selfAssessGloss",
      answerField: "gloss",
      label: "What does it mean?",
      placeholder: "",
    },
    // Production: from meaning ─────────────────────────────────────
    {
      kind: "promptGloss",
      answerField: "reading",
      label: "Type the pinyin",
      placeholder: "ni hao",
      stripTones: true,
    },
    {
      kind: "promptGloss",
      answerField: "word",
      label: "Type the character(s) — or the pinyin",
      placeholder: "你好 / ni hao",
      acceptReadingAlternate: true,
    },
    // Listening ────────────────────────────────────────────────────
    {
      kind: "promptAudio",
      answerField: "word",
      label: "Listen — type what you hear",
      placeholder: "你好 / ni hao",
      acceptReadingAlternate: true,
    },
    {
      kind: "promptAudio",
      answerField: "reading",
      label: "Listen — type the pinyin",
      placeholder: "ni hao",
      stripTones: true,
    },
  ],
  ja: [
    // Recognition: from kanji/kana ─────────────────────────────────
    {
      kind: "promptCharacter",
      answerField: "reading",
      label: "Read aloud — type the kana",
      placeholder: "こんにちは",
    },
    {
      kind: "selfAssessGloss",
      answerField: "gloss",
      label: "What does it mean?",
      placeholder: "",
    },
    // Production: from meaning ─────────────────────────────────────
    {
      kind: "promptGloss",
      answerField: "reading",
      label: "Type the reading (kana)",
      placeholder: "こんにちは",
    },
    {
      kind: "promptGloss",
      answerField: "word",
      label: "Type the kanji/kana",
      placeholder: "今日は",
    },
    // Listening ────────────────────────────────────────────────────
    {
      kind: "promptAudio",
      answerField: "word",
      label: "Listen — type what you hear",
      placeholder: "今日は",
    },
    {
      kind: "promptAudio",
      answerField: "reading",
      label: "Listen — type the kana",
      placeholder: "こんにちは",
    },
  ],
};

// Safe fallback so a future workspace can't crash the plugin if it
// ends up here without a palette. In practice `supportedLangs` keeps
// non-CJK workspaces out, but the cost of the guard is one constant.
const DEFAULT_PALETTE: StageDef[] = [
  {
    kind: "promptGloss",
    answerField: "word",
    label: "Type the word",
    placeholder: "…",
  },
];

/** How many recall stages to draw from the palette per card. The
 *  intro stage (when present) is on top of this. Three feels like
 *  the original Kaniwani's cadence — long enough that each card
 *  actually exercises multiple axes of recall, short enough that a
 *  25-card queue stays under ~10 minutes. */
const STAGES_PER_CARD = 3;

/** Batch presets for the prestart picker — same mechanism as
 *  vocab-recall's, with smaller rungs because every kaniwani card is
 *  ~3–5 tasks (intro + typed stages + tone pick), not a single flip.
 *  Ten new cards ≈ forty tasks, so "5 cards" is a real session here. */
const SESSION_PRESETS = [5, 10, 20];

/** When a card lapses, we re-queue it this many positions ahead for
 *  a single retest. Far enough that the user has practised other
 *  cards in between (so it's a real recall test, not just typing
 *  what's still in working memory); close enough that the loop feels
 *  immediate rather than punitive. */
const RETEST_OFFSET = 4;

/** Pick the single stage we use for an in-session retest after a
 *  card lapses. Prefer a gloss-answer (typing the meaning) since
 *  meaning recall is the most stable axis to verify on; fall back to
 *  the first usable stage if the card has no gloss. Returns null only
 *  when the card has neither a gloss nor a reading — caller falls
 *  back to grading normally in that case. */
export function pickRetestStage(
  card: VocabEntry,
  palette: readonly StageDef[],
): StageDef | null {
  const usable = palette.filter((s) => {
    if (s.kind === "intro") return false;
    if (s.answerField === "reading") return !!card.reading?.trim();
    if (s.answerField === "gloss") return !!card.gloss?.trim();
    return true;
  });
  const gloss = usable.find((s) => s.answerField === "gloss");
  return gloss ?? usable[0] ?? null;
}

const kaniwani: StudyPlugin = {
  meta: {
    id: "kaniwani",
    name: "Kaniwani — typed recall",
    description:
      "Production practice for CJK: introduce new cards, then drill character ↔ reading ↔ meaning ↔ audio in a mixed plan per card.",
    icon: Pencil,
    supportedLangs: ["zh", "ja"],
  },
  StudyView,
};

export default kaniwani;

// ── Component ──

type CardProgress = {
  /** The full per-card stage plan, built once when the queue is
   *  assembled. Lives on progress (not in palette state) so each card
   *  gets its own random draw. */
  plan: StageDef[];
  /** Wrong attempts across all stages of this card. Drives the FSRS
   *  grade. Doesn't include intro (which has no input). */
  mistakes: number;
};

/** A single position in the interleaved task list: which card and
 *  which stage within that card's plan. The flat list is what drives
 *  the session — stages take turns across cards instead of running
 *  per-card-back-to-back. */
type TaskRef = { cardId: number; stageInPlanIdx: number };

const MODE_ID = "kaniwani";

function StudyView({ ctx }: StudyViewProps) {
  const palette = PALETTE_BY_LANG[ctx.workspace.targetLang] ?? DEFAULT_PALETTE;
  const tts = useTTS();
  // Try to rehydrate an in-progress session from localStorage first.
  // If the user left mid-flow, we want to pick up exactly where they
  // dropped — same queue, same plan, same task pointer. If there's
  // no snapshot (or the saved cards have all been deleted), we fall
  // through to a fresh build below.
  const initial = useMemo(() => {
    const wsId = ctx.workspace.id;
    const saved = loadSnapshot<StageDef>(wsId, MODE_ID);
    if (!saved) return null;
    const vocabById = new Map<number, VocabEntry>();
    for (const c of ctx.vocab) vocabById.set(c.id, c);
    for (const c of ctx.dueVocab) vocabById.set(c.id, c);
    const result = rehydrate(saved, vocabById);
    if (!result) {
      clearSnapshot(wsId, MODE_ID);
      return null;
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Prestart gate. Skip when rehydrating a saved snapshot — asking
  // "do you want to drill?" mid-session would be jarring and would
  // reset the user's expectations about whether grades flow.
  const [started, setStarted] = useState(initial != null);

  // The ready pool — the exact queue vocab-recall builds (due reviews
  // first, then new cards, deduped), so the two modes always agree on
  // what "N cards ready" means. Kaniwani additionally needs a gloss
  // (several stages prompt with it). Uncapped like vocab-recall: the
  // prestart batch picker below is the user's session-size control.
  const sessionPool = useMemo(() => {
    if (initial) return [];
    return buildStudySessionQueue(
      ctx.dueVocab,
      ctx.vocab,
      UNCAPPED_DAILY_LIMITS,
    ).filter((c) => !!c.gloss?.trim());
  }, [initial, ctx.dueVocab, ctx.vocab]);
  // Queue is the fixed set of cards for the session — the batch the
  // user picked off the front of the pool. The lapsed re-test lives in
  // the `tasks` list (a new task spliced ahead), so the queue itself
  // stays immutable after `startSession`.
  const [queue, setQueue] = useState<VocabEntry[]>(
    initial ? initial.queue : [],
  );
  // Cards waiting on a single in-session retest before they get
  // graded. When a card finishes its last task with too many
  // mistakes for the first time, we append a fresh retest stage to
  // the card's plan and splice a task pointing at it a few positions
  // ahead in the task list. The retest's verdict is locked at
  // "again" regardless of its own result — the lapse is the SRS
  // truth. The set caps the loop at one retest per card per session.
  const pendingRegradeRef = useRef<Set<number>>(
    new Set(initial?.snap.pendingRegradeCardIds ?? []),
  );
  // Cards already graded by the runner — guards against re-grading
  // when a card has another future task lined up (e.g. retests).
  const gradedCardsRef = useRef<Set<number>>(
    new Set(initial?.snap.gradedCardIds ?? []),
  );
  // Per-grade tallies + per-card summaries for the host's session
  // summary screen (grade pills + "what you studied" list). Refs, not
  // state — they're only read when the session ends. Cards graded
  // before a snapshot resume aren't reconstructed (the snapshot keeps
  // ids, not grades); the summary covers this sitting.
  const gradesRef = useRef({ again: 0, hard: 0, good: 0, easy: 0 });
  const reviewedCardsRef = useRef<ReviewedCardSummary[]>([]);
  const [progress, setProgress] = useState<Record<number, CardProgress>>(() => {
    if (!initial) return {};
    const out: Record<number, CardProgress> = {};
    for (const c of initial.queue) {
      const plan = initial.snap.plans[c.id];
      if (!plan) continue;
      out[c.id] = {
        plan,
        mistakes: initial.snap.mistakesByCardId[c.id] ?? 0,
      };
    }
    return out;
  });
  // Interleaved task list: each entry is (cardId, stageInPlanIdx).
  // Built once in `startSession`; mutated when a card lapses (a retest
  // task is spliced in ~4 positions ahead).
  const [tasks, setTasks] = useState<TaskRef[]>(() => {
    if (!initial) return [];
    return initial.snap.tasks.map((t) => ({
      cardId: t.cardId,
      stageInPlanIdx: t.stageInPlanIdx,
    }));
  });
  const [taskIdx, setTaskIdx] = useState(initial?.snap.taskIdx ?? 0);
  // Snapshot of pre-restored cards already done — used to seed the
  // header "X / Y graded" counter so the resumed session doesn't
  // start back at 0/N.
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<"idle" | "correct" | "wrong">("idle");
  const [reveal, setReveal] = useState<string | null>(null); // shown when wrong
  // Done counter — seeded from the snapshot's already-graded set so a
  // resumed session shows real progress instead of restarting at 0/N.
  const [done, setDone] = useState(initial?.snap.gradedCardIds.length ?? 0);
  const [paused, setPaused] = useState(false);
  const [pendingNeverAgain, setPendingNeverAgain] = useState<VocabEntry | null>(
    null,
  );
  // Side panels — same notes / AI adjuncts vocab-recall mounts, so the
  // study surfaces stay interchangeable. Only one panel at a time.
  const [notesOpen, setNotesOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  // Notes saved mid-session. The kaniwani queue is deliberately
  // immutable after build (tasks reference cards by id), so instead of
  // patching queue rows we overlay the edited cardNotes here — the
  // drawer re-opens with what the user just saved instead of the
  // stale snapshot.
  const [notesOverride, setNotesOverride] = useState<
    Record<number, string | null>
  >({});
  const inputRef = useRef<HTMLInputElement>(null);
  // Accumulated active session seconds — only ticks while the tab
  // is visible AND we're not paused. Used for the duration we ship
  // to the session-summary screen so a user who left the app sitting
  // open for an hour doesn't get an inflated time.
  const getActiveSecs = useActiveSessionTime(paused);
  // O(1) card-by-id lookup so we don't scan the queue per render.
  const cardsById = useMemo(() => {
    const m = new Map<number, VocabEntry>();
    for (const c of queue) m.set(c.id, c);
    return m;
  }, [queue]);

  useEffect(() => {
    if (!started) return;
    void ctx.ensureSessionStarted("review");
  }, [ctx, started]);

  // Persist the in-progress snapshot on every state-change tick.
  // Cheap (single localStorage write), already keyed per
  // (workspace, mode), and the runner's state is already small JSON.
  // We snapshot inside an effect so the data we persist is post-
  // commit; no race with the ref-backed pending/graded sets since
  // both are updated synchronously alongside the state changes that
  // trigger this effect.
  useEffect(() => {
    // Nothing to persist until the user picks a batch — and saving the
    // empty pre-start state would clobber nothing useful anyway.
    if (!started || queue.length === 0) return;
    const wsId = ctx.workspace.id;
    const plans: Record<number, StageDef[]> = {};
    const mistakesByCardId: Record<number, number> = {};
    for (const [idStr, p] of Object.entries(progress)) {
      const id = Number(idStr);
      plans[id] = p.plan;
      mistakesByCardId[id] = p.mistakes;
    }
    const snap: SessionSnapshot<StageDef> = {
      version: 1,
      workspaceId: wsId,
      mode: MODE_ID,
      cardIds: queue.map((c) => c.id),
      plans,
      tasks: tasks.map((t) => ({
        cardId: t.cardId,
        stageInPlanIdx: t.stageInPlanIdx,
      })),
      taskIdx,
      mistakesByCardId,
      pendingRegradeCardIds: Array.from(pendingRegradeRef.current),
      gradedCardIds: Array.from(gradedCardsRef.current),
      activeSecs: 0, // not load-bearing yet; placeholder for future
      startedAt: Math.floor(Date.now() / 1000),
    };
    saveSnapshot(snap);
  }, [ctx.workspace.id, started, queue, tasks, taskIdx, progress, done]);

  // Clear the snapshot once the runner reaches the "all done" state
  // (taskIdx past the end). The user can also clear it explicitly by
  // ending from the pause overlay — handled inline at the call site.
  useEffect(() => {
    if (tasks.length > 0 && taskIdx >= tasks.length) {
      clearSnapshot(ctx.workspace.id, MODE_ID);
    }
  }, [tasks.length, taskIdx, ctx.workspace.id]);

  /** Stats payload for the host's summary screen — one builder so the
   *  natural finish and the pause-overlay End ship identical shapes. */
  const buildSessionStats = () => ({
    cardsReviewed: done,
    durationSecs: getActiveSecs(),
    grades: { ...gradesRef.current },
    reviewedCards: [...reviewedCardsRef.current],
    extra: { mode: "kaniwani" } as Record<string, string>,
  });

  // Hand off to the host's summary screen the moment the last task
  // resolves — the old flow parked on a plugin-local "All cards
  // typed." screen and only reached the summary if the user clicked
  // through, which read as the summary never appearing. The fired
  // guard keeps onSessionEnd single-shot (the parent unmounts us in
  // response, but effects can re-run before that lands).
  const sessionEndFiredRef = useRef(false);
  const sessionComplete = tasks.length > 0 && taskIdx >= tasks.length;
  useEffect(() => {
    if (!sessionComplete || sessionEndFiredRef.current) return;
    sessionEndFiredRef.current = true;
    ctx.onSessionEnd(buildSessionStats());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionComplete]);

  // Derive the active task / card / stage. The card and stage both
  // change on every taskIdx advance — there's no more "stay on the
  // same card for a few stages" loop.
  const task = tasks[taskIdx];
  const card = task ? cardsById.get(task.cardId) ?? null : null;
  const cardProg = task ? progress[task.cardId] : null;
  const stage = task && cardProg ? cardProg.plan[task.stageInPlanIdx] : null;
  useEffect(() => {
    inputRef.current?.focus();
  }, [taskIdx]);

  // Per-stage tone-pick options. Shuffled once per stage entry so the
  // correct answer doesn't always land in the same slot. The set is
  // 4 entries — the correct tone-marked reading plus up to 3
  // permutations that change tones but keep syllable shape.
  const [pickedTone, setPickedTone] = useState<string | null>(null);
  const toneOptions = useMemo(() => {
    if (!card || !stage || stage.kind !== "pickTones") return [];
    const reading = card.reading?.trim();
    if (!reading) return [];
    const correctNumeric = readingKey(reading);
    const distractors = tonePermutedReadings(reading, 3);
    const opts = [correctNumeric, ...distractors];
    // Light Fisher-Yates so the correct option isn't always first.
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [opts[i], opts[j]] = [opts[j]!, opts[i]!];
    }
    return opts;
  }, [card?.id, stage?.kind, taskIdx]);
  useEffect(() => {
    setPickedTone(null);
  }, [taskIdx]);

  // Auto-play on the explicit listening stage AND on the new-card
  // intro ("studying" phase — lesson, not quiz). The recall stages
  // that follow intro never autoplay, so the pronunciation only ever
  // arrives when the user is being taught the card or being asked to
  // listen — never as a side-channel hint to a recall question.
  useEffect(() => {
    // No autoplay behind the prestart picker (belt-and-braces — the
    // queue is empty until the user picks a batch, so `card` is null
    // there anyway). `silent` keeps a failing provider from toasting
    // once per card.
    if (!started || !card || !stage) return;
    if (stage.kind !== "promptAudio" && stage.kind !== "intro") return;
    void tts.speak(card.word, ctx.workspace.targetLang, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskIdx, card?.id, stage?.kind, started]);

  const total = queue.length;

  /** Slice the first `n` cards off the pool (reviews first, then new —
   *  the same order vocab-recall studies them in), draw each card's
   *  plan once, and derive both the progress map and the interleaved
   *  task list from that single draw. */
  function startSession(n: number) {
    const picked = sessionPool.slice(0, n);
    if (picked.length === 0) return;
    const plans: Record<number, StageDef[]> = {};
    for (const c of picked) plans[c.id] = planForCard(c, palette);
    setQueue(picked);
    setProgress(
      Object.fromEntries(
        picked.map((c) => [c.id, { plan: plans[c.id]!, mistakes: 0 }]),
      ),
    );
    setTasks(buildInterleavedTasks(picked, plans));
    setTaskIdx(0);
    setStarted(true);
  }

  if (!started) {
    const ready = sessionPool.length;
    const presets = SESSION_PRESETS.filter((n) => ready > n);
    return (
      <PrestartShell
        icon={Pencil}
        pluginName="Kaniwani — typed recall"
        title={ready === 0 ? "All caught up." : `${ready} cards ready.`}
        description={
          ready === 0
            ? "Nothing due right now and no new cards are queued. Save more words from chat or the reader, then come back."
            : "Pick how many you want to type now. Reviews come first, then new cards — so a smaller batch still gives priority to what's actually due."
        }
        drillMode={ctx.drillMode}
        setDrillMode={ctx.setDrillMode}
        srsAnchorState={ctx.srsAnchorState}
      >
        {ready > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {presets.map((n) => (
                <Button
                  key={n}
                  variant="outline"
                  size="lg"
                  onClick={() => startSession(n)}
                  className="min-w-[110px]"
                >
                  {n} cards
                </Button>
              ))}
              <Button
                size="lg"
                onClick={() => startSession(ready)}
                className="min-w-[110px]"
              >
                All {ready}
              </Button>
            </div>
            <p className="text-center text-[11px] text-muted-foreground">
              Each card walks a short plan — character ↔ reading ↔ meaning
              ↔ audio, ~3–5 tasks per card — so batches run longer than
              plain flashcards.
            </p>
          </>
        )}
      </PrestartShell>
    );
  }

  if (total === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Pencil className="size-6 text-muted-foreground" />
        <h2 className="font-serif text-2xl tracking-tight">Nothing to type yet.</h2>
        <p className="max-w-md text-[13.5px] text-muted-foreground">
          Save some vocabulary first, or wait for cards to become due.
          Kaniwani works best on cards you've seen at least once.
        </p>
        <Button
          variant="ghost"
          onClick={() =>
            ctx.onSessionEnd({
              cardsReviewed: 0,
              durationSecs: getActiveSecs(),
            })
          }
        >
          Leave session
        </Button>
      </div>
    );
  }

  if (!card || !cardProg || !stage) {
    // Natural completion — the effect above is already shipping the
    // stats to the host's summary screen; this placeholder shows for
    // at most a frame.
    if (sessionComplete) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          Wrapping up…
        </div>
      );
    }
    // Inconsistent state fallback (e.g. the active card was removed
    // while tasks remain) — keep a manual exit so the user is never
    // stuck.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <CheckCircle2 className="size-7 text-emerald-500" />
        <h2 className="font-serif text-3xl tracking-tight">All cards typed.</h2>
        <p className="text-[13.5px] text-muted-foreground">
          {done} card{done === 1 ? "" : "s"} graded ·{" "}
          {Math.max(1, Math.floor(getActiveSecs() / 60))} min
        </p>
        <Button variant="outline" onClick={() => ctx.onSessionEnd(buildSessionStats())}>
          <RotateCcw className="size-4" />
          End session
        </Button>
      </div>
    );
  }

  function gradeCard(cardId: number, grade: "again" | "good" | "easy") {
    if (gradedCardsRef.current.has(cardId)) return;
    gradedCardsRef.current.add(cardId);
    const graded = cardsById.get(cardId);
    if (graded) {
      gradesRef.current[grade] += 1;
      // Boosted cards land here twice (the guard set is cleared for
      // the re-encounter); the summary screen dedupes by word with
      // the latest grade winning, which is what the user expects.
      reviewedCardsRef.current.push({
        word: graded.word,
        reading: graded.reading,
        gloss: graded.gloss,
        grade,
      });
    }
    void ctx.reviewVocab(cardId, grade);
    void ctx.bump("words_seen");
    setDone((d) => d + 1);
  }

  /** Boost — re-study this card later in the same session and grade
   *  it `again` so FSRS treats this run as a lapse. We grade now,
   *  drop any future tasks for this card from the task list, then
   *  generate a fresh plan + tasks and splice them ~5 task positions
   *  ahead so the user practises it again before the session ends. */
  function actionBoost() {
    if (!card || !task) return;
    const cardId = card.id;
    gradeCard(cardId, "again");
    // Allow the boosted re-encounter to grade again later. Without
    // this the gradedCardsRef guard would swallow the second grade.
    gradedCardsRef.current.delete(cardId);
    pendingRegradeRef.current.delete(cardId);
    const freshPlan = planForCard(card, palette);
    setProgress((p) => ({
      ...p,
      [cardId]: { plan: freshPlan, mistakes: 0 },
    }));
    setTasks((prev) => {
      // Drop the active task + any future tasks for this card, then
      // splice the new tasks ahead so the card comes back later.
      const filtered = prev.filter(
        (t, i) => i <= taskIdx ? i < taskIdx : t.cardId !== cardId,
      );
      const newTasks: TaskRef[] = freshPlan.map((_, i) => ({
        cardId,
        stageInPlanIdx: i,
      }));
      const insertAt = Math.min(filtered.length, taskIdx + RETEST_OFFSET + 1);
      return [
        ...filtered.slice(0, insertAt),
        ...newTasks,
        ...filtered.slice(insertAt),
      ];
    });
    setInput("");
    setFeedback("idle");
    setReveal(null);
    setPickedTone(null);
    toast.success(`Boosted "${card.word}" — coming back soon`);
  }

  /** Never-show-again — opens the confirm dialog. The actual delete
   *  + cleanup runs in `confirmNeverAgain` once the user agrees. */
  function startNeverAgain() {
    if (!card) return;
    setPendingNeverAgain(card);
  }

  async function confirmNeverAgain() {
    const target = pendingNeverAgain;
    setPendingNeverAgain(null);
    if (!target) return;
    await deleteVocab(target.id);
    // Drop the card's tasks from the future list (it may have been
    // mid-flow; we don't grade it for FSRS — delete is the strongest
    // verdict).
    setTasks((prev) => prev.filter((t) => t.cardId !== target.id));
    setProgress((p) => {
      const { [target.id]: _, ...rest } = p;
      void _;
      return rest;
    });
    pendingRegradeRef.current.delete(target.id);
    gradedCardsRef.current.delete(target.id);
    setInput("");
    setFeedback("idle");
    setReveal(null);
    setPickedTone(null);
    toast(`Removed "${target.word}"`);
  }

  function advanceStage(extraMistakes = 0) {
    if (!cardProg || !card || !task) return;
    const cardId = card.id;
    // Fold any caller-supplied mistake delta into both the persisted
    // count (so the next stage sees it if there is one) AND the
    // aggregation below (so the final grade reflects it even before
    // React flushes the setProgress). Used by self-assess stages where
    // the "grade" emerges from a Yes/Hard/Good/Easy pick instead of a
    // typed-then-checked answer.
    const effectiveMistakes = cardProg.mistakes + extraMistakes;
    if (extraMistakes > 0) {
      setProgress((p) => ({
        ...p,
        [cardId]: { ...cardProg, mistakes: effectiveMistakes },
      }));
    }
    // "Last task for this card" — no future task in the current
    // (possibly already-spliced) list references the same cardId.
    const moreForThisCard = tasks
      .slice(taskIdx + 1)
      .some((t) => t.cardId === cardId);

    let updatedTasks = tasks;
    if (!moreForThisCard) {
      const computedGrade: "again" | "good" | "easy" =
        effectiveMistakes === 0
          ? "easy"
          : effectiveMistakes <= 1
            ? "good"
            : "again";
      const alreadyPending = pendingRegradeRef.current.has(cardId);
      if (computedGrade === "again" && !alreadyPending) {
        // First lapse — append a single retest stage to the card's
        // plan and splice a task pointing at it ~RETEST_OFFSET ahead
        // in the task list. The original lapse verdict is locked in
        // (set when the retest resolves regardless of result).
        const retest = pickRetestStage(card, palette);
        if (retest) {
          const newStageIdx = cardProg.plan.length;
          pendingRegradeRef.current.add(cardId);
          setProgress((p) => ({
            ...p,
            [cardId]: {
              ...cardProg,
              plan: [...cardProg.plan, retest],
              mistakes: 0,
            },
          }));
          const insertAt = Math.min(tasks.length, taskIdx + RETEST_OFFSET);
          updatedTasks = [
            ...tasks.slice(0, insertAt),
            { cardId, stageInPlanIdx: newStageIdx },
            ...tasks.slice(insertAt),
          ];
          setTasks(updatedTasks);
        } else {
          // No retest stage available — grade normally.
          gradeCard(cardId, computedGrade);
        }
      } else if (alreadyPending) {
        // This task WAS the retest. Verdict is the original lapse,
        // regardless of how the retest itself went.
        pendingRegradeRef.current.delete(cardId);
        gradeCard(cardId, "again");
      } else {
        gradeCard(cardId, computedGrade);
      }
    }

    const nextIdx = taskIdx + 1;
    setInput("");
    setFeedback("idle");
    setReveal(null);
    if (nextIdx >= updatedTasks.length) {
      setTaskIdx(nextIdx); // triggers the "all done" render path
      return;
    }
    setTaskIdx(nextIdx);
  }

  function check() {
    if (!cardProg || !card || !stage) return;
    const expected = expectedAnswer(card, stage);
    if (!expected) {
      // The card lacks the data this stage needs (e.g. no reading).
      // Skip silently; not counted as a mistake — the card never
      // promised to teach this axis.
      advanceStage();
      return;
    }
    const ok = isAcceptableAnswer(input, expected, stage, card.reading);
    if (ok) {
      setFeedback("correct");
      // Play the canonical pronunciation right after the user commits
      // — never on the front of the card, so the audio doesn't
      // telegraph tones / shape before they've recalled it. promptAudio
      // is the exception (the listening drill auto-plays as the
      // prompt); we skip the post-check play there to avoid doubling
      // up the same clip.
      if (stage.kind !== "promptAudio") {
        void tts.speak(card.word, ctx.workspace.targetLang);
      }
      setTimeout(advanceStage, 350);
    } else {
      setFeedback("wrong");
      // Readings can be stored in numeric CC-CEDICT form ("ni3 hao3");
      // reveal the tone-marked form the rest of the app shows. Kana
      // and word/gloss answers pass through prettyPinyin untouched.
      setReveal(
        stage.answerField === "reading" ? prettyPinyin(expected) : expected,
      );
      setProgress((p) => ({
        ...p,
        [card.id]: { ...cardProg, mistakes: cardProg.mistakes + 1 },
      }));
      if (stage.kind !== "promptAudio") {
        void tts.speak(card.word, ctx.workspace.targetLang);
      }
    }
  }

  function tryAgain() {
    setInput("");
    setFeedback("idle");
    setReveal(null);
    inputRef.current?.focus();
  }

  // Overall progress driven by the flat task list now that stages
  // interleave across cards. The "Card X / Y" counter shows how many
  // cards have been graded so far (uniques in `done`), not a fixed
  // pointer — multiple cards are in flight at any given task.
  const progressPct =
    tasks.length > 0 ? (taskIdx / tasks.length) * 100 : 0;

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <div className="border-b border-border px-6 pt-2 pb-3">
          <div className="flex w-full items-center gap-4">
            <p className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              Task {taskIdx + 1} / {tasks.length} · {done} / {total} cards
              {stage.kind === "intro" && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
                  <Sparkles className="size-3" />
                  Lesson
                </span>
              )}
            </p>
            <div className="flex-1">
              <Progress value={progressPct} />
            </div>
            <SessionTopBarControls
              onBoost={actionBoost}
              onNeverAgain={startNeverAgain}
              onPause={() => setPaused(true)}
              disableBoost={!card}
            />
          </div>
        </div>
      </TooltipProvider>

      <div className="flex flex-1 items-center justify-center px-6 py-8">
        <div className="w-full max-w-xl">
          <div className="rounded-2xl border border-border bg-card px-6 py-8 text-center shadow-sm">
            {stage.kind === "intro" ? (
              <IntroStage
                card={card}
                lang={ctx.workspace.targetLang}
                keysDisabled={notesOpen || aiOpen}
                onContinue={() => advanceStage()}
              />
            ) : stage.kind === "selfAssessGloss" ? (
              // Keyed per task — without it React reuses the component
              // instance when two self-assess tasks land back-to-back,
              // carrying the previous card's phase (and the reading's
              // blur toggle) into the next one. A stale "reveal" phase
              // shows the new card's answer before the user assessed.
              <SelfAssessGlossStage
                key={taskIdx}
                card={card}
                lang={ctx.workspace.targetLang}
                keysDisabled={notesOpen || aiOpen}
                onResult={(extraMistakes) => advanceStage(extraMistakes)}
                onPlayAudio={() =>
                  void tts.speak(card.word, ctx.workspace.targetLang)
                }
              />
            ) : stage.kind === "pickTones" ? (
              <PickTonesStage
                card={card}
                options={toneOptions}
                picked={pickedTone}
                feedback={feedback}
                onPick={(opt) => {
                  if (!cardProg || !card || feedback !== "idle") return;
                  setPickedTone(opt);
                  const correct = readingKey(card.reading);
                  // Play the canonical pronunciation after commit —
                  // never on the front, only once the user has
                  // chosen, so the audio doesn't reveal tones before
                  // the pick.
                  void tts.speak(card.word, ctx.workspace.targetLang);
                  if (opt === correct) {
                    setFeedback("correct");
                    setTimeout(advanceStage, 350);
                  } else {
                    setFeedback("wrong");
                    setReveal(prettyPinyin(card.reading));
                    setProgress((p) => ({
                      ...p,
                      [card.id]: {
                        ...cardProg,
                        mistakes: cardProg.mistakes + 1,
                      },
                    }));
                  }
                }}
                onTryAgain={() => {
                  setPickedTone(null);
                  setFeedback("idle");
                  setReveal(null);
                }}
                onSkip={advanceStage}
                reveal={reveal}
              />
            ) : (
              <>
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {stage.label}
                </div>
                <PromptDisplay
                  card={card}
                  stage={stage}
                  lang={ctx.workspace.targetLang}
                />
                <div className="mt-5">
                  <Input
                    ref={inputRef}
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                      if (feedback !== "idle") setFeedback("idle");
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (feedback === "wrong") tryAgain();
                      else check();
                    }}
                    placeholder={stage.placeholder}
                    className={cn(
                      "h-12 text-center font-serif !text-xl",
                      feedback === "correct" &&
                        "border-emerald-500/60 ring-2 ring-emerald-500/30",
                      feedback === "wrong" &&
                        "border-rose-500/60 ring-2 ring-rose-500/30",
                    )}
                    disabled={feedback === "correct"}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                {feedback === "wrong" && reveal && (
                  <div className="mt-3 flex items-center justify-center gap-2 rounded-md bg-rose-500/10 px-3 py-2 text-[13px] text-rose-700 dark:text-rose-300">
                    <XCircle className="size-4 shrink-0" />
                    <span>
                      Expected:{" "}
                      <span className="font-mono font-semibold">{reveal}</span>
                    </span>
                  </div>
                )}

                <div className="mt-4 flex items-center justify-center gap-2">
                  {feedback === "wrong" ? (
                    <>
                      <Button onClick={tryAgain} variant="outline" size="sm">
                        Try again
                      </Button>
                      <Button onClick={() => advanceStage()} variant="ghost" size="sm">
                        Skip stage
                      </Button>
                    </>
                  ) : (
                    <Button
                      onClick={check}
                      disabled={!input.trim() || feedback === "correct"}
                    >
                      Check
                    </Button>
                  )}
                  {/* Always allow a replay — the audio-prompt stage
                      auto-plays on entry but the user might want to
                      hear it again. Other stages get a regular
                      pronunciation button. */}
                  <SpeakButton
                    text={card.word}
                    lang={ctx.workspace.targetLang}
                    vocabId={card.id}
                    cachedAudioAvailable={card.hasAudio}
                    title={
                      stage.kind === "promptAudio"
                        ? "Replay"
                        : "Read aloud"
                    }
                  />
                </div>

                <p className="mt-3 text-[11.5px] text-muted-foreground">
                  Press{" "}
                  <kbd className="rounded border bg-background px-1">Enter</kbd>{" "}
                  to check.
                  {feedback === "wrong" &&
                    " Press Enter to try again, or skip to the next stage."}
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Floating action rail (right edge) ──
          Same adjunct column vocab-recall shows: play audio, ask the
          AI, take notes. No keyboard shortcuts here — kaniwani's
          stages are typing-driven, so single letters aren't free. */}
      <SideRail
        onSpeak={() => void tts.speak(card.word, ctx.workspace.targetLang)}
        onNotes={() => {
          setNotesOpen((v) => !v);
          setAiOpen(false);
        }}
        onAi={() => {
          setAiOpen((v) => !v);
          setNotesOpen(false);
        }}
        notesOpen={notesOpen}
        aiOpen={aiOpen}
      />

      {/* Keyboard reference for the input-driven stages. The
          self-assess stage renders its own phase-aware footer; the
          tone picker is mouse-only so it shows none. */}
      {(stage.kind === "intro" ||
        stage.kind === "promptGloss" ||
        stage.kind === "promptCharacter" ||
        stage.kind === "promptAudio") && (
        <HintFooter>
          <div className="flex items-center gap-1">
            <KeyChip
              k={["Enter"]}
              label={stage.kind === "intro" ? "got it" : "check"}
            />
          </div>
        </HintFooter>
      )}

      {/* ── Notes drawer ── card-chrome shared surface; cardNotes
          overlay keeps mid-session saves visible (see notesOverride). */}
      <NotesDrawer
        open={notesOpen}
        card={{
          ...card,
          cardNotes:
            card.id in notesOverride ? notesOverride[card.id] : card.cardNotes,
        }}
        onClose={() => setNotesOpen(false)}
        onSaved={(updated) =>
          setNotesOverride((p) => ({ ...p, [updated.id]: updated.cardNotes }))
        }
      />

      {/* ── AI drawer ── streaming chat with the current card injected
          as context. Dismissable with Escape; owns its own input. */}
      <StudyAiDrawer
        open={aiOpen}
        card={card}
        targetLang={ctx.workspace.targetLang}
        nativeLang={ctx.workspace.nativeLang}
        onClose={() => setAiOpen(false)}
      />

      {/* Pause overlay — fullscreen take-a-break with Resume / End.
          End ships partial stats so the session-summary screen still
          gets accurate numbers. Active-time tracking is paused while
          this is up (see the visibility-aware accumulator above). */}
      {paused && (
        <PauseOverlay
          progress={progressPct}
          done={done}
          total={total}
          elapsedSecs={getActiveSecs()}
          onResume={() => setPaused(false)}
          onEnd={() => {
            clearSnapshot(ctx.workspace.id, MODE_ID);
            ctx.onSessionEnd(buildSessionStats());
          }}
        />
      )}

      {/* Never-show-again confirm */}
      <AlertDialog
        open={pendingNeverAgain != null}
        onOpenChange={(v) => {
          if (!v) setPendingNeverAgain(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Never show &ldquo;{pendingNeverAgain?.word}&rdquo; again?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The card is removed from your vocabulary entirely — it
              won&apos;t come back in any study mode. Re-add it later
              from the Browse tab if you change your mind.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmNeverAgain()}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Stage-specific render helpers ──

/** Fixed bottom-right keyboard reference — same slot and visual
 *  treatment as vocab-recall's hint bar, composed per stage from
 *  KeyChip rows. Pointer-events off so it never blocks the card. */
function HintFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="hidden md:flex pointer-events-none fixed bottom-3 right-3 z-20 flex-col items-end gap-2 text-muted-foreground/70">
      {children}
    </div>
  );
}

function IntroStage({
  card,
  lang,
  keysDisabled,
  onContinue,
}: {
  card: VocabEntry;
  lang: LanguageCode;
  /** True while a side panel (notes / AI) is open. */
  keysDisabled: boolean;
  onContinue: () => void;
}) {
  // Enter / → advance past the lesson — the rest of the plan is
  // keyboard-driven, so the intro can't be the one stage that needs a
  // click. Skip when a button has focus (SpeakButton's native Enter
  // activation would stack with the advance) or a panel is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keysDisabled) return;
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      if (
        t instanceof HTMLElement &&
        t.closest("button") != null &&
        (e.key === "Enter" || e.key === " ")
      ) {
        return;
      }
      if (e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        onContinue();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onContinue, keysDisabled]);

  return (
    <>
      <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
        <Sparkles className="size-3" />
        New card — read it once
      </div>
      <div className="mt-4 font-serif text-[64px] leading-none tracking-tight">
        {card.word}
      </div>
      {card.reading && (
        <div className="mt-3">
          <Pinyin raw={card.reading} className="text-lg" />
        </div>
      )}
      {card.gloss && (
        <p className="mt-3 max-w-md text-[14px] text-foreground/85 mx-auto">
          {card.gloss.split(/;\s*/).slice(0, 3).join(" · ")}
        </p>
      )}
      <div className="mt-5 flex items-center justify-center gap-2">
        <SpeakButton
          text={card.word}
          lang={lang}
          vocabId={card.id}
          cachedAudioAvailable={card.hasAudio}
          title="Replay"
        />
        <Button onClick={onContinue} size="sm">
          Got it
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
      <p className="mt-3 text-[11.5px] text-muted-foreground">
        We'll quiz you on this card in the next few stages.
      </p>
    </>
  );
}

/** How much each self-assessed grade adds to the card's mistake count.
 *  The kaniwani aggregator only knows three buckets (0 → easy, 1 →
 *  good, ≥2 → again), so Again maps to a forced lapse, Hard caps the
 *  card at "good", and Good/Easy both stay clean — the four buttons
 *  exist for muscle-memory parity with vocab-recall, not because the
 *  aggregation can distinguish all four. */
const SELF_ASSESS_MISTAKES: Record<Grade, number> = {
  again: 2,
  hard: 1,
  good: 0,
  easy: 0,
};

/** Sub-labels for the grade row. Vocab-recall shows FSRS interval
 *  estimates there; kaniwani's grade is aggregated across the card's
 *  whole stage plan, so interval promises would be a lie — describe
 *  the self-assessment instead. */
const SELF_ASSESS_HINTS: Record<Grade, string> = {
  again: "didn't know",
  hard: "barely",
  good: "knew it",
  easy: "instant",
};

/** Meaning recall as a flashcard, not a typed quiz. Typing English
 *  glosses is low-signal — the user often knows the meaning but
 *  doesn't know which exact synonym the dictionary picked, so a
 *  self-assessment is a better fit. Two phases:
 *
 *    1. Front: show the character. "Do you know the meaning?" with
 *       Yes/No buttons.
 *    2. After Yes: reveal the gloss and ask "How well?" with the
 *       standard Again / Hard / Good / Easy grade row (same design and
 *       1-4 / a s d f keys as vocab-recall — see SELF_ASSESS_MISTAKES
 *       for how the four grades fold into kaniwani's mistake count).
 *       After No: reveal the gloss with a Continue button (counts as
 *       a forced lapse, same as Again). */
function SelfAssessGlossStage({
  card,
  lang,
  keysDisabled,
  onResult,
  onPlayAudio,
}: {
  card: VocabEntry;
  lang: LanguageCode;
  /** True while a side panel (notes / AI) is open — keyboard grading
   *  must not fire behind the drawer. */
  keysDisabled: boolean;
  onResult: (extraMistakes: number) => void;
  onPlayAudio: () => void;
}) {
  const [phase, setPhase] = useState<"ask" | "reveal-no" | "reveal-yes">("ask");

  function answer(yes: boolean) {
    if (phase !== "ask") return;
    setPhase(yes ? "reveal-yes" : "reveal-no");
    // Play after commit — never on the front, so audio doesn't telegraph
    // anything before the user has self-assessed.
    onPlayAudio();
  }

  function finish(extraMistakes: number) {
    onResult(extraMistakes);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keysDisabled) return;
      // Don't hijack typing in inputs / textareas.
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      // A focused button (e.g. the replay SpeakButton) owns its native
      // Enter / Space activation — grading on top of it would fire two
      // actions from one keypress.
      if (
        t instanceof HTMLElement &&
        t.closest("button") != null &&
        (e.key === "Enter" || e.key === " ")
      ) {
        return;
      }
      const k = e.key.toLowerCase();
      if (phase === "ask") {
        const yes =
          k === "y" ||
          e.key === "1" ||
          e.key === "ArrowRight" ||
          k === "l" ||
          e.key === "Enter";
        const no =
          e.key === "2" || k === "n" || e.key === "ArrowLeft" || k === "h";
        if (yes) {
          e.preventDefault();
          answer(true);
        } else if (no) {
          e.preventDefault();
          answer(false);
        }
        return;
      }
      if (phase === "reveal-no") {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          finish(2);
        }
        return;
      }
      // reveal-yes: the standard grade keys — 1-4 / a s d f, Enter
      // accepts Good. Identical bindings to vocab-recall's graded
      // stage so the user's fingers don't have to know which plugin
      // they're in.
      const gradeKeyMap: Record<string, Grade> = {
        "1": "again", a: "again",
        "2": "hard", s: "hard",
        "3": "good", d: "good",
        "4": "easy", f: "easy",
      };
      const g = gradeKeyMap[e.key] ?? gradeKeyMap[k];
      if (g) {
        e.preventDefault();
        finish(SELF_ASSESS_MISTAKES[g]);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        finish(SELF_ASSESS_MISTAKES.good);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, keysDisabled]);

  if (phase === "ask") {
    return (
      <>
        <div className="font-serif text-[64px] leading-none tracking-tight">
          {card.word}
        </div>
        {card.reading && (
          <div className="mt-3 text-[14px]">
            {/* Reading starts blurred — pronunciation is a strong hint
                for meaning recall, so revealing it is the user's call.
                The per-task key on this stage (see the call site)
                resets the blur for the next card. Pretty (tone-marked)
                but uncoloured: tone colours would bleed through the
                blur and telegraph the tones before the reveal. */}
            <BlurReveal
              text={prettyPinyin(card.reading)}
              className="text-muted-foreground"
              hiddenTitle="Click to reveal reading"
            />
          </div>
        )}
        {/* Same two-tone gate vocab-recall asks its recall questions
            with — No rose-left, Yes emerald-right. The question lives
            inside the gate, so no separate header above the word. */}
        <YesNoGate
          question="Do you know the meaning?"
          onYes={() => answer(true)}
          onNo={() => answer(false)}
          hint="yes: → / l / y / Enter   ·   no: ← / h / n"
        />
        <HintFooter>
          <div className="flex items-center gap-1">
            <KeyChip k={["←", "h"]} label="no" />
            <KeyChip k={["→", "l"]} label="yes" />
          </div>
        </HintFooter>
      </>
    );
  }

  // Reveal — gloss visible. "How well?" only after a Yes; No goes
  // straight to Continue since the user already conceded they didn't
  // know it.
  return (
    <>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {phase === "reveal-no" ? "Here's the meaning" : "How well?"}
      </div>
      <div className="mt-3 font-serif text-[40px] leading-none tracking-tight">
        {card.word}
      </div>
      {card.reading && (
        <div className="mt-2">
          <Pinyin raw={card.reading} className="text-[14px]" />
        </div>
      )}
      {card.gloss && (
        <p className="mt-4 mx-auto max-w-md text-[15px] text-foreground/90">
          {card.gloss.split(/;\s*/).slice(0, 4).join(" · ")}
        </p>
      )}
      {phase === "reveal-no" ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => finish(2)} size="sm">
            Continue
            <ArrowRight className="size-3.5" />
          </Button>
          <SpeakButton
            text={card.word}
            lang={lang}
            vocabId={card.id}
            cachedAudioAvailable={card.hasAudio}
            title="Replay"
          />
        </div>
      ) : (
        <>
          {/* Standard grade row — same component, colors, and keys as
              vocab-recall's graded stage. Good carries the suggested
              ring because Enter accepts it. */}
          <GradeRow
            className="mt-5"
            onGrade={(g) => finish(SELF_ASSESS_MISTAKES[g])}
            suggested="good"
            hints={SELF_ASSESS_HINTS}
          />
          <div className="mt-3 flex items-center justify-center">
            <SpeakButton
              text={card.word}
              lang={lang}
              vocabId={card.id}
              cachedAudioAvailable={card.hasAudio}
              title="Replay"
            />
          </div>
        </>
      )}
      <p className="mt-3 text-[11.5px] text-muted-foreground">
        {phase === "reveal-no" ? (
          <>
            <kbd className="rounded border bg-background px-1">Enter</kbd> to
            continue
          </>
        ) : (
          <>Enter accepts Good · 1 / 2 / 3 / 4 or a s d f to grade</>
        )}
      </p>
      <HintFooter>
        {phase === "reveal-yes" && <GradeKeyChips />}
        <div className="flex items-center gap-1">
          <KeyChip
            k={["Enter"]}
            label={phase === "reveal-no" ? "continue" : "good"}
          />
        </div>
      </HintFooter>
    </>
  );
}

function PickTonesStage({
  card,
  options,
  picked,
  feedback,
  onPick,
  onTryAgain,
  onSkip,
  reveal,
}: {
  card: VocabEntry;
  options: string[];
  picked: string | null;
  feedback: "idle" | "correct" | "wrong";
  onPick: (option: string) => void;
  onTryAgain: () => void;
  onSkip: () => void;
  reveal: string | null;
}) {
  const correctKey = readingKey(card.reading);
  return (
    <>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Pick the right tones
      </div>
      <div className="mt-3 font-serif text-[48px] leading-none tracking-tight">
        {card.word}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2">
        {options.map((opt) => {
          const isCorrect = opt === correctKey;
          const isPicked = opt === picked;
          const showResolution = feedback !== "idle";
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onPick(opt)}
              disabled={feedback !== "idle"}
              className={cn(
                "h-12 rounded-md border-2 px-3 font-serif text-[18px] transition-colors",
                showResolution && isPicked && isCorrect
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : showResolution && isPicked && !isCorrect
                    ? "border-rose-500 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                    : showResolution && isCorrect
                      ? "border-emerald-500/60 bg-emerald-500/5"
                      : "border-border bg-card hover:bg-accent/30",
                showResolution && !isPicked && !isCorrect && "opacity-60",
              )}
            >
              {prettyPinyin(opt)}
            </button>
          );
        })}
      </div>

      {feedback === "wrong" && reveal && (
        <div className="mt-3 flex items-center justify-center gap-2 rounded-md bg-rose-500/10 px-3 py-2 text-[13px] text-rose-700 dark:text-rose-300">
          <XCircle className="size-4 shrink-0" />
          <span>
            Correct tones:{" "}
            <span className="font-mono font-semibold">{reveal}</span>
          </span>
        </div>
      )}

      {feedback === "wrong" && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button onClick={onTryAgain} variant="outline" size="sm">
            Try again
          </Button>
          <Button onClick={onSkip} variant="ghost" size="sm">
            Skip stage
          </Button>
        </div>
      )}
    </>
  );
}

function PromptDisplay({
  card,
  stage,
  lang,
}: {
  card: VocabEntry;
  stage: StageDef;
  lang: LanguageCode;
}) {
  if (stage.kind === "promptCharacter") {
    return (
      <div className="mt-3 font-serif text-[48px] leading-none tracking-tight">
        {card.word}
      </div>
    );
  }
  if (stage.kind === "promptAudio") {
    return (
      <div className="mt-3 flex flex-col items-center justify-center gap-2 py-4">
        <div className="flex size-16 items-center justify-center rounded-full bg-foreground/5 text-foreground/70">
          <Volume2 className="size-7" />
        </div>
        <p className="text-[12px] text-muted-foreground">
          (Audio plays automatically — use the speaker to replay.)
        </p>
        <span className="sr-only">{card.word}</span>
        <span className="sr-only">{lang}</span>
      </div>
    );
  }
  // promptGloss
  return (
    <div className="mt-3 font-serif text-3xl leading-snug tracking-tight">
      {card.gloss ?? "(no gloss)"}
    </div>
  );
}

// ── Pure helpers (exported for tests) ──

/** Build a per-card stage plan. Strategy:
 *
 *   1. If the card is `new`, prepend an `intro` lesson stage so the
 *      user sees the character + reading + meaning + audio before
 *      they're tested. Mirrors Kaniwani's "Lessons" phase, scoped to
 *      one card at a time since our SRS already drip-feeds new cards.
 *   2. Pick `STAGES_PER_CARD` recall stages from the palette,
 *      enforcing variety across `(kind, answerField)` so the same
 *      card never asks for the same thing twice in a row.
 *   3. Drop any stage whose answer field is missing on the card
 *      (e.g. a vocab row imported without a reading). Picking an
 *      impossible stage isn't fatal — `check()` skips silently — but
 *      filtering up-front keeps the plan honest in the progress
 *      counter.
 *
 *  Exposed for tests. The `random` arg is here so tests can pass a
 *  seeded RNG; production callers use Math.random.
 */
export function planForCard(
  card: VocabEntry,
  palette: readonly StageDef[],
  random: () => number = Math.random,
): StageDef[] {
  // Filter palette to stages whose answer is actually available on
  // this card. Avoids planning a "type the reading" stage for a card
  // imported without a reading. An empty result is fine — new cards
  // still get an intro lesson even if recall is impossible.
  const usable = palette.filter((s) => {
    if (s.answerField === "reading") return !!card.reading?.trim();
    if (s.answerField === "gloss") return !!card.gloss?.trim();
    return true;
  });

  // Pick a varied subset. We shuffle then walk, keeping a stage only
  // if its (kind, answerField) pair hasn't been used yet on this
  // card. Once we've hit STAGES_PER_CARD or exhausted the palette,
  // we stop. The shuffle uses the provided random — Fisher-Yates so
  // tests with a deterministic random get reproducible plans.
  const shuffled = [...usable];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const seen = new Set<string>();
  const recall: StageDef[] = [];
  for (const s of shuffled) {
    const key = `${s.kind}:${s.answerField}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recall.push(s);
    if (recall.length >= STAGES_PER_CARD) break;
  }

  // Chain at most ONE `pickTones` stage after the first type-pinyin
  // (stripTones) stage in the plan. The user types the syllables
  // first, then picks the right tone variant — same one-two flow
  // the mobile sibling uses on zh, just chained per card here
  // instead of interleaved across cards. We cap at one per plan to
  // keep the tone-pick a fresh recall task rather than a rote
  // re-pick (it would be the same correct answer either time) and
  // to keep `(kind, answerField)` uniqueness across the plan.
  const hasReading = !!card.reading?.trim();
  const chained: StageDef[] = [];
  let tonePickAdded = false;
  for (const s of recall) {
    chained.push(s);
    if (
      !tonePickAdded &&
      s.stripTones &&
      s.answerField === "reading" &&
      hasReading
    ) {
      chained.push({
        kind: "pickTones",
        answerField: "reading",
        label: "Pick the right tones",
        placeholder: "",
      });
      tonePickAdded = true;
    }
  }

  // Prepend intro for brand-new cards. We deliberately use the card's
  // current status rather than e.g. reviewCount — `status` is the
  // single source of truth the SRS reads from.
  if (card.status === "new") {
    return [
      {
        kind: "intro",
        // The intro stage has no real answer field; pick `word` so
        // the data layer doesn't see a sentinel. `check()` never
        // runs on an intro stage anyway — advanceStage is called
        // directly from the "Got it" button.
        answerField: "word",
        label: "Lesson",
        placeholder: "",
      },
      ...chained,
    ];
  }
  return chained;
}

/** Group a card's flat plan into "atoms" — runs of consecutive
 *  stages that must play back-to-back on the same card. Today the
 *  only pairing is `pickTones` always glued to the type-pinyin stage
 *  that precedes it. Everything else is a single-stage atom. The
 *  wave interleaver emits one atom per card per wave, so paired
 *  challenges stay together even as cards take turns. */
export function plansToAtoms(plan: StageDef[]): StageDef[][] {
  const atoms: StageDef[][] = [];
  let i = 0;
  while (i < plan.length) {
    const s = plan[i]!;
    const next = plan[i + 1];
    if (
      next &&
      next.kind === "pickTones" &&
      s.stripTones &&
      s.answerField === "reading"
    ) {
      atoms.push([s, next]);
      i += 2;
    } else {
      atoms.push([s]);
      i += 1;
    }
  }
  return atoms;
}

/** Walk every card's plan wave-by-wave, shuffling within each wave
 *  so cards take turns in random order. Each wave emits one atom per
 *  card (so a type-pinyin + pickTones pair stays glued on that card,
 *  but ABCD-A's first atom plays before ABCD-A's second atom). The
 *  result is a flat task list the runner advances through one task
 *  at a time. */
export function buildInterleavedTasks(
  queue: readonly VocabEntry[],
  plans: Record<number, StageDef[]>,
  random: () => number = Math.random,
): TaskRef[] {
  // Per-card: list of atoms AND the starting stageInPlanIdx of each
  // atom (so we can emit the right stage indices into the task).
  const atomsByCardId = new Map<number, { atom: StageDef[]; baseIdx: number }[]>();
  for (const c of queue) {
    const plan = plans[c.id] ?? [];
    const atoms = plansToAtoms(plan);
    let baseIdx = 0;
    const entries: { atom: StageDef[]; baseIdx: number }[] = [];
    for (const atom of atoms) {
      entries.push({ atom, baseIdx });
      baseIdx += atom.length;
    }
    atomsByCardId.set(c.id, entries);
  }
  const maxAtoms = Math.max(
    0,
    ...Array.from(atomsByCardId.values()).map((arr) => arr.length),
  );
  const tasks: TaskRef[] = [];
  for (let waveIdx = 0; waveIdx < maxAtoms; waveIdx++) {
    const wave: { cardId: number; atom: StageDef[]; baseIdx: number }[] = [];
    for (const c of queue) {
      const entries = atomsByCardId.get(c.id);
      const entry = entries?.[waveIdx];
      if (entry) wave.push({ cardId: c.id, atom: entry.atom, baseIdx: entry.baseIdx });
    }
    // Fisher–Yates so the same card doesn't always come first.
    for (let i = wave.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [wave[i], wave[j]] = [wave[j]!, wave[i]!];
    }
    for (const w of wave) {
      for (let k = 0; k < w.atom.length; k++) {
        tasks.push({ cardId: w.cardId, stageInPlanIdx: w.baseIdx + k });
      }
    }
  }
  return tasks;
}

function expectedAnswer(card: VocabEntry, stage: StageDef): string | null {
  if (stage.answerField === "reading") return card.reading?.trim() || null;
  if (stage.answerField === "word") return card.word.trim();
  if (stage.answerField === "gloss") return card.gloss?.trim() || null;
  return null;
}

const TONE_MAP: Record<string, string> = {
  ā: "a", á: "a", ǎ: "a", à: "a", ē: "e", é: "e", ě: "e", è: "e",
  ī: "i", í: "i", ǐ: "i", ì: "i", ō: "o", ó: "o", ǒ: "o", ò: "o",
  ū: "u", ú: "u", ǔ: "u", ù: "u", ǖ: "u", ǘ: "u", ǚ: "u", ǜ: "u",
  ü: "u", Ā: "a",
};

function stripTones(s: string): string {
  return s
    .toLowerCase()
    .replace(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüĀ]/g, (c) => TONE_MAP[c] ?? c);
}

function normaliseSpacing(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

// Common English contractions collapsed both ways so "iam sorry"
// matches "I'm sorry" and "you are nice" matches "you're nice". The
// mapping is applied to BOTH user input and each gloss sense so they
// normalise to the same expanded form regardless of which form the
// content pack ships. Real words that would corrupt legitimate
// glosses ("were" / "well" / "ill" / "shell" / "hell") are NOT
// expanded — the false-match risk isn't worth it.
const CONTRACTION_EXPANSIONS: Array<[RegExp, string]> = [
  [/\bcouldnt\b/g, "could not"],
  [/\bshouldnt\b/g, "should not"],
  [/\bwouldnt\b/g, "would not"],
  [/\bdoesnt\b/g, "does not"],
  [/\bdidnt\b/g, "did not"],
  [/\bwasnt\b/g, "was not"],
  [/\bisnt\b/g, "is not"],
  [/\barent\b/g, "are not"],
  [/\bhavent\b/g, "have not"],
  [/\bhadnt\b/g, "had not"],
  [/\bhasnt\b/g, "has not"],
  [/\bwerent\b/g, "were not"],
  [/\byoure\b/g, "you are"],
  [/\btheyre\b/g, "they are"],
  [/\btheyve\b/g, "they have"],
  [/\bweve\b/g, "we have"],
  [/\byouve\b/g, "you have"],
  [/\btheyll\b/g, "they will"],
  [/\byoull\b/g, "you will"],
  [/\bdont\b/g, "do not"],
  [/\bcant\b/g, "can not"],
  [/\bwont\b/g, "will not"],
  [/\bshes\b/g, "she is"],
  [/\bhes\b/g, "he is"],
  [/\bits\b/g, "it is"],
  [/\bthats\b/g, "that is"],
  [/\bwhats\b/g, "what is"],
  [/\biam\b/g, "i am"],
  [/\bim\b/g, "i am"],
];

function expandContractions(s: string): string {
  let out = s;
  for (const [re, repl] of CONTRACTION_EXPANSIONS) out = out.replace(re, repl);
  return out;
}

/** Normalise a gloss sense for comparison: lowercase, drop
 *  parenthetical clarifiers like "(plural)" / "(formal)" that qualify
 *  the meaning but aren't part of the answer, strip stray punctuation
 *  apart from spaces, collapse whitespace, then expand contractions.
 *  Apostrophes are stripped before expansion so "I'm" / "Im" / "iam"
 *  all funnel to the same form. */
function normaliseGlossSense(s: string): string {
  const stripped = s
    .toLowerCase()
    .normalize("NFC")
    .replace(/^(to|a|an|the)\s+/i, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, "")
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return expandContractions(stripped);
}

/** Forgiving compare. zh pinyin: tones optional. CJK: ignore spacing.
 *  Multi-sense glosses ("hello; hi; how are you"): accept any sense,
 *  with parenthetical qualifiers stripped and common English
 *  contractions normalised so "iam sorry" matches "I'm sorry" and
 *  "you" matches "you (plural)". When `acceptReadingAlternate` is on
 *  (zh `word`-answer stages), the caller threads in the card's
 *  reading via `readingAlt` so a learner who hasn't drilled the
 *  characters yet can type the pinyin and still match. */
export function isAcceptableAnswer(
  user: string,
  expected: string,
  stage: StageDef,
  readingAlt?: string | null,
): boolean {
  const u = user.trim();
  if (!u) return false;
  if (stage.stripTones) {
    return (
      stripTones(normaliseSpacing(u)) === stripTones(normaliseSpacing(expected))
    );
  }
  // `word`-answer stages on zh accept either the character form
  // (exact, after spacing-normalisation) OR the tone-stripped pinyin
  // of the card's reading. The reading is provided by the caller
  // since the answer-matcher doesn't have access to the VocabEntry.
  if (stage.acceptReadingAlternate && readingAlt) {
    const userKey = stripTones(normaliseSpacing(u));
    const readingKey = stripTones(normaliseSpacing(readingAlt));
    if (userKey && userKey === readingKey) return true;
  }
  // Glosses split on ";" / "/" / "," count as alternates. Each sense
  // and the user input both run through normaliseGlossSense so
  // parentheticals + contraction-variants converge before compare.
  const userNorm = normaliseGlossSense(u);
  if (!userNorm) return false;
  if (/[;/,]/.test(expected)) {
    const senses = expected
      .split(/[;/,]/)
      .map((s) => normaliseGlossSense(s))
      .filter(Boolean);
    if (senses.includes(userNorm)) return true;
  }
  if (normaliseGlossSense(expected) === userNorm) return true;
  return normaliseSpacing(u) === normaliseSpacing(expected);
}
