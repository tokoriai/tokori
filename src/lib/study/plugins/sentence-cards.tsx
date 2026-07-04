import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  BookmarkCheck,
  Library,
  Loader2,
  MessageSquareQuote,
  Sparkles,
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
import { Tokenized } from "@/components/tokenized";
import {
  buildStudySessionQueue,
  UNCAPPED_DAILY_LIMITS,
  useStudyConfig,
} from "@/lib/study-config";
import { deleteVocab, updateVocabFields } from "@/lib/db";
import {
  parseExamples,
  pickSavedExample,
  serialiseExamples,
  type ExampleSentence,
} from "@/lib/examples";
import { useProviderConfigs } from "@/lib/provider-context";
import { useTTS } from "@/lib/tts-context";
import { languageName, type LanguageCode } from "@/lib/languages";
import { searchKnowledge } from "@/lib/knowledge";
import { PrestartShell } from "@/lib/study/prestart";
import {
  PauseOverlay,
  SessionTopBarControls,
  useActiveSessionTime,
} from "@/lib/study/session-controls";
import {
  usePluginSetting,
  type Grade,
  type StudyPlugin,
  type StudyViewProps,
  type VocabEntry,
} from "@/lib/study/api";
import { cn } from "@/lib/utils";

/**
 * AI / library sentence flashcards.
 *
 * The session is built in one shot at start: AI mode batches every sentence
 * into a single LLM call (mirroring sentence-mining); library mode loops the
 * queue and pulls one FTS-backed sentence per card. The card surface is the
 * sentence itself — the target word is *highlighted inside it*, not shown as
 * a header. Direction toggle decides whether the user reads target → native
 * (recognition) or native → target (production).
 *
 * Optional save-to-card writes the displayed sentence to the vocab row's
 * `cardNotes` examples (via `lib/examples`) when the user grades the card,
 * with a per-card toggle to undo before grading. Saved sentences show up in
 * Settings → Personal Dictionary → Sentences automatically.
 */
const sentenceCards: StudyPlugin = {
  meta: {
    id: "sentence-cards",
    name: "Sentence cards",
    description:
      "Pre-generated example sentences for each due word. Recognition or production.",
    icon: MessageSquareQuote,
    author: "Tokori",
  },
  StudyView,
  Settings,
};

export default sentenceCards;

const PLUGIN_ID = "sentence-cards";

type SourceMode = "library" | "ai";
type AiLevel = "k" | "k+1" | "random";
type Direction = "recognition" | "production";

type CardSentence = {
  card: VocabEntry;
  /** `null` = the AI couldn't produce a valid sentence (or library had no
   *  hit). The renderer skips these cleanly rather than throwing. */
  sentence: string | null;
  /** Native-language translation. AI populates it from the prompt; library
   *  falls back to the card's gloss because the corpus is target-only. */
  translation: string | null;
  source: SourceMode;
  sourceTitle?: string | null;
};

function StudyView({ ctx }: StudyViewProps) {
  const { active: provider, sendChat } = useProviderConfigs();
  const tts = useTTS();
  const [autoPlay] = usePluginSetting(PLUGIN_ID, "autoPlay", true);
  const [savedSource, setSavedSource] = usePluginSetting<SourceMode | null>(
    PLUGIN_ID,
    "source",
    null,
  );
  const [savedLevel, setSavedLevel] = usePluginSetting<AiLevel>(
    PLUGIN_ID,
    "aiLevel",
    "k",
  );
  const [savedDirection, setSavedDirection] = usePluginSetting<Direction>(
    PLUGIN_ID,
    "direction",
    "recognition",
  );
  const [savedSaveToDict, setSavedSaveToDict] = usePluginSetting<boolean>(
    PLUGIN_ID,
    "saveToDict",
    true,
  );
  // Persisted per-workspace via the plugin setting layer. Defaults to
  // true for Chinese because pinyin is the canonical learner scaffold;
  // the user can flip it off inline once they're reading mostly by
  // character. Other languages ignore the value (the prop is `false` for
  // them — no ruby to render anyway).
  const [showRuby, setShowRuby] = usePluginSetting<boolean>(
    PLUGIN_ID,
    "showRuby",
    true,
  );

  const [source, setSource] = useState<SourceMode | null>(savedSource);
  const [aiLevel, setAiLevel] = useState<AiLevel>(savedLevel);
  const [direction, setDirection] = useState<Direction>(savedDirection);
  const [saveOn, setSaveOn] = useState<boolean>(savedSaveToDict);

  const studyCfg = useStudyConfig(ctx.workspace.id, ctx.workspace.targetLang);

  const [queue, setQueue] = useState<CardSentence[] | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [grades, setGrades] = useState({ again: 0, hard: 0, good: 0, easy: 0 });
  const startedAt = useMemo(() => Math.floor(Date.now() / 1000), []);
  const [paused, setPaused] = useState(false);
  const [pendingBlock, setPendingBlock] = useState<VocabEntry | null>(null);
  // Active-only time accumulator (mirrors vocab-recall + kaniwani). Stops
  // when the tab is hidden or `paused` is on so the dashboard's session
  // duration reflects real study time.
  const getActiveSecs = useActiveSessionTime(paused);

  // Per-card save override — initialised from the session-level toggle when
  // the queue is built. Toggling here only changes whether THIS card gets
  // persisted; it doesn't affect future cards. (Cards the user untoggles
  // mid-session are not saved.)
  const [perCardSave, setPerCardSave] = useState<Record<number, boolean>>({});
  // Per-card AI generation in flight — the "no sentence" fallback lets
  // the user generate one on demand.
  const [generatingId, setGeneratingId] = useState<number | null>(null);

  const target = ctx.workspace.targetLang;
  const native = ctx.workspace.nativeLang;
  const effectiveShowRuby = target === "zh" && showRuby;

  // Build queue once per (source, direction) — direction doesn't affect
  // the AI prompt (we always need sentence + translation pair) but it does
  // affect what we *render*, so a flip mid-deck would surprise the user.
  // Keying on both means switching back to setup → flipping direction →
  // start, rebuilds cleanly.
  useEffect(() => {
    if (source == null) return;
    let cancelled = false;
    setBuilding(true);
    setBuildError(null);
    void (async () => {
      void ctx.ensureSessionStarted("review");
      try {
        // Custom scope = a user-bounded cram (one chapter / collection);
        // daily caps would clip it mid-chapter, so skip them there.
        const baseQueue = buildStudySessionQueue(
          ctx.dueVocab,
          ctx.vocab,
          ctx.customScope ? UNCAPPED_DAILY_LIMITS : studyCfg.config,
        );
        if (baseQueue.length === 0) {
          if (!cancelled) setQueue([]);
          return;
        }
        const enriched =
          source === "library"
            ? await buildLibraryQueue(ctx.workspace.id, baseQueue)
            : await generateSentenceBatch({
                cards: baseQueue,
                knownVocab: ctx.vocab,
                level: aiLevel,
                targetLang: target,
                nativeLang: native,
                provider: !!provider,
                sendChat,
              });
        if (!cancelled) {
          setQueue(enriched);
          // Seed per-card toggles from the session-level switch.
          const initial: Record<number, boolean> = {};
          for (const item of enriched) initial[item.card.id] = saveOn;
          setPerCardSave(initial);
        }
      } catch (err) {
        if (!cancelled) {
          setBuildError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setBuilding(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, direction, ctx.workspace.id]);

  const item = queue?.[idx] ?? null;
  const card = item?.card ?? null;
  const sentenceText = item?.sentence ?? null;
  const translationText = item?.translation ?? null;

  // Compute the [start, end) range of the headword inside the sentence so
  // Tokenized can render it with the karaoke highlight (its `activeRange`
  // channel is already wired to the `tts-active` CSS class).
  const targetRange = useMemo(
    () => (sentenceText && card ? findWordRange(sentenceText, card.word) : null),
    [sentenceText, card],
  );

  // Auto-play TTS. Recognition plays on the front (target is the audible
  // event); production plays on reveal (the target only appears on the
  // back). Both keyed on the sentence text so a fresh card re-plays.
  const playedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoPlay || !sentenceText || !card) return;
    const targetVisible =
      direction === "recognition" || (direction === "production" && revealed);
    if (!targetVisible) return;
    const key = `${card.id}::${sentenceText}::${revealed}`;
    if (playedRef.current === key) return;
    playedRef.current = key;
    void tts.speak(sentenceText, target).catch(() => {});
  }, [autoPlay, sentenceText, card, direction, revealed, target, tts]);

  const grade = useCallback(
    async (g: Grade) => {
      if (!card || !item) return;
      await ctx.reviewVocab(card.id, g);
      void ctx.bump("words_seen");
      setGrades((p) => ({ ...p, [g]: p[g] + 1 }));
      setReviewedCount((n) => n + 1);
      // Persist the sentence if this card's toggle is on. Quiet — failures
      // are non-blocking (a card's grade has already landed by the time we
      // get here; the save is a bonus, not the primary action).
      if (
        perCardSave[card.id] &&
        sentenceText &&
        sentenceText.trim().length > 0
      ) {
        try {
          const existing = parseExamples(card.cardNotes);
          const duplicate = existing.some((e) => e.target === sentenceText);
          if (!duplicate) {
            const next: ExampleSentence[] = [
              ...existing,
              {
                id: randomId(),
                target: sentenceText,
                native: translationText ?? undefined,
                source: item.source === "ai" ? "ai" : "user",
              },
            ];
            await updateVocabFields({
              id: card.id,
              cardNotes: serialiseExamples(next),
            });
          }
        } catch (err) {
          console.warn("[sentence-cards] save-to-card failed", err);
        }
      }
      setRevealed(false);
      setIdx((i) => i + 1);
    },
    [card, item, ctx, perCardSave, sentenceText, translationText],
  );

  // On-demand AI generation for a card with no sentence (library had no
  // match, or the AI batch skipped it). Generates one, SAVES it to the
  // card's examples so a later session reuses it instead of regenerating
  // (buildLibraryQueue + the AI fallback both reuse saved examples via
  // pickSavedExample), and swaps it into the live queue.
  const generateForCard = useCallback(
    async (entry: CardSentence) => {
      if (!provider) {
        toast.error("Add an AI provider in Settings → Providers to generate.");
        return;
      }
      setGeneratingId(entry.card.id);
      try {
        const [result] = await generateSentenceBatch({
          cards: [entry.card],
          knownVocab: ctx.vocab,
          level: aiLevel,
          targetLang: target,
          nativeLang: native,
          provider: true,
          sendChat,
        });
        if (!result?.sentence) {
          toast.error("Couldn't generate a sentence — try again.");
          return;
        }
        const sentence = result.sentence;
        const translation = result.translation ?? null;
        try {
          const existing = parseExamples(entry.card.cardNotes);
          if (!existing.some((e) => e.target === sentence)) {
            const next: ExampleSentence[] = [
              ...existing,
              {
                id: randomId(),
                target: sentence,
                native: translation ?? undefined,
                source: "ai",
              },
            ];
            await updateVocabFields({
              id: entry.card.id,
              cardNotes: serialiseExamples(next),
            });
          }
        } catch (err) {
          console.warn("[sentence-cards] saving generated example failed", err);
        }
        setQueue((prev) =>
          prev
            ? prev.map((q) =>
                q.card.id === entry.card.id
                  ? { ...q, sentence, translation: translation ?? q.translation }
                  : q,
              )
            : prev,
        );
      } catch (err) {
        toast.error("Generation failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setGeneratingId(null);
      }
    },
    [provider, ctx.vocab, aiLevel, target, native, sendChat],
  );

  // ── Top-bar bypass actions ──────────────────────────────────────────────
  // Boost: re-insert the current card ~5 positions ahead so it surfaces
  // again before the session ends. Skips the FSRS grade.
  const actionBoost = useCallback(() => {
    if (!card || !queue) return;
    setQueue((prev) => {
      if (!prev) return prev;
      const insertAt = Math.min(prev.length, idx + 5);
      const dup = prev[idx];
      if (!dup) return prev;
      const next = [...prev];
      next.splice(insertAt, 0, dup);
      return next;
    });
    setRevealed(false);
    setIdx((i) => i + 1);
    toast.success(`Boosted "${card.word}" — coming back soon`);
  }, [card, queue, idx]);

  // Block: delete the card from vocab outright; gated by an AlertDialog so
  // an accidental click doesn't quietly nuke a row. Removes it from the
  // live queue + leaves idx pointing at the same slot (next card slides in).
  const actionBlockConfirmed = useCallback(
    async (victim: VocabEntry) => {
      await deleteVocab(victim.id);
      setQueue((prev) => (prev ? prev.filter((c) => c.card.id !== victim.id) : prev));
      setRevealed(false);
      toast(`Blocked "${victim.word}"`);
    },
    [],
  );

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  // Space / Enter / → / l : reveal, then grade Good.
  // 1 / a, 2 / s, 3 / d, 4 / f : direct grade.
  // j / ↓ : replay TTS.
  // p : pause.
  useEffect(() => {
    if (!card || paused || pendingBlock) return;
    function onKey(e: KeyboardEvent) {
      // Don't capture while the user is typing into something (notes
      // drawer, future inputs) or holding a modifier.
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "enter" || k === "arrowright" || k === "l") {
        e.preventDefault();
        if (!revealed) {
          setRevealed(true);
          return;
        }
        void grade("good");
        return;
      }
      if (k === "p") {
        e.preventDefault();
        setPaused(true);
        return;
      }
      if (k === "j" || k === "arrowdown") {
        e.preventDefault();
        if (sentenceText) {
          void tts.speak(sentenceText, target).catch(() => {});
        }
        return;
      }
      if (!revealed) return;
      if (k === "1" || k === "a") {
        e.preventDefault();
        void grade("again");
      } else if (k === "2" || k === "s") {
        e.preventDefault();
        void grade("hard");
      } else if (k === "3" || k === "d") {
        e.preventDefault();
        void grade("good");
      } else if (k === "4" || k === "f") {
        e.preventDefault();
        void grade("easy");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, paused, pendingBlock, revealed, grade, sentenceText, target, tts]);

  // Setup screen — gates everything until the user confirms.
  if (source == null) {
    return (
      <SetupScreen
        aiLevel={aiLevel}
        setAiLevel={(l) => {
          setAiLevel(l);
          setSavedLevel(l);
        }}
        direction={direction}
        setDirection={(d) => {
          setDirection(d);
          setSavedDirection(d);
        }}
        saveOn={saveOn}
        setSaveOn={(v) => {
          setSaveOn(v);
          setSavedSaveToDict(v);
        }}
        providerReady={!!provider}
        drillMode={ctx.drillMode}
        setDrillMode={ctx.setDrillMode}
        srsAnchorState={ctx.srsAnchorState}
        onPick={(picked) => {
          setSource(picked);
          setSavedSource(picked);
        }}
      />
    );
  }

  if (building || queue == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <p>
          {source === "ai"
            ? "Generating sentences with the AI…"
            : "Pulling sentences from your library…"}
        </p>
        <p className="text-[11.5px] opacity-70">One batched pass — cards load instantly.</p>
      </div>
    );
  }

  if (buildError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <h2 className="font-serif text-2xl tracking-tight">
          Couldn&apos;t build the deck.
        </h2>
        <p className="max-w-md text-[13px] text-muted-foreground">{buildError}</p>
        <Button variant="outline" onClick={() => setSource(null)}>
          Back to setup
        </Button>
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <EmptyQueue
        onSessionEnd={() =>
          ctx.onSessionEnd({
            cardsReviewed: 0,
            durationSecs: Math.floor(Date.now() / 1000) - startedAt,
          })
        }
        onBack={() => setSource(null)}
      />
    );
  }

  if (!item || !card) {
    return (
      <SessionDone
        reviewedCount={reviewedCount}
        onLeave={() =>
          ctx.onSessionEnd({
            cardsReviewed: reviewedCount,
            durationSecs: Math.floor(Date.now() / 1000) - startedAt,
            grades,
          })
        }
      />
    );
  }

  const missing = sentenceText == null;
  const cardSaveOn = perCardSave[card.id] ?? false;

  return (
    <>
      <TopActionBar
        idx={idx}
        total={queue.length}
        sourceBadge={source === "ai" ? `AI · ${aiLevel}` : "library"}
        directionBadge={
          direction === "recognition" ? `${target} → ${native}` : `${native} → ${target}`
        }
        onBoost={actionBoost}
        onBlock={() => setPendingBlock(card)}
        onPause={() => setPaused(true)}
        disableBoost={!card}
      />
      <div className="flex flex-1 items-center justify-center px-6 py-6">
        <div className="relative w-full max-w-xl">
          {target === "zh" && (
            <div className="mb-2 flex justify-end">
              <PinyinToggle on={showRuby} onChange={setShowRuby} />
            </div>
          )}
          <div className="block w-full rounded-2xl border border-border bg-card px-6 py-10 shadow-sm transition-all">
            {missing ? (
              <MissingFallback
                source={source}
                canGenerate={!!provider}
                generating={generatingId === card.id}
                onGenerate={() => void generateForCard(item)}
                onSkip={() => {
                  setRevealed(false);
                  setIdx((i) => i + 1);
                }}
              />
            ) : direction === "recognition" ? (
              <RecognitionView
                sentence={sentenceText!}
                translation={translationText}
                targetLang={target}
                targetRange={targetRange}
                showRuby={effectiveShowRuby}
                revealed={revealed}
                onReveal={() => setRevealed(true)}
                sourceTitle={item.sourceTitle ?? null}
              />
            ) : (
              <ProductionView
                sentence={sentenceText!}
                translation={translationText}
                targetLang={target}
                targetRange={targetRange}
                showRuby={effectiveShowRuby}
                revealed={revealed}
                onReveal={() => setRevealed(true)}
              />
            )}
          </div>

          {!missing && (
            <div className="mt-3 flex items-center justify-end gap-2">
              <SaveToggle
                on={cardSaveOn}
                onChange={(v) =>
                  setPerCardSave((m) => ({ ...m, [card.id]: v }))
                }
              />
            </div>
          )}

          <div className="mt-4 grid grid-cols-4 gap-2">
            <GradeButton
              disabled={missing ? false : !revealed}
              label="Again"
              hint="<1m"
              accent="bg-rose-500/10 text-rose-700 dark:text-rose-400"
              onClick={() => void grade("again")}
            />
            <GradeButton
              disabled={missing ? false : !revealed}
              label="Hard"
              hint="~1d"
              accent="bg-amber-500/10 text-amber-700 dark:text-amber-400"
              onClick={() => void grade("hard")}
            />
            <GradeButton
              disabled={missing ? false : !revealed}
              label="Good"
              hint="~3d"
              accent="bg-sky-500/10 text-sky-700 dark:text-sky-400"
              onClick={() => void grade("good")}
            />
            <GradeButton
              disabled={missing ? false : !revealed}
              label="Easy"
              hint="1w+"
              accent="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              onClick={() => void grade("easy")}
            />
          </div>
          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            {missing
              ? "No sentence — grade from memory or skip"
              : revealed
                ? "Grade how well you understood it"
                : direction === "recognition"
                  ? "Listen, read, then reveal the translation"
                  : "Read, think of the target sentence, then reveal"}
          </p>
        </div>
      </div>

      {/* Keyboard cheatsheet — bottom-right corner, mirrors vocab-recall.
          Hidden on small screens where there's no keyboard anyway. */}
      <KeyboardHintBar revealed={revealed} />

      {/* Block confirmation. Kept mounted across card changes via
          `pendingBlock` so the dialog stays steady when boost / advance
          fire mid-stream. */}
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
              surface in study sessions again. You can re-add it later via
              the Browse tab if you change your mind.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const victim = pendingBlock;
                setPendingBlock(null);
                if (victim) await actionBlockConfirmed(victim);
              }}
            >
              Block
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {paused && (
        <PauseOverlay
          progress={(idx / Math.max(1, queue.length)) * 100}
          done={reviewedCount}
          total={queue.length}
          elapsedSecs={getActiveSecs()}
          onResume={() => setPaused(false)}
          onEnd={() =>
            ctx.onSessionEnd({
              cardsReviewed: reviewedCount,
              durationSecs: getActiveSecs(),
              grades,
            })
          }
        />
      )}
    </>
  );
}

function RecognitionView({
  sentence,
  translation,
  targetLang,
  targetRange,
  showRuby,
  revealed,
  onReveal,
  sourceTitle,
}: {
  sentence: string;
  translation: string | null;
  targetLang: LanguageCode;
  targetRange: [number, number] | null;
  showRuby: boolean;
  revealed: boolean;
  onReveal: () => void;
  sourceTitle: string | null;
}) {
  return (
    <>
      <div className="relative">
        <div className="absolute right-0 top-0 z-10">
          <SpeakButton text={sentence} lang={targetLang} />
        </div>
        <div className="study-sentence-target pr-9 text-[22px] leading-relaxed">
          <Tokenized
            text={sentence}
            lang={targetLang}
            showRuby={showRuby}
            activeRange={targetRange}
          />
        </div>
        {sourceTitle && (
          <p className="mt-3 text-[11px] text-muted-foreground">From {sourceTitle}</p>
        )}
      </div>
      {revealed ? (
        <div className="mt-6 border-t border-border pt-4">
          <p className="text-[15px] leading-relaxed">
            {translation ?? (
              <em className="text-muted-foreground">No translation available</em>
            )}
          </p>
        </div>
      ) : (
        <div className="mt-6 flex justify-center">
          <Button variant="outline" onClick={onReveal}>
            Show translation
          </Button>
        </div>
      )}
    </>
  );
}

function ProductionView({
  sentence,
  translation,
  targetLang,
  targetRange,
  showRuby,
  revealed,
  onReveal,
}: {
  sentence: string;
  translation: string | null;
  targetLang: LanguageCode;
  targetRange: [number, number] | null;
  showRuby: boolean;
  revealed: boolean;
  onReveal: () => void;
}) {
  return (
    <>
      <p className="text-[20px] leading-relaxed">
        {translation ?? (
          <em className="text-muted-foreground">
            No native translation — try the recognition direction.
          </em>
        )}
      </p>
      {revealed ? (
        <div className="mt-6 border-t border-border pt-4">
          <div className="relative">
            <div className="absolute right-0 top-0 z-10">
              <SpeakButton text={sentence} lang={targetLang} />
            </div>
            <div className="study-sentence-target pr-9 text-[22px] leading-relaxed">
              <Tokenized
                text={sentence}
                lang={targetLang}
                showRuby={showRuby}
                activeRange={targetRange}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-6 flex justify-center">
          <Button variant="outline" onClick={onReveal}>
            Reveal target sentence
          </Button>
        </div>
      )}
    </>
  );
}

function PinyinToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors",
        on
          ? "border-foreground/20 bg-foreground/5 text-foreground/80 hover:bg-foreground/10"
          : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
      title={on ? "Hide pinyin above characters" : "Show pinyin above characters"}
      aria-pressed={on}
    >
      <span className="font-mono text-[10px] tracking-wider">PIN</span>
      {on ? "on" : "off"}
    </button>
  );
}

function TopActionBar({
  idx,
  total,
  sourceBadge,
  directionBadge,
  onBoost,
  onBlock,
  onPause,
  disableBoost,
}: {
  idx: number;
  total: number;
  sourceBadge: string;
  directionBadge: string;
  onBoost: () => void;
  onBlock: () => void;
  onPause: () => void;
  disableBoost?: boolean;
}) {
  const progress = (idx / Math.max(1, total)) * 100;
  return (
    <TooltipProvider delayDuration={300}>
      <div className="border-b border-border px-6 pt-2 pb-3">
        <div className="flex w-full items-center gap-4">
          <p className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {idx + 1} / {total}
          </p>
          <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
            <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {sourceBadge}
            </span>
            <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {directionBadge}
            </span>
          </span>
          <div className="flex-1">
            <Progress value={progress} />
          </div>
          <SessionTopBarControls
            onBoost={onBoost}
            onNeverAgain={onBlock}
            onPause={onPause}
            disableBoost={disableBoost}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * Bottom-right keyboard cheatsheet. Mirrors `vocab-recall`'s
 * `KeyboardHintBar` in shape + classnames so the muscle memory transfers
 * between the two flashcard modes. Hidden below `md` because there's no
 * physical keyboard in play on touch surfaces.
 */
function KeyboardHintBar({ revealed }: { revealed: boolean }) {
  return (
    <div className="hidden md:flex pointer-events-none fixed bottom-3 right-3 z-20 flex-col items-end gap-2 text-muted-foreground/70">
      {!revealed ? (
        <div className="flex items-center gap-1">
          <KeyChip k={["→", "l"]} label="reveal" />
          <KeyChip k={["⏎", "Enter"]} label="reveal" />
          <KeyChip k={["↓", "j"]} label="audio" />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <KeyChip k={["1", "a"]} label="again" tone="rose" />
            <KeyChip k={["2", "s"]} label="hard" tone="amber" />
            <KeyChip k={["3", "d"]} label="good" tone="sky" />
            <KeyChip k={["4", "f"]} label="easy" tone="emerald" />
          </div>
          <div className="flex items-center gap-1">
            <KeyChip k={["⏎", "l"]} label="good" tone="sky" />
            <KeyChip k={["↓", "j"]} label="audio" />
          </div>
        </>
      )}
      <div className="flex items-center gap-2 text-[9.5px]">
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border/60 bg-muted/30 px-1 py-px font-mono text-[9px] text-muted-foreground/80">
            P
          </kbd>
          <span className="text-muted-foreground/60">pause</span>
        </span>
      </div>
    </div>
  );
}

function KeyChip({
  k,
  label,
  tone,
}: {
  k: [string, string] | [string];
  label: string;
  tone?: "rose" | "amber" | "sky" | "emerald";
}) {
  const toneClass: Record<NonNullable<typeof tone>, string> = {
    rose: "text-rose-500/80 dark:text-rose-400/80",
    amber: "text-amber-600/80 dark:text-amber-400/80",
    sky: "text-sky-600/80 dark:text-sky-400/80",
    emerald: "text-emerald-600/80 dark:text-emerald-400/80",
  };
  return (
    <span className="flex w-12 flex-col items-center gap-px rounded border border-border/40 bg-muted/20 px-1 py-1 text-center">
      <kbd className="font-mono text-[12px] leading-none text-muted-foreground/85">
        {k[0]}
      </kbd>
      {k[1] && (
        <span className="font-mono text-[9px] leading-none text-muted-foreground/55">
          {k[1]}
        </span>
      )}
      <span
        className={cn(
          "mt-0.5 text-[9px] leading-none text-muted-foreground/55",
          tone && toneClass[tone],
        )}
      >
        {label}
      </span>
    </span>
  );
}

function SaveToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors",
        on
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400"
          : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
      title={
        on
          ? "This sentence will be saved to the card's examples when you grade it. Click to skip saving."
          : "Click to save this sentence to the card's examples when you grade it."
      }
    >
      {on ? (
        <>
          <BookmarkCheck className="size-3.5" />
          Will save
        </>
      ) : (
        <>
          <Bookmark className="size-3.5" />
          Save
        </>
      )}
    </button>
  );
}

function MissingFallback({
  source,
  canGenerate,
  generating,
  onGenerate,
  onSkip,
}: {
  source: SourceMode;
  canGenerate: boolean;
  generating: boolean;
  onGenerate: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-3 text-center">
      <p className="text-[13px] text-muted-foreground">
        {source === "library"
          ? "No matching sentence in your library yet."
          : "The AI didn't produce a usable sentence for this card."}
      </p>
      <div className="flex justify-center gap-2">
        {canGenerate && (
          <Button size="sm" onClick={onGenerate} disabled={generating}>
            {generating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {generating ? "Generating…" : "Generate with AI"}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onSkip} disabled={generating}>
          Skip
        </Button>
      </div>
      {!canGenerate && (
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          Add an AI provider in Settings → Providers to generate one
          {source === "library"
            ? ", or read / save more text containing this word."
            : "."}
        </p>
      )}
    </div>
  );
}

function SetupScreen({
  aiLevel,
  setAiLevel,
  direction,
  setDirection,
  saveOn,
  setSaveOn,
  providerReady,
  drillMode,
  setDrillMode,
  srsAnchorState,
  onPick,
}: {
  aiLevel: AiLevel;
  setAiLevel: (l: AiLevel) => void;
  direction: Direction;
  setDirection: (d: Direction) => void;
  saveOn: boolean;
  setSaveOn: (v: boolean) => void;
  providerReady: boolean;
  drillMode: boolean;
  setDrillMode: (next: boolean) => void;
  srsAnchorState: "unknown" | "free" | "alreadyAnchored";
  onPick: (mode: SourceMode) => void;
}) {
  const levels: { id: AiLevel; label: string; desc: string }[] = [
    {
      id: "k",
      label: "k",
      desc: "Strict — only words you already know plus the target.",
    },
    {
      id: "k+1",
      label: "k+1",
      desc: "Krashen sweet spot — your vocab plus ~1 new word for stretch.",
    },
    {
      id: "random",
      label: "random",
      desc: "No vocab gating — natural intermediate prose around the target.",
    },
  ];
  const directions: { id: Direction; label: string; desc: string }[] = [
    {
      id: "recognition",
      label: "Recognition",
      desc: "Target sentence on front, native translation on back. Audio on the front.",
    },
    {
      id: "production",
      label: "Production",
      desc: "Native sentence on front; recall the target. Reveal shows the target sentence with audio.",
    },
  ];
  return (
    <PrestartShell
      icon={MessageSquareQuote}
      pluginName="Sentence cards"
      title="Pick a source for tonight's deck."
      description="Each card is one example sentence with the target word highlighted inside it. The whole deck is built up front — cards never spin loading."
      drillMode={drillMode}
      setDrillMode={setDrillMode}
      srsAnchorState={srsAnchorState}
    >
      <div className="rounded-2xl border border-border bg-muted/30 p-4">
        <p className="mb-3 text-[12px] uppercase tracking-wider text-muted-foreground">
          Direction
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {directions.map((d) => {
            const active = direction === d.id;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setDirection(d.id)}
                className={cn(
                  "rounded-xl border px-3 py-2 text-left transition-all",
                  active
                    ? "border-foreground/50 bg-card shadow-sm"
                    : "border-border bg-background hover:border-foreground/30",
                )}
              >
                <div className="text-[13px] font-medium">{d.label}</div>
                <div className="text-[11px] leading-snug text-muted-foreground">
                  {d.desc}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex w-full items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/30">
        <input
          type="checkbox"
          checked={saveOn}
          onChange={(e) => setSaveOn(e.target.checked)}
          className="mt-1 size-4"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">
            Save shown sentences to each card
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
            Appends to the card&apos;s examples on grade. Browse them under
            Settings → Personal Dictionary → Sentences. You can untoggle
            individual cards during the session.
          </p>
        </div>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onPick("library")}
          className="group flex flex-col gap-2 rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition-all hover:border-foreground/30 hover:shadow-md"
        >
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-lg bg-foreground/5 text-foreground/80 group-hover:bg-foreground/10">
              <Library className="size-4" />
            </div>
            <h3 className="font-serif text-lg tracking-tight">From your library</h3>
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Pull example sentences from passages you&apos;ve actually read — reader docs,
            notes, textbook chapters. Skips cards whose word isn&apos;t in your library yet.
          </p>
        </button>

        <button
          type="button"
          onClick={() => onPick("ai")}
          disabled={!providerReady}
          className={cn(
            "group flex flex-col gap-2 rounded-2xl border p-5 text-left shadow-sm transition-all",
            providerReady
              ? "border-border bg-card hover:border-foreground/30 hover:shadow-md"
              : "cursor-not-allowed border-dashed border-border/50 bg-muted/30 opacity-60",
          )}
        >
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-lg bg-foreground/5 text-foreground/80 group-hover:bg-foreground/10">
              <Sparkles className="size-4" />
            </div>
            <h3 className="font-serif text-lg tracking-tight">AI-generated</h3>
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {providerReady
              ? "One short sentence per card, batched into a single LLM call. Locked to your known vocab — pick a level below."
              : "Add a provider in Settings → Providers to unlock."}
          </p>
        </button>
      </div>

      <div className="rounded-2xl border border-border bg-muted/30 p-4">
        <p className="mb-3 text-[12px] uppercase tracking-wider text-muted-foreground">
          AI level
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {levels.map((l) => {
            const active = aiLevel === l.id;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => setAiLevel(l.id)}
                className={cn(
                  "rounded-xl border px-3 py-2 text-left transition-all",
                  active
                    ? "border-foreground/50 bg-card shadow-sm"
                    : "border-border bg-background hover:border-foreground/30",
                )}
              >
                <div className="font-mono text-[13px]">{l.label}</div>
                <div className="text-[11px] leading-snug text-muted-foreground">
                  {l.desc}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </PrestartShell>
  );
}

function EmptyQueue({
  onSessionEnd,
  onBack,
}: {
  onSessionEnd: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <MessageSquareQuote className="size-5" />
      </div>
      <h2 className="font-serif text-2xl tracking-tight">All caught up.</h2>
      <p className="max-w-md text-[13.5px] text-muted-foreground">
        No cards are due. Save more vocab from chat or the reader, or wait for
        the FSRS intervals to roll around.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          Change source
        </Button>
        <Button variant="ghost" size="sm" onClick={onSessionEnd}>
          Leave session
        </Button>
      </div>
    </div>
  );
}

function SessionDone({
  reviewedCount,
  onLeave,
}: {
  reviewedCount: number;
  onLeave: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <h2 className="font-serif text-3xl tracking-tight">Session done.</h2>
      <p className="text-[13.5px] text-muted-foreground">
        Reviewed {reviewedCount} card{reviewedCount === 1 ? "" : "s"}.
      </p>
      <Button onClick={onLeave} variant="ghost">
        End session
      </Button>
    </div>
  );
}

function GradeButton({
  label,
  hint,
  accent,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  accent: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-xl border border-border px-3 py-3 text-left transition-all hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50",
        accent,
      )}
    >
      <div className="text-[13.5px] font-medium">{label}</div>
      <div className="text-[11px] opacity-80">{hint}</div>
    </button>
  );
}

function Settings() {
  const [autoPlay, setAutoPlay, loaded] = usePluginSetting(
    PLUGIN_ID,
    "autoPlay",
    true,
  );
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={autoPlay}
          disabled={!loaded}
          onChange={(e) => setAutoPlay(e.target.checked)}
          className="size-4"
        />
        Auto-play the sentence (front in recognition, back in production)
      </label>
      <p className="text-[11.5px] text-muted-foreground">
        Source, direction, AI level, and save-to-card are chosen at the start of
        each session.
      </p>
    </div>
  );
}

// ── Range computation ────────────────────────────────────────────────────

/** First occurrence of `word` in `sentence`, returned as a half-open
 *  character range `[start, end)` suitable for `Tokenized`'s `activeRange`
 *  prop. Returns `null` when the word isn't found.
 *
 *   - CJK: direct substring match — no inflection, no case.
 *   - Other scripts: case-insensitive search; we deliberately don't try
 *     stem matching here (the renderer just needs *some* visible anchor;
 *     missing the inflected form is fine and shows the sentence without a
 *     highlight, which still reads). */
export function findWordRange(
  sentence: string,
  word: string,
): [number, number] | null {
  if (!sentence || !word) return null;
  const s = sentence.normalize("NFC");
  const w = word.normalize("NFC");
  let idx = s.indexOf(w);
  if (idx < 0) {
    const ls = s.toLowerCase();
    const lw = w.toLowerCase();
    idx = ls.indexOf(lw);
  }
  if (idx < 0) return null;
  return [idx, idx + w.length];
}

// ── Library mode ─────────────────────────────────────────────────────────

async function buildLibraryQueue(
  workspaceId: number,
  cards: VocabEntry[],
): Promise<CardSentence[]> {
  const out: CardSentence[] = [];
  for (const card of cards) {
    const hit = await findLibrarySentence(workspaceId, card.word);
    if (hit) {
      out.push({
        card,
        sentence: hit.sentence,
        // Library sentences come from the user's target-language corpus —
        // there is no aligned translation. Fall back to the card's gloss
        // so production direction has *something* to show on the front.
        translation: card.gloss ?? null,
        source: "library",
        sourceTitle: hit.sourceTitle,
      });
      continue;
    }
    // No corpus hit — reuse a saved sentence (e.g. one sentence mining
    // generated and stored earlier) so the card still has something to
    // study instead of dropping to the skip-only fallback.
    const saved = pickSavedExample(card.cardNotes, card.word);
    out.push({
      card,
      sentence: saved?.target ?? null,
      translation: saved?.native ?? card.gloss ?? null,
      source: "library",
      sourceTitle: null,
    });
  }
  return out;
}

async function findLibrarySentence(
  workspaceId: number,
  word: string,
): Promise<{ sentence: string; sourceTitle: string | null } | null> {
  const hits = await searchKnowledge(workspaceId, word, 5).catch(() => []);
  for (const h of hits) {
    const sentences = h.snippet.split(/(?<=[.!?。！？])\s+|\n+/g);
    const match = sentences.find(
      (s) => s.includes(word) && s.length >= 8 && s.length <= 220,
    );
    if (match) {
      return { sentence: match.trim(), sourceTitle: h.sourceTitle };
    }
  }
  return null;
}

// ── AI batched generation ────────────────────────────────────────────────

/** Single LLM call for every card in the deck. Mirrors the
 *  sentence-mining generator: JSONL output, level-driven prompt, lenient
 *  parser, partial-failure tolerant. Cards the model fails on (missing
 *  entry or sentence without the target word) come back with
 *  `sentence: null` and render with a "skip" fallback. */
async function generateSentenceBatch(args: {
  cards: VocabEntry[];
  knownVocab: VocabEntry[];
  level: AiLevel;
  targetLang: string;
  nativeLang: string;
  provider: boolean;
  sendChat: ReturnType<typeof useProviderConfigs>["sendChat"];
}): Promise<CardSentence[]> {
  const { cards, knownVocab, level, targetLang, nativeLang, provider, sendChat } = args;
  if (!provider) {
    throw new Error("Add an AI provider in Settings → Providers, or pick library mode.");
  }
  if (cards.length === 0) return [];
  const target = languageName(targetLang as LanguageCode);
  const native = languageName(nativeLang as LanguageCode);
  const targetWordSet = new Set(cards.map((c) => c.word));

  const mastered: string[] = [];
  const learning: string[] = [];
  for (const v of knownVocab) {
    if (targetWordSet.has(v.word)) continue;
    if (v.status === "mastered" || v.status === "review") {
      if (mastered.length < 80) mastered.push(v.word);
    } else if (v.status === "learning") {
      if (learning.length < 40) learning.push(v.word);
    }
  }

  const wordList = cards
    .map((c, i) => {
      const gloss = c.gloss
        ? ` — ${c.gloss.split(/;\s*/).slice(0, 2).join("; ")}`
        : "";
      return `${i + 1}. ${c.word}${gloss}`;
    })
    .join("\n");

  const exampleSentence = cards[0]?.word
    ? `e.g. {"index":1,"sentence":"...${cards[0].word}...","translation":"..."}`
    : `e.g. {"index":1,"sentence":"...","translation":"..."}`;
  const jsonLine =
    `Output format: one JSON object per line, no array brackets, no markdown fences, no commentary. ` +
    `Shape: {"index":N,"sentence":"<${target} sentence>","translation":"<${native}>"}. ` +
    `${exampleSentence}. ` +
    `One line per TARGET. Indexes match TARGETS below.`;

  const lines: string[] = [
    `${target} example-sentence tutor. For each TARGET word, write ONE short natural ${target} sentence that uses the exact word.`,
  ];
  if (level === "random") {
    lines.push(
      ``,
      `## RULES`,
      `- Target word appears exactly once, verbatim (only inflect if ${target} grammar requires it).`,
      `- Natural intermediate sentences, 10–20 words, concrete everyday situations.`,
      `- ${native} translation for each.`,
      `- ${jsonLine}`,
    );
  } else {
    const allowOneNew = level === "k+1";
    lines.push(
      `Surrounding context must come from KNOWN words${allowOneNew ? " (at most ONE extra unfamiliar word allowed for i+1 stretch)" : ""}. The target is the ${allowOneNew ? "main" : "ONLY"} new element.`,
      ``,
      `## RULES`,
      `- Target word appears exactly once, verbatim (only inflect if ${target} grammar requires it).`,
      allowOneNew
        ? `- Other content words: from KNOWN_MASTERED/KNOWN_LEARNING, plus up to ONE inferable high-frequency word.`
        : `- Other content words (nouns/verbs/adj/adv): KNOWN_MASTERED or KNOWN_LEARNING only.`,
      `- Function words (particles, pronouns, articles, prepositions, numbers, copulas, measure words) always allowed.`,
      `- 8–18 words, natural and concrete. No filler.`,
      `- If stuck, prefer a longer/simpler sentence over breaking the vocab rule.`,
      `- ${native} translation for each.`,
      `- ${jsonLine}`,
    );
    if (mastered.length > 0) {
      lines.push(``, `## KNOWN_MASTERED`, mastered.join("、"));
    }
    if (learning.length > 0) {
      lines.push(``, `## KNOWN_LEARNING`, learning.join("、"));
    }
    if (mastered.length === 0 && learning.length === 0) {
      lines.push(
        ``,
        `## NOTE`,
        `The learner has no saved vocab yet — use absolute-beginner (A1-level) ${target} only. Concrete, everyday nouns and verbs.`,
      );
    }
  }
  lines.push(``, `## TARGETS`, wordList);

  const systemPrompt = lines.join("\n");
  const reply = await sendChat({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Generate example sentences for ${cards.length} words.` },
    ],
    onToken: () => {},
  });
  const parsed = parseSentenceResponse(reply);
  const byIndex = new Map<number, { sentence: string; translation?: string }>();
  parsed.forEach((p, posIdx) => {
    if (!p.sentence) return;
    const idx = typeof p.index === "number" ? p.index : posIdx + 1;
    byIndex.set(idx, { sentence: String(p.sentence), translation: p.translation });
  });
  if (parsed.length === 0 && reply.trim().length > 0) {
    console.warn(
      "[sentence-cards] AI replied but no sentences could be parsed. Raw reply (truncated):",
      reply.slice(0, 400),
    );
  }
  return cards.map((card, i) => {
    const hit = byIndex.get(i + 1);
    if (!hit || !sentenceContainsWord(hit.sentence, card.word)) {
      // The model dropped this card or produced a sentence missing the
      // target word. Reuse a saved sentence if the card has one so it
      // still studies cleanly; otherwise fall through to the skip card.
      const saved = pickSavedExample(card.cardNotes, card.word);
      if (saved) {
        return {
          card,
          sentence: saved.target,
          translation: saved.native ?? card.gloss ?? null,
          source: "ai",
          sourceTitle: null,
        };
      }
      return {
        card,
        sentence: null,
        translation: null,
        source: "ai",
        sourceTitle: "AI",
      };
    }
    return {
      card,
      sentence: hit.sentence.trim(),
      translation: hit.translation?.trim() || null,
      source: "ai",
      sourceTitle: "AI",
    };
  });
}

// ── Parser internals ─────────────────────────────────────────────────────
//
// Mirrored from sentence-mining's parseClozeResponse. Same four-stage
// fallback: strict array → JSONL → regex objects → numbered list. Kept
// independent (rather than imported) so the two plugins don't grow a
// runtime dependency on each other.

type ParsedLine = { index?: number; sentence?: string; translation?: string };

function parseSentenceResponse(raw: string): ParsedLine[] {
  if (!raw) return [];
  const cleaned = raw
    .replace(/^﻿/, "")
    .replace(/```[\w]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/ /g, " ")
    .trim();

  const stages = [
    () => tryParseJsonArray(cleaned),
    () => tryParseJsonl(cleaned),
    () => tryExtractJsonObjects(cleaned),
    () => tryParseNumberedList(cleaned),
  ];
  let best: ParsedLine[] = [];
  for (const stage of stages) {
    try {
      const got = stage();
      if (got.length > best.length) best = got;
    } catch {
      /* keep trying */
    }
  }
  return best;
}

function tryParseJsonArray(s: string): ParsedLine[] {
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  const slice = stripTrailingCommas(s.slice(start, end + 1));
  const parsed = JSON.parse(slice) as unknown;
  return Array.isArray(parsed) ? (parsed as ParsedLine[]) : [];
}

function tryParseJsonl(s: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const line of s.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/,\s*$/, "");
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const obj = JSON.parse(stripTrailingCommas(trimmed)) as Record<string, unknown>;
      if (typeof obj.sentence === "string") {
        out.push({
          index: typeof obj.index === "number" ? obj.index : undefined,
          sentence: obj.sentence,
          translation:
            typeof obj.translation === "string" ? obj.translation : undefined,
        });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function tryExtractJsonObjects(s: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  const re = /\{[^{}]*?"sentence"[^{}]*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    try {
      const obj = JSON.parse(stripTrailingCommas(m[0])) as Record<string, unknown>;
      if (typeof obj.sentence === "string") {
        out.push({
          index: typeof obj.index === "number" ? obj.index : undefined,
          sentence: obj.sentence,
          translation:
            typeof obj.translation === "string" ? obj.translation : undefined,
        });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

function tryParseNumberedList(s: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  const lineRe = /^\s*(\d+)\s*[.)]\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(s))) {
    const idx = Number(m[1]);
    const body = m[2];
    const dashMatch = body.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    if (dashMatch) {
      out.push({ index: idx, sentence: dashMatch[1].trim(), translation: dashMatch[2].trim() });
      continue;
    }
    const parenMatch = body.match(/^(.+?)\s+\((.+)\)\s*$/);
    if (parenMatch) {
      out.push({ index: idx, sentence: parenMatch[1].trim(), translation: parenMatch[2].trim() });
      continue;
    }
    out.push({ index: idx, sentence: body.trim() });
  }
  return out;
}

function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

function sentenceContainsWord(sentence: string, word: string): boolean {
  if (!sentence || !word) return false;
  const s = sentence.normalize("NFC");
  const w = word.normalize("NFC");
  if (s.includes(w)) return true;
  const ls = s.toLowerCase();
  const lw = w.toLowerCase();
  if (ls.includes(lw)) return true;
  if (/[一-鿿぀-ヿ가-힯]/.test(w)) return false;
  if (lw.length >= 5) {
    const stem = lw.slice(0, Math.max(4, Math.floor(lw.length * 0.6)));
    if (ls.includes(stem)) return true;
  }
  return false;
}

function randomId(): string {
  // crypto.randomUUID is available in modern browsers + Node 19+, but
  // older Tauri webviews (Linux WebKitGTK) sometimes ship a runtime
  // that doesn't expose it on `crypto`. Fall back to a 64-bit random
  // hex string — only used as a React key + delete handle, so collision
  // safety at this scale is fine.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Exposed for tests + diagnostics. Not part of the public plugin contract.
export const __INTERNAL = {
  parseSentenceResponse,
  sentenceContainsWord,
  findWordRange,
};
