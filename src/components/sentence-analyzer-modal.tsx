/**
 * Sentence analyzer.
 *
 * Bigger-than-popover modal that gives the student a focused look at
 * one sentence pulled from a chat reply or a reader passage:
 *
 *   1. Header — the full sentence + a speak button.
 *   2. Translation row — pushes through the user's default translate
 *      engine (Google free / DeepL / etc.) or a chat provider when
 *      "AI" is the configured engine.
 *   3. Token strip — every word in the sentence becomes a clickable
 *      button; the active token gets an inline AI explanation that
 *      treats the surrounding sentence as context. Different from the
 *      regular click-to-define popover because the prompt explicitly
 *      asks "what does X mean *here*", which is what learners need
 *      when a word has multiple senses.
 *
 * Self-contained — only requires a `sentence` + `lang` string plus
 * the open / close handlers. The modal pulls the active workspace,
 * provider, and translate config from contexts itself so callers
 * (Tokenized popover, chat-markdown link, future shortcut) don't need
 * to thread them through.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Languages,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChatMarkdown } from "@/components/chat-markdown";
import { SpeakButton } from "@/components/speak-button";
import { StreamingText } from "@/components/streaming-text";
import { Tokenized } from "@/components/tokenized";
import { splitThinking, ThinkingPulse } from "@/components/thinking-block";
import { romanizeHangul } from "@/lib/romanize-ko";
import { splitSentences } from "@/lib/sentence-segment";
import { useProviderConfigs } from "@/lib/provider-context";
import { useWorkspace } from "@/lib/workspace-context";
import { listProviders, listTranslateConfigs } from "@/lib/db";
import {
  engineByKind,
  FALLBACK_ENGINE,
} from "@/lib/translate/registry";
import type { TranslateConfig } from "@/lib/translate/api";
import { languageName, type LanguageCode } from "@/lib/languages";
import { cn } from "@/lib/utils";

type AnalyzerMode = "plain" | "linguist";

export function SentenceAnalyzerModal({
  open,
  onClose,
  sentence: requestedSentence,
  lang,
  source,
}: {
  open: boolean;
  onClose: () => void;
  sentence: string;
  lang: LanguageCode;
  /** Reserved for a future "preselect this token" hint. We
   *  intentionally don't auto-fire AI on open — the user clicks a
   *  word to trigger the explanation. */
  initialFocus?: string;
  /** Full text the sentence came from + the clicked word's offset in
   *  it. Enables ‹ › paging through the whole reply / passage; absent,
   *  the modal shows just the requested sentence. */
  source?: { text: string; offset: number };
}) {
  const { active: workspace } = useWorkspace();
  const { active: provider, sendChat } = useProviderConfigs();

  // Sentence navigation. With a full source we split it into sentences
  // and let the header chevrons page through them. The derived
  // `sentence` drives everything below (tokenize, translate, AI calls)
  // exactly like the prop used to — paging resets the analysis panels
  // via the existing sentence-keyed effects.
  const sentences = useMemo(
    () => (source?.text ? splitSentences(source.text) : []),
    [source?.text],
  );
  // Offset the navigation is anchored at; null = the original request.
  const [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => {
    if (open) setCursor(null);
  }, [open, requestedSentence, source?.text, source?.offset]);
  const activeIdx = useMemo(() => {
    if (sentences.length === 0) return -1;
    const pos = cursor ?? source?.offset ?? 0;
    let idx = sentences.findIndex((s) => pos >= s.start && pos < s.end);
    // Clicked inside a gap between sentences (whitespace run) — snap
    // to the next one; past the last, snap to the last.
    if (idx === -1) idx = sentences.findIndex((s) => s.start >= pos);
    if (idx === -1) idx = sentences.length - 1;
    return idx;
  }, [sentences, cursor, source?.offset]);
  const sentence =
    activeIdx >= 0 ? sentences[activeIdx].sentence : requestedSentence;
  function goToSentence(idx: number) {
    const s = sentences[idx];
    if (s) setCursor(s.start);
  }
  const [tokens, setTokens] = useState<string[]>([]);
  const [tokenizing, setTokenizing] = useState(false);
  const [translation, setTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  // AI summary — one call that translates AND explains the sentence:
  // grammar constructions, conjugations / particles, nuance. Complements
  // the engine translation above (fast, literal) with the "why does it
  // mean that" layer.
  const [summary, setSummary] = useState<string>("");
  const [summarizing, setSummarizing] = useState(false);
  const [activeWord, setActiveWord] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<string>("");
  const [explaining, setExplaining] = useState(false);
  // Plain mode = current behaviour (click a word, AI explains).
  // Linguist mode = single AI call that produces a Leipzig-style
  // interlinear gloss for the whole sentence. Toggle is persisted per
  // workspace so a learner who lives in Linguist mode doesn't have to
  // re-flip it on every open.
  const [mode, setMode] = useState<AnalyzerMode>("plain");
  const [gloss, setGloss] = useState<string>("");
  const [glossing, setGlossing] = useState(false);
  const modeStorageKey = workspace ? `analyzer.mode.${workspace.id}` : null;
  useEffect(() => {
    if (!open || !modeStorageKey) return;
    const stored = localStorage.getItem(modeStorageKey);
    if (stored === "plain" || stored === "linguist") setMode(stored);
  }, [open, modeStorageKey]);
  function switchMode(next: AnalyzerMode) {
    setMode(next);
    if (modeStorageKey) localStorage.setItem(modeStorageKey, next);
  }

  // Reading toggle — pinyin ruby for Chinese, furigana for Japanese,
  // a Revised-Romanization line for Korean. Hidden for languages whose
  // script already carries the pronunciation. Persisted per workspace,
  // same pattern as the Plain/Linguist mode above.
  const readingLabel =
    lang === "zh"
      ? "Pinyin"
      : lang === "ja"
        ? "Furigana"
        : lang === "ko"
          ? "Romaja"
          : null;
  const readingStorageKey = workspace
    ? `analyzer.reading.${workspace.id}`
    : null;
  const [showReading, setShowReading] = useState(false);
  useEffect(() => {
    if (!open || !readingStorageKey) return;
    setShowReading(localStorage.getItem(readingStorageKey) === "1");
  }, [open, readingStorageKey]);
  function toggleReading() {
    setShowReading((prev) => {
      const next = !prev;
      if (readingStorageKey) {
        localStorage.setItem(readingStorageKey, next ? "1" : "0");
      }
      return next;
    });
  }
  // Track which translate engine + AI-or-not the user has configured
  // so the button label can say what's about to fire.
  const translateLabelRef = useRef<string>("Translate");

  // Tokenize on open. CJK languages need the Rust jieba (Chinese) /
  // simple grapheme split (Japanese / Korean) to produce useful word
  // boundaries; everything else can split on whitespace + light
  // punctuation.
  useEffect(() => {
    if (!open || !sentence) return;
    let cancelled = false;
    setTokenizing(true);
    setTranslation(null);
    setSummary("");
    setExplanation("");
    // Gloss too — without this a Linguist-mode gloss from the previous
    // sentence would show under the next one.
    setGloss("");
    setActiveWord(null);
    void (async () => {
      try {
        const t = await tokenize(sentence, lang);
        if (cancelled) return;
        setTokens(t);
        // Don't pre-select / auto-explain. The user fires the AI
        // call by clicking a token themselves.
      } finally {
        if (!cancelled) setTokenizing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sentence, lang]);

  // Note: we *don't* auto-explain `initialFocus` on open. The user
  // wants to trigger explanations themselves (cost + intent) — the
  // seeded focus token only highlights so they can see which word
  // the modal opened around. Click any token (the seed or a
  // different one) to fire the AI prompt.

  // Resolve the active translate engine label for the button so the
  // user sees which path will run. Cheap — done on open only.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const cfgs = await listTranslateConfigs().catch(() => [] as TranslateConfig[]);
      const def = cfgs.find((c) => c.isDefault) ?? cfgs[0] ?? null;
      const engine = def ? engineByKind(def.kind) ?? FALLBACK_ENGINE : FALLBACK_ENGINE;
      translateLabelRef.current = `Translate via ${engine.meta.name}`;
    })();
  }, [open]);

  async function runTranslate() {
    if (!workspace || !sentence) return;
    setTranslating(true);
    setTranslation(null);
    try {
      const cfgs = await listTranslateConfigs();
      const def = cfgs.find((c) => c.isDefault) ?? cfgs[0];
      const engine = def
        ? engineByKind(def.kind) ?? FALLBACK_ENGINE
        : FALLBACK_ENGINE;
      const config: TranslateConfig =
        def ??
        {
          id: 0,
          kind: "google-free",
          label: "Google (free)",
          apiKey: null,
          secondaryKey: null,
          baseUrl: null,
          providerId: null,
          model: null,
          isDefault: true,
          createdAt: 0,
        };
      // For AI-backed engines we hand back a callAi shim wrapping
      // sendChat so the engine doesn't need its own provider plumbing.
      const allProviders = await listProviders().catch(() => []);
      const result = await engine.translate({
        source: workspace.targetLang,
        target: workspace.nativeLang,
        texts: [sentence],
        config,
        callAi: async ({ messages }) => {
          // engine.translate doesn't carry a provider override, so we
          // just use the active one (sendChat reads the active config).
          return await sendChat({ messages, onToken: () => {} });
        },
        getProvider: (id: number) =>
          allProviders.find((p) => p.id === id) ?? null,
      });
      setTranslation(result[0] ?? "");
    } catch (err) {
      toast.error("Couldn't translate", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTranslating(false);
    }
  }

  async function runSummary() {
    if (!workspace || !provider) {
      toast.error("Configure a provider in Settings to use AI explanations");
      return;
    }
    setSummarizing(true);
    setSummary("");
    try {
      const target = languageName(workspace.targetLang);
      const native = languageName(workspace.nativeLang);
      const reply = await sendChat({
        messages: [
          {
            role: "system",
            content:
              `You're a ${target} grammar tutor. A student is reading a ` +
              `${target} sentence and wants to understand it fully. Write a ` +
              `concise breakdown in ${native}, formatted as markdown with ` +
              `exactly these bold-labelled sections:\n\n` +
              `**Translation:** a natural ${native} translation.\n` +
              `**Literal:** a word-order-preserving literal rendering — only ` +
              `when it differs meaningfully from the natural translation, ` +
              `otherwise omit the section.\n` +
              `**Grammar:** 2-4 bullet points (each starting with "- "), ` +
              `naming the constructions at work (tense/aspect, particles, ` +
              `conjugations, word order, clause structure) and what each ` +
              `contributes. Bold the ${target} forms you reference.\n` +
              `**Nuance:** one line on register, tone, or idiom — omit if ` +
              `nothing is notable.\n\n` +
              `Bold the section labels exactly as shown and leave a blank ` +
              `line between sections. No headings (#), no preamble, no ` +
              `commentary after the last section, and never include ` +
              `<think> or reasoning tags in your answer.`,
          },
          { role: "user", content: sentence },
        ],
        onToken: (delta) => setSummary((p) => p + delta),
      });
      setSummary(reply.trim());
    } catch (err) {
      toast.error("AI summary failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSummarizing(false);
    }
  }

  async function explainWord(word: string) {
    if (!workspace || !provider) {
      toast.error("Configure a provider in Settings to use AI explanations");
      return;
    }
    setActiveWord(word);
    setExplaining(true);
    setExplanation("");
    try {
      const target = languageName(workspace.targetLang);
      const native = languageName(workspace.nativeLang);
      const reply = await sendChat({
        messages: [
          {
            role: "system",
            content:
              `You're a ${target} tutor explaining vocabulary in context.` +
              ` The student is reading a ${target} sentence and needs to know` +
              ` what one word means *in this specific sentence*.\n\n` +
              `Output exactly three short numbered lines (1. / 2. / 3.), ` +
              `in ${native}:\n` +
              `1. The meaning of the word in this sentence (1 sentence).\n` +
              `2. The part of speech.\n` +
              `3. A concise reason for the meaning given the surrounding context.\n\n` +
              `Bold the word itself and key grammar terms with ` +
              `**double asterisks**. No preamble, no headings, and never ` +
              `include <think> or reasoning tags.`,
          },
          {
            role: "user",
            content: `Sentence: "${sentence}"\nWord: ${word}`,
          },
        ],
        onToken: (delta) => setExplanation((p) => p + delta),
      });
      // sendChat with onToken streams; we re-set with the final reply
      // in case the stream missed tail tokens (some providers do this).
      setExplanation(reply.trim());
    } catch (err) {
      toast.error("AI explanation failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setExplaining(false);
    }
  }

  async function runGloss() {
    if (!workspace || !provider) {
      toast.error("Configure a provider in Settings to use AI explanations");
      return;
    }
    setGlossing(true);
    setGloss("");
    try {
      const target = languageName(workspace.targetLang);
      const native = languageName(workspace.nativeLang);
      const reply = await sendChat({
        messages: [
          {
            role: "system",
            content:
              `You produce Leipzig-style interlinear glosses for a ${target} ` +
              `learner. Output exactly three lines of plain text, no markdown:\n\n` +
              `Line 1: the ${target} sentence with morpheme breaks shown as ` +
              `hyphens (e.g. com-í, hab-l-amos, geh-st).\n` +
              `Line 2: morpheme-aligned glosses in English, using Leipzig ` +
              `abbreviations in caps (1SG, 2PL, NOM, ACC, PST, PFV, IPFV, ` +
              `SBJV, INF, PRS, FUT, INDF, DEF, M, F, N, etc.). Word stems ` +
              `get a lowercase English meaning; bound morphemes get the ` +
              `Leipzig label. Align tokens with whitespace so columns roughly ` +
              `line up with line 1.\n` +
              `Line 3: a single-quoted free translation in ${native}.\n\n` +
              `No headings, no preamble, no commentary after line 3.`,
          },
          { role: "user", content: sentence },
        ],
        onToken: (delta) => setGloss((p) => p + delta),
      });
      setGloss(reply.trim());
    } catch (err) {
      toast.error("Gloss generation failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGlossing(false);
    }
  }

  const sourceName = useMemo(() => languageName(lang), [lang]);

  // Reasoning models (DeepSeek R1, Qwen, …) wrap chain-of-thought in
  // <think>/<reasoning> tags. Strip them at render with the same helper
  // the chat surfaces use — while a tag is still open we show the
  // Thinking pulse, never the raw reasoning text.
  const summarySplit = splitThinking(summary);
  const explanationSplit = splitThinking(explanation);
  const glossSplit = splitThinking(gloss);

  if (!workspace) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
              Sentence analyzer · {sourceName}
            </DialogTitle>
            <ModePill mode={mode} onChange={switchMode} />
          </div>
          <DialogDescription className="sr-only">
            Translate the sentence and inspect any word in context, or
            generate a Leipzig-style interlinear gloss.
          </DialogDescription>
          <div className="flex items-start gap-3 pt-2">
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "font-serif text-[20px] text-foreground",
                  // Ruby needs taller lines so the reading rail doesn't
                  // collide with the row above — same trick the reader
                  // prose uses.
                  showReading && (lang === "zh" || lang === "ja")
                    ? "leading-[2.1]"
                    : "leading-snug",
                )}
              >
                {showReading && (lang === "zh" || lang === "ja") ? (
                  // Ruby readings (and click-to-define for free) via the
                  // same pipeline the reader uses.
                  <Tokenized text={sentence} lang={lang} showRuby />
                ) : (
                  sentence
                )}
              </p>
              {showReading && lang === "ko" && (
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                  {romanizeHangul(sentence)}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {/* ‹ › sentence pager — only when the request carried the
                  full source and it actually has more than one sentence. */}
              {sentences.length > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => goToSentence(activeIdx - 1)}
                    disabled={activeIdx <= 0}
                    aria-label="Previous sentence"
                    title="Previous sentence"
                    className="flex size-6 cursor-pointer items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
                  >
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <span className="text-[10.5px] tabular-nums text-muted-foreground">
                    {activeIdx + 1}/{sentences.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => goToSentence(activeIdx + 1)}
                    disabled={activeIdx < 0 || activeIdx >= sentences.length - 1}
                    aria-label="Next sentence"
                    title="Next sentence"
                    className="flex size-6 cursor-pointer items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
                  >
                    <ChevronRight className="size-3.5" />
                  </button>
                </div>
              )}
              {readingLabel && (
                <button
                  type="button"
                  onClick={toggleReading}
                  aria-pressed={showReading}
                  title={
                    showReading
                      ? `Hide ${readingLabel.toLowerCase()}`
                      : `Show ${readingLabel.toLowerCase()}`
                  }
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                    showReading
                      ? "border-foreground/30 bg-foreground text-background"
                      : "border-border bg-card/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {readingLabel}
                </button>
              )}
              <SpeakButton text={sentence} lang={lang} size="sm" />
            </div>
          </div>
        </DialogHeader>

        {/* Three stacked sections can outgrow the viewport once the AI
            summary streams in — scroll the body, keep the header pinned. */}
        <div className="grid max-h-[70vh] gap-5 overflow-y-auto px-6 py-4">
          {/* Translation row */}
          <section className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Translation
              </h4>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runTranslate()}
                disabled={translating}
              >
                {translating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Languages className="size-3.5" />
                )}
                {translateLabelRef.current}
              </Button>
            </div>
            <div className="min-h-[44px] rounded-xl border border-border bg-card/40 px-4 py-3 text-[14px] leading-relaxed">
              {translation ? (
                <p>{translation}</p>
              ) : translating ? (
                <p className="text-muted-foreground">Translating…</p>
              ) : (
                <p className="text-muted-foreground">
                  Click <em>Translate</em> to render the sentence in{" "}
                  {languageName(workspace.nativeLang)}.
                </p>
              )}
            </div>
          </section>

          {/* AI summary — translation + grammar + nuance in one call.
              Sits in both modes (the Plain/Linguist toggle only swaps
              the section below) because "what's going on grammatically"
              is wanted either way. */}
          <section className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                AI summary
              </h4>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runSummary()}
                disabled={summarizing}
              >
                {summarizing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                {summarySplit.reply ? "Regenerate" : "Summarize"}
              </Button>
            </div>
            <div className="min-h-[44px] rounded-xl border border-border bg-card/40 px-4 py-3 text-[13.5px] leading-relaxed">
              {summarizing && summarySplit.thinkOpen && (
                <div className={cn(summarySplit.reply && "mb-2")}>
                  <ThinkingPulse />
                </div>
              )}
              {summarySplit.reply ? (
                summarizing ? (
                  // Stream as cheap animated plain text; the markdown
                  // (bold labels, bullets) lands when the reply finishes
                  // — the same two-phase render the chat surface uses.
                  <div>
                    <StreamingText text={summarySplit.reply} className="inline" />
                    <StreamCaret />
                  </div>
                ) : (
                  <ChatMarkdown text={summarySplit.reply} lang={lang} />
                )
              ) : summarizing ? (
                summarySplit.thinkOpen ? null : (
                  <p className="text-muted-foreground">
                    <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
                    Asking the tutor…
                  </p>
                )
              ) : !provider ? (
                <p className="text-muted-foreground">
                  Configure a chat provider in Settings → Providers to use
                  the AI summary.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  AI translation, grammar breakdown, and nuance — one call.
                </p>
              )}
            </div>
          </section>

          {/* Word picker or Linguist gloss — the toggle in the header
              swaps the bottom half between the two without disturbing
              the translation row above. */}
          {mode === "linguist" ? (
            <section className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Interlinear gloss
                </h4>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runGloss()}
                  disabled={glossing}
                >
                  {glossing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <BookOpen className="size-3.5" />
                  )}
                  {glossSplit.reply ? "Regenerate" : "Generate gloss"}
                </Button>
              </div>
              <div className="min-h-[120px] rounded-xl border border-border bg-card/40 px-4 py-3 font-mono text-[13px] leading-relaxed">
                {glossing && glossSplit.thinkOpen ? (
                  <ThinkingPulse />
                ) : glossSplit.reply ? (
                  <pre className="whitespace-pre-wrap font-mono text-foreground/90">
                    {glossSplit.reply}
                    {glossing && <StreamCaret />}
                  </pre>
                ) : glossing ? (
                  <p className="text-muted-foreground">
                    <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
                    Generating Leipzig gloss…
                  </p>
                ) : !provider ? (
                  <p className="text-muted-foreground">
                    Configure a chat provider in Settings → Providers to use
                    AI glossing.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Three lines: morpheme-broken sentence, Leipzig-abbreviated
                    glosses (1SG, PST, NOM, …), and a free translation.
                  </p>
                )}
              </div>
            </section>
          ) : (
          <section className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Word in context
              </h4>
              {activeWord && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveWord(null);
                    setExplanation("");
                  }}
                  className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" /> Clear
                </button>
              )}
            </div>
            {tokenizing ? (
              <div className="flex items-center gap-2 rounded-xl border border-border bg-card/40 px-4 py-3 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Tokenising…
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tokens.map((tok, i) => (
                  <button
                    key={`${tok}-${i}`}
                    type="button"
                    onClick={() => void explainWord(tok)}
                    className={cn(
                      "rounded-md border px-2 py-1 font-serif text-[14.5px] transition-colors",
                      activeWord === tok
                        ? "border-foreground/40 bg-accent shadow-sm"
                        : "border-border bg-card/60 hover:border-foreground/20 hover:bg-accent/40",
                    )}
                  >
                    {tok}
                  </button>
                ))}
              </div>
            )}
            {activeWord ? (
              <div className="rounded-xl border border-border bg-card/40 px-4 py-3 text-[13.5px] leading-relaxed">
                <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <Sparkles className="size-3.5" />
                  Meaning of{" "}
                  <span className="font-serif text-[14px] normal-case text-foreground">
                    {activeWord}
                  </span>{" "}
                  here
                </div>
                {explaining && explanationSplit.thinkOpen ? (
                  <ThinkingPulse />
                ) : explanationSplit.reply ? (
                  explaining ? (
                    <div>
                      <StreamingText
                        text={explanationSplit.reply}
                        className="inline"
                      />
                      <StreamCaret />
                    </div>
                  ) : (
                    <ChatMarkdown text={explanationSplit.reply} lang={lang} />
                  )
                ) : explaining ? (
                  <p className="text-muted-foreground">
                    <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
                    Asking the tutor…
                  </p>
                ) : !provider ? (
                  <p className="text-muted-foreground">
                    Configure a chat provider in Settings → Providers to use
                    AI explanations.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-[11.5px] text-muted-foreground">
                Click any word above to ask the tutor what it means in this
                sentence.
              </p>
            )}
          </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Blinking caret at the streaming text's tail — the standard "the
 *  model is still talking" affordance, same as the study AI drawer. */
function StreamCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-3.5 w-1 animate-pulse rounded-full bg-emerald-500/80 align-text-bottom"
    />
  );
}

function ModePill({
  mode,
  onChange,
}: {
  mode: AnalyzerMode;
  onChange: (next: AnalyzerMode) => void;
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0 rounded-full border border-border bg-card/60 p-0.5 text-[11px]">
      {(["plain", "linguist"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "rounded-full px-2.5 py-0.5 font-medium transition-colors",
            mode === m
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m === "plain" ? "Plain" : "Linguist"}
        </button>
      ))}
    </div>
  );
}

/**
 * Best-effort sentence → token list. Chinese uses the bundled jieba
 * tokenizer; Japanese / Korean fall back to a graphemic split (one
 * char per token, which is what the rest of the app does for those
 * languages too); everything else splits on whitespace + light
 * punctuation.
 */
async function tokenize(sentence: string, lang: string): Promise<string[]> {
  const trimmed = sentence.trim();
  if (!trimmed) return [];
  if (lang === "zh" && isTauri()) {
    try {
      const tokens = await invoke<string[]>("tokenize_zh", { text: trimmed });
      return tokens.filter((t) => t.trim().length > 0);
    } catch {
      // Fall through to char-split.
    }
  }
  if (lang === "zh" || lang === "ja" || lang === "ko") {
    return Array.from(trimmed).filter((c) => /\S/.test(c));
  }
  return trimmed
    .split(/[\s,;:.!?。！？،।]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}
