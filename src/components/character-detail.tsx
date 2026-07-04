import { useEffect, useMemo, useRef, useState } from "react";
import HanziWriter from "hanzi-writer";
import {
  BookmarkCheck,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GlossList, parseGlossSenses } from "@/components/gloss-list";
import { Pinyin } from "@/components/pinyin";
import { Reading } from "@/components/reading";
import { PushToAnkiButton } from "@/components/push-to-anki";
import { SpeakButton } from "@/components/speak-button";
import { MemoryPanel } from "@/components/vocab-memory";
import { GrammarProfilePanel } from "@/components/grammar-profile-panel";
import { PronunciationCard } from "@/components/pronunciation-card";
import { GlanceCard } from "@/components/glance-card";
import {
  parseExamples,
  serialiseExamples,
  type ExampleSentence,
} from "@/lib/examples";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  addWordToCollection,
  collectionsForVocab,
  listCollections,
  listVocab,
  lookupDict,
  lookupVocabBatch,
  removeWordFromCollection,
  saveVocab,
  searchDict,
  setVocabStatus,
  updateVocabFields,
  type Collection,
  type DictEntry,
  type VocabEntry,
  type VocabStatus,
} from "@/lib/db";
import { useChineseConfig } from "@/lib/chinese-config";
import { loadStrokeData, type StrokeData } from "@/lib/hanzi-stroke-data";
import { useProviderConfigs } from "@/lib/provider-context";
import { useWorkspace } from "@/lib/workspace-context";
import { languageName, type LanguageCode } from "@/lib/languages";
import { detailCaps, strokeOrderChars } from "@/lib/dict-detail";
import type { GrammarProfile } from "@/lib/grammar-profile";
import { cn } from "@/lib/utils";

type Props = {
  char: string;
  lang: string;
};


const STATUS_META: Record<
  VocabStatus,
  { label: string; pill: string; dot: string }
> = {
  unseen: {
    label: "Library",
    pill: "border-slate-300/60 text-slate-500 dark:text-slate-400",
    dot: "bg-slate-300 dark:bg-slate-600",
  },
  new: {
    label: "New",
    pill: "border-sky-500/40 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  learning: {
    label: "Learning",
    pill: "border-amber-500/40 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  review: {
    label: "In review",
    pill: "border-violet-500/40 text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  mastered: {
    label: "Known",
    pill: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
};

const STATUSES: VocabStatus[] = ["new", "learning", "review", "mastered"];

const AI_MODE_KEY = (workspaceId: number) =>
  `tokori.aiExampleMode.${workspaceId}`;

type AiMode = "k" | "k1" | "plain";

export function CharacterDetail({ char, lang }: Props) {
  const { active: workspace } = useWorkspace();
  const { active: provider, sendChat } = useProviderConfigs();
  const isZh = lang === "zh";
  const caps = useMemo(() => detailCaps(lang), [lang]);
  // Honor the workspace's Chinese script preference. When the user
  // has picked "traditional", we swap the headword and altWord so
  // the traditional form is the big-display character and the
  // simplified form sits underneath as the alternate. The picker
  // lives in Settings → Chinese; reads via `useChineseConfig`.
  const { config: chineseConfig } = useChineseConfig(workspace?.id ?? null);
  const preferTraditional = isZh && chineseConfig.script === "traditional";

  const [entry, setEntry] = useState<DictEntry | null>(null);
  const [compounds, setCompounds] = useState<DictEntry[]>([]);
  const [strokes, setStrokes] = useState<number | null>(null);
  const [vocab, setVocab] = useState<VocabEntry | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [memberOf, setMemberOf] = useState<Set<number>>(() => new Set());
  const [examples, setExamples] = useState<ExampleSentence[]>([]);
  const [extra, setExtra] = useState("");
  const [savingExamples, setSavingExamples] = useState(false);
  // Example-generation mode (persisted per workspace):
  //   "k"     — only words in known vocab; the headword is the one new element.
  //   "k1"    — Krashen i+1 (default): known vocab + ~1 new word.
  //   "plain" — no gating, intermediate-level prose.
  const [aiMode, setAiMode] = useState<AiMode>("k1");
  const [aiBusy, setAiBusy] = useState(false);
  // AI grammar profile for de/es. Owned here (not in the panel) so the
  // right-rail "at a glance" card shares the same generated data. The
  // `GrammarProfilePanel` hydrates this from localStorage on word change.
  const [grammar, setGrammar] = useState<GrammarProfile | null>(null);

  // Sync aiMode with persisted preference per workspace.
  useEffect(() => {
    if (!workspace) return;
    const raw = localStorage.getItem(AI_MODE_KEY(workspace.id));
    if (raw === "k" || raw === "plain") setAiMode(raw);
    else setAiMode("k1");
  }, [workspace?.id]);

  function applyAiMode(next: AiMode) {
    setAiMode(next);
    if (workspace) localStorage.setItem(AI_MODE_KEY(workspace.id), next);
  }

  // Load the dict entry for the headword.
  useEffect(() => {
    let cancelled = false;
    void lookupDict(lang, char).then((e) => {
      if (!cancelled) setEntry(e);
    });
    return () => {
      cancelled = true;
    };
  }, [char, lang]);

  // Multi-char compound view (only meaningful for zh — kanji decomposition is
  // a different problem we don't tackle here).
  useEffect(() => {
    if (!isZh) return;
    let cancelled = false;
    void searchDict(lang, char, 80).then((rows) => {
      if (cancelled) return;
      const out = rows
        .filter((r) => r.word.length > 1 && [...r.word].includes(char))
        .slice(0, 30);
      setCompounds(out);
    });
    return () => {
      cancelled = true;
    };
  }, [char, lang, isZh]);

  // Load existing vocab state + collections + example sentences from db.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void lookupVocabBatch(workspace.id, [char]).then((m) => {
      if (cancelled) return;
      const v = m.get(char) ?? null;
      setVocab(v);
      setExamples(parseExamples(v?.cardNotes ?? null));
      setExtra(v?.frontExtra ?? "");
    });
    void listCollections(workspace.id).then(async (cols) => {
      if (cancelled) return;
      setCollections(cols);
      // Find which ones currently contain this word. We don't have a single
      // direct call, but listCollections returns word_count and we can ask
      // the collection->words endpoint via a local check. Cheaper option:
      // listCollections already includes a `containsWord` if we extend it.
      // For now — we lazily query when the popover opens (see below).
    });
    return () => {
      cancelled = true;
    };
  }, [workspace?.id, char]);

  const status: VocabStatus | null = vocab?.status ?? null;

  async function saveAt(newStatus: VocabStatus) {
    if (!workspace || !entry) return;
    await setVocabStatus({
      workspaceId: workspace.id,
      word: entry.word,
      reading: entry.reading ?? null,
      gloss: entry.gloss ?? null,
      status: newStatus,
    });
    const m = await lookupVocabBatch(workspace.id, [entry.word]);
    setVocab(m.get(entry.word) ?? null);
    toast.success(`${entry.word} → ${STATUS_META[newStatus].label}`);
  }

  async function toggleCollection(c: Collection, isMember: boolean) {
    if (!workspace || !entry) return;
    if (isMember) {
      // Need vocab id to call removeWordFromCollection.
      const v =
        vocab ??
        (await saveVocab({
          workspaceId: workspace.id,
          word: entry.word,
          reading: entry.reading ?? null,
          gloss: entry.gloss ?? null,
          source: "search",
        }));
      await removeWordFromCollection(c.id, v.id);
      setMemberOf((prev) => {
        const next = new Set(prev);
        next.delete(c.id);
        return next;
      });
      toast(`Removed from ${c.name}`);
    } else {
      await addWordToCollection({
        workspaceId: workspace.id,
        collectionId: c.id,
        word: entry.word,
        reading: entry.reading ?? null,
        gloss: entry.gloss ?? null,
      });
      setMemberOf((prev) => new Set(prev).add(c.id));
      toast.success(`Added to ${c.name}`);
      // Refresh vocab state in case this was the very first save for this word.
      const m = await lookupVocabBatch(workspace.id, [entry.word]);
      setVocab(m.get(entry.word) ?? null);
    }
  }

  // Example-sentence helpers ↓

  function setExamplesAndPersist(next: ExampleSentence[]) {
    setExamples(next);
    if (!vocab) return;
    setSavingExamples(true);
    void updateVocabFields({
      id: vocab.id,
      cardNotes: serialiseExamples(next),
    })
      .catch(() => {})
      .finally(() => setSavingExamples(false));
  }

  function addBlankExample() {
    setExamples((prev) => [
      ...prev,
      { id: cryptoId(), target: "", native: "", source: "user" },
    ]);
  }

  function updateExample(id: string, patch: Partial<ExampleSentence>) {
    const next = examples.map((e) => (e.id === id ? { ...e, ...patch } : e));
    setExamplesAndPersist(next);
  }

  function deleteExample(id: string) {
    setExamplesAndPersist(examples.filter((e) => e.id !== id));
  }

  // Persists an example onto vocab_entries.card_notes. Creates the vocab row
  // if it doesn't exist yet.
  async function saveExampleToDict(ex: ExampleSentence) {
    if (!workspace || !entry) return;
    if (!ex.target.trim()) {
      toast.error("Nothing to save — write the sentence first");
      return;
    }
    setSavingExamples(true);
    try {
      let v = vocab;
      if (!v) {
        v = await saveVocab({
          workspaceId: workspace.id,
          word: entry.word,
          reading: entry.reading ?? null,
          gloss: entry.gloss ?? null,
          source: "search",
        });
        setVocab(v);
      }
      const next = examples.map((e) =>
        e.id === ex.id ? { ...e, source: "user" as const } : e,
      );
      setExamples(next);
      await updateVocabFields({
        id: v.id,
        cardNotes: serialiseExamples(next),
      });
      toast.success(`Saved to ${entry.word}`);
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingExamples(false);
    }
  }

  async function generateAiExamples() {
    if (!workspace || !entry || !provider) {
      toast.error("Configure a provider in Settings first");
      return;
    }
    setAiBusy(true);
    try {
      const target = languageName(workspace.targetLang);
      const native = languageName(workspace.nativeLang);
      const jsonShape =
        `{"target":"<sentence in ${target}>","native":"<translation in ${native}>"}`;

      let systemPrompt: string;
      if (aiMode === "plain") {
        systemPrompt =
          `You're a ${target} tutor. Write three short example sentences that use the word ` +
          `"${entry.word}" naturally. Each sentence should be appropriate for an intermediate learner — concrete, ` +
          `everyday situations rather than abstract ones. Output ONLY a JSON array of objects with the shape ` +
          `${jsonShape}. No code fences, no preamble.`;
      } else {
        // k vs k+1: whether one extra new word is allowed in addition to the
        // headword (k+1) or the headword must be the only new element (k).
        const allowOneNew = aiMode === "k1";
        const vocab = await listVocab(workspace.id, 1500).catch(
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
        const recentlyReviewed = [...vocab]
          .filter((v) => v.lastReview != null)
          .sort((a, b) => (b.lastReview ?? 0) - (a.lastReview ?? 0))
          .slice(0, 20)
          .map((v) => v.word);

        const lines: string[] = [
          allowOneNew
            ? `You're a ${target} tutor. Write three short example sentences using the word "${entry.word}" — Krashen-style "i+1" comprehensible input.`
            : `You're a ${target} tutor. Write three short example sentences using the word "${entry.word}" with strict comprehensible-input constraints — the headword should be the ONLY new element in each sentence.`,
          ``,
          `## RULES`,
          `- Each sentence MUST contain "${entry.word}".`,
          allowOneNew
            ? `- 90%+ of the OTHER content words must come from the KNOWN, LEARNING, or RECENTLY REVIEWED lists below.`
            : `- Every OTHER content word (nouns, verbs, adjectives, adverbs) MUST come from the KNOWN, LEARNING, or RECENTLY REVIEWED lists below.`,
          allowOneNew
            ? `- Up to 1–2 truly new words are OK if they are high-frequency and inferable from context.`
            : `- No new words other than "${entry.word}". If you can't build a natural sentence within these constraints, lengthen / simplify rather than introducing another unfamiliar word.`,
          `- Function words / particles / pronouns / numbers / measure words / common verbs are always fine.`,
          `- Concrete, everyday situations — not abstract ones.`,
          `- Output ONLY a JSON array of ${jsonShape} objects. No code fences, no preamble.`,
        ];
        if (mastered.length > 0) {
          lines.push("", `### KNOWN (mastered)`, mastered.join("、"));
        }
        if (learning.length > 0) {
          lines.push("", `### LEARNING`, learning.join("、"));
        }
        if (recentlyReviewed.length > 0) {
          lines.push(
            "",
            `### RECENTLY REVIEWED (anchor sentences around these where natural)`,
            recentlyReviewed.join("、"),
          );
        }
        if (mastered.length === 0 && learning.length === 0) {
          lines.push(
            "",
            `### NOTE`,
            `The student has no saved vocabulary yet — use absolute-beginner (A1) level words around "${entry.word}".`,
          );
        }
        systemPrompt = lines.join("\n");
      }

      const reply = await sendChat({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: entry.word },
        ],
        onToken: () => {},
      });
      const parsed = tryParseJsonArray(reply);
      if (!parsed || parsed.length === 0) {
        toast.error("Couldn't parse the AI's response");
        return;
      }
      const next: ExampleSentence[] = [
        ...examples,
        ...parsed.map((p) => ({
          id: cryptoId(),
          target: String(p.target ?? ""),
          native: String(p.native ?? ""),
          source: "ai" as const,
        })),
      ];
      setExamplesAndPersist(next);
      toast.success(`Added ${parsed.length} example sentence${parsed.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error("AI generation failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAiBusy(false);
    }
  }

  // `extraSaveRef` guards against the race where the user types
  // quickly into Additional notes on an unsaved word: each keystroke
  // would otherwise fire its own `saveVocab` call and we'd end up
  // creating the row multiple times. Once one save is in flight we
  // hold the latest text in `pendingExtraRef` and apply it via
  // `updateVocabFields` after the row exists.
  const extraSaveRef = useRef<Promise<VocabEntry | null> | null>(null);
  const pendingExtraRef = useRef<string | null>(null);

  function persistExtra(next: string) {
    setExtra(next);
    if (vocab) {
      void updateVocabFields({ id: vocab.id, frontExtra: next || null });
      return;
    }
    if (!workspace || !entry) return;
    // No vocab row yet — the user is typing notes on a word they
    // haven't formally "saved" with the Status button. Treat the
    // typing itself as intent to save: spin up a vocab row as
    // status="new" and write the notes into it. Subsequent edits
    // hit the regular updateVocabFields path above.
    pendingExtraRef.current = next;
    if (extraSaveRef.current) return;
    extraSaveRef.current = (async () => {
      try {
        const created = await saveVocab({
          workspaceId: workspace.id,
          word: entry.word,
          reading: entry.reading ?? null,
          gloss: entry.gloss ?? null,
          source: "notes",
        });
        // `saveVocab` returns the row but doesn't bring along
        // `frontExtra`; write the pending notes back through
        // `updateVocabFields` so the latest text wins even if the
        // user kept typing during the save.
        const finalText = pendingExtraRef.current ?? "";
        await updateVocabFields({
          id: created.id,
          frontExtra: finalText || null,
        });
        setVocab({ ...created, frontExtra: finalText || null });
        return created;
      } catch (err) {
        toast.error(
          `Couldn't save notes: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      } finally {
        extraSaveRef.current = null;
        pendingExtraRef.current = null;
      }
    })();
  }

  // CJK-only character list for the stroke panels. A multi-char entry like
  // 你好 becomes ["你","好"] so we can render one HanziWriter per char.
  // Latin/punctuation are stripped (no stroke data). Computed before the
  // early return below so this hook runs unconditionally.
  const strokeChars = useMemo(
    () => (caps.strokeOrder ? strokeOrderChars(char) : []),
    [char, caps.strokeOrder],
  );

  // What the right rail will show (computed before the return so the grid
  // can collapse to one column when there's nothing to put in it — e.g. a
  // pure-kana Japanese word has no kanji to animate).
  const showStroke = caps.sidebar === "stroke" && strokeChars.length > 0;
  const showRail =
    showStroke ||
    caps.sidebar === "pronunciation" ||
    caps.sidebar === "glance";

  // Script-preference: when the workspace is set to "traditional",
  // swap headword + altWord so the traditional form is the big
  // display character. The dictionary stores `word` = simplified
  // and `altWord` = traditional (CC-CEDICT convention from the
  // pack builder); switching them is a pure render-side swap, the
  // underlying entry isn't mutated.
  const headword =
    preferTraditional && entry?.altWord ? entry.altWord : char;
  const secondaryForm =
    preferTraditional
      ? entry?.word && entry.word !== headword
        ? entry.word
        : null
      : entry?.altWord && entry.altWord !== headword
        ? entry.altWord
        : null;

  return (
    <div
      className={cn(
        "grid gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:gap-10 lg:px-10 lg:py-10",
        showRail ? "lg:grid-cols-[minmax(0,1fr)_380px]" : "lg:grid-cols-1",
      )}
    >
      {/* LEFT column: hero, actions, examples, extras, compounds. */}
      <div className="space-y-6">
        {/* ── Hero card ─────────────────────────────────────────
            Restructured for clarity: the headword + script-pair sit
            on the left, the SRS status pill sits top-right. Pinyin
            and stat chips share a single row beneath the title so
            the user scans the metadata in one sweep instead of
            two. The whole thing is in a soft card so it reads as
            "the headword block" — the actions and definition live
            below in their own visual layers. */}
        <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <div className="flex items-end gap-3">
                <div className="font-serif text-7xl leading-none tracking-tight sm:text-8xl">
                  {headword}
                </div>
                {entry && (
                  <SpeakButton
                    text={entry.word}
                    lang={lang as LanguageCode}
                    size="sm"
                  />
                )}
              </div>
              {secondaryForm && (
                <div className="font-serif text-2xl text-muted-foreground">
                  {secondaryForm}{" "}
                  <span className="text-[11px] uppercase tracking-wider opacity-70">
                    {preferTraditional ? "simplified" : "traditional"}
                  </span>
                </div>
              )}
              {entry?.reading && (
                <Reading
                  lang={lang}
                  reading={entry.reading}
                  pitchAccent={entry.pitchAccent}
                  className="text-lg"
                />
              )}
              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
                {strokes != null && (
                  <span className="rounded-full border border-border bg-background/60 px-2 py-0.5">
                    {strokes} stroke{strokes === 1 ? "" : "s"}
                  </span>
                )}
                {[...char].length === 1 && (
                  <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 font-mono">
                    U+{char.codePointAt(0)?.toString(16).toUpperCase()}
                  </span>
                )}
              </div>
            </div>

            {status && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    title="Click to change status"
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      STATUS_META[status].pill,
                    )}
                  >
                    <span className={cn("size-1.5 rounded-full", STATUS_META[status].dot)} />
                    {STATUS_META[status].label}
                    <ChevronDown className="size-3 opacity-60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-56 p-1" align="end">
                  {STATUSES.map((s) => {
                    const meta = STATUS_META[s];
                    const active = s === status;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => void saveAt(s)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                          active ? "bg-accent" : "hover:bg-accent/60",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className={cn("size-1.5 rounded-full", meta.dot)} />
                          {meta.label}
                        </span>
                        {active && <Check className="size-3.5 text-muted-foreground" />}
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            )}
          </div>

          {/* ── Definition. Labelled so it reads as a discrete
                section even when the hero card is busy. */}
          <div className="mt-5 border-t border-border/60 pt-4">
            <p className="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              Definition
            </p>
            {entry?.gloss ? (
              <GlossList gloss={entry.gloss} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No dictionary entry. Install or update the {languageName(lang)} dictionary.
              </p>
            )}
          </div>

            {/* Action row. Wraps on narrow screens. */}
            <div className="flex flex-wrap gap-2 pt-1">
              <StatusMenu currentStatus={status} onPick={(s) => void saveAt(s)} disabled={!entry} />
              <CollectionMenu
                collections={collections}
                memberOf={memberOf}
                workspaceId={workspace?.id ?? null}
                vocabId={vocab?.id ?? null}
                onOpen={async () => {
                  // Lazy-fetch which collections this word belongs to, only on
                  // first open — keeps the page render cheap.
                  if (!workspace || !vocab) return;
                  const set = await getMembershipFor(workspace.id, vocab.id, collections);
                  setMemberOf(set);
                }}
                onToggle={(c, isMember) => void toggleCollection(c, isMember)}
                disabled={!entry}
              />
              {caps.strokeOrder && entry && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    // Send to writing practice via a localStorage handoff
                    // that the Study view picks up on next mount.
                    try {
                      localStorage.setItem(
                        "tokori:writing-queue",
                        JSON.stringify({ word: entry.word, ts: Date.now() }),
                      );
                      toast.success(
                        `Queued "${entry.word}" — open Study → Hanzi writing.`,
                      );
                    } catch {
                      toast.error("Couldn't queue for writing practice");
                    }
                  }}
                >
                  <PenLine className="size-3.5" />
                  Writing practice
                </Button>
              )}
              {entry && (
                <PushToAnkiButton
                  word={entry.word}
                  reading={entry.reading}
                  gloss={entry.gloss}
                />
              )}
            </div>
          {/* /Hero card */}
        </div>

        {/* Memory & review history. Only meaningful once the word is
            saved into vocab AND has at least one review on file — the
            panel shows FSRS stability + the per-grade log, both of
            which are zero/empty until the user grades the card once.
            Suppressing the all-zero card keeps the detail page from
            looking half-baked on freshly-saved words; the user can
            still drive memory from the Flashcards study mode. */}
        {vocab && vocab.reviewCount > 0 && <MemoryPanel entry={vocab} />}

        {/* Example sentences. Always rendered — empty state nudges the user
            to either type one or hit "Generate with AI". */}
        <ExamplesSection
          examples={examples}
          saving={savingExamples}
          aiBusy={aiBusy}
          aiAvailable={!!provider}
          aiMode={aiMode}
          onChangeAiMode={applyAiMode}
          onAdd={addBlankExample}
          onUpdate={updateExample}
          onDelete={deleteExample}
          onGenerate={generateAiExamples}
          onSaveToWord={saveExampleToDict}
          targetLang={lang as LanguageCode}
        />

        {/* Grammar profile (German / Spanish). AI-generated, cached per
            word on the device. Owned state lives here so the right-rail
            GlanceCard mirrors it. */}
        {caps.grammar && (
          <GrammarProfilePanel
            lang={lang as LanguageCode}
            word={char}
            nativeLang={(workspace?.nativeLang ?? "en") as LanguageCode}
            profile={grammar}
            onProfile={setGrammar}
          />
        )}

        {/* "Additional" — free-form notes / mnemonics. Persists to
            vocab_entries.front_extra; on an unsaved word, the first
            keystroke auto-creates the vocab row (status="new") so the
            notes survive a navigation. The field is therefore always
            editable. */}
        <div className="rounded-xl border border-border bg-card p-4">
          <label
            htmlFor="extra-notes"
            className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            Additional notes
          </label>
          <textarea
            id="extra-notes"
            value={extra}
            onChange={(e) => persistExtra(e.target.value)}
            placeholder="Mnemonics, etymology, the song lyric you first heard this in — all yours."
            className="block min-h-[80px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-[13.5px] leading-relaxed shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {!vocab && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Notes save the word to your vocabulary automatically on the
              first keystroke.
            </p>
          )}
        </div>

        {/* Stroke order grid. Sits BEFORE the compounds list so the
            user reads the per-stroke breakdown immediately after the
            animation, then drops down into related words. Mounting
            here (rather than in the right rail) also keeps it visible
            on narrow widths where the right column collapses below
            everything. */}
        {caps.strokeOrder && strokeChars.length > 0 && (
          <MultiCharStrokeSequence chars={strokeChars} />
        )}

        {/* Compounds — words that contain the active char. Hidden when
            zooming a multi-char word (compounds for "你好" don't really
            make sense — search for the parts instead). */}
        {caps.compounds && [...char].length === 1 && compounds.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Words with {char}
            </h3>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {compounds.map((c, i) => (
                <li
                  key={`${c.word}-${i}`}
                  className="rounded-lg border border-border bg-muted/30 px-3 py-2 transition-colors hover:bg-muted/60"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-serif text-[18px]">{c.word}</span>
                    <Pinyin raw={c.reading} className="text-[11.5px]" />
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">
                    {parseGlossSenses(c.gloss).slice(0, 3).join(" · ") || c.gloss}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* RIGHT column (sticky on lg+): per-language. CJK → stroke
          animation panel; Korean → pronunciation; German/Spanish →
          at-a-glance grammar. The per-stroke grid lives in the left
          column above compounds. */}
      {showRail && (
        <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          {showStroke && (
            <MultiCharStrokePanel
              chars={strokeChars}
              onStrokesLoaded={setStrokes}
            />
          )}
          {caps.sidebar === "pronunciation" && <PronunciationCard word={char} />}
          {caps.sidebar === "glance" && (
            <GlanceCard lang={lang} word={char} entry={entry} profile={grammar} />
          )}
        </div>
      )}
    </div>
  );
}

// Inline popover for changing SRS status. Five options: a "remove" entry plus
// the four real statuses.
function StatusMenu({
  currentStatus,
  onPick,
  disabled,
}: {
  currentStatus: VocabStatus | null;
  onPick: (s: VocabStatus) => void;
  disabled?: boolean;
}) {
  const label = currentStatus
    ? `Status · ${STATUS_META[currentStatus].label}`
    : "Save to vocabulary";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant={currentStatus ? "outline" : "default"} disabled={disabled}>
          {currentStatus ? (
            <Check className="size-3.5" />
          ) : (
            <Plus className="size-3.5" />
          )}
          {label}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        {STATUSES.map((s) => {
          const meta = STATUS_META[s];
          const active = s === currentStatus;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                active ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <span className="flex items-center gap-2">
                <span className={cn("size-1.5 rounded-full", meta.dot)} />
                {meta.label}
              </span>
              {active && <Check className="size-3.5 text-muted-foreground" />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function CollectionMenu({
  collections,
  memberOf,
  workspaceId: _workspaceId,
  vocabId: _vocabId,
  onOpen,
  onToggle,
  disabled,
}: {
  collections: Collection[];
  memberOf: Set<number>;
  workspaceId: number | null;
  vocabId: number | null;
  onOpen: () => void;
  onToggle: (c: Collection, isMember: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Drill-down state. `null` = main view (top-level lists); a number
  // is the id of the parent whose children we're showing. Closing
  // the popover resets it so the next open lands back on the main
  // view — keeps the interaction predictable.
  const [drillId, setDrillId] = useState<number | null>(null);

  // Index parents → children once per render. Collections without a
  // parent show up at the top level; everything else is grouped
  // under its parent. Orphan children (parent missing) bubble up to
  // the top level so we never hide them entirely.
  const { topLevel, childrenByParent } = useMemo(() => {
    const top: Collection[] = [];
    const childMap = new Map<number, Collection[]>();
    const ids = new Set(collections.map((c) => c.id));
    for (const c of collections) {
      if (c.parentId != null && ids.has(c.parentId)) {
        const arr = childMap.get(c.parentId) ?? [];
        arr.push(c);
        childMap.set(c.parentId, arr);
      } else {
        top.push(c);
      }
    }
    return { topLevel: top, childrenByParent: childMap };
  }, [collections]);

  // Count how many of the user's saved collections sit under each
  // parent — drives the badge on parent rows so the user can see at
  // a glance "this word is in 3 sub-lists of HSK 3.0".
  function memberCountUnder(parentId: number): number {
    const kids = childrenByParent.get(parentId) ?? [];
    let n = 0;
    for (const k of kids) if (memberOf.has(k.id)) n += 1;
    return n;
  }

  const drillParent =
    drillId != null ? collections.find((c) => c.id === drillId) ?? null : null;
  const drillChildren =
    drillId != null ? childrenByParent.get(drillId) ?? [] : [];

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          onOpen();
        } else {
          // Reset drill state on close so re-opens always start fresh.
          setDrillId(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <Plus className="size-3.5" />
          Add to list
          {memberOf.size > 0 && (
            <span className="ml-1 rounded-full bg-secondary px-1.5 text-[10.5px] text-secondary-foreground">
              {memberOf.size}
            </span>
          )}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1" align="start">
        {collections.length === 0 ? (
          <p className="px-2.5 py-2 text-[12.5px] text-muted-foreground">
            No collections yet. Create one from the Lists view.
          </p>
        ) : drillParent ? (
          // ── Sub-list view ───────────────────────────────────────
          <div>
            <button
              type="button"
              onClick={() => setDrillId(null)}
              className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" />
              All lists
            </button>
            <p className="mt-1 px-2.5 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              {drillParent.name}
            </p>
            <ul className="max-h-72 space-y-0.5 overflow-y-auto">
              {drillChildren.map((c) => (
                <CollectionRow
                  key={c.id}
                  collection={c}
                  isMember={memberOf.has(c.id)}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          </div>
        ) : (
          // ── Main view: top-level lists ─────────────────────────
          <ul className="max-h-72 space-y-0.5 overflow-y-auto">
            {topLevel.map((c) => {
              const isMember = memberOf.has(c.id);
              const kids = childrenByParent.get(c.id) ?? [];
              const hasChildren = kids.length > 0;
              const subMembers = hasChildren ? memberCountUnder(c.id) : 0;
              if (hasChildren) {
                // Parent row — click drills into its children rather
                // than toggling. Parents in this codebase are
                // organisational (HSK 3.0 → HSK 1 / HSK 2 / …), they
                // don't typically hold their own words, so the
                // drill-only behaviour matches expectations.
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setDrillId(c.id)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/60"
                    >
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate">{c.name}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {kids.length}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {subMembers > 0 && (
                          <span className="rounded-full bg-emerald-500/15 px-1.5 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-300">
                            {subMembers}
                          </span>
                        )}
                        <ChevronRight className="size-3.5 text-muted-foreground" />
                      </span>
                    </button>
                  </li>
                );
              }
              return (
                <CollectionRow
                  key={c.id}
                  collection={c}
                  isMember={isMember}
                  onToggle={onToggle}
                />
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function CollectionRow({
  collection,
  isMember,
  onToggle,
}: {
  collection: Collection;
  isMember: boolean;
  onToggle: (c: Collection, isMember: boolean) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onToggle(collection, isMember)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
          isMember ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <span className="truncate">{collection.name}</span>
        {isMember ? (
          <Check className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <Plus className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
    </li>
  );
}

function ExamplesSection({
  examples,
  saving,
  aiBusy,
  aiAvailable,
  aiMode,
  onChangeAiMode,
  onAdd,
  onUpdate,
  onDelete,
  onGenerate,
  onSaveToWord,
  targetLang,
}: {
  examples: ExampleSentence[];
  saving: boolean;
  aiBusy: boolean;
  aiAvailable: boolean;
  aiMode: AiMode;
  onChangeAiMode: (mode: AiMode) => void;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<ExampleSentence>) => void;
  onDelete: (id: string) => void;
  onGenerate: () => void;
  onSaveToWord: (ex: ExampleSentence) => void | Promise<void>;
  targetLang: LanguageCode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Example sentences
        </h3>
        <div className="flex items-center gap-1">
          {saving && (
            <span className="text-[11px] text-muted-foreground">Saving…</span>
          )}
          {/* AI mode picker — only meaningful when generating, but
              we always show it so the user can preview / change the
              setting before clicking Generate. Tiny pill toggle keeps
              the row compact. */}
          {/* Three-way mode picker matches the sentence-mining setup
              screen and the answer-card generator, so the difficulty
              vocabulary is consistent across surfaces. */}
          <div
            className="inline-flex rounded-full border border-border bg-background/50 p-0.5"
            role="group"
            aria-label="AI generation mode"
          >
            {(
              [
                { id: "k", label: "k", title: "k — strict, only vocab you already know" },
                { id: "k1", label: "k+1", title: "k+1 — your vocab + ~1 new word" },
                { id: "plain", label: "plain", title: "plain — no vocab gating, intermediate prose" },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onChangeAiMode(m.id)}
                disabled={aiBusy}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10.5px] font-medium tracking-wide transition-colors",
                  aiMode === m.id
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title={m.title}
              >
                {m.label}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={onAdd}>
            <Plus className="size-3.5" />
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={onGenerate} disabled={aiBusy || !aiAvailable}>
            {aiBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            Generate
          </Button>
        </div>
      </div>
      {examples.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          Add a sentence you've seen this word in, or click <em>Generate</em> to ask the
          active AI provider for three at your level.
        </p>
      ) : (
        <ul className="space-y-2">
          {examples.map((ex) => (
            <li
              key={ex.id}
              className="grid gap-1.5 rounded-lg border border-border bg-background/50 p-2.5"
            >
              <div className="flex items-start gap-2">
                <Input
                  value={ex.target}
                  onChange={(e) => onUpdate(ex.id, { target: e.target.value })}
                  placeholder={`Target ${languageName(targetLang)} sentence`}
                  className="border-0 bg-transparent px-1 text-[15px] font-serif shadow-none focus-visible:ring-0"
                />
                {ex.target.trim() && (
                  <SpeakButton text={ex.target} lang={targetLang} size="sm" />
                )}
                {/* Save the example as part of THIS word's record.
                    `source === "user"` is our durable "saved" flag —
                    set both for hand-typed examples and for AI ones
                    the user has explicitly kept. Persistence rides on
                    `vocab_entries.card_notes` so re-opening the same
                    word's detail page shows the saved sentence
                    again. */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void onSaveToWord(ex)}
                  disabled={!ex.target.trim() || ex.source === "user"}
                  className={cn(
                    "text-muted-foreground hover:text-foreground",
                    ex.source === "user" &&
                      "text-emerald-600 dark:text-emerald-400",
                  )}
                  title={
                    ex.source === "user"
                      ? "Saved to this word"
                      : "Save to this word"
                  }
                >
                  {ex.source === "user" ? (
                    <BookmarkCheck className="size-3.5" />
                  ) : (
                    <BookmarkPlus className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onDelete(ex.id)}
                  className="text-muted-foreground hover:text-destructive"
                  title="Remove"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Input
                value={ex.native ?? ""}
                onChange={(e) => onUpdate(ex.id, { native: e.target.value })}
                placeholder="Translation (optional)"
                className="border-0 bg-transparent px-1 text-[12.5px] text-muted-foreground shadow-none focus-visible:ring-0"
              />
              <span
                className={cn(
                  "self-start rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
                  ex.source === "ai"
                    ? "border-primary/30 bg-primary/5 text-primary"
                    : "border-border bg-muted/40 text-muted-foreground",
                )}
              >
                {ex.source === "ai" ? "AI generated" : "Yours"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Mounts one HanziWriter per character side-by-side and animates them in
// sequence with a looping cycle.
function MultiCharStrokePanel({
  chars,
  onStrokesLoaded,
}: {
  chars: string[];
  onStrokesLoaded: (n: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const writersRef = useRef<HanziWriter[]>([]);
  const animatingRef = useRef(false);
  const loopRef = useRef(false);
  const autoPlayedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Chars that actually resolved stroke data, in order — drives the tiles
  // and the aspect ratio. Can be a subset of `chars`: a few Japanese
  // kokuji (働 込 辻) aren't in the bundled dataset.
  const [presentChars, setPresentChars] = useState<string[]>([]);
  // Chars with no stroke data — shown as a quiet footnote, not the
  // "nothing loaded" error.
  const [skipped, setSkipped] = useState<string[]>([]);

  useEffect(() => {
    const wrap = containerRef.current;
    if (!wrap) return;
    setError(null);
    setReady(false);
    setPresentChars([]);
    setSkipped([]);
    animatingRef.current = false;
    loopRef.current = false;
    autoPlayedRef.current = false;
    wrap.innerHTML = "";
    writersRef.current = [];

    let cancelled = false;

    // Resolve availability up front so a single missing glyph skips its
    // tile instead of erroring the whole panel. `loadStrokeData` already
    // swallows fetch failures to null, so "no data" covers both a glyph
    // absent from the dataset and an offline first-fetch.
    void Promise.all(
      chars.map((c) => loadStrokeData(c).then((data) => ({ c, data }))),
    ).then((results) => {
      if (cancelled) return;
      const present = results.filter(
        (r): r is { c: string; data: StrokeData } =>
          !!(r.data && r.data.medians),
      );
      setSkipped(
        results.filter((r) => !(r.data && r.data.medians)).map((r) => r.c),
      );
      if (present.length === 0) {
        setError("none");
        return;
      }
      setPresentChars(present.map((p) => p.c));
      onStrokesLoaded(
        present.reduce((n, p) => n + (p.data.strokes?.length ?? 0), 0),
      );

      // Theme-aware stroke colours. HanziWriter sets these as SVG fill /
      // stroke attributes and only accepts plain colour strings (no
      // `color-mix(...)`, no CSS variables), so we resolve to hex at mount
      // based on the root's `.dark` class. All strokes share one neutral
      // foreground — the per-stroke grid below marks the newest stroke
      // instead, which keeps the animation calm in both themes.
      const isDark =
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark");
      const strokeColor = isDark ? "#f5f5f5" : "#171717";
      const radicalColor = strokeColor;
      const outlineColor = isDark
        ? "rgba(255,255,255,0.18)"
        : "rgba(0,0,0,0.18)";

      // One tile + writer per resolved char, feeding the already-loaded
      // data straight into HanziWriter (no second fetch).
      present.forEach(({ c, data }) => {
        const tile = document.createElement("div");
        tile.className = "shrink-0";
        tile.style.flex = "1 1 0";
        tile.style.minWidth = "0";
        wrap.appendChild(tile);
        try {
          const writer = HanziWriter.create(tile, c, {
            width: 240,
            height: 240,
            padding: 8,
            strokeColor,
            radicalColor,
            outlineColor,
            delayBetweenStrokes: 160,
            strokeAnimationSpeed: 1.2,
            charDataLoader: (_charToLoad, onComplete) =>
              onComplete(data as { strokes: string[]; medians: number[][][] }),
          });
          writersRef.current.push(writer);
          // Give the SVG an explicit viewBox so the strokes centre inside
          // the tile when stretched to 100% (HanziWriter omits one).
          const svg = tile.querySelector("svg");
          if (svg) {
            svg.setAttribute("viewBox", "0 0 240 240");
            svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
            svg.setAttribute("width", "100%");
            svg.setAttribute("height", "100%");
            svg.style.display = "block";
          }
        } catch (err) {
          // A single writer failing shouldn't take down the panel.
          console.warn("hanzi-writer create failed", err);
        }
      });
      setReady(true);
    });

    return () => {
      cancelled = true;
      loopRef.current = false;
    };
  }, [chars, onStrokesLoaded]);

  // Auto-play the stroke animation once on first load so the user
  // doesn't have to hunt for the button. Guarded by `autoPlayedRef`
  // so re-renders that flip `ready` back-and-forth (e.g. char swap)
  // don't kick the animation off mid-stream.
  useEffect(() => {
    if (!ready || autoPlayedRef.current) return;
    autoPlayedRef.current = true;
    // Small delay so the layout settles before the animation begins —
    // prevents the SVG flicker from a width:0 → width:full transition.
    const t = setTimeout(() => playSequence(false), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  function playSequence(loop: boolean) {
    const writers = writersRef.current;
    if (writers.length === 0) return;
    animatingRef.current = true;
    loopRef.current = loop;
    let idx = 0;
    const playOne = () => {
      if (!animatingRef.current) return;
      const w = writers[idx];
      // Clear then animate so a re-press starts cleanly even on the
      // currently-shown char.
      try {
        w.hideCharacter();
      } catch {
        /* noop */
      }
      w.animateCharacter({
        onComplete: () => {
          if (!animatingRef.current) return;
          if (idx + 1 < writers.length) {
            idx += 1;
            // 250ms beat between chars — long enough to feel intentional,
            // short enough not to drag.
            setTimeout(playOne, 250);
          } else if (loopRef.current) {
            idx = 0;
            // 700ms pause between loops so the user can mentally reset.
            setTimeout(playOne, 700);
          } else {
            animatingRef.current = false;
          }
        },
      });
    };
    playOne();
  }

  function stopSequence() {
    animatingRef.current = false;
    loopRef.current = false;
    for (const w of writersRef.current) {
      try {
        w.showCharacter();
      } catch {
        /* noop */
      }
    }
  }

  // Tile count for the aspect ratio: resolved chars once known, else the
  // requested chars so the box has a sane shape while loading.
  const tileCount = presentChars.length || chars.length;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div
        ref={containerRef}
        className={cn(
          "flex w-full flex-row items-stretch justify-stretch gap-2 bg-muted/30 p-2",
          // Faint grid under the character — keeps the strokes
          // visually anchored without competing with them. Uses
          // CSS-in-class background-image so it stays theme-aware
          // (alpha is applied on top of the muted token below).
          "[background-image:linear-gradient(to_right,color-mix(in_srgb,var(--color-muted-foreground)_18%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--color-muted-foreground)_18%,transparent)_1px,transparent_1px)]",
          "[background-size:50%_50%] [background-position:center]",
        )}
        style={{
          // Aspect ratio scales with character count so a long word
          // like 中华人民共和国 stays readable. ~1:1 per char up to
          // 3, then we cap so the panel doesn't dominate the page.
          aspectRatio:
            tileCount <= 1 ? "1 / 1" : tileCount === 2 ? "2 / 1" : `${Math.min(tileCount, 4)} / 1`,
        }}
      />
      {error ? (
        // Nothing in the dataset for these glyphs (kept neutral — the
        // word still gets every other section of the page).
        <p className="border-t border-border bg-card px-3 py-2 text-[11.5px] text-muted-foreground">
          Stroke order isn’t available for {chars.join("")} yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-center gap-1.5 border-t border-border bg-card px-3 py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => playSequence(false)}
              disabled={!ready}
            >
              <Play className="size-3.5" />
              {presentChars.length > 1 ? "Animate all" : "Animate"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => playSequence(true)}
              disabled={!ready}
            >
              <RotateCcw className="size-3.5" />
              Loop
            </Button>
            {animatingRef.current && (
              <Button size="sm" variant="ghost" onClick={stopSequence}>
                Stop
              </Button>
            )}
          </div>
          {skipped.length > 0 && (
            <p className="border-t border-border/60 bg-card px-3 py-1.5 text-[10.5px] text-muted-foreground">
              No stroke data for {skipped.join("、")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function MultiCharStrokeSequence({ chars }: { chars: string[] }) {
  return (
    <div className="space-y-3">
      {chars.map((c) => (
        <div key={c} className="space-y-1.5">
          {chars.length > 1 && (
            <p className="px-1 text-[11.5px] text-muted-foreground">
              <span className="mr-1 font-serif text-[14px] text-foreground">
                {c}
              </span>
              stroke order
            </p>
          )}
          <StrokeSequenceGrid char={c} />
        </div>
      ))}
    </div>
  );
}

function tryParseJsonArray(s: string): { target: string; native?: string }[] | null {
  // The model sometimes wraps with code fences despite our prompt; strip them.
  const trimmed = s
    .replace(/```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  // Find the first `[` and last `]` so a wandering preamble doesn't kill us.
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cryptoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

// Renders one mini-SVG per stroke showing strokes 1..N drawn in. Stroke paths
// in hanzi-writer-data are Y-down in a 1024×1024 box, so we flip via a CSS
// transform on the wrapping <g>. Long characters (>16 strokes) trim to the
// last 16 with a "+N more" pill.
function StrokeSequenceGrid({ char }: { char: string }) {
  const [data, setData] = useState<{ strokes: string[] } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);
    void loadStrokeData(char).then((d) => {
      if (cancelled) return;
      if (d && Array.isArray(d.strokes)) setData(d);
      else setError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [char]);

  if (error) {
    return (
      <p className="rounded-md border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
        Stroke data unavailable for {char}.
      </p>
    );
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading strokes…
      </div>
    );
  }

  const strokes = data.strokes;
  const total = strokes.length;
  // Cap stays high — tiles are tiny (36px), so even 24-stroke
  // characters fit comfortably in 1–2 rows with flex-wrap.
  const cap = Math.min(total, 24);

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Stroke order
      </p>
      {/* flex-wrap so the row flows on narrow widths instead of forcing
          a fixed grid column count. Tiles are intentionally small —
          the animation panel carries the detailed view; this strip
          is just a quick reference for the order. */}
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: cap }, (_, i) => (
          <StrokeTile key={i} strokes={strokes} upTo={i} />
        ))}
        {total > cap && (
          <div className="flex size-9 items-center justify-center rounded-md border border-dashed border-border bg-muted/30 text-[10px] text-muted-foreground">
            +{total - cap}
          </div>
        )}
      </div>
    </div>
  );
}

function StrokeTile({ strokes, upTo }: { strokes: string[]; upTo: number }) {
  // Theme-aware fills. Previous strokes paint as a soft muted tone
  // so the newest stroke is the visual anchor. The accent picks a
  // calm teal that reads as "this is the highlight" without
  // shouting — the earlier tone-1 (Pleco red) version felt like an
  // error indicator, especially in dark mode. Indigo / teal sits
  // closer to the shadcn surface vocabulary while still being
  // distinct from the foreground neutrals.
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  const newestFill = isDark ? "#67e8f9" : "#0e7490";
  const olderFill = isDark ? "rgba(245,245,245,0.40)" : "rgba(23,23,23,0.40)";
  return (
    <div className="relative size-9 shrink-0 overflow-hidden rounded-md border border-border bg-background">
      <svg
        viewBox="0 0 1024 1024"
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 size-full"
      >
        {/* hanzi-writer-data paths use a math-y-up coordinate system in
            a 1024-unit grid; flip via SVG-internal transform (matches
            the library's own renderer) so paths land inside the
            viewBox instead of overflowing the tile. */}
        <g transform="matrix(1 0 0 -1 0 900)">
          {strokes.slice(0, upTo + 1).map((d, j) => (
            <path key={j} d={d} fill={j === upTo ? newestFill : olderFill} />
          ))}
        </g>
      </svg>
      <span className="absolute right-0 top-0 px-1 text-[8.5px] font-medium leading-tight text-muted-foreground/80">
        {upTo + 1}
      </span>
    </div>
  );
}

async function getMembershipFor(
  workspaceId: number,
  vocabId: number,
  _collections: Collection[],
): Promise<Set<number>> {
  // Single indexed query against collection_words filtered by vocab_id —
  // O(memberships) instead of the previous O(collections × wordsPerColl)
  // which would fan out to N parallel queries and saturate the SQLx pool
  // on workspaces with hundreds of collections.
  const cols = await collectionsForVocab(workspaceId, vocabId);
  const out = new Set<number>();
  for (const c of cols) out.add(c.id);
  return out;
}

