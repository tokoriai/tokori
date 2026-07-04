import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  BookmarkPlus,
  Check,
  FilePlus2,
  FolderPlus,
  Loader2 as Spinner,
  Pencil,
  RotateCcw,
  Save,
  ScanText,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Pinyin } from "@/components/pinyin";
import { PitchKana } from "@/components/reading";
import { PushToAnkiButton } from "@/components/push-to-anki";
import { SpeakButton } from "@/components/speak-button";
import {
  addDictEntry,
  addWordToCollection,
  deletePersonalDictOverride,
  getOrCreateDefaultCollection,
  getOrCreatePersonalDict,
  hasPersonalDictOverride,
  listCollections,
  saveVocab,
  setVocabStatus,
  updateVocabFields,
  upsertPersonalDictEntry,
  type Collection,
  type VocabStatus,
} from "@/lib/db";
import {
  invalidateDictionaryAvailabilityCache,
  useHasDictionary,
} from "@/lib/dict-availability";
import { invalidateDictLookupCache, lookupDictCached } from "@/lib/word-lookup";
import {
  parseExamples,
  serialiseExamples,
  type ExampleSentence as StoredExampleSentence,
} from "@/lib/examples";
import { parsePinyin, prettyPinyin, type PinyinSyllable } from "@/lib/pinyin";
import { pitchKind, splitMora } from "@/lib/pitch";
import { languageName, profileFor, type LanguageCode } from "@/lib/languages";
import { useWorkspace } from "@/lib/workspace-context";
import { useChineseConfig } from "@/lib/chinese-config";
import { useSession } from "@/lib/session-context";
import { useDisplay } from "@/lib/display-context";
import { useProviderConfigs } from "@/lib/provider-context";
import { requestSettingsIntent } from "@/lib/settings-intent";
import { navigateToTab } from "@/lib/nav-event";
import { requestAnalyzeSentence } from "@/lib/analyzer-event";
import { useAnalyzerSource } from "@/lib/analyzer-source-context";
import { requestComposeCard } from "@/lib/compose-card-event";
import { sentenceAround } from "@/lib/sentence-segment";
import { wrapAsCloze } from "@/lib/cloze";
import { cn } from "@/lib/utils";
import { fromDict } from "@/lib/lookup-result";
import type { ExampleSentence, LookupResult } from "@/lib/lookup-result";

/** Append AI-generated examples to a vocab row's card_notes blob,
 *  deduping by target sentence. Existing user/AI examples are
 *  preserved. Cap kept low so the row doesn't bloat indefinitely
 *  across multiple AI re-generations. */
async function persistExamples(
  vocabId: number,
  existingCardNotes: string | null,
  newExamples: ExampleSentence[],
): Promise<void> {
  if (newExamples.length === 0) return;
  const existing = parseExamples(existingCardNotes);
  const seen = new Set(existing.map((e) => e.target.trim()));
  const fresh: StoredExampleSentence[] = [];
  for (const ex of newExamples) {
    const t = ex.target.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    fresh.push({
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      target: t,
      native: ex.native ? ex.native.trim() : undefined,
      source: "ai",
    });
  }
  if (fresh.length === 0) return;
  const merged = [...existing, ...fresh].slice(-12);
  await updateVocabFields({
    id: vocabId,
    cardNotes: serialiseExamples(merged),
  });
}

/**
 * The per-word interactive unit: a hover trigger + the define popover
 * (dictionary lookup, AI-generated definition, save-to-vocab, status
 * grading, sentence analyzer, card composer). Two render variants share
 * one body:
 *   - `inline` — renders the word glyph (with ruby/pinyin/furigana) as
 *     the trigger. Used by `Tokenized` in chat / reader / notes prose.
 *   - `overlay` — renders a transparent, absolutely-positioned box as
 *     the trigger, so a clickable hotspot can sit on top of a page image
 *     (the OCR / PDF reader). The caller positions the surrounding box.
 */
export function WordPopover({
  word,
  entry,
  status,
  showRuby = false,
  lang,
  sourceText,
  sourceOffset,
  ttsActive,
  variant = "inline",
  fallbackReading = null,
}: {
  word: string;
  /** May be null when the word isn't in any installed dictionary. The cell
   *  still renders an underline + popover so the user can save the word
   *  to vocab anyway and jump to the full dictionary search. */
  entry: LookupResult | null;
  status: VocabStatus | null;
  showRuby?: boolean;
  lang: LanguageCode;
  /** Full prose this word lives inside — used to find the surrounding
   *  sentence for the analyzer modal. */
  sourceText: string;
  /** Character offset of this word inside `sourceText`. */
  sourceOffset: number;
  /** Render with the karaoke-style "currently being read" background. */
  ttsActive?: boolean;
  /** `inline` (default) renders the word glyph; `overlay` renders a
   *  transparent positioned box for hotspots over a page image. */
  variant?: "inline" | "overlay";
  /** Composed per-character reading for zh tokens that aren't dict
   *  headwords (see Tokenized). Drives the ruby rail ONLY — the popover
   *  body keeps showing true dictionary data, so a missing entry still
   *  reads as missing. */
  fallbackReading?: string | null;
}) {
  const { active: workspace } = useWorkspace();
  const { bump } = useSession();
  const display = useDisplay();
  const { sendChat } = useProviderConfigs();
  const [localStatus, setLocalStatus] = useState<VocabStatus | null>(status);
  const [busy, setBusy] = useState(false);
  // Full plain-text message when this popover lives inside fragmented
  // markdown (chat replies). `sourceText` there can be a single bolded
  // word — useless for sentence extraction — so the analyzer + cloze
  // affordances re-anchor into the full text when it's available.
  const analyzerSource = useAnalyzerSource();
  function resolvedSource(): { text: string; offset: number } {
    if (analyzerSource) {
      const at = analyzerSource.indexOf(sourceText);
      if (at >= 0) return { text: analyzerSource, offset: at + sourceOffset };
    }
    return { text: sourceText, offset: sourceOffset };
  }
  // Only matters when there's no dict entry for this word — lets the
  // popover differentiate "word missing from the dictionary" (rare,
  // usually a proper noun) vs "no dictionary set up at all" (common
  // for German/Spanish/English workspaces).
  const hasDict = useHasDictionary(lang);
  // LLM-generated entries override the dict-lookup result locally so
  // the popover updates without waiting for a parent re-render. The
  // generated row is also persisted into the per-language Personal
  // dict so future hovers (and the lookup-cache parent) pick it up.
  const [localEntry, setLocalEntry] = useState<LookupResult | null>(entry);
  const [generating, setGenerating] = useState(false);
  // Definition-editor + controlled-open state. `openState` mirrors the
  // HoverCard's hover-driven open; while `editing` is true we force the
  // card open (`open={openState || editing}`) so it can't dismiss
  // mid-edit when the pointer leaves the card.
  const [openState, setOpenState] = useState(false);
  const [editing, setEditing] = useState(false);
  const [hasOverride, setHasOverride] = useState(false);
  useEffect(() => setLocalEntry(entry), [entry]);
  // Cells get recycled across words in long lists — never carry edit
  // state from one word to the next.
  useEffect(() => {
    setEditing(false);
    setHasOverride(false);
  }, [word]);

  /** Open the inline definition editor and resolve, in the background,
   *  whether a Personal-dict override already exists (gates the "Reset
   *  to original" affordance). */
  function openEditor() {
    setEditing(true);
    void hasPersonalDictOverride(lang, word)
      .then(setHasOverride)
      .catch(() => setHasOverride(false));
  }

  const effectiveEntry = localEntry ?? entry;

  // Chinese script preference (Settings → Chinese). When the learner
  // picked "traditional", the dictionary popover shows the traditional
  // headword — CC-CEDICT carries both forms via the entry's `altWord`,
  // surfaced here as `traditional`. We only swap the *displayed*
  // headword: the inline text and vocab keying stay on the surface
  // form the user clicked, so known/unknown underlines keep matching
  // the running text (which may be simplified even for a traditional
  // learner, e.g. AI tutor output).
  const { config: chineseConfig } = useChineseConfig(workspace?.id ?? null);
  const preferTraditional =
    lang === "zh" && chineseConfig.script === "traditional";
  const headword =
    preferTraditional &&
    effectiveEntry?.traditional &&
    effectiveEntry.traditional !== word
      ? effectiveEntry.traditional
      : word;

  // Keep local state in sync if the parent's vocab map changes (e.g. after rebuild).
  useEffect(() => setLocalStatus(status), [status]);

  async function generateDefinition() {
    if (!workspace || generating) return;
    setGenerating(true);
    try {
      const targetName = languageName(workspace.targetLang);
      const nativeName = languageName(workspace.nativeLang);
      const wantsReading = profileFor(workspace.targetLang).hasReadings;
      const readingHint = wantsReading
        ? `"reading": "<phonetic reading (pinyin / furigana / etc.) — empty string if not applicable>",`
        : `"reading": "",`;
      const messages = [
        {
          role: "system" as const,
          content:
            `You are a concise bilingual dictionary. Reply with ONE JSON ` +
            `object only — no prose, no markdown fences. Keep the gloss ` +
            `under 120 characters. If the word has multiple senses, ` +
            `separate them with "; ". Provide TWO short example ` +
            `sentences that show the word in natural usage. Each ` +
            `example MUST include a ${targetName} sentence and its ` +
            `${nativeName} translation. Do NOT add explanations, ` +
            `etymology, or any extra fields.`,
        },
        {
          role: "user" as const,
          content:
            `Define this ${targetName} word for a ${nativeName} speaker.\n\n` +
            `Word: ${word}\n\n` +
            `Reply with JSON shaped exactly:\n` +
            `{\n` +
            `  "word": "${word}",\n` +
            `  ${readingHint}\n` +
            `  "gloss": "<short ${nativeName} translation>",\n` +
            `  "examples": [\n` +
            `    { "target": "<${targetName} sentence using ${word}>", "native": "<${nativeName} translation of that sentence>" },\n` +
            `    { "target": "<another ${targetName} sentence using ${word}>", "native": "<${nativeName} translation>" }\n` +
            `  ]\n` +
            `}`,
        },
      ];
      let raw = "";
      await sendChat({
        messages,
        onToken: (delta) => {
          raw += delta;
        },
      });
      // The model often wraps JSON in ```json``` despite instructions —
      // strip a leading/trailing fence and any prose before the first {.
      const cleaned = raw
        .replace(/```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      const jsonStr = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
      let parsed: {
        word?: unknown;
        reading?: unknown;
        gloss?: unknown;
        examples?: unknown;
      };
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        throw new Error("AI didn't return valid JSON. Try a different provider?");
      }
      const reading =
        typeof parsed.reading === "string" && parsed.reading.trim()
          ? parsed.reading.trim()
          : null;
      const gloss = typeof parsed.gloss === "string" ? parsed.gloss.trim() : "";
      if (!gloss) throw new Error("AI didn't return a gloss.");
      // Defensive parse on examples — model output is unreliable; we
      // accept any shape that has a string `target`, drop everything
      // else. An empty list is fine; the popover hides the section.
      const examples: ExampleSentence[] = Array.isArray(parsed.examples)
        ? parsed.examples
            .map((row) => {
              if (!row || typeof row !== "object") return null;
              const r = row as { target?: unknown; native?: unknown };
              const t = typeof r.target === "string" ? r.target.trim() : "";
              const n = typeof r.native === "string" ? r.native.trim() : "";
              if (!t) return null;
              return { target: t, native: n } as ExampleSentence;
            })
            .filter((x): x is ExampleSentence => x !== null)
            .slice(0, 5)
        : [];
      const generated: LookupResult = {
        reading,
        gloss,
        examples: examples.length > 0 ? examples : undefined,
      };
      setLocalEntry(generated);
      // Persist to the per-language Personal dict — gloss only (clean,
      // ;-separated senses). Example sentences live in
      // vocab_entries.card_notes and surface in the personal-dict
      // "Sentences" tab. Old entries that still have examples crammed
      // into the gloss column via EXAMPLES_DELIMITER keep working
      // because parseGlossWithExamples is still called on read; new
      // ones won't go down that path.
      try {
        const dict = await getOrCreatePersonalDict(lang);
        await addDictEntry({
          dictId: dict.id,
          word,
          reading,
          gloss,
        });
        invalidateDictionaryAvailabilityCache();
        // The session cache had this word as a miss; drop it so the new
        // personal-dict entry is picked up on the next render.
        invalidateDictLookupCache(lang);
      } catch (err) {
        console.warn("save generated entry to personal dict", err);
      }
      // If the word is already in vocab, attach the AI examples to
      // its card_notes immediately so they show in the Sentences tab.
      // Otherwise they're held in localEntry and persisted on "Save to
      // vocab" (see onSave).
      if (localStatus != null && examples.length > 0 && workspace) {
        try {
          const v = await saveVocab({
            workspaceId: workspace.id,
            word,
            reading,
            gloss,
            source: "ai-define",
          });
          await persistExamples(v.id, v.cardNotes, examples);
        } catch (err) {
          console.warn("save AI examples to card_notes", err);
        }
      }
      toast.success(`Generated definition for ${word}`, { description: gloss.slice(0, 80) });
    } catch (err) {
      toast.error("Couldn't generate", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGenerating(false);
    }
  }

  async function onSave() {
    if (!workspace) return;
    setBusy(true);
    try {
      const saved = await saveVocab({
        workspaceId: workspace.id,
        word,
        reading: effectiveEntry?.reading ?? null,
        gloss: effectiveEntry?.gloss ?? null,
        source: "chat",
      });
      // Carry any AI-generated example sentences into vocab.card_notes
      // so they appear in the personal-dict "Sentences" tab. Examples
      // arrive here only if the user clicked AI before "Save to vocab".
      const examplesFromAi = effectiveEntry?.examples ?? [];
      if (examplesFromAi.length > 0) {
        try {
          await persistExamples(saved.id, saved.cardNotes, examplesFromAi);
        } catch (err) {
          console.warn("attach AI examples on vocab save", err);
        }
      }
      void bump("words_saved");
      setLocalStatus("new");
      toast.success(`Saved ${word}`, { description: effectiveEntry?.gloss?.slice(0, 80) });
    } catch (err) {
      console.error("save vocab", err);
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(next: VocabStatus) {
    if (!workspace) return;
    setBusy(true);
    try {
      await setVocabStatus({
        workspaceId: workspace.id,
        word,
        reading: effectiveEntry?.reading ?? null,
        gloss: effectiveEntry?.gloss ?? null,
        status: next,
      });
      if (localStatus == null) void bump("words_saved");
      setLocalStatus(next);
    } catch (err) {
      toast.error("Couldn't update", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  const chars = useMemo(() => [...word], [word]);
  // Ruby syllables prefer the real dict reading; the composed
  // per-character fallback keeps pinyin above hanzi even when the
  // token isn't a dictionary headword (jieba compounds, names).
  const rubyReading = effectiveEntry?.reading ?? fallbackReading;
  const syllables = useMemo(
    () => (rubyReading ? parsePinyin(rubyReading) : []),
    [rubyReading],
  );

  const peek = display.shiftPressed && localStatus === "mastered";
  // Underline colour per status. Sky for `review` matches the rest
  // of the app's review-status pills (library + flashcards + the
  // popover's own grade-button), and frees up emerald for the
  // `mastered` peek-on-shift affordance below (it's the "you've got
  // this" colour throughout the UI). The dotted fallback is for
  // words with no vocab row yet.
  const baseDecoration =
    localStatus === "mastered"
      ? "underline decoration-2 underline-offset-[3px] decoration-transparent"
      : localStatus === "review"
        ? "underline decoration-2 underline-offset-[3px] decoration-sky-500/80"
        : localStatus === "learning"
          ? "underline decoration-2 underline-offset-[3px] decoration-amber-400/90"
          : localStatus === "new"
            ? "underline decoration-2 underline-offset-[3px] decoration-rose-400/85"
            : "underline decoration-dotted decoration-2 underline-offset-[3px] decoration-muted-foreground/45";

  // The trigger is the only thing that differs between variants; the
  // popover body below is identical for both.
  const trigger =
    variant === "overlay" ? (
      <span
        // Transparent hotspot sized by the positioned parent. The page
        // image underneath shows the word; we reuse the SRS palette as a
        // bottom edge so known/learning words stay visible on the page.
        tabIndex={-1}
        aria-label={word}
        className={cn(
          "absolute inset-0 cursor-pointer rounded-[2px] transition-colors",
          "hover:bg-primary/10",
          localStatus === "review" && "border-b-2 border-sky-500/60",
          localStatus === "learning" && "border-b-2 border-amber-400/70",
          localStatus === "new" && "border-b-2 border-rose-400/70",
          peek && "bg-emerald-500/10",
          ttsActive && "tts-active",
        )}
      />
    ) : (
      <span
        // Take the trigger out of the tab order. Without this, tabbing out
        // of the chat textarea would walk through every word in the
        // conversation, opening hover cards and flashing underlines.
        tabIndex={-1}
        className={cn(
          "cursor-pointer transition-colors rounded-sm px-px",
          baseDecoration,
          peek && "decoration-emerald-500/40",
          localStatus === "mastered"
            ? "hover:decoration-emerald-500/40"
            : "hover:decoration-foreground/80",
          ttsActive && "tts-active",
        )}
      >
        {lang === "zh" ? (
          <CharCluster chars={chars} syllables={syllables} showRuby={showRuby} />
        ) : lang === "ja" && showRuby ? (
          // Per-word block furigana — the kana reading sits above the
          // whole token, not per-character (we don't have mecab-style
          // char↔mora alignment client-side, and JMdict only stores
          // word-level readings anyway). Reuses the `.ruby-pinyin`
          // flex column so the line-box matches non-word skeletons
          // and pinyin-rendered hanzi siblings.
          //
          // When the dict row carries pitch data we colour the
          // furigana per mora using `<PitchKana>` (high/low). Words
          // without pitch fall through to the plain reading — no
          // jarring visual switch.
          <span className="ruby-pinyin">
            <span className="ruby-pinyin-rt">
              {effectiveEntry?.reading ? (
                <PitchKana
                  reading={effectiveEntry.reading}
                  accent={effectiveEntry.pitchAccent}
                />
              ) : (
                " "
              )}
            </span>
            <span>{word}</span>
          </span>
        ) : (
          word
        )}
      </span>
    );

  return (
    <HoverCard
      open={openState || editing}
      onOpenChange={setOpenState}
      openDelay={120}
      closeDelay={120}
    >
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent
        align="start"
        sideOffset={6}
        className="w-[320px] overflow-hidden rounded-xl p-0"
      >
        {/* Header: word + reading + status badge */}
        <div className="flex items-start gap-3 border-b border-border/60 p-4 pb-3">
          <div className="min-w-0 flex-1">
            <div className="font-serif text-2xl leading-tight">{headword}</div>
            {/* Simplified alternate — only shown when we're displaying
                the traditional headword, so the learner still sees the
                form that appears in the running text. */}
            {headword !== word && (
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                简 {word}
              </div>
            )}
            {effectiveEntry?.reading && (
              <div className="mt-0.5 text-[13px] font-semibold text-emerald-600 dark:text-emerald-400">
                {lang === "zh" ? (
                  <Pinyin raw={effectiveEntry.reading} />
                ) : lang === "ja" ? (
                  // Japanese reading carries pitch (when seeded). Even
                  // without an accent number `PitchKana` falls through
                  // to the plain reading string, so we always go
                  // through the same path here for ja.
                  <PitchKana
                    reading={effectiveEntry.reading}
                    accent={effectiveEntry.pitchAccent}
                  />
                ) : (
                  // Plain rendering for hangul / IPA-ish readings on
                  // other languages — the Pinyin parser would
                  // mis-tag them as toneless syllables and strip
                  // combining marks.
                  effectiveEntry.reading
                )}
              </div>
            )}
            {/* Pitch-kind label (heiban / atamadaka / nakadaka / odaka).
                Only rendered for JA hits that carry accent data so a
                learner picks up the named category over time without
                having to memorise the drop-position number. We use
                `splitMora` rather than codepoint length so digraphs
                (きょ) count as one mora — same convention the
                colouring uses. */}
            {lang === "ja" &&
              effectiveEntry?.reading &&
              effectiveEntry.pitchAccent != null && (
                <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {pitchKind(
                    splitMora(effectiveEntry.reading).length,
                    effectiveEntry.pitchAccent,
                  )}
                </div>
              )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <SpeakButton text={word} lang={lang} size="sm" />
            {localStatus && <StatusBadge status={localStatus} />}
          </div>
        </div>

        {/* Sentence analysis — labeled and right under the header so it's
            discoverable (the old icon-only button in the bottom action row
            was easy to miss). Pops the surrounding sentence into the global
            analyzer modal: translation, AI summary with grammar notes, and
            per-word in-context explanations. */}
        <button
          type="button"
          onClick={() => {
            const src = resolvedSource();
            const seg = sentenceAround(src.text, src.offset);
            const sentence = seg.sentence || word;
            requestAnalyzeSentence({
              sentence,
              lang,
              focus: word,
              source: src.text ? src : undefined,
            });
          }}
          className="flex w-full cursor-pointer items-center gap-1.5 border-b border-border/60 px-4 py-2 text-left text-[11.5px] font-medium text-foreground/80 transition-colors hover:bg-accent/40 hover:text-foreground"
          title="Open the sentence analyzer for the sentence around this word"
        >
          <ScanText className="size-3.5" />
          Sentence analyzer
        </button>

        {/* Definitions — split on `; ` so each sense reads on its own line.
            The pencil (top-right) opens an inline editor that saves an
            override into the per-language Personal dict; that entry then
            wins every lookup, so a learner can correct a CC-CEDICT /
            JMdict gloss without touching the shipped pack. When the word
            isn't in any installed dictionary, we still render the popover
            with a "no definition" hint + ways to add one (AI or by hand). */}
        <div className="relative border-b border-border/60">
          {!editing && effectiveEntry?.gloss && (
            <button
              type="button"
              onClick={openEditor}
              className="absolute right-1.5 top-1.5 z-10 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Edit this definition"
              aria-label={`Edit the definition of ${word}`}
            >
              <Pencil className="size-3.5" />
            </button>
          )}
          <div
            className={cn(
              "max-h-56 overflow-y-auto px-4 py-3",
              !editing && effectiveEntry?.gloss && "pr-9",
            )}
          >
            {editing ? (
              <DefinitionEditor
                lang={lang}
                word={word}
                initialReading={effectiveEntry?.reading ?? ""}
                initialGloss={effectiveEntry?.gloss ?? ""}
                initialAltWord={effectiveEntry?.traditional ?? null}
                showReading={profileFor(lang).hasReadings}
                hasOverride={hasOverride}
                onCancel={() => setEditing(false)}
                onSaved={(reading, gloss) => {
                  // Keep the original's examples / traditional headword /
                  // pitch; the edit only touches reading + gloss. Drop
                  // `inflectionOf` — the override is now a direct entry
                  // for the surface word, not a lemma match.
                  setLocalEntry(
                    effectiveEntry
                      ? { ...effectiveEntry, reading, gloss, inflectionOf: undefined }
                      : { reading, gloss },
                  );
                  setHasOverride(true);
                  setEditing(false);
                }}
                onReverted={(restored) => {
                  setLocalEntry(restored);
                  setHasOverride(false);
                  setEditing(false);
                }}
              />
            ) : effectiveEntry?.gloss ? (
              <>
                {effectiveEntry.inflectionOf && effectiveEntry.inflectionOf !== word && (
                  <div className="mb-1.5 text-[11px] italic text-muted-foreground">
                    inflected form of{" "}
                    <span className="font-serif text-foreground/80 not-italic">
                      {effectiveEntry.inflectionOf}
                    </span>
                  </div>
                )}
                {effectiveEntry.gloss.split(/;\s+/).slice(0, 5).map((def, i, arr) => (
                  <div
                    key={i}
                    className="text-[13px] leading-relaxed text-foreground/85"
                  >
                    {arr.length > 1 && (
                      <span className="mr-1.5 text-[11px] text-emerald-600/60 dark:text-emerald-400/50">
                        {i + 1}.
                      </span>
                    )}
                    {def}
                  </div>
                ))}
                {effectiveEntry.examples && effectiveEntry.examples.length > 0 && (
                  <div className="mt-2.5 space-y-1.5 border-t border-border/40 pt-2">
                    <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                      Examples
                    </p>
                    {effectiveEntry.examples.slice(0, 5).map((ex, i) => (
                      <div key={i} className="space-y-0.5">
                        <p className="text-[12.5px] leading-snug text-foreground/90">
                          {ex.target}
                        </p>
                        {ex.native && (
                          <p className="text-[11.5px] italic leading-snug text-muted-foreground">
                            {ex.native}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : hasDict === false ? (
              // No dictionary installed for this language at all. Common
              // for non-CJK workspaces (German/Spanish) where we don't
              // ship a built-in pack yet. Three ways out:
              //   - Generate one with the active LLM (lands in the
              //     per-language Personal dict so it sticks).
              //   - Write your own definition by hand (same Personal dict).
              //   - Jump to Settings → Dictionaries and install a pack.
              <div className="space-y-2">
                <p className="text-[12.5px] italic text-muted-foreground">
                  No dictionary set up for this language yet. Generate a
                  one-off definition with the AI, write your own, or install
                  a pack.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <GenerateDefinitionButton
                    onClick={() => void generateDefinition()}
                    busy={generating}
                  />
                  <WriteYourOwnButton onClick={openEditor} />
                  <button
                    type="button"
                    onClick={() => {
                      requestSettingsIntent("openDictionaries");
                      navigateToTab("settings");
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-foreground/20 bg-foreground/5 px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/10"
                  >
                    <BookOpen className="size-3.5" />
                    Set up dictionary
                  </button>
                </div>
              </div>
            ) : (
              // Dictionary installed but this word isn't in it. Generate
              // an AI definition or write one by hand — either way it's
              // persisted to Personal so the next hover finds it.
              <div className="space-y-2">
                <p className="text-[12.5px] italic text-muted-foreground">
                  No dictionary entry for this word. Generate one with the
                  AI or write your own — it'll be saved to your Personal
                  dict.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <GenerateDefinitionButton
                    onClick={() => void generateDefinition()}
                    busy={generating}
                  />
                  <WriteYourOwnButton onClick={openEditor} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Install-dictionary nudge — always visible when no full dict
            is installed, even when the bundled CEDICT_MINI gave us a
            definition above. The mini covers the common ~3k Chinese
            words; outside that the popover would silently show
            nothing. This bar stays as a one-line reminder until the
            user installs a real dict. Renders nothing while we're
            still resolving (`hasDict === null`) so the popover doesn't
            flash on first hover. */}
        {hasDict === false && effectiveEntry?.gloss && (
          <button
            type="button"
            onClick={() => {
              requestSettingsIntent("openDictionaries");
              navigateToTab("settings");
            }}
            className="flex w-full items-center justify-between gap-2 border-b border-border/60 px-4 py-2 text-left text-[11.5px] text-amber-700 transition-colors hover:bg-amber-500/10 dark:text-amber-300"
            title="Open Settings → Dictionaries"
          >
            <span className="flex items-center gap-1.5">
              <BookOpen className="size-3.5" />
              No dictionary installed — using bundled mini
            </span>
            <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] font-medium">
              Set up →
            </span>
          </button>
        )}

        {/* 4-button status grid */}
        <div className="grid grid-cols-4 gap-1.5 p-3 text-[11px] font-bold">
          {STATUS_BUTTONS.map((opt) => {
            const active = localStatus === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => void setStatus(opt.value)}
                disabled={busy || !workspace}
                className={cn(
                  "rounded-lg border py-1.5 transition-all hover:scale-[1.02] active:scale-[0.98]",
                  active
                    ? `${opt.bg} ${opt.border} ${opt.text}`
                    : "border-border/60 bg-transparent text-muted-foreground hover:bg-accent/40",
                  busy && "opacity-50",
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Bottom actions: save + push to Anki */}
        <div className="flex gap-1.5 border-t border-border/60 p-3 pt-2.5">
          {localStatus == null ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !workspace}
              onClick={onSave}
              className="flex-1 justify-center gap-1.5"
            >
              <BookmarkPlus className="size-3.5" />
              Save to vocab
            </Button>
          ) : (
            <span className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-[11.5px] font-medium text-emerald-700 dark:text-emerald-400">
              <Check className="size-3.5" />
              In vocab
            </span>
          )}
          {/* Open the card composer with this word + dict reading +
              gloss pre-filled, and the surrounding sentence as a
              cloze (the clicked word wrapped as `{{c1::word}}`).
              The composer's cloze field is fully editable, so the
              user can clear or rewrite if they don't want the
              sentence on the card. The composer is mounted globally
              via `GlobalAddCard` — we fire-and-forget an event. */}
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => {
              const src = resolvedSource();
              const seg = sentenceAround(src.text, src.offset);
              // Cloze position uses the word's offset *relative to
              // the sentence*, not the full source, so wrapAsCloze
              // marks the right occurrence even when the word appears
              // multiple times in the source.
              const sentence = seg.sentence;
              const cloze = sentence ? wrapAsCloze(sentence, word) : null;
              const reading = effectiveEntry?.reading ?? null;
              requestComposeCard({
                lang,
                word,
                reading:
                  lang === "zh" && reading ? prettyPinyin(reading) : reading,
                gloss: effectiveEntry?.gloss ?? null,
                frontExtra: cloze,
              });
            }}
            title="Make a card from this word"
          >
            <FilePlus2 className="size-3.5" />
          </Button>
          <AddToListButton
            word={word}
            reading={effectiveEntry?.reading ?? null}
            gloss={effectiveEntry?.gloss ?? null}
          />
          <PushToAnkiButton
            word={word}
            reading={effectiveEntry?.reading ?? null}
            gloss={effectiveEntry?.gloss ?? null}
          />
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

const STATUS_BUTTONS: {
  value: VocabStatus;
  label: string;
  bg: string;
  border: string;
  text: string;
}[] = [
  {
    value: "new",
    label: "New",
    bg: "bg-rose-500/15",
    border: "border-rose-500/40",
    text: "text-rose-600 dark:text-rose-400",
  },
  {
    value: "learning",
    label: "Learning",
    bg: "bg-amber-500/15",
    border: "border-amber-500/40",
    text: "text-amber-600 dark:text-amber-400",
  },
  {
    value: "review",
    label: "Review",
    bg: "bg-sky-500/15",
    border: "border-sky-500/40",
    text: "text-sky-600 dark:text-sky-400",
  },
  {
    value: "mastered",
    label: "Known",
    bg: "bg-emerald-500/15",
    border: "border-emerald-500/40",
    text: "text-emerald-600 dark:text-emerald-400",
  },
];

/**
 * Quick "+ List" picker shown in the word popover. Click → choose a collection.
 * Last-used id is persisted in localStorage so the next open defaults the
 * highlighted choice. Uses Radix Popover for the dropdown.
 */
function AddToListButton({
  word,
  reading,
  gloss,
}: {
  word: string;
  reading: string | null;
  gloss: string | null;
}) {
  const { active: workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [recentlyAdded, setRecentlyAdded] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !workspace) return;
    let cancelled = false;
    void (async () => {
      // Make sure default exists, then load.
      await getOrCreateDefaultCollection(workspace.id);
      const list = await listCollections(workspace.id);
      if (!cancelled) setCollections(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspace?.id]);

  async function add(c: Collection) {
    if (!workspace) return;
    setBusy(c.id);
    try {
      await addWordToCollection({
        workspaceId: workspace.id,
        collectionId: c.id,
        word,
        reading,
        gloss,
      });
      localStorage.setItem("collections.lastUsed", String(c.id));
      setRecentlyAdded(c.id);
      toast.success(`Added "${word}" to ${c.name}`);
      setTimeout(() => {
        setOpen(false);
        setRecentlyAdded(null);
      }, 600);
    } catch (err) {
      toast.error("Couldn't add", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  if (!workspace) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[11.5px] font-medium text-foreground/80 transition-colors hover:bg-accent/60 hover:text-foreground"
          title="Add to a collection"
        >
          <FolderPlus className="size-3.5" />
          List
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-64 p-1">
        <div className="px-2 pb-1 pt-0.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Add to collection
        </div>
        {collections.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">
            Loading collections…
          </p>
        ) : (
          <ul className="flex flex-col">
            {collections.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => void add(c)}
                  disabled={busy != null}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                    "hover:bg-accent/60",
                    recentlyAdded === c.id &&
                      "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate">{c.name}</span>
                    {c.isDefault && (
                      <span className="rounded border border-border px-1 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                        default
                      </span>
                    )}
                  </span>
                  {busy === c.id ? (
                    <Spinner className="size-3 animate-spin" />
                  ) : (
                    <span className="text-[10.5px] text-muted-foreground">
                      {c.wordCount ?? 0}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function StatusBadge({ status }: { status: VocabStatus }) {
  const opt = STATUS_BUTTONS.find((s) => s.value === status);
  if (!opt) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        opt.bg,
        opt.border,
        opt.text,
      )}
    >
      {opt.label}
    </span>
  );
}

function CharCluster({
  chars,
  syllables,
  showRuby,
}: {
  chars: string[];
  syllables: PinyinSyllable[];
  showRuby: boolean;
}) {
  const aligned = showRuby && syllables.length === chars.length;
  if (aligned) {
    return (
      <>
        {chars.map((ch, i) => {
          const syl = syllables[i];
          return (
            <ruby key={i} className="ruby-pinyin">
              <rt data-tone={syl.tone} className="ruby-pinyin-rt">
                {syl.pretty}
              </rt>
              <span>{ch}</span>
            </ruby>
          );
        })}
      </>
    );
  }
  // No pinyin to render. When the surrounding context is showing ruby
  // (showRuby=true on siblings), wrap each char in the SAME ruby
  // skeleton with an empty <rt>. The flex column reserves the
  // top "rt" row whether it has content or not, so a bare text node
  // would sit lower than its ruby siblings — visible in chat / live
  // mode as a character floating above the line. The empty rt keeps
  // the baseline of every char aligned without rendering anything.
  if (showRuby) {
    return (
      <>
        {chars.map((ch, i) => (
          <ruby key={i} className="ruby-pinyin">
            <rt className="ruby-pinyin-rt" aria-hidden="true">
              {" "}
            </rt>
            <span>{ch}</span>
          </ruby>
        ))}
      </>
    );
  }
  return <>{chars.join("")}</>;
}

function GenerateDefinitionButton({
  onClick,
  busy,
}: {
  onClick: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md border border-foreground/20 bg-foreground/5 px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/10 disabled:opacity-60"
    >
      {busy ? (
        <Spinner className="size-3.5 animate-spin" />
      ) : (
        <Sparkles className="size-3.5" />
      )}
      {busy ? "Generating…" : "Generate definition"}
    </button>
  );
}

function WriteYourOwnButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-foreground/20 bg-foreground/5 px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/10"
    >
      <Pencil className="size-3.5" />
      Write your own
    </button>
  );
}

/**
 * Inline definition editor shown inside the word popover. Saves the
 * user's reading + gloss as a Personal-dict override (via
 * `upsertPersonalDictEntry`), which then wins every lookup for this word
 * — the "edit the CC-CEDICT / JMdict entry" affordance the popover's
 * pencil opens. "Reset to original" removes the override and re-reads the
 * packaged entry. The parent pins the HoverCard open while this is
 * mounted, so the card can't dismiss mid-edit.
 */
function DefinitionEditor({
  lang,
  word,
  initialReading,
  initialGloss,
  initialAltWord,
  showReading,
  hasOverride,
  onSaved,
  onReverted,
  onCancel,
}: {
  lang: LanguageCode;
  word: string;
  initialReading: string;
  initialGloss: string;
  /** Preserved on save so a zh learner's traditional headword survives
   *  the override (the editor only edits reading + gloss). */
  initialAltWord: string | null;
  showReading: boolean;
  hasOverride: boolean;
  onSaved: (reading: string | null, gloss: string) => void;
  onReverted: (entry: LookupResult | null) => void;
  onCancel: () => void;
}) {
  const [reading, setReading] = useState(initialReading);
  const [gloss, setGloss] = useState(initialGloss);
  const [busy, setBusy] = useState(false);

  async function save() {
    const g = gloss.trim();
    if (!g) {
      toast.error("Definition can't be empty");
      return;
    }
    setBusy(true);
    try {
      const r = showReading && reading.trim() ? reading.trim() : null;
      await upsertPersonalDictEntry({
        lang,
        word,
        reading: r,
        gloss: g,
        altWord: initialAltWord,
      });
      // Both caches are keyed per language; drop them so the next render
      // (and the parent's lookup cache) pick up the override.
      invalidateDictLookupCache(lang);
      invalidateDictionaryAvailabilityCache();
      onSaved(r, g);
      toast.success(`Saved your definition for ${word}`);
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function revert() {
    setBusy(true);
    try {
      await deletePersonalDictOverride(lang, word);
      invalidateDictLookupCache(lang);
      invalidateDictionaryAvailabilityCache();
      // Re-read after invalidation to surface whatever the packaged
      // dictionaries hold now (or nothing, if the word only ever lived
      // in the Personal dict).
      const fresh = await lookupDictCached(lang, [word]);
      const hit = fresh.get(word);
      onReverted(hit ? fromDict(hit) : null);
      toast.success(`Restored the original entry for ${word}`);
    } catch (err) {
      toast.error("Couldn't reset", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="space-y-2.5"
      onKeyDown={(e) => {
        // Keep Escape / ⌘+Enter local so they don't bubble to the
        // surrounding chat/reader shortcuts.
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void save();
        }
      }}
    >
      {showReading && (
        <div className="space-y-1">
          <label
            htmlFor={`def-reading-${word}`}
            className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            Reading
          </label>
          <Input
            id={`def-reading-${word}`}
            value={reading}
            onChange={(e) => setReading(e.target.value)}
            placeholder="pronunciation"
            disabled={busy}
            className="h-7 text-[12.5px]"
          />
        </div>
      )}
      <div className="space-y-1">
        <label
          htmlFor={`def-gloss-${word}`}
          className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground"
        >
          Definition
        </label>
        <Textarea
          id={`def-gloss-${word}`}
          autoFocus
          value={gloss}
          onChange={(e) => setGloss(e.target.value)}
          placeholder="Separate senses with “; ”"
          disabled={busy}
          rows={3}
          className="min-h-[58px] resize-none text-[12.5px] leading-relaxed"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        {hasOverride ? (
          <button
            type="button"
            onClick={() => void revert()}
            disabled={busy}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            title="Remove your edit and restore the original dictionary entry"
          >
            <RotateCcw className="size-3" />
            Reset to original
          </button>
        ) : (
          <span aria-hidden />
        )}
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            disabled={busy}
            className="h-7 px-2 text-[12px]"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={busy}
            className="h-7 gap-1.5 px-2.5 text-[12px]"
          >
            {busy ? (
              <Spinner className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
