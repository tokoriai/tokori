import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  BookOpen,
  CheckCircle2,
  Eye,
  Library,
  Loader2,
  Pause,
  Play,
  RocketIcon,
  Sparkles,
  Sprout,
  StopCircle,
  XCircle,
} from "lucide-react";
import { StudyAiDrawer } from "@/components/study/ai-drawer";
import { Tokenized } from "@/components/tokenized";
import { profileFor } from "@/lib/languages";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SpeakButton } from "@/components/speak-button";
import { deleteVocab, updateVocabFields } from "@/lib/db";
import {
  newExampleId,
  parseExamples,
  pickSavedExample,
  serialiseExamples,
  type ExampleSentence,
} from "@/lib/examples";
import { searchKnowledge } from "@/lib/knowledge";
import { useProviderConfigs } from "@/lib/provider-context";
import { languageName, type LanguageCode } from "@/lib/languages";
import type { StudyPlugin, StudyViewProps, VocabEntry } from "@/lib/study/api";
import { PrestartShell } from "@/lib/study/prestart";
import { cn } from "@/lib/utils";

/**
 * Sentence mining — universal study mode.
 *
 * For each due card, search the user's FTS knowledge base (reader docs,
 * notes, textbook chapters, past assistant replies) for a sentence that
 * actually contains the word. Mask the word as `____`, ask the user to type
 * it. Falls back to a plain "type the word from the gloss" prompt when no
 * example sentence exists yet.
 *
 * Works for every language because it's grounded in the user's own corpus —
 * no language-specific stages, no transliteration assumptions.
 */

export type CardWithSentence = {
  card: VocabEntry;
  /** A real sentence containing card.word, or null when nothing was found. */
  sentence: string | null;
  /** Where the sentence came from — shown as a small attribution. */
  sourceTitle?: string | null;
  /** Native-language translation. Only populated for AI-generated
   *  sentences (the prompt asks for it); library-mode sentences come
   *  from the user's own corpus and we don't auto-translate them. */
  translation?: string | null;
};

/** Two ways to build the cloze queue. `library` is the original flow —
 *  search the user's FTS knowledge base for sentences they've already
 *  read. `ai` generates fresh cloze sentences via the active LLM
 *  provider, biased toward learning + due vocab. The user picks at
 *  the start of each session via the setup screen. */
type SourceMode = "library" | "ai";

/** How many cards to include in an AI session. The "all" option uses
 *  every learning + due card; the numeric options cap. Capping is
 *  important because each card costs an LLM round trip's worth of
 *  output (we batch them, but the prompt grows linearly). */
type AiCount = 10 | 15 | 20 | "all";

/** How aggressive the AI should be about constraining sentence
 *  context to the learner's known vocab.
 *
 *   - `k`        : strict — only known + target word, k+0. Pure cloze
 *                  drill where the target is the only unknown.
 *   - `k+1`      : Krashen i+1 — allow ~1 high-frequency new word
 *                  alongside the target. A touch of stretch.
 *   - `random`   : no vocab gating. Generates natural, intermediate
 *                  prose around the target — useful when the user
 *                  wants raw exposure rather than scaffolded drill.
 */
export type AiLevel = "k" | "k+1" | "random";

const sentenceMining: StudyPlugin = {
  meta: {
    id: "sentence-mining",
    name: "Sentence mining",
    description:
      "Fill in the missing word from a real sentence in your reader, notes, or textbook.",
    icon: Sprout,
    // No supportedLangs → available for every workspace.
  },
  StudyView,
};

export default sentenceMining;

function StudyView({ ctx }: StudyViewProps) {
  const { active: provider, sendChat } = useProviderConfigs();
  // `null` while the user hasn't picked a mode yet — the setup screen
  // owns the entry. Once chosen, the queue-build effect runs against
  // the corresponding source.
  const [mode, setMode] = useState<SourceMode | null>(null);
  const [aiCount, setAiCount] = useState<AiCount>(15);
  // Sentence difficulty for AI mode. Defaults to k+1 — same Krashen
  // sweet spot the rest of the app leans on (the answer-card example
  // generator and the reader's k+1 simplifier both default here).
  const [aiLevel, setAiLevel] = useState<AiLevel>("k+1");
  const [queue, setQueue] = useState<CardWithSentence[] | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<"idle" | "correct" | "wrong">("idle");
  const [revealed, setRevealed] = useState(false);
  const [mistakes, setMistakes] = useState(0);
  // Per-card AI hint, keyed by vocab id. Cached so re-clicking the
  // hint button doesn't re-spend tokens, and so a user who pauses
  // mid-card and comes back still sees the same clue.
  const [hintsByCard, setHintsByCard] = useState<Record<number, string>>({});
  const [hintBusy, setHintBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const startedAt = useMemo(() => Math.floor(Date.now() / 1000), []);
  // ── Top-bar session controls (parity with vocab-recall + hanzi-writing) ─
  const [paused, setPaused] = useState(false);
  const [pendingNeverAgain, setPendingNeverAgain] = useState<VocabEntry | null>(null);
  // AI tutor sidebar — same drawer the vocab-recall plugin uses,
  // ported via the shared `StudyAiDrawer` component. The cloze
  // sentence (when present) is fed into the system prompt as extra
  // context so the tutor can reason about "the sentence I was just
  // shown".
  const [aiOpen, setAiOpen] = useState(false);
  const stats = useRef({
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
    sentencesUsed: 0,
    fallbacks: 0,
  });

  // Cards eligible for AI mode — learning + due, mastered excluded.
  // Memoed so the count badge on the setup screen updates live as the
  // user reviews other modes elsewhere (rare, but cheap to keep right).
  const aiEligible = useMemo(
    () =>
      pickAiCards(ctx.dueVocab, ctx.vocab, aiCount === "all" ? null : aiCount),
    [ctx.dueVocab, ctx.vocab, aiCount],
  );
  const aiTotalEligible = useMemo(
    () => pickAiCards(ctx.dueVocab, ctx.vocab, null).length,
    [ctx.dueVocab, ctx.vocab],
  );

  // Build the queue once the user confirms a mode. Library mode runs
  // the original FTS-backed lookup; AI mode batches a single LLM call
  // for all selected cards.
  useEffect(() => {
    if (mode == null) return;
    let cancelled = false;
    setBuilding(true);
    setBuildError(null);
    void (async () => {
      void ctx.ensureSessionStarted("review");
      try {
        if (mode === "library") {
          const cards = pickCards(ctx.dueVocab, ctx.vocab);
          // Slots are filled in queue order: a reused save lands
          // immediately, a fresh corpus hit is deferred until after the
          // batched translation call so we don't fire one request per
          // card.
          const enriched: CardWithSentence[] = new Array(cards.length);
          const pending: {
            slot: number;
            card: VocabEntry;
            sentence: string;
            sourceTitle: string | null;
          }[] = [];
          for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            // Reuse a saved sentence first — it already carries the
            // translation we generated last time, so the word the user
            // hasn't reviewed yet shows the same cloze without another
            // search or LLM round-trip.
            const saved = pickSavedExample(card.cardNotes, card.word);
            if (saved) {
              enriched[i] = {
                card,
                sentence: saved.target,
                sourceTitle: null,
                translation: saved.native ?? null,
              };
              continue;
            }
            const example = await findExampleSentence(ctx.workspace.id, card.word);
            if (example) {
              pending.push({
                slot: i,
                card,
                sentence: example.sentence,
                sourceTitle: example.sourceTitle,
              });
            } else {
              enriched[i] = { card, sentence: null, sourceTitle: null };
            }
          }
          // Give the freshly-found corpus sentences a real translation in
          // one batched call. Provider-gated: without one we leave the
          // translation null and the reveal falls back to the gloss, the
          // same as the original library behaviour.
          let translations: (string | null)[] = pending.map(() => null);
          if (provider && pending.length > 0) {
            translations = await translateSentences({
              items: pending.map((p) => ({ word: p.card.word, sentence: p.sentence })),
              targetLang: ctx.workspace.targetLang,
              nativeLang: ctx.workspace.nativeLang,
              sendChat,
            }).catch(() => pending.map(() => null));
          }
          pending.forEach((p, k) => {
            const translation = translations[k] ?? null;
            enriched[p.slot] = {
              card: p.card,
              sentence: p.sentence,
              sourceTitle: p.sourceTitle,
              translation,
            };
            // Persist so re-entry reuses it (and sentence-cards can fall
            // back to it). Library sentences come from the user's own
            // corpus → source "user".
            void persistExample(p.card, p.sentence, translation, "user");
          });
          if (!cancelled) setQueue(enriched);
          return;
        }
        // AI mode — generate cloze sentences in one batched call.
        if (!provider) {
          if (!cancelled)
            setBuildError(
              "AI mode needs a provider. Configure one in Settings → Providers.",
            );
          return;
        }
        const targetCards = aiEligible;
        if (targetCards.length === 0) {
          if (!cancelled) setQueue([]);
          return;
        }
        // Reuse anything we generated (or the user saved) before: a word
        // the user hasn't reviewed yet keeps the same cloze instead of
        // re-spending tokens on a fresh one. Only the cards without a
        // saved sentence go to the model.
        const enriched: CardWithSentence[] = new Array(targetCards.length);
        const toGenerate: { slot: number; card: VocabEntry }[] = [];
        targetCards.forEach((card, i) => {
          const saved = pickSavedExample(card.cardNotes, card.word);
          if (saved) {
            enriched[i] = {
              card,
              sentence: saved.target,
              sourceTitle: null,
              translation: saved.native ?? null,
            };
          } else {
            toGenerate.push({ slot: i, card });
          }
        });
        if (toGenerate.length > 0) {
          const generated = await generateClozeSentences({
            cards: toGenerate.map((g) => g.card),
            // Pass the workspace's known vocab so the prompt can lock the
            // surrounding context to words the user actually owns. The
            // cloze is the test — every OTHER word in the sentence
            // should be familiar, otherwise the user is guessing two
            // unknowns at once.
            knownVocab: ctx.vocab,
            level: aiLevel,
            targetLang: ctx.workspace.targetLang,
            nativeLang: ctx.workspace.nativeLang,
            sendChat,
          });
          generated.forEach((g, k) => {
            enriched[toGenerate[k].slot] = g;
            // Save the generation so it survives re-entry. Skip the cards
            // the model failed on (sentence === null) — there's nothing
            // worth persisting.
            if (g.sentence) {
              void persistExample(g.card, g.sentence, g.translation ?? null, "ai");
            }
          });
        }
        if (!cancelled) setQueue(enriched);
      } catch (err) {
        if (!cancelled)
          setBuildError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBuilding(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ctx.workspace.id]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [idx]);

  // Setup screen — first thing the user sees. Picks library vs AI and
  // (for AI) how many cards to drill in this session.
  if (mode == null) {
    return (
      <SetupScreen
        provider={provider != null}
        aiCount={aiCount}
        setAiCount={setAiCount}
        aiLevel={aiLevel}
        setAiLevel={setAiLevel}
        aiEligibleTotal={aiTotalEligible}
        drillMode={ctx.drillMode}
        setDrillMode={ctx.setDrillMode}
        srsAnchorState={ctx.srsAnchorState}
        onPick={(m) => setMode(m)}
      />
    );
  }

  if (queue == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        {mode === "ai" ? (
          <>
            <p>Generating cloze sentences with the AI…</p>
            <p className="text-[11.5px] opacity-70">
              {aiEligible.length} card{aiEligible.length === 1 ? "" : "s"} ·
              one batched call
            </p>
          </>
        ) : (
          <p>Looking for example sentences in your reader…</p>
        )}
      </div>
    );
  }

  if (buildError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <XCircle className="size-6 text-rose-500" />
        <h2 className="font-serif text-2xl tracking-tight">Couldn't build the queue.</h2>
        <p className="max-w-md text-[13px] text-muted-foreground">{buildError}</p>
        <Button variant="outline" onClick={() => setMode(null)}>
          Back to setup
        </Button>
      </div>
    );
  }

  // The construction phase between modes — preserves a graceful
  // fallback if `building` is true but `queue` is also non-null
  // (rare; happens when re-entering the queue after a state reset).
  if (building) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Preparing the next session…
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <EmptyQueue
        onLeave={() =>
          ctx.onSessionEnd({
            cardsReviewed: 0,
            durationSecs: Math.floor(Date.now() / 1000) - startedAt,
          })
        }
      />
    );
  }

  const item = queue[idx];

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <CheckCircle2 className="size-7 text-emerald-500" />
        <h2 className="font-serif text-3xl tracking-tight">Session complete.</h2>
        <p className="text-[13.5px] text-muted-foreground">
          {idx} card{idx === 1 ? "" : "s"} ·{" "}
          {Math.max(1, Math.floor((Date.now() / 1000 - startedAt) / 60))} min ·{" "}
          {stats.current.sentencesUsed} from your library,{" "}
          {stats.current.fallbacks} from glosses
        </p>
        <Button
          variant="outline"
          onClick={() =>
            ctx.onSessionEnd({
              cardsReviewed: idx,
              durationSecs: Math.floor(Date.now() / 1000) - startedAt,
              grades: { ...stats.current },
              extra: {
                sentencesUsed: stats.current.sentencesUsed,
                fallbacks: stats.current.fallbacks,
              },
            })
          }
        >
          End session
        </Button>
      </div>
    );
  }

  const { card, sentence, sourceTitle, translation } = item;
  const expected = card.word;
  const hasReadings = profileFor(ctx.workspace.targetLang as LanguageCode).hasReadings;

  const masked = sentence ? maskWord(sentence, expected) : null;

  function check() {
    // Allow typing the pinyin / reading instead of the target script.
    // Helpful for Chinese / Japanese learners who haven't installed a
    // CJK input method (or just want to drill aural recall). The
    // reading on the card was set when the dictionary entry was saved.
    const ok = isMatch(input, expected, card.reading ?? null);
    if (ok) {
      setFeedback("correct");
      void ctx.bump("words_seen");
      // Tally a soft grade based on mistakes for this card.
      const grade =
        mistakes === 0 ? "easy" : mistakes === 1 ? "good" : "again";
      stats.current[grade] += 1;
      if (sentence) stats.current.sentencesUsed += 1;
      else stats.current.fallbacks += 1;
      void ctx.reviewVocab(card.id, grade);
      // No auto-advance — the user explicitly hits Next to move on.
      // That gives them time to read the full sentence with
      // click-to-define highlighting + the English translation
      // before the next card.
    } else {
      setFeedback("wrong");
      setMistakes((m) => m + 1);
    }
  }

  function advance() {
    setIdx((i) => i + 1);
    setInput("");
    setFeedback("idle");
    setRevealed(false);
    setMistakes(0);
  }

  /** Ask the active provider for a short, non-translating hint about
   *  the masked word. The prompt is explicit: don't reveal the
   *  translation, give a clue someone could use to guess. Cached
   *  per-card so spamming the button doesn't re-cost tokens. */
  async function requestHint() {
    if (!card || hintBusy) return;
    if (hintsByCard[card.id]) return; // already have one
    if (!provider) {
      toast.info("Add a provider in Settings → Providers to get hints.");
      return;
    }
    setHintBusy(true);
    try {
      const native = languageName(ctx.workspace.nativeLang);
      const target = languageName(ctx.workspace.targetLang);
      const sentenceContext = sentence
        ? `The word appears in: "${sentence}"`
        : "";
      const reply = await sendChat({
        messages: [
          {
            role: "system",
            content:
              `You give riddle-style hints for a ${target} vocabulary drill. ` +
              `Output ONE short ${native} sentence (max 12 words) that hints at ` +
              `what the masked word means WITHOUT translating it. ` +
              `Hint with category, function, or context. Forbidden: the literal ${native} translation, the ${target} word, the reading. ` +
              `No quotes, no labels, no commentary — just the hint.`,
          },
          {
            role: "user",
            content:
              `Word (do NOT translate this): ${card.word}\n` +
              (card.reading ? `Reading: ${card.reading}\n` : "") +
              (sentenceContext ? sentenceContext + "\n" : "") +
              `\nGive the hint.`,
          },
        ],
        onToken: () => {},
      });
      const hint = reply.trim().replace(/^["']|["']$/g, "");
      if (hint) {
        setHintsByCard((prev) => ({ ...prev, [card.id]: hint }));
      }
    } catch (err) {
      toast.error(
        `Hint failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setHintBusy(false);
    }
  }

  function reveal() {
    setRevealed(true);
    setMistakes((m) => Math.max(m, 2)); // count revealed cards as needs-more-practice
  }

  // ── Top-bar actions (parity with vocab-recall) ────────────────────────
  // Boost — re-study this card later in the same session, mark FSRS
  // "again". We keep the enriched CardWithSentence payload so the
  // re-surfaced card still has its example sentence.
  function actionBoost() {
    if (!queue) return;
    const item = queue[idx];
    if (!item) return;
    void ctx.reviewVocab(item.card.id, "again");
    stats.current.again += 1;
    setQueue((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      const insertAt = Math.min(prev.length, idx + 5);
      next.splice(insertAt, 0, item);
      return next;
    });
    advance();
    toast.success(`Boosted "${item.card.word}" — coming back soon`);
  }

  function startNeverAgain() {
    if (!queue) return;
    const item = queue[idx];
    if (!item) return;
    setPendingNeverAgain(item.card);
  }

  async function confirmNeverAgain() {
    const target = pendingNeverAgain;
    setPendingNeverAgain(null);
    if (!target) return;
    await deleteVocab(target.id);
    setQueue((prev) => (prev ? prev.filter((q) => q.card.id !== target.id) : prev));
    advance();
    toast(`Removed "${target.word}"`);
  }

  return (
    <>
      {/* Top action bar — full-width, mirroring the vocab-recall and
          hanzi-writing pattern. Progress + sentence source on the left,
          session-level actions (Boost / Never-again / Pause) on the
          right. */}
      <TooltipProvider delayDuration={300}>
        <div className="border-b border-border px-6 pt-2 pb-3">
          <div className="flex w-full items-center gap-4">
            <p className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {idx + 1} / {queue.length}
              {sourceTitle && (
                <span className="ml-2 text-[10.5px] text-muted-foreground/80">
                  · from {sourceTitle}
                </span>
              )}
            </p>
            <div className="flex-1">
              <Progress value={(idx / Math.max(1, queue.length)) * 100} />
            </div>
            <div className="flex items-center gap-1">
              <TopBarButton
                onClick={() => setAiOpen(true)}
                tooltip="Ask AI about this card  ·  A"
                className={cn(
                  aiOpen && "bg-accent text-foreground",
                )}
              >
                <Sparkles className="size-4" />
              </TopBarButton>
              <TopBarButton
                onClick={actionBoost}
                tooltip="Boost — re-study this card later in the same session."
                className="text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
              >
                <RocketIcon className="size-4" />
              </TopBarButton>
              <TopBarButton
                onClick={startNeverAgain}
                tooltip="Never show this card again — removes it from your vocabulary."
                className="text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
              >
                <Ban className="size-4" />
              </TopBarButton>
              <div className="mx-1 h-5 w-px bg-border" />
              <TopBarButton
                onClick={() => setPaused(true)}
                tooltip="Pause"
              >
                <Pause className="size-4" />
              </TopBarButton>
            </div>
          </div>
        </div>
      </TooltipProvider>

      <div className="flex flex-1 items-center justify-center px-6 py-8">
        <div className="w-full max-w-2xl">
          <div className="rounded-2xl border border-border bg-card px-6 py-7 text-center shadow-sm">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {sentence ? "Fill in the blank" : "Type the word"}
            </div>

            {sentence ? (
              <div className="mt-4 font-serif text-[20px] leading-relaxed">
                {revealed || feedback === "correct" ? (
                  // After reveal: render the full sentence through the
                  // shared Tokenized component so every word gets the
                  // status-coloured underline + click-to-define popover
                  // and (when enabled) pinyin/furigana ruby. The cloze
                  // target is wrapped in a highlight via key-based
                  // splitting so it still stands out.
                  <RevealedSentence
                    text={sentence}
                    highlight={expected}
                    lang={ctx.workspace.targetLang as LanguageCode}
                  />
                ) : (
                  <SentenceWithBlank
                    text={masked ?? sentence}
                    highlight={expected}
                    reveal={false}
                  />
                )}
              </div>
            ) : (
              <div className="mt-4">
                <p className="text-[14px] text-foreground/85">
                  {sourceTitle === "AI"
                    ? "The AI didn't return a usable sentence for this card. Working from the gloss:"
                    : "No example in your library yet. Working from the gloss:"}
                </p>
                <div className="mt-3 font-serif text-2xl">
                  {card.gloss ?? "(no gloss)"}
                </div>
              </div>
            )}

            {/* Translation reveal — only shown after the user grades or
                reveals. Always starts blurred (local-only blur, ignores
                the global showTranslations toggle) so the answer card
                stays a moment of self-testing. AI-mode sentences carry
                a model-provided translation; library-mode sentences
                fall back to the card's gloss as a translation hint. */}
            {(revealed || feedback === "correct") && sentence && (
              // After grading: show the English translation
              // unblurred so the user can read it alongside the
              // highlighted target sentence before moving on. The
              // earlier blurred behaviour was friction (you had to
              // click twice — once to grade, once to read) and the
              // user explicitly asked for it visible immediately.
              <div className="mt-3 flex justify-center">
                {feedback === "correct" ? (
                  <p className="max-w-md text-center text-[13px] leading-relaxed text-foreground/80">
                    {translation ||
                      card.gloss?.split(/;\s*/).slice(0, 3).join(" · ") ||
                      "(no translation)"}
                  </p>
                ) : (
                  <LocalBlur
                    key={`${idx}-${sentence}`}
                    text={
                      translation ||
                      card.gloss?.split(/;\s*/).slice(0, 3).join(" · ") ||
                      "(no translation)"
                    }
                  />
                )}
              </div>
            )}

            {/* Riddle-style AI hint. Generic clue about what the
                masked word means — function, category, context — but
                NOT the translation. Renders once requested via the
                Hint button below; cached per card so the user can
                stare at it as long as they need. */}
            {sentence && !revealed && feedback !== "correct" && hintsByCard[card.id] && (
              <div className="mt-3 flex justify-center">
                <div className="inline-flex max-w-md items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[12.5px] text-amber-800 dark:text-amber-200">
                  <span className="text-base leading-none">💡</span>
                  <span className="leading-snug">{hintsByCard[card.id]}</span>
                </div>
              </div>
            )}

            {sentence && !revealed && feedback !== "correct" && (
              // Three blurred hint chips, in increasing strength.
              // Click any one to reveal that level of help — others
              // stay hidden so the user only spends the assistance
              // they actually need.
              //   1. Starts with: first grapheme of the target. The
              //      lightest nudge — almost a free hint, often
              //      enough to unstick memory without revealing the
              //      word.
              //   2. Reading: pinyin / furigana / romaji. Tells you
              //      *how* to say it without telling you *what* it
              //      means. Only renders when the card carries a
              //      reading (CJK + a few others).
              //   3. Translation: the full gloss. Heaviest hint —
              //      pretty much hands you the answer.
              // All three reuse the same LocalBlur element so the
              // reveal interaction is consistent with the post-grade
              // translation block.
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[11.5px]">
                <HintChip label="starts with" value={firstGrapheme(expected)} />
                {card.reading && card.reading.trim() && (
                  <HintChip label="reading" value={card.reading.trim()} />
                )}
                {card.gloss && (
                  <HintChip
                    label="translation"
                    value={card.gloss
                      .split(/;\s*/)
                      .slice(0, 3)
                      .join(" · ")}
                  />
                )}
              </div>
            )}

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
                  if (feedback === "correct") return;
                  if (feedback === "wrong") {
                    setInput("");
                    setFeedback("idle");
                    return;
                  }
                  check();
                }}
                placeholder={hasReadings ? "type the word (or pinyin / reading)" : "type the word"}
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

            {feedback === "wrong" && (
              <div className="mt-3 flex items-center justify-center gap-2 rounded-md bg-rose-500/10 px-3 py-2 text-[13px] text-rose-700 dark:text-rose-300">
                <XCircle className="size-4 shrink-0" />
                <span>Not quite — try again, or reveal.</span>
              </div>
            )}

            <div className="mt-4 flex items-center justify-center gap-2">
              {feedback === "correct" ? (
                <Button onClick={advance} size="sm">
                  Next →
                </Button>
              ) : (
                <>
                  <Button onClick={check} disabled={!input.trim()}>
                    Check
                  </Button>
                  {/* AI hint — generic riddle-style clue that does
                      NOT reveal the translation. Disabled while the
                      AI call is in flight; once a hint exists for
                      the current card, the button just becomes a
                      reminder ("Hint shown") since clicking again
                      would do nothing useful. */}
                  <Button
                    onClick={() => void requestHint()}
                    variant="ghost"
                    size="sm"
                    disabled={hintBusy || !!hintsByCard[card.id]}
                    title={
                      hintsByCard[card.id]
                        ? "Hint already shown above"
                        : "Get a clue about the word — no translation"
                    }
                  >
                    {hintBusy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <span className="text-base leading-none">💡</span>
                    )}
                    Hint
                  </Button>
                  <Button onClick={reveal} variant="ghost" size="sm">
                    <Eye className="size-3.5" />
                    Reveal
                  </Button>
                </>
              )}
              <SpeakButton
                text={card.word}
                lang={ctx.workspace.targetLang}
                vocabId={card.id}
                cachedAudioAvailable={card.hasAudio}
              />
            </div>

            {(revealed || feedback === "correct") && (
              <div className="mt-4 space-y-1 text-[13px] text-foreground/85">
                <div>
                  <span className="font-mono text-[14px] font-semibold">
                    {card.word}
                  </span>
                  {card.reading && (
                    <span className="ml-2 text-muted-foreground">{card.reading}</span>
                  )}
                </div>
                {card.gloss && <p className="text-muted-foreground">{card.gloss}</p>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* AI tutor sidebar — same drawer the vocab-recall plugin uses.
          The current cloze sentence is fed in as extra system context
          when present so the tutor can explain the surrounding prose
          without being asked twice. */}
      <StudyAiDrawer
        open={aiOpen}
        card={card}
        targetLang={ctx.workspace.targetLang}
        nativeLang={ctx.workspace.nativeLang}
        extraSystemContext={
          sentence
            ? `The learner is drilling a cloze of "${card.word}" in this sentence:\n${sentence}`
            : undefined
        }
        onClose={() => setAiOpen(false)}
      />

      {/* Pause overlay — fullscreen take-a-break with Resume / End.
          End ships partial stats so the host's session-summary screen
          renders correctly. */}
      {paused && (
        <PauseOverlay
          progress={(idx / Math.max(1, queue.length)) * 100}
          done={idx}
          total={queue.length}
          startedAt={startedAt}
          onResume={() => setPaused(false)}
          onEnd={() =>
            ctx.onSessionEnd({
              cardsReviewed: idx,
              durationSecs: Math.floor(Date.now() / 1000) - startedAt,
              grades: { ...stats.current },
              extra: {
                sentencesUsed: stats.current.sentencesUsed,
                fallbacks: stats.current.fallbacks,
              },
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

// ─── Top bar button + pause overlay ───────────────────────────────────
//
// Inline copies of the same two helpers used by hanzi-writing and
// vocab-recall. We deliberately don't export them from a shared module
// yet — the implementations are tiny, the divergence cost is low, and
// extracting before we have three or four real call sites would lock
// in a contract before we know what's truly common across plugins.

function TopBarButton({
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
  done,
  total,
  startedAt,
  onResume,
  onEnd,
}: {
  progress: number;
  done: number;
  total: number;
  startedAt: number;
  onResume: () => void;
  onEnd: () => void;
}) {
  const minutes = Math.max(
    1,
    Math.round((Math.floor(Date.now() / 1000) - startedAt) / 60),
  );
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
          {done} / {total} cards · {minutes}m
        </p>
        <div className="mt-4">
          <Progress value={progress} />
        </div>
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
      </div>
    </div>
  );
}

// ── Helpers ──

function EmptyQueue({ onLeave }: { onLeave: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Sprout className="size-6 text-muted-foreground" />
      <h2 className="font-serif text-2xl tracking-tight">Nothing to mine yet.</h2>
      <p className="max-w-md text-[13.5px] text-muted-foreground">
        Save some vocabulary first. Sentence mining works best when you have
        reader passages, notes, or textbook chapters that contain those words —
        the plugin finds real sentences to drill against.
      </p>
      <Button variant="ghost" onClick={onLeave}>
        Leave session
      </Button>
    </div>
  );
}

/** Up to 25 cards: due first, then any non-mastered fillers. */
function pickCards(due: VocabEntry[], all: VocabEntry[]): VocabEntry[] {
  const seen = new Set(due.map((c) => c.id));
  const fillers = all.filter((c) => !seen.has(c.id) && c.status !== "mastered");
  return [...due, ...fillers].slice(0, 25);
}

/** AI mode card picker. Pulls the cards the user struggles with most:
 *  due cards first (status='learning' and status='review' that have
 *  rolled over), then any other learning-status cards as fillers.
 *  Excludes 'mastered' (already owned) and 'new' (the user hasn't
 *  studied them yet — drilling cloze on never-seen words is more
 *  punitive than helpful). `cap` limits the total; null = unlimited. */
function pickAiCards(
  due: VocabEntry[],
  all: VocabEntry[],
  cap: number | null,
): VocabEntry[] {
  const seen = new Set<number>();
  const out: VocabEntry[] = [];
  for (const v of due) {
    if (v.status === "mastered" || v.status === "new") continue;
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
  }
  for (const v of all) {
    if (seen.has(v.id)) continue;
    if (v.status !== "learning" && v.status !== "review") continue;
    seen.add(v.id);
    out.push(v);
  }
  return cap == null ? out : out.slice(0, cap);
}

/** Batched cloze-sentence generation. One LLM call per session,
 *  regardless of how many cards. The prompt locks the context to
 *  vocab the user already owns — only the cloze target may be
 *  unfamiliar — so the drill tests one unknown at a time, not two.
 *  The model returns a JSON array matching the input order; we
 *  tolerate any missing entries (those cards fall back to the original
 *  "type the word from the gloss" prompt at runtime). */
export async function generateClozeSentences(args: {
  cards: VocabEntry[];
  /** Workspace vocabulary used to build the KNOWN list in the
   *  prompt. We deliberately accept the in-memory list rather than
   *  re-querying — `ctx.vocab` is already capped at 500 by
   *  `listStudyVocab`, which is plenty for the prompt and avoids
   *  shipping the same payload across IPC twice per session. */
  knownVocab: VocabEntry[];
  /** How tightly to constrain the surrounding context. */
  level: AiLevel;
  targetLang: string;
  nativeLang: string;
  sendChat: ReturnType<typeof useProviderConfigs>["sendChat"];
}): Promise<CardWithSentence[]> {
  const { cards, knownVocab, level, targetLang, nativeLang, sendChat } = args;
  if (cards.length === 0) return [];
  const target = languageName(targetLang as LanguageCode);
  const native = languageName(nativeLang as LanguageCode);
  const targetWordSet = new Set(cards.map((c) => c.word));

  // KNOWN-vocab buckets. Mastered + review = "proven" (user has
  // recalled these multiple times); learning = "currently studying"
  // (familiar enough to recognize in context). We surface them as
  // separate sections so the model can lean harder on mastered words
  // when possible while still allowing learning words. We also
  // exclude the cards being drilled in this session — the cloze
  // target shouldn't appear in the KNOWN list, otherwise the model
  // might use it twice and break the drill.
  // Caps tightened: 80 mastered + 40 learning is plenty of context
  // for a single cloze sentence. The model only references a few
  // words per sentence, so larger lists were token waste.
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
      const gloss = c.gloss ? ` — ${c.gloss.split(/;\s*/).slice(0, 2).join("; ")}` : "";
      return `${i + 1}. ${c.word}${gloss}`;
    })
    .join("\n");

  const lines: string[] = [
    `${target} cloze tutor. For each TARGET word, write ONE short natural ${target} sentence using the exact word — it will be masked as the test prompt.`,
  ];
  // JSONL (one object per line). Small / local models keep this shape
  // far more reliably than a single JSON array — a partial truncation
  // still leaves the previous lines parseable, and they don't get
  // confused by trailing commas + array brackets. Numbered fallback
  // formats are also accepted by the client parser.
  const exampleSentence =
    cards[0]?.word
      ? `e.g. {"index":1,"sentence":"...${cards[0].word}...","translation":"..."}`
      : `e.g. {"index":1,"sentence":"...","translation":"..."}`;
  const jsonLine =
    `Output format: one JSON object per line, no array brackets, no markdown fences, no commentary. ` +
    `Shape: {"index":N,"sentence":"<${target} sentence>","translation":"<${native}>"}. ` +
    `${exampleSentence}. ` +
    `One line per TARGET. Indexes match TARGETS below.`;
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
      { role: "user", content: `Generate cloze sentences for ${cards.length} words.` },
    ],
    onToken: () => {},
  });
  const parsed = parseClozeResponse(reply);
  // Build a lookup by index so we don't depend on the model preserving
  // order — some models drop entries, some renumber. We accept entries
  // both by their `index` field AND by their position in the parsed
  // array, so a local LLM that forgets the index still works as long
  // as the order matches.
  const byIndex = new Map<number, { sentence: string; translation?: string }>();
  parsed.forEach((p, posIdx) => {
    if (!p.sentence) return;
    const idx = typeof p.index === "number" ? p.index : posIdx + 1;
    byIndex.set(idx, { sentence: String(p.sentence), translation: p.translation });
  });
  // Diagnostic: when the parser found nothing at all, leave a console
  // breadcrumb so the user can see why every card fell back to the
  // gloss prompt. Common on small local LLMs that ignore the JSON
  // instructions entirely.
  if (parsed.length === 0 && reply.trim().length > 0) {
    console.warn(
      "[sentence-mining] AI replied but no cloze sentences could be parsed. Raw reply (truncated):",
      reply.slice(0, 400),
    );
  }
  return cards.map((card, i) => {
    const hit = byIndex.get(i + 1);
    if (!hit || !sentenceContainsWord(hit.sentence, card.word)) {
      // Either missing entry or the model emitted a sentence without
      // the target word — fall back to the gloss-based "type the
      // word" mode for this card. We still mark the source as AI so
      // the session-summary tally is honest about how many cards the
      // model failed on.
      return { card, sentence: null, sourceTitle: "AI" };
    }
    return {
      card,
      sentence: hit.sentence.trim(),
      sourceTitle: "AI",
      translation: hit.translation?.trim() || null,
    };
  });
}

/** Robust parser for the cloze-generation reply.
 *
 *  Local LLMs almost never emit clean JSON. The legacy implementation
 *  required a single well-formed JSON array between the first `[` and
 *  last `]`, which fell over on:
 *   - smart / curly quotes (most templated chat finetunes)
 *   - trailing commas after the last object
 *   - extra prose before the array
 *   - a per-line JSONL output (very common on Llama 3.x and Qwen)
 *   - numbered-list output ("1. sentence — translation")
 *
 *  This version tries each format in turn and returns whichever yields
 *  the most entries. Order: strict JSON → JSONL → per-object regex →
 *  numbered list. Each stage is silent on its own failure; only the
 *  empty-everything case warrants a console breadcrumb (handled in the
 *  caller).
 */
function parseClozeResponse(
  raw: string,
): { index?: number; sentence?: string; translation?: string }[] {
  if (!raw) return [];
  // Strip BOM, ALL code fences (some models emit several blocks),
  // and normalise smart quotes / non-breaking spaces. Doing this once
  // up-front means every downstream parser sees the same shape.
  const cleaned = raw
    .replace(/^﻿/, "")
    .replace(/```[\w]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/ /g, " ")
    .trim();

  const stages = [
    () => tryParseJsonArray(cleaned),
    () => tryParseJsonl(cleaned),
    () => tryExtractJsonObjects(cleaned),
    () => tryParseNumberedList(cleaned),
  ];
  let best: { index?: number; sentence?: string; translation?: string }[] = [];
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

/** Quick JSON-array path. Locates the outermost `[ ... ]` and tolerates
 *  trailing commas, the single most common JSON output bug on local
 *  LLMs. */
function tryParseJsonArray(
  s: string,
): { index?: number; sentence?: string; translation?: string }[] {
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  const slice = stripTrailingCommas(s.slice(start, end + 1));
  const parsed = JSON.parse(slice) as unknown;
  return Array.isArray(parsed) ? (parsed as never[]) : [];
}

/** JSONL: one JSON object per line, no enclosing array. Many small
 *  models prefer this because they don't have to track an open
 *  bracket across many lines. */
function tryParseJsonl(
  s: string,
): { index?: number; sentence?: string; translation?: string }[] {
  const out: { index?: number; sentence?: string; translation?: string }[] = [];
  for (const line of s.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/,\s*$/, "");
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const obj = JSON.parse(stripTrailingCommas(trimmed)) as Record<
        string,
        unknown
      >;
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

/** Last-resort regex grab: pull every `{ ... }` block that contains a
 *  "sentence" key. Handles a stream where objects are separated by
 *  prose, not commas. */
function tryExtractJsonObjects(
  s: string,
): { index?: number; sentence?: string; translation?: string }[] {
  const out: { index?: number; sentence?: string; translation?: string }[] = [];
  // Non-greedy, balanced enough for one-level-deep flat objects (the
  // shape we asked for has no nested objects). Multi-line via the [^]
  // pattern since `s` flag isn't always portable.
  const re = /\{[^{}]*?"sentence"[^{}]*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    try {
      const obj = JSON.parse(stripTrailingCommas(m[0])) as Record<
        string,
        unknown
      >;
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

/** Numbered-list fallback for models that abandoned JSON entirely:
 *     1. <target sentence> — <translation>
 *     2. <target sentence> (<translation>)
 *     3. <target sentence>
 *  Splits on the leading "N." / "N)" marker; the optional dash or
 *  parenthesised tail becomes the translation. */
function tryParseNumberedList(
  s: string,
): { index?: number; sentence?: string; translation?: string }[] {
  const out: { index?: number; sentence?: string; translation?: string }[] = [];
  const lineRe = /^\s*(\d+)\s*[.)]\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(s))) {
    const idx = Number(m[1]);
    const body = m[2];
    // Try dash separator first (em-dash, en-dash, ASCII hyphen with
    // whitespace), then a final parenthesised translation.
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
  // Drop `,` that immediately precedes `}` or `]`. Conservative — only
  // touches the comma when the next non-whitespace char is a closer.
  return s.replace(/,(\s*[}\]])/g, "$1");
}

/** Append a sentence to the card's saved examples, deduped by exact
 *  target text. Best-effort: the FSRS grade has already (or will) land
 *  independently, so a failed save is a missed convenience, not a lost
 *  review — we log and move on. Mirrors the save path in sentence-cards
 *  so a sentence saved by either mode shows up in the personal-dict
 *  Sentences view identically. */
async function persistExample(
  card: VocabEntry,
  sentence: string,
  translation: string | null,
  source: ExampleSentence["source"],
): Promise<void> {
  try {
    const existing = parseExamples(card.cardNotes);
    if (existing.some((e) => e.target === sentence)) return;
    const next: ExampleSentence[] = [
      ...existing,
      {
        id: newExampleId(),
        target: sentence,
        native: translation ?? undefined,
        source,
      },
    ];
    await updateVocabFields({ id: card.id, cardNotes: serialiseExamples(next) });
  } catch (err) {
    console.warn("[sentence-mining] example save failed", err);
  }
}

/** Batch-translate target-language sentences into the native language in
 *  one LLM call. Returns translations aligned to the input order; any
 *  the model drops come back as null so the caller can fall back to the
 *  gloss. Mirrors the cloze generator's JSONL-first, lenient parsing so
 *  small local models stay usable. */
export async function translateSentences(args: {
  items: { word: string; sentence: string }[];
  targetLang: string;
  nativeLang: string;
  sendChat: ReturnType<typeof useProviderConfigs>["sendChat"];
}): Promise<(string | null)[]> {
  const { items, targetLang, nativeLang, sendChat } = args;
  if (items.length === 0) return [];
  const target = languageName(targetLang as LanguageCode);
  const native = languageName(nativeLang as LanguageCode);
  const list = items.map((it, i) => `${i + 1}. ${it.sentence}`).join("\n");
  const systemPrompt = [
    `${target} → ${native} translator for a vocabulary drill.`,
    `Translate each numbered ${target} sentence into natural, faithful ${native}.`,
    `Output format: one JSON object per line, no array brackets, no markdown fences, no commentary.`,
    `Shape: {"index":N,"translation":"<${native}>"}.`,
    `One line per sentence. Indexes match the list below.`,
    ``,
    `## SENTENCES`,
    list,
  ].join("\n");
  const reply = await sendChat({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Translate ${items.length} sentences.` },
    ],
    onToken: () => {},
  });
  const parsed = parseTranslations(reply);
  const byIndex = new Map<number, string>();
  parsed.forEach((p, posIdx) => {
    if (!p.translation) return;
    const idx = typeof p.index === "number" ? p.index : posIdx + 1;
    byIndex.set(idx, p.translation);
  });
  return items.map((_, i) => byIndex.get(i + 1) ?? null);
}

/** Lenient parser for the translation reply. Same cleaning as
 *  parseClozeResponse, then: grab every flat `{ ... }` object carrying a
 *  "translation" key (covers JSON arrays, JSONL, and prose-separated
 *  objects in one pass), falling back to a numbered list when the model
 *  abandoned JSON entirely. */
function parseTranslations(
  raw: string,
): { index?: number; translation?: string }[] {
  if (!raw) return [];
  const cleaned = raw
    .replace(/^﻿/, "")
    .replace(/```[\w]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/ /g, " ")
    .trim();
  const out: { index?: number; translation?: string }[] = [];
  const re = /\{[^{}]*?"translation"[^{}]*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    try {
      const obj = JSON.parse(stripTrailingCommas(m[0])) as Record<string, unknown>;
      if (typeof obj.translation === "string") {
        out.push({
          index: typeof obj.index === "number" ? obj.index : undefined,
          translation: obj.translation,
        });
      }
    } catch {
      /* skip malformed object */
    }
  }
  if (out.length > 0) return out;
  // Numbered-list fallback: "N. translation" / "N) translation".
  const lineRe = /^\s*(\d+)\s*[.)]\s+(.+?)\s*$/gm;
  while ((m = lineRe.exec(cleaned))) {
    out.push({ index: Number(m[1]), translation: m[2].trim() });
  }
  return out;
}

// Exposed for tests + docs. Kept off the public API of the plugin so
// host code doesn't lean on the parser internals.
export const __INTERNAL = {
  parseClozeResponse,
  parseTranslations,
  sentenceContainsWord,
};

/** Looser containment test for "did the model use the target word?".
 *  Case-insensitive + NFC-normalised. Languages with no inflection
 *  (CJK) get exact substring; for inflected languages the model often
 *  conjugates ("comer" → "comemos"), so we also try a 4-char prefix
 *  match for words ≥ 5 chars. Function words ("a", "to") are too
 *  short to safely loose-match — we keep them strict.  */
function sentenceContainsWord(sentence: string, word: string): boolean {
  if (!sentence || !word) return false;
  const s = sentence.normalize("NFC");
  const w = word.normalize("NFC");
  if (s.includes(w)) return true;
  const ls = s.toLowerCase();
  const lw = w.toLowerCase();
  if (ls.includes(lw)) return true;
  // CJK: no inflection — the exact / case check above is the answer.
  if (/[一-鿿぀-ヿ가-힯]/.test(w)) return false;
  // Latin: try a stem match for words long enough to be safe.
  if (lw.length >= 5) {
    const stem = lw.slice(0, Math.max(4, Math.floor(lw.length * 0.6)));
    if (ls.includes(stem)) return true;
  }
  return false;
}

function SetupScreen({
  provider,
  aiCount,
  setAiCount,
  aiLevel,
  setAiLevel,
  aiEligibleTotal,
  drillMode,
  setDrillMode,
  srsAnchorState,
  onPick,
}: {
  provider: boolean;
  aiCount: AiCount;
  setAiCount: (c: AiCount) => void;
  aiLevel: AiLevel;
  setAiLevel: (l: AiLevel) => void;
  aiEligibleTotal: number;
  drillMode: boolean;
  setDrillMode: (next: boolean) => void;
  srsAnchorState: "unknown" | "free" | "alreadyAnchored";
  onPick: (mode: SourceMode) => void;
}) {
  const counts: AiCount[] = [10, 15, 20, "all"];
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
  return (
    <PrestartShell
      icon={Sprout}
      pluginName="Sentence mining"
      title="Pick a source for tonight's drill."
      description="Cloze the missing word from a real sentence — either pulled from your own library, or generated fresh by the AI for the words you're still working on."
      drillMode={drillMode}
      setDrillMode={setDrillMode}
      srsAnchorState={srsAnchorState}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Library mode — keeps the original FTS-backed behaviour. */}
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
            Pull example sentences from passages you've actually read — reader
            docs, notes, textbook chapters. Falls back to the gloss for words
            your library doesn't cover yet.
          </p>
        </button>

        {/* AI mode — new in this round. */}
        <button
          type="button"
          onClick={() => onPick("ai")}
          disabled={!provider || aiEligibleTotal === 0}
          className={cn(
            "group flex flex-col gap-2 rounded-2xl border p-5 text-left shadow-sm transition-all",
            provider && aiEligibleTotal > 0
              ? "border-border bg-card hover:border-foreground/30 hover:shadow-md"
              : "cursor-not-allowed border-dashed border-border/50 bg-muted/30 opacity-60",
          )}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "flex size-9 items-center justify-center rounded-lg text-amber-700 dark:text-amber-300",
                "bg-amber-500/15",
              )}
            >
              <Sparkles className="size-4" />
            </div>
            <h3 className="font-serif text-lg tracking-tight">AI-generated cloze</h3>
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {provider
              ? `Generate fresh sentences for your hardest cards (learning + due). One batched LLM call at the start of the session — no per-card round-trips.`
              : "Configure a provider in Settings → Providers to enable AI mode."}
          </p>
          {provider && (
            <p className="text-[11.5px] text-muted-foreground/80">
              Eligible cards: {aiEligibleTotal}{" "}
              {aiEligibleTotal === 1 ? "word" : "words"} (learning + review)
            </p>
          )}
        </button>
      </div>

      {/* Per-mode options — count + difficulty for AI mode. Both
          sit in the same card so the user can see all the AI knobs
          in one place before they pick the source. */}
      {provider && aiEligibleTotal > 0 && (
        <div className="space-y-4 rounded-2xl border border-border bg-card/40 px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">
              <BookOpen className="size-3.5" />
              Cards per AI session
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {counts.map((c) => {
                const label = c === "all" ? `All (${aiEligibleTotal})` : String(c);
                const active = aiCount === c;
                const disabled = c !== "all" && aiEligibleTotal < c;
                return (
                  <button
                    key={String(c)}
                    type="button"
                    onClick={() => setAiCount(c)}
                    disabled={disabled}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                      active
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-background hover:border-foreground/40",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              The AI generates all sentences in a single call at the start of the
              session, so the cap controls total prompt size + LLM cost.
            </p>
          </div>

          <div className="border-t border-border/60 pt-4">
            <div className="flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">
              <Sparkles className="size-3.5" />
              Sentence difficulty
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {levels.map((l) => {
                const active = aiLevel === l.id;
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setAiLevel(l.id)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                      active
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-background hover:border-foreground/40",
                    )}
                  >
                    {l.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              {levels.find((l) => l.id === aiLevel)?.desc}
            </p>
          </div>
        </div>
      )}
    </PrestartShell>
  );
}

/**
 * Search the FTS knowledge base for a sentence containing `word`. Returns the
 * first matching sentence we can extract from the top-ranked snippet, plus a
 * label for where it came from. Null if nothing fits.
 */
async function findExampleSentence(
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

/** Replace every standalone occurrence of `word` in `text` with `____`. */
function maskWord(text: string, word: string): string {
  if (!word) return text;
  // Latin-script: prefer word-boundary replacement so we don't blank
  // sub-strings inside other words. CJK has no boundaries — fall back to a
  // global replace which is the right behaviour there.
  const isCJK = /[一-鿿぀-ヿ가-힯]/.test(word);
  if (isCJK) {
    return text.split(word).join("____");
  }
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "____");
}

function isMatch(
  user: string,
  expected: string,
  /** Optional reading (pinyin / furigana / romaji) the user can type
   *  instead of the target script. Lets a Mandarin learner type
   *  "ni3 hao3" or "nihao" instead of "你好" without losing credit. */
  reading?: string | null,
): boolean {
  const u = user.trim().toLowerCase().normalize("NFC");
  const e = expected.trim().toLowerCase().normalize("NFC");
  if (!u || !e) return false;
  if (u === e) return true;
  // Pinyin / reading fallback. We compare three forms: the raw reading
  // (with tones), the toneless reading (numbers stripped), and a fully
  // collapsed version (no spaces) — so "nǐ hǎo", "ni3 hao3", "ni hao",
  // and "nihao" all count as the same answer.
  if (!reading) return false;
  const candidates = pinyinForms(reading);
  return candidates.has(collapsePinyin(u));
}

/** Build the comparison set for an answer's reading. We do this once
 *  per check and short-circuit on the first match in `isMatch`. */
function pinyinForms(reading: string): Set<string> {
  const out = new Set<string>();
  // Strip CC-CEDICT-style brackets ("[ni3 hao3]") and any pipe
  // alternation ("zh|zhōng" → take first). Leftovers get normalized.
  const cleaned = reading
    .replace(/[\[\]]/g, "")
    .split("|")[0]
    .toLowerCase()
    .normalize("NFC");
  out.add(collapsePinyin(cleaned));
  // Also add the toneless form (numeric tones removed).
  out.add(collapsePinyin(cleaned.replace(/[1-5]/g, "")));
  // Tone-mark stripping for diacritic readings (nǐ → ni).
  const stripped = cleaned.normalize("NFD").replace(/\p{M}+/gu, "");
  out.add(collapsePinyin(stripped));
  return out;
}

function collapsePinyin(s: string): string {
  return s.replace(/\s+/g, "").replace(/[·']/g, "");
}

/** Render a revealed sentence with the target word marked AND every
 *  surrounding word run through `Tokenized` for click-to-define +
 *  pinyin/furigana ruby. The target word itself bypasses Tokenized so
 *  the highlight chip survives — wrapping it in Tokenized would have
 *  the segmenter chop it into syllables and lose the chip styling. */
function RevealedSentence({
  text,
  highlight,
  lang,
}: {
  text: string;
  highlight: string;
  lang: LanguageCode;
}) {
  if (!highlight || !text.includes(highlight)) {
    return <Tokenized text={text} lang={lang} />;
  }
  const parts = text.split(highlight);
  return (
    <span>
      {parts.map((p, i) => (
        <span key={i}>
          {p && <Tokenized text={p} lang={lang} />}
          {i < parts.length - 1 && (
            <mark className="rounded bg-emerald-500/15 px-1 text-emerald-700 dark:text-emerald-300">
              <Tokenized text={highlight} lang={lang} />
            </mark>
          )}
        </span>
      ))}
    </span>
  );
}

/** Pre-reveal hint badge — a labelled, blurred-by-default chip. The
 *  user clicks the chip to expose just that level of help (starts-with
 *  / reading / translation), keeping the others hidden so the cost of
 *  taking a hint scales with how much you're cheating. Visually a
 *  small pill so a row of them under the input doesn't dominate the
 *  card. */
function HintChip({ label, value }: { label: string; value: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setRevealed((v) => !v)}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-1 text-[11px] transition-colors hover:border-foreground/30 hover:bg-accent/40"
      title={revealed ? "Click to blur" : `Click to reveal ${label}`}
    >
      <span className="font-medium uppercase tracking-wider text-muted-foreground/80 text-[10px]">
        {label}
      </span>
      <span
        className={cn(
          "rounded-sm px-0.5 transition-all text-foreground/90",
          !revealed && "blur-[3.5px] hover:blur-[2px] select-none",
        )}
      >
        {value}
      </span>
    </button>
  );
}

/** First user-perceived "character" of `s`. Splitting on Unicode
 *  graphemes (via Intl.Segmenter when present) means combining marks,
 *  emoji, and CJK each behave naturally — `é` stays one grapheme, 你好
 *  yields 你, "abc" yields "a". Falls back to the first code point on
 *  older runtimes; we're inside a Tauri webview so Intl.Segmenter is
 *  always available, but the guard avoids surprises during a vitest
 *  run or browser dev mode. */
function firstGrapheme(s: string): string {
  if (!s) return "";
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const it = seg.segment(s)[Symbol.iterator]();
      const first = it.next();
      if (!first.done) return first.value.segment;
    } catch {
      /* fall through to codepoint */
    }
  }
  return Array.from(s)[0] ?? s[0] ?? "";
}

/** Click-to-reveal translation for the answer card. Always starts
 *  blurred — independent of the global `showTranslations` toggle —
 *  so the cloze answer card stays a moment of self-testing even when
 *  the user has translations on globally elsewhere. Re-blurs when the
 *  React `key` prop changes (e.g. moving to the next card). */
function LocalBlur({ text }: { text: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setRevealed((v) => !v)}
      className={cn(
        "rounded-sm border-b border-dotted border-foreground/40 px-0.5 text-[12.5px] text-muted-foreground transition-all",
        !revealed && "blur-[3px] hover:blur-[1.5px] cursor-pointer select-none",
      )}
      title={revealed ? "Click to blur" : "Click to reveal translation"}
    >
      {text}
    </button>
  );
}

/** Render a sentence highlighting the target word once it's revealed. */
function SentenceWithBlank({
  text,
  highlight,
  reveal,
}: {
  text: string;
  highlight: string;
  reveal: boolean;
}) {
  if (!reveal) {
    return <span>{text}</span>;
  }
  const parts = text.split(highlight);
  if (parts.length === 1) return <span>{text}</span>;
  return (
    <span>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && (
            <mark className="rounded bg-emerald-500/15 px-1 text-emerald-700 dark:text-emerald-300">
              {highlight}
            </mark>
          )}
        </span>
      ))}
    </span>
  );
}
