import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import HanziWriter from "hanzi-writer";
import {
  Brush,
  Check,
  Eraser,
  Eye,
  ListOrdered,
  Pencil,
  RotateCcw,
  SkipForward,
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
import { Progress } from "@/components/ui/progress";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SpeakButton } from "@/components/speak-button";
import { Pinyin } from "@/components/pinyin";
import { deleteVocab } from "@/lib/db";
import { loadStrokeData } from "@/lib/hanzi-stroke-data";
import {
  PauseOverlay,
  SessionTopBarControls,
  useActiveSessionTime,
} from "@/lib/study/session-controls";
import type {
  StudyPlugin,
  StudyViewProps,
  VocabEntry,
} from "@/lib/study/api";
import { PrestartShell } from "@/lib/study/prestart";
import { cn } from "@/lib/utils";

// Hanzi/kanji range. Kana is intentionally excluded — hanzi-writer-data
// doesn't ship stroke data for kana.
const CJK_RX = /[一-鿿㐀-䶿]/;

// Tianzige (田字格) practice-grid background — the faint cross-hair every
// CJK writing sheet uses. Shared by the live canvas, the answer tile, and
// the per-character review strip so they read as one family.
const TIANZIGE =
  "[background-image:linear-gradient(to_right,rgba(120,120,135,0.16)_1px,transparent_1px),linear-gradient(to_bottom,rgba(120,120,135,0.16)_1px,transparent_1px)] [background-size:50%_50%] [background-position:center]";

const hanziWriting: StudyPlugin = {
  meta: {
    id: "hanzi-writing",
    name: "Handwriting practice",
    description:
      "Draw each character stroke-by-stroke. Real-time stroke-order corrections.",
    icon: Brush,
    supportedLangs: ["zh", "ja"],
  },
  StudyView,
};

export default hanziWriting;

type CharProgress = {
  done: boolean;
  mistakes: number;
};

/** One character's captured drawing, grabbed the moment the learner
 *  leaves it. `svg` is the HanziWriter render (quiz mode); `ink` is the
 *  free-draw overlay's literal strokes as a PNG data URL. Either may be
 *  null (e.g. a character skipped before any ink was laid down). */
type CharShot = { svg: string | null; ink: string | null };

/** A boolean toggle backed by localStorage so its state survives across
 *  study sessions. Reads once on mount, writes on every change. Falls
 *  back to `fallback` when nothing is stored yet (or during SSR). Keeps
 *  every practice control persistent without a hand-written effect per
 *  toggle. */
function usePersistentToggle(key: string, fallback: boolean) {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(key, value ? "1" : "0");
    }
  }, [key, value]);
  return [value, setValue] as const;
}

function StudyView({ ctx }: StudyViewProps) {
  // Honor the writing-practice queue handoff from the dictionary detail page.
  // If the user clicked "Writing practice" on a word, that word jumps to the
  // front of the queue so it's the first thing they see when they open Study.
  // The handoff lives in localStorage so it survives a refresh and isn't
  // lost on view-switch.
  const [queue, setQueue] = useState<VocabEntry[]>(() => {
    const base = pickWritableCards(ctx.dueVocab, ctx.vocab);
    try {
      const raw = localStorage.getItem("tokori:writing-queue");
      if (!raw) return base;
      const parsed = JSON.parse(raw) as { word?: string; ts?: number };
      // Stale handoffs (older than 5 min) are ignored — those are leftovers
      // from a previous click the user already forgot about.
      if (
        !parsed?.word ||
        typeof parsed.ts !== "number" ||
        Date.now() - parsed.ts > 5 * 60_000
      ) {
        return base;
      }
      // Promote the queued word to position 0; if it isn't already in vocab
      // we synthesise a placeholder entry so the writer at least shows it.
      localStorage.removeItem("tokori:writing-queue");
      const queuedFromVocab = ctx.vocab.find((v) => v.word === parsed.word);
      if (queuedFromVocab) {
        return [
          queuedFromVocab,
          ...base.filter((v) => v.id !== queuedFromVocab.id),
        ];
      }
      return base;
    } catch {
      return base;
    }
  });
  const [cardIdx, setCardIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [progress, setProgress] = useState<CharProgress[]>([]);
  // Per-character drawing snapshots, captured the instant the learner
  // leaves each character. The end-of-card review panel replays every
  // one so a multi-character word shows the whole word the user drew —
  // not just the final glyph, which is all the single live HanziWriter
  // container would otherwise retain.
  const [shots, setShots] = useState<(CharShot | null)[]>([]);
  // Set when the user has just finished drawing the LAST character of
  // the active card. We hold here on a "your drawing / answer" review
  // panel so the user can compare against the canonical form before
  // moving on — no auto-advance. The card is graded only when the user
  // taps "Next card" (see finishCard).
  const [cardReview, setCardReview] = useState(false);
  const [done, setDone] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pendingNeverAgain, setPendingNeverAgain] = useState<VocabEntry | null>(null);
  // Active-only time accumulator — pauses for backgrounded tabs and
  // for the in-app pause overlay so duration reflects time the user
  // actually spent practising.
  const getActiveSecs = useActiveSessionTime(paused);

  // Practice toggles — all persisted (usePersistentToggle) so the
  // controls a learner sets carry over to their next session instead of
  // resetting every time Handwriting practice opens.
  const [tutorialOn, setTutorialOn] = usePersistentToggle(
    "hanzi-writing.tutorial",
    false,
  );
  // First-run stroke-order demo. The very first time anyone opens
  // Handwriting practice we animate the first character (even with the
  // Tutorial toggle off), leave its outline up, and hand them the quiz —
  // a one-time "here's how this works". Persisted so it never fires
  // again. `introPlaying` mirrors it into render state (for the caption)
  // and the writer effect; it's intentionally NOT in that effect's dep
  // list (see the eslint-disable there) so its true→false flip can't
  // remount the writer mid-demo.
  const [introSeen, setIntroSeen] = usePersistentToggle(
    "hanzi-writing.introSeen",
    false,
  );
  const [introPlaying, setIntroPlaying] = useState(() => !introSeen);
  const [showHints, setShowHints] = usePersistentToggle(
    "hanzi-writing.showHints",
    true,
  );
  // Free draw mode replaces the strict HanziWriter quiz with a blank
  // canvas overlay; the outline shows behind as a target.
  const [freeDraw, setFreeDraw] = usePersistentToggle(
    "hanzi-writing.freeDraw",
    false,
  );
  // Default off — leaking the reading in the prompt telegraphs the
  // character and undermines the recall test. The toggle stays available
  // in the action row for whoever wants the scaffold.
  const [showPinyin, setShowPinyin] = usePersistentToggle(
    "hanzi-writing.showPinyin",
    false,
  );
  // `blindCanvas` only takes effect while free-draw is active — quiz mode
  // needs the outline as a drawing target.
  const [blindCanvas, setBlindCanvas] = usePersistentToggle(
    "hanzi-writing.blindCanvas",
    false,
  );
  // Collapsible stroke-order reference under the canvas — off by default
  // so it never reveals the answer unless the learner asks for it.
  const [showStrokes, setShowStrokes] = usePersistentToggle(
    "hanzi-writing.showStrokes",
    false,
  );
  // Hide the character outline when the learner toggles it off. In quiz
  // mode this becomes a write-from-memory drill — HanziWriter still
  // validates strokes and reveals a hint after a miss
  // (showHintAfterMisses). In free-draw mode it's the same blank canvas.
  const hideOutline = blindCanvas;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const writerRef = useRef<HanziWriter | null>(null);
  // Lifted from the live FreeDrawCanvas so we can snapshot the learner's
  // literal pen strokes when they leave a character in free-draw mode.
  const freeInkRef = useRef<HTMLCanvasElement | null>(null);
  const handleFreeInk = useCallback((c: HTMLCanvasElement | null) => {
    freeInkRef.current = c;
  }, []);
  // Latest progress for the active char — accessed inside HanziWriter callbacks.
  const charMistakesRef = useRef(0);
  // Prestart gate — flip drill mode / pick session size before drawing
  // any character. Off by default so the user is reminded that grades
  // flow into FSRS unless they opt out.
  const [started, setStarted] = useState(false);
  // Bumped by "Restart char" to force the writer effect to remount when
  // nothing else in its deps changes — same card, same position, same
  // glyph. (Previously faked with a setTutorialOn double-toggle, which
  // React batched into a no-op so the restart silently did nothing.)
  const [restartNonce, setRestartNonce] = useState(0);

  // Keep the session alive while drawing, but never fight a manual
  // pause. `ctx` is rebuilt as the session clock ticks — and the instant
  // we pause, because `paused` is in ensureStarted's deps. Re-running
  // ensureSessionStarted on each rebuild is what keeps the 5-minute
  // idle-timeout from firing mid-session. The `paused` guard is load-
  // bearing: without it, the rebuild triggered by pausing would call
  // ensureSessionStarted, which auto-resumes a paused session — so the
  // pause + frozen clock wouldn't stick. (Mirrors vocab-recall.)
  useEffect(() => {
    if (!started || paused) return;
    void ctx.ensureSessionStarted("review");
  }, [ctx, started, paused]);

  // Every hook below — the `chars` memo and the two effects — must run on
  // every render, including while the prestart gate is still up. So the
  // gate's early `return` lives *after* them (just past the HanziWriter
  // effect), not here: returning here would make the prestart render call
  // fewer hooks than the drawing render and crash React with "rendered
  // more hooks than during the previous render".
  const card = queue[cardIdx];
  const chars = useMemo(
    () => (card ? [...card.word].filter((c) => CJK_RX.test(c)) : []),
    [card],
  );
  const currentChar = chars[charIdx] ?? null;

  // Reset per-card progress whenever the card changes.
  useEffect(() => {
    setProgress(chars.map(() => ({ done: false, mistakes: 0 })));
    setShots(chars.map(() => null));
    setCharIdx(0);
    setCardReview(false);
    charMistakesRef.current = 0;
  }, [card?.id, chars.length]);

  // Mount + drive HanziWriter for the active character.
  //
  // Three rendering modes layered on the same container:
  //
  //   • Quiz mode    (default) — stroke-by-stroke validation, mistakes
  //                              are counted, completion auto-advances.
  //   • Free draw    — outline is shown but no quiz; the FreeDrawCanvas
  //                    component overlays a transparent canvas where the
  //                    user scribbles freely. Advance happens via the
  //                    "Done" button in free-draw controls.
  //   • Tutorial     — animates the stroke order first; then either
  //                    starts the quiz or just leaves the outline visible
  //                    (free draw branch).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !currentChar) return;
    container.innerHTML = "";
    let cancelled = false;
    charMistakesRef.current = 0;

    const writer = HanziWriter.create(container, currentChar, {
      width: 280,
      height: 280,
      padding: 12,
      // In free-draw mode we'd normally want the outline visible as
      // a guide; the overlay canvas handles drawing and we never call
      // quiz() in that branch. But when `blindCanvas` is on the user
      // wants a truly blank canvas — they're recalling the character
      // from the gloss alone — so we suppress the outline too.
      showOutline: !hideOutline,
      showCharacter: false,
      strokeColor: "#10b981",
      outlineColor: "rgba(120,120,135,0.30)",
      highlightColor: "#34d399",
      drawingColor: "#0f766e",
      drawingWidth: 6,
      delayBetweenStrokes: 220,
      strokeAnimationSpeed: 1.1,
      charDataLoader: (charToLoad, onComplete, onError) => {
        loadStrokeData(charToLoad)
          .then((data) => {
            if (cancelled) return;
            if (!data) {
              if (onError) onError(new Error(`no stroke data for ${charToLoad}`));
              return;
            }
            onComplete(data);
          })
          .catch((err) => {
            if (!cancelled && onError) onError(err);
          });
      },
    });
    writerRef.current = writer;

    function startQuiz() {
      writer.quiz({
        leniency: 2.5,
        showHintAfterMisses: showHints ? 1 : Infinity,
        onMistake: () => {
          charMistakesRef.current += 1;
          // Mirror into state so the visible counter updates.
          setProgress((prev) =>
            prev.map((p, i) =>
              i === charIdx ? { ...p, mistakes: p.mistakes + 1 } : p,
            ),
          );
        },
        onComplete: () => {
          if (cancelled) return;
          setProgress((prev) =>
            prev.map((p, i) => (i === charIdx ? { ...p, done: true } : p)),
          );
          // Brief pause for the success flash, then advance.
          setTimeout(() => {
            if (cancelled) return;
            advanceFromChar();
          }, 420);
        },
      });
    }

    // Demo the stroke order when the Tutorial toggle is on, or once on
    // the very first run (introPlaying). introPlaying is read here but
    // deliberately omitted from the dep list below — it only transitions
    // true→false, and that flip must not remount the writer mid-demo.
    if (tutorialOn || introPlaying) {
      writer.animateCharacter({
        onComplete: () => {
          if (cancelled) return;
          // First-run demo is one-and-done — remember it and let the
          // rest of the word be the learner's own.
          if (introPlaying) {
            setIntroPlaying(false);
            setIntroSeen(true);
          }
          // Free draw mode skips the quiz — leave the outline visible
          // and let the FreeDrawCanvas overlay take over.
          if (!freeDraw) startQuiz();
        },
      });
    } else if (!freeDraw) {
      startQuiz();
    }
    // No else branch — in free-draw without tutorial we just leave the
    // outline as-is for the overlay to draw on top of.

    return () => {
      cancelled = true;
      try {
        writerRef.current = null;
        container.innerHTML = "";
      } catch {
        /* noop */
      }
    };
    // `started` is in the deps so the writer mounts the instant the user
    // leaves the prestart gate. During prestart the container ref is null
    // (the drawing JSX isn't mounted yet) so this effect no-ops; when
    // `started` flips true the drawing JSX mounts and the effect re-runs
    // against a real container.
    //
    // The deps key on the *position* — `card?.id` + `charIdx` — not just
    // the glyph (`currentChar`). Advancing between two identical adjacent
    // characters (謝謝, 爸爸, 拜拜, 星星, …) leaves the glyph string
    // unchanged, so a currentChar-only dep saw "no change", skipped the
    // remount, and left a dead canvas that ignored every stroke until an
    // unrelated dep flipped (toggling Tutorial was the accidental fix).
    // `cardReview` re-inits the writer when the review panel closes for
    // the next card (covers two identical single-char cards back to
    // back); `restartNonce` lets "Restart char" force the same remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    card?.id,
    charIdx,
    currentChar,
    cardReview,
    restartNonce,
    tutorialOn,
    showHints,
    freeDraw,
    hideOutline,
    started,
  ]);

  // Prestart gate — kept after all hooks above so the hook order is
  // identical before and after "Start drawing" (see the NOTE by `card`).
  if (!started) {
    return (
      <PrestartShell
        icon={Brush}
        pluginName="Handwriting practice"
        title={
          queue.length === 0
            ? "Nothing to draw yet."
            : `${queue.length} card${queue.length === 1 ? "" : "s"} ready.`
        }
        description={
          queue.length === 0
            ? "Save some words with CJK characters first, or wait for cards to become due."
            : "Draw each character stroke-by-stroke. Real-time stroke-order corrections; mistakes feed the FSRS grade."
        }
        drillMode={ctx.drillMode}
        setDrillMode={ctx.setDrillMode}
        srsAnchorState={ctx.srsAnchorState}
        onStart={queue.length === 0 ? undefined : () => setStarted(true)}
        startLabel="Start drawing"
      />
    );
  }

  // Pause/resume drive the session clock too (ctx.pauseSession →
  // session-context), so the sidebar timer and the idle auto-end freeze
  // while the pause overlay is up — matching the sidebar's own Pause and
  // the sibling plugins. Local `paused` also freezes useActiveSessionTime
  // and shows the overlay.
  function doPause() {
    if (paused) return;
    setPaused(true);
    ctx.pauseSession();
  }
  function doResume() {
    if (!paused) return;
    setPaused(false);
    ctx.resumeSession();
  }

  // Snapshot the active character before we move off it. Quiz mode
  // leaves the finished glyph in the HanziWriter <svg>; free-draw keeps
  // the learner's strokes on the overlay canvas. We grab whichever
  // applies so the review panel can replay the whole word — not just the
  // last glyph the single live container would otherwise retain.
  function captureChar(idx: number) {
    const svg = containerRef.current?.querySelector("svg")?.outerHTML ?? null;
    const ink = freeDraw
      ? freeInkRef.current?.toDataURL("image/png") ?? null
      : null;
    setShots((prev) => {
      const next = [...prev];
      next[idx] = { svg, ink };
      return next;
    });
  }

  function advanceFromChar() {
    captureChar(charIdx);
    const isLastChar = charIdx + 1 >= chars.length;
    if (!isLastChar) {
      setCharIdx((i) => i + 1);
      return;
    }
    // Last char of the card is done — enter the review panel instead
    // of grading + advancing right away. The user taps "Next card"
    // (see finishCard) once they're ready to move on.
    setCardReview(true);
  }

  function finishCard() {
    if (!card) return;
    const totalMistakes =
      progress.reduce((sum, p) => sum + p.mistakes, 0) +
      charMistakesRef.current;
    const grade =
      totalMistakes === 0 ? "easy" : totalMistakes <= 2 ? "good" : "again";
    void ctx.reviewVocab(card.id, grade);
    void ctx.bump("words_seen");
    setDone((d) => d + 1);
    setCardIdx((i) => i + 1);
  }

  function skipChar() {
    // Reveal the answer animation, count it as needing-more-practice, advance.
    setProgress((prev) =>
      prev.map((p, i) =>
        i === charIdx ? { ...p, mistakes: Math.max(p.mistakes, 3) } : p,
      ),
    );
    advanceFromChar();
  }

  function skipCard() {
    if (!card) return;
    void ctx.reviewVocab(card.id, "again");
    setDone((d) => d + 1);
    setCardIdx((i) => i + 1);
  }

  // Boost = study this card again later in the session. Marks "again" for
  // FSRS and re-inserts the card 5 positions ahead.
  function actionBoost() {
    if (!card) return;
    void ctx.reviewVocab(card.id, "again");
    setQueue((prev) => {
      const next = [...prev];
      const insertAt = Math.min(prev.length, cardIdx + 5);
      next.splice(insertAt, 0, card);
      return next;
    });
    setDone((d) => d + 1);
    setCardIdx((i) => i + 1);
    toast.success(`Boosted "${card.word}" — coming back soon`);
  }

  // Never show again — gated by the AlertDialog at the bottom of the
  // tree. The actual delete runs in confirmNeverAgain below; this just
  // opens the prompt.
  function startNeverAgain() {
    if (!card) return;
    setPendingNeverAgain(card);
  }

  async function confirmNeverAgain() {
    const target = pendingNeverAgain;
    setPendingNeverAgain(null);
    if (!target) return;
    await deleteVocab(target.id);
    setQueue((prev) => prev.filter((v) => v.id !== target.id));
    toast(`Removed "${target.word}"`);
  }

  function tryAgain() {
    // Reset the active char's progress, then bump the nonce to remount the
    // writer + restart the quiz. The effect's cleanup clears the container,
    // so we don't wipe it by hand here.
    setProgress((prev) =>
      prev.map((p, i) =>
        i === charIdx ? { done: false, mistakes: 0 } : p,
      ),
    );
    charMistakesRef.current = 0;
    setRestartNonce((n) => n + 1);
  }

  if (queue.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Brush className="size-6 text-muted-foreground" />
        <h2 className="font-serif text-2xl tracking-tight">Nothing to write yet.</h2>
        <p className="max-w-md text-[13.5px] text-muted-foreground">
          Save some vocabulary that contains hanzi or kanji first. Words made entirely of
          kana / latin letters can't be drilled here — try Sentence Mining or Kaniwani for those.
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

  if (!card) {
    const totalMistakes = 0; // already graded each card individually
    void totalMistakes;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <h2 className="font-serif text-3xl tracking-tight">Session complete.</h2>
        <p className="text-[13.5px] text-muted-foreground">
          {done} card{done === 1 ? "" : "s"} ·{" "}
          {Math.max(1, Math.floor(getActiveSecs() / 60))} min
        </p>
        <Button
          variant="outline"
          onClick={() =>
            ctx.onSessionEnd({
              cardsReviewed: done,
              durationSecs: getActiveSecs(),
              extra: { mode: "hanzi-writing" },
            })
          }
        >
          End session
        </Button>
      </div>
    );
  }

  const cardMistakes = progress.reduce((s, p) => s + p.mistakes, 0);

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <div className="border-b border-border px-6 pt-2 pb-3">
          <div className="flex w-full items-center gap-4">
            <p className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {cardIdx + 1} / {queue.length}
              {chars.length > 1 && (
                <span className="ml-2">
                  · char {Math.min(charIdx + 1, chars.length)} / {chars.length}
                </span>
              )}
            </p>
            <div className="flex-1">
              <Progress
                value={
                  ((cardIdx + (chars.length ? charIdx / chars.length : 0)) /
                    queue.length) *
                  100
                }
              />
            </div>
            <SessionTopBarControls
              onBoost={actionBoost}
              onNeverAgain={startNeverAgain}
              onPause={doPause}
            />
          </div>
        </div>
      </TooltipProvider>

      <div className="flex flex-1 flex-col items-center gap-4 px-6 py-6 overflow-y-auto">
        {/* Prompt */}
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {card.gloss ? "Write the word for…" : "Write the character"}
          </p>
          {card.gloss && (
            <p className="font-serif text-xl text-foreground/90">{card.gloss}</p>
          )}
          {card.reading && showPinyin && (
            <Pinyin raw={card.reading} className="text-[13px] text-muted-foreground" />
          )}
          {introPlaying && !cardReview && (
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              Watch the stroke order once, then trace it yourself.
            </p>
          )}
        </div>

        {/* Per-character chips for multi-char words */}
        {chars.length > 1 && (
          <div className="flex flex-wrap justify-center gap-1.5">
            {chars.map((c, i) => {
              const p = progress[i];
              const active = i === charIdx;
              // Blur characters you haven't drawn yet — the chips must not
              // give away the answer when the whole point is recall. Done
              // chars stay legible (you already wrote them); any blurred
              // chip un-blurs on hover for a quick peek.
              return (
                <span
                  key={i}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-serif text-[14px]",
                    p?.done
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : active
                        ? "border-foreground/40 bg-foreground/5 text-foreground"
                        : "border-border text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "transition-[filter] duration-150",
                      !p?.done && "blur-[5px] hover:blur-none",
                    )}
                  >
                    {c}
                  </span>
                </span>
              );
            })}
          </div>
        )}

        {/* Drawing canvas + optional free-draw overlay. The relative
            wrapper lets the FreeDrawCanvas absolutely-position itself
            on top of the HanziWriter SVG without disrupting the
            existing layout / sizing.
            In review state we render an "Answer" panel beside the
            canvas so the user can compare their drawing to the
            canonical form before tapping Next card. The canvas
            itself stays mounted (one container, one ref) so the
            HanziWriter handle survives the transition. */}
        <div className="flex flex-wrap items-stretch justify-center gap-4">
          <div className="flex flex-col items-center">
            {cardReview && (
              <p className="mb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                Your drawing
              </p>
            )}
            {cardReview ? (
              <DrawingRecap shots={shots} chars={chars} />
            ) : (
              <div
                className="relative"
                key={`wrap-${card.id}-${charIdx}-${freeDraw ? "free" : "quiz"}`}
              >
                <div
                  ref={containerRef}
                  className={cn(
                    "flex aspect-square w-[280px] items-center justify-center rounded-xl bg-background/40",
                    TIANZIGE,
                  )}
                />
                {freeDraw && (
                  <FreeDrawCanvas
                    key={`fd-${card.id}-${charIdx}`}
                    size={280}
                    className="absolute inset-0"
                    onCanvasReady={handleFreeInk}
                  />
                )}
              </div>
            )}
          </div>
          {cardReview && (
            <div className="flex flex-col items-center">
              <p className="mb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                Answer
              </p>
              <div
                className={cn(
                  "flex aspect-square w-[280px] items-center justify-center rounded-xl bg-background/40",
                  TIANZIGE,
                )}
              >
                <span
                  className="font-serif text-foreground"
                  style={{
                    fontSize: chars.length > 1 ? 110 : 180,
                    lineHeight: 1,
                  }}
                >
                  {card.word}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Collapsible stroke-order reference. Sits directly under the
            canvas; toggled by the "Strokes" button in the action row.
            Keyed by character so it remounts (and reloads) cleanly when
            you advance. Builds the character one stroke at a time so a
            learner can check order without revealing the whole word. */}
        {showStrokes && currentChar && (
          <StrokeOrder key={currentChar} char={currentChar} />
        )}

        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>
            mistakes: <span className="font-medium text-foreground">{cardMistakes}</span>
          </span>
          {!showHints && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[10.5px]">
              hints off
            </span>
          )}
        </div>

        {/* Card-review primary action — replaces the action row while
            the user is comparing their drawing to the answer. Tapping
            Next card runs finishCard (grade + advance to next card).
            cardReview is auto-cleared when the card changes. */}
        {cardReview && (
          <div className="flex flex-col items-center gap-2">
            <Button
              size="lg"
              onClick={() => {
                finishCard();
              }}
            >
              Next card
            </Button>
            <p className="text-[11px] text-muted-foreground">
              {cardMistakes === 0
                ? "Clean run."
                : `${cardMistakes} mistake${cardMistakes === 1 ? "" : "s"}.`}
            </p>
          </div>
        )}

        {/* Action row. Free-draw mode swaps the quiz-specific controls
            (Restart char / Hints / Skip char) for a Done button — the
            user advances manually since there's no auto-completion.
            Hidden while in card-review so the focus is on the Next
            button + the comparison. */}
        {!cardReview && (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <Button
            size="sm"
            variant={freeDraw ? "default" : "outline"}
            onClick={() => setFreeDraw((v) => !v)}
            title={
              freeDraw
                ? "Switch back to stroke-order quiz mode"
                : "Free-draw mode — sketch on a blank canvas without quiz feedback"
            }
          >
            <Pencil className="size-3.5" />
            Free draw
          </Button>
          <Button
            size="sm"
            variant={tutorialOn ? "default" : "ghost"}
            onClick={() => setTutorialOn((v) => !v)}
            title="Animate the stroke order before each char"
          >
            <Eye className="size-3.5" />
            Tutorial
          </Button>
          <Button
            size="sm"
            variant={showStrokes ? "default" : "ghost"}
            onClick={() => setShowStrokes((v) => !v)}
            title={
              showStrokes
                ? "Hide the stroke-order reference"
                : "Show the stroke order for this character under the canvas"
            }
          >
            <ListOrdered className="size-3.5" />
            Strokes
          </Button>
          {card.reading && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowPinyin((v) => !v)}
              title={
                showPinyin
                  ? "Hide the pinyin / reading at the top"
                  : "Show the pinyin / reading at the top"
              }
            >
              Pinyin {showPinyin ? "on" : "off"}
            </Button>
          )}
          <Button
            size="sm"
            variant={blindCanvas ? "default" : "ghost"}
            onClick={() => setBlindCanvas((v) => !v)}
            title={
              blindCanvas
                ? "Show the character outline as a tracing guide"
                : "Hide the outline — draw from memory (a hint still appears after a miss)"
            }
          >
            {blindCanvas ? "Show outline" : "Hide outline"}
          </Button>
          {freeDraw ? (
            <Button size="sm" variant="ghost" onClick={advanceFromChar}>
              <Check className="size-3.5" />
              Done
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={tryAgain}>
                <RotateCcw className="size-3.5" />
                Restart char
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowHints((v) => !v)}
                title={showHints ? "Hints on after one miss" : "No hints — strict mode"}
              >
                Hints {showHints ? "on" : "off"}
              </Button>
              <Button size="sm" variant="ghost" onClick={skipChar}>
                <SkipForward className="size-3.5" />
                Skip char
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={skipCard}>
            Skip card
          </Button>
          <SpeakButton
            text={card.word}
            lang={ctx.workspace.targetLang}
            vocabId={card.id}
            cachedAudioAvailable={card.hasAudio}
          />
        </div>
        )}
      </div>

      {/* Pause overlay — fullscreen take-a-break with Resume / End.
          End ships partial stats so the host's session-summary screen
          still gets accurate numbers. */}
      {paused && (
        <PauseOverlay
          progress={
            queue.length > 0
              ? ((cardIdx + (chars.length ? charIdx / chars.length : 0)) /
                  queue.length) *
                100
              : 0
          }
          done={done}
          total={queue.length}
          elapsedSecs={getActiveSecs()}
          onResume={doResume}
          onEnd={() =>
            ctx.onSessionEnd({
              cardsReviewed: done,
              durationSecs: getActiveSecs(),
              extra: { mode: "hanzi-writing" },
            })
          }
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

// Transparent overlay positioned over the HanziWriter SVG so the character
// outline shows through underneath as a guide.
function FreeDrawCanvas({
  size,
  className,
  onCanvasReady,
}: {
  size: number;
  className?: string;
  /** Hands the parent the live <canvas> so it can snapshot the strokes
   *  for the end-of-card review panel. */
  onCanvasReady?: (c: HTMLCanvasElement | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Mirror the node into both our own ref (used for drawing) and the
  // parent's snapshot ref via one callback ref.
  const setCanvasNode = useCallback(
    (node: HTMLCanvasElement | null) => {
      canvasRef.current = node;
      onCanvasReady?.(node);
    },
    [onCanvasReady],
  );
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");

  // Account for HiDPI screens — match the canvas backing-store size to
  // device pixel ratio so strokes don't look blurry on retina displays.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx2d = c.getContext("2d");
    if (ctx2d) {
      ctx2d.scale(dpr, dpr);
      ctx2d.lineCap = "round";
      ctx2d.lineJoin = "round";
    }
  }, [size]);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>): {
    x: number;
    y: number;
  } {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * size,
      y: ((e.clientY - rect.top) / rect.height) * size,
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastRef.current = pointFromEvent(e);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const c = canvasRef.current;
    const ctx2d = c?.getContext("2d");
    if (!c || !ctx2d || !lastRef.current) return;
    const p = pointFromEvent(e);
    ctx2d.globalCompositeOperation =
      tool === "eraser" ? "destination-out" : "source-over";
    ctx2d.strokeStyle = "#0f766e";
    ctx2d.lineWidth = tool === "eraser" ? 18 : 6;
    ctx2d.beginPath();
    ctx2d.moveTo(lastRef.current.x, lastRef.current.y);
    ctx2d.lineTo(p.x, p.y);
    ctx2d.stroke();
    lastRef.current = p;
  }

  function endStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drawingRef.current = false;
    lastRef.current = null;
  }

  function clear() {
    const c = canvasRef.current;
    const ctx2d = c?.getContext("2d");
    if (!c || !ctx2d) return;
    // Reset transform first so clearRect uses canvas-space, not the
    // dpr-scaled space we set up in the mount effect.
    ctx2d.save();
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, c.width, c.height);
    ctx2d.restore();
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <canvas
        ref={setCanvasNode}
        style={{ width: size, height: size, touchAction: "none" }}
        className="cursor-crosshair rounded-xl"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
      />
      {/* Pen / eraser / clear — stacked at the bottom-right corner so
          they don't fight the HanziWriter outline for visual space. */}
      <div className="pointer-events-auto absolute bottom-1 right-1 flex flex-col gap-0.5">
        <button
          type="button"
          onClick={() => setTool("pen")}
          className={cn(
            "flex size-6 items-center justify-center rounded text-[10px] transition-colors",
            tool === "pen"
              ? "bg-foreground text-background"
              : "bg-card text-muted-foreground hover:text-foreground",
          )}
          title="Pen"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => setTool("eraser")}
          className={cn(
            "flex size-6 items-center justify-center rounded text-[10px] transition-colors",
            tool === "eraser"
              ? "bg-foreground text-background"
              : "bg-card text-muted-foreground hover:text-foreground",
          )}
          title="Eraser"
        >
          <Eraser className="size-3" />
        </button>
        <button
          type="button"
          onClick={clear}
          className="flex size-6 items-center justify-center rounded bg-card text-muted-foreground transition-colors hover:text-foreground"
          title="Clear"
        >
          <RotateCcw className="size-3" />
        </button>
      </div>
    </div>
  );
}

// End-of-card review strip: replays every character the learner drew for
// the active card. Each tile renders the exact snapshot captured when
// they left that character — the HanziWriter <svg> (quiz mode) and/or the
// free-draw ink — so a multi-character word shows the whole word, not
// just the final glyph. Tiles shrink for multi-char words so the row
// stays beside the Answer panel; the snapshot is scaled, not re-laid-out,
// so stroke positions stay true. Mask ids in the captured SVG are
// globally unique (HanziWriter increments a module-level counter), so two
// snapshots never cross-clip when rendered together.
function DrawingRecap({
  shots,
  chars,
}: {
  shots: (CharShot | null)[];
  chars: string[];
}) {
  const size = chars.length > 1 ? 132 : 280;
  return (
    <div className="flex max-w-[280px] flex-wrap items-center justify-center gap-2">
      {chars.map((c, i) => {
        const shot = shots[i] ?? null;
        return (
          <div
            key={i}
            className={cn(
              "relative shrink-0 overflow-hidden rounded-xl bg-background/40",
              TIANZIGE,
            )}
            style={{ width: size, height: size }}
          >
            {shot?.svg ? (
              <div
                className="absolute left-0 top-0 origin-top-left [&_svg]:block"
                style={{
                  width: 280,
                  height: 280,
                  transform: `scale(${size / 280})`,
                }}
                dangerouslySetInnerHTML={{ __html: shot.svg }}
              />
            ) : (
              // No snapshot (e.g. the char was skipped before any ink) —
              // fall back to the target glyph, faint.
              <span
                className="grid h-full place-items-center font-serif text-muted-foreground/40"
                style={{ fontSize: size * 0.6, lineHeight: 1 }}
              >
                {c}
              </span>
            )}
            {shot?.ink && (
              <img
                src={shot.ink}
                alt=""
                aria-hidden
                className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Static stroke-order chart for one character — the classic 筆順
// reference. Loads the same offline stroke data the writer uses, then
// renders one mini-glyph per stroke, each adding the next stroke (latest
// highlighted, earlier ones greyed). Renders the raw SVG paths directly
// with HanziWriter's own scaling transform, so it's fully static — no
// extra writer instances, no animation, no network on desktop.
function StrokeOrder({ char }: { char: string }) {
  const [strokes, setStrokes] = useState<string[] | null>(null);
  // Loaded once on mount. The parent keys this component by character,
  // so a new character remounts it fresh (state back to null) instead of
  // us resetting state inside the effect.
  useEffect(() => {
    let cancelled = false;
    loadStrokeData(char)
      .then((data) => {
        if (!cancelled) setStrokes(data?.strokes ?? []);
      })
      .catch(() => {
        if (!cancelled) setStrokes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [char]);

  // 1024-unit stroke coords → a 100×100 viewBox (with the y-flip the font
  // data needs). Deterministic and cheap, so computed inline.
  const transform = HanziWriter.getScalingTransform(100, 100).transform;

  return (
    <div className="w-full max-w-md rounded-xl border border-border bg-background/30 p-2.5">
      <p className="mb-2 text-center text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        Stroke order
      </p>
      {strokes === null ? (
        <p className="py-1.5 text-center text-[12px] text-muted-foreground">
          Loading strokes…
        </p>
      ) : strokes.length === 0 ? (
        <p className="py-1.5 text-center text-[12px] text-muted-foreground">
          No stroke data for this character.
        </p>
      ) : (
        <div className="flex flex-wrap justify-center gap-1.5">
          {strokes.map((_, i) => (
            <svg
              key={i}
              width={40}
              height={40}
              viewBox="0 0 100 100"
              className="rounded-md border border-border/60 bg-background"
              aria-hidden
            >
              <g transform={transform}>
                {strokes.slice(0, i + 1).map((d, j) => (
                  <path
                    key={j}
                    d={d}
                    fill={j === i ? "#10b981" : "rgba(120,120,135,0.45)"}
                  />
                ))}
              </g>
            </svg>
          ))}
        </div>
      )}
    </div>
  );
}

function pickWritableCards(
  due: VocabEntry[],
  all: VocabEntry[],
): VocabEntry[] {
  const has = (w: string) => [...w].some((c) => CJK_RX.test(c));
  const seen = new Set(due.map((c) => c.id));
  const dueWritable = due.filter((c) => has(c.word));
  const fillers = all.filter(
    (c) => !seen.has(c.id) && c.status !== "mastered" && has(c.word),
  );
  return [...dueWritable, ...fillers].slice(0, 20);
}
