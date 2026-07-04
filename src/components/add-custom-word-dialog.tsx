/**
 * Add-a-custom-word dialog.
 *
 * Opens from the dictionary's "no result" state (and the sidebar search
 * pane) so a learner can add a word the installed dictionaries don't
 * cover. The headword + reading + definition land in the per-language
 * *Personal* dictionary (`getOrCreatePersonalDict` → `addDictEntry`), so
 * every later lookup — click-to-define popover, search bar, vocab
 * extractor — sees it alongside CC-CEDICT / JMdict / etc.
 *
 * AI helpers (active chat provider) fill the tedious parts: a concise
 * gloss, and example sentences. Sentences have no home in `dict_entries`,
 * so when any are present we also create a vocabulary card and store them
 * in its `card_notes` (the same `TOKORI_EXAMPLES_V1` format the rest of
 * the app reads) — that's what the "Also add to my vocabulary" toggle
 * controls, forced on whenever sentences exist so they can't be lost.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addDictEntry,
  getOrCreatePersonalDict,
  saveVocab,
  updateVocabFields,
} from "@/lib/db";
import { serialiseExamples, type ExampleSentence } from "@/lib/examples";
import { languageName } from "@/lib/languages";
import { romanizeHangul } from "@/lib/romanize-ko";
import { useProviderConfigs } from "@/lib/provider-context";
import { useWorkspace } from "@/lib/workspace-context";

/** Per-language "reading" field config: what to call it, a placeholder,
 *  and how to fill it. Korean romanizes locally (rule-based, instant);
 *  the rest describe what the AI should produce (pinyin / kana / IPA).
 *  Languages absent from this map don't show a reading field. */
type ReadingCfg = {
  label: string;
  placeholder: string;
  /** Rule-based generator — no AI, no provider needed (Korean). */
  local?: (word: string) => string;
  /** Tail of the AI instruction: what kind of reading to produce. */
  aiInstruction?: string;
};

function readingConfigFor(lang: string | undefined): ReadingCfg | null {
  switch (lang) {
    case "zh":
      return {
        label: "Pinyin",
        placeholder: "nǐ hǎo",
        aiInstruction:
          "the Hanyu Pinyin with tone marks, one space between syllables (e.g. nǐ hǎo)",
      };
    case "ja":
      return {
        label: "Reading",
        placeholder: "べんきょう",
        aiInstruction: "the kana reading in hiragana (no kanji, no rōmaji)",
      };
    case "ko":
      return {
        label: "Romanization",
        placeholder: "annyeong",
        local: (w) => romanizeHangul(w),
      };
    case "es":
      return {
        label: "Pronunciation (IPA)",
        placeholder: "/ˈola/",
        aiInstruction:
          "the IPA phonetic transcription between slashes (e.g. /ˈola/)",
      };
    case "de":
      return {
        label: "Lautschrift (IPA)",
        placeholder: "/haˈloː/",
        aiInstruction:
          "the IPA phonetic transcription between slashes (e.g. /haˈloː/)",
      };
    default:
      return null;
  }
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/** Strip a model reply down to usable text: drop any <think> block and
 *  code fences, collapse whitespace, and unwrap surrounding quotes. */
function cleanModelText(raw: string): string {
  const afterThink = (() => {
    const m = raw.match(/<\/think>\s*/i);
    return m ? raw.slice(m.index! + m[0].length) : raw;
  })();
  return afterThink
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“'']|["”'']$/g, "")
    .trim();
}

/** Pull the first {target, native} pair out of a model reply, tolerating
 *  bare objects, arrays, code fences, and <think> preambles. */
function parseExampleReply(raw: string): { target: string; native: string } | null {
  const text = raw
    .replace(/<\/?think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "");
  const m = text.match(
    /\{\s*"target"\s*:\s*"([^"]+)"\s*(?:,\s*"native"\s*:\s*"([^"]*)")?\s*\}/,
  );
  if (m) return { target: m[1], native: m[2] ?? "" };
  return null;
}

export function AddCustomWordDialog({
  open,
  onOpenChange,
  initialWord = "",
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill the headword — e.g. the search query that returned nothing. */
  initialWord?: string;
  /** Fired after a successful save so the caller can refresh the view. */
  onAdded?: () => void;
}) {
  const { active: workspace } = useWorkspace();
  const { active: provider, sendChat } = useProviderConfigs();

  const lang = workspace?.targetLang;
  const readingCfg = useMemo(() => readingConfigFor(lang), [lang]);

  const [word, setWord] = useState(initialWord);
  const [reading, setReading] = useState("");
  const [readingTouched, setReadingTouched] = useState(false);
  const [readingBusy, setReadingBusy] = useState(false);
  const [gloss, setGloss] = useState("");
  const [examples, setExamples] = useState<ExampleSentence[]>([]);
  const [addToVocab, setAddToVocab] = useState(true);
  const [defBusy, setDefBusy] = useState(false);
  const [exBusy, setExBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  // The word we last auto-generated a reading for, so the auto-fill
  // fires once per distinct word and never fights manual edits.
  const autoReadingFor = useRef("");

  // Reset every time the dialog opens so a previous draft (or a stale
  // prefill) never leaks into the next add.
  useEffect(() => {
    if (!open) return;
    setWord(initialWord);
    setReading("");
    setReadingTouched(false);
    setReadingBusy(false);
    setGloss("");
    setExamples([]);
    setAddToVocab(true);
    setDefBusy(false);
    setExBusy(false);
    setSaving(false);
    autoReadingFor.current = "";
  }, [open, initialWord]);

  const targetName = lang ? languageName(lang) : "the target language";
  const nativeName = workspace ? languageName(workspace.nativeLang) : "English";
  const canSave = word.trim().length > 0 && gloss.trim().length > 0 && !saving;

  async function generateReading(targetWord?: string) {
    const w = (targetWord ?? word).trim();
    if (!readingCfg || !w) return;
    if (readingCfg.local) {
      setReading(readingCfg.local(w));
      return;
    }
    if (!provider) return;
    setReadingBusy(true);
    try {
      const system =
        `You are a ${targetName} pronunciation tool. For the ${targetName} word or phrase the ` +
        `user sends, reply with ONLY ${readingCfg.aiInstruction}. Output nothing else — not the ` +
        `original word, no translation, no quotes, no explanation.`;
      const reply = await sendChat({
        messages: [
          { role: "system", content: system },
          { role: "user", content: w },
        ],
        onToken: () => {},
      });
      const text = cleanModelText(reply);
      if (text) setReading(text);
    } catch {
      // Silent — the field stays editable and the manual button remains.
    } finally {
      setReadingBusy(false);
    }
  }

  // Auto-fill the reading shortly after the word settles, unless the user
  // has taken over the field. Korean is rule-based (instant, offline);
  // pinyin / kana / IPA use the active AI provider when one is set.
  useEffect(() => {
    // `open` guard is load-bearing: this component stays mounted while
    // closed and `initialWord` tracks the live search query, so without
    // it we'd fire background AI calls every time the user types in the
    // sidebar search.
    if (!open || !readingCfg || readingTouched) return;
    const w = word.trim();
    if (!w || autoReadingFor.current === w) return;
    if (!readingCfg.local && !provider) return;
    const t = setTimeout(() => {
      autoReadingFor.current = w;
      void generateReading(w);
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, word, readingCfg, readingTouched, provider]);

  async function generateDefinition() {
    if (!provider || !word.trim()) return;
    setDefBusy(true);
    try {
      const system =
        `You are a concise bilingual ${targetName}→${nativeName} dictionary. ` +
        `Give the dictionary definition of the ${targetName} word or phrase the user sends. ` +
        `Reply with ONLY the definition in ${nativeName} — no preamble, no quotes, no the headword. ` +
        `Keep it short (a few words); separate distinct senses with "; ".`;
      const reply = await sendChat({
        messages: [
          { role: "system", content: system },
          { role: "user", content: word.trim() },
        ],
        onToken: () => {},
      });
      const text = cleanModelText(reply);
      if (!text) {
        toast.error("Couldn't generate a definition", {
          description: "The model returned an empty reply.",
        });
        return;
      }
      setGloss(text);
    } catch (err) {
      toast.error("Definition generation failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDefBusy(false);
    }
  }

  async function generateExample() {
    if (!provider || !word.trim()) return;
    setExBusy(true);
    try {
      const shape = `{"target":"<sentence in ${targetName}>","native":"<translation in ${nativeName}>"}`;
      const system =
        `You are a ${targetName} tutor. Write ONE short, natural example sentence ` +
        `(8–18 words, everyday register) that uses "${word.trim()}". ` +
        `Output ONLY one JSON object of shape ${shape} — no code fences, no preamble, no <think>.`;
      const reply = await sendChat({
        messages: [
          { role: "system", content: system },
          { role: "user", content: word.trim() },
        ],
        onToken: () => {},
      });
      const parsed = parseExampleReply(reply);
      if (!parsed?.target) {
        toast.error("Couldn't parse the example", {
          description: cleanModelText(reply).slice(0, 140) || "(empty reply)",
        });
        return;
      }
      setExamples((prev) => [
        ...prev,
        { id: newId(), target: parsed.target, native: parsed.native, source: "ai" },
      ]);
    } catch (err) {
      toast.error("Example generation failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setExBusy(false);
    }
  }

  function addBlankExample() {
    setExamples((prev) => [
      ...prev,
      { id: newId(), target: "", native: "", source: "user" },
    ]);
  }

  function updateExample(id: string, patch: Partial<ExampleSentence>) {
    setExamples((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function removeExample(id: string) {
    setExamples((prev) => prev.filter((e) => e.id !== id));
  }

  async function save() {
    if (!workspace || !lang || !canSave) return;
    setSaving(true);
    try {
      const readingVal = readingCfg ? reading.trim() || null : null;
      const dict = await getOrCreatePersonalDict(lang);
      await addDictEntry({
        dictId: dict.id,
        word: word.trim(),
        reading: readingVal,
        gloss: gloss.trim(),
      });

      // Sentences (and the toggle) get their own vocab card — dict_entries
      // has nowhere to keep example sentences.
      const keptExamples = examples.filter((e) => e.target.trim());
      let savedSentences = 0;
      if (addToVocab) {
        const vocab = await saveVocab({
          workspaceId: workspace.id,
          word: word.trim(),
          reading: readingVal,
          gloss: gloss.trim(),
          source: "manual",
        });
        if (keptExamples.length > 0) {
          await updateVocabFields({
            id: vocab.id,
            cardNotes: serialiseExamples(keptExamples),
          });
          savedSentences = keptExamples.length;
        }
      }

      const extra = addToVocab
        ? savedSentences > 0
          ? ` · ${savedSentences} sentence${savedSentences === 1 ? "" : "s"} on a study card`
          : " · added to your vocabulary"
        : "";
      toast.success(`Added “${word.trim()}” to your dictionary${extra}`);
      onAdded?.();
      onOpenChange(false);
    } catch (err) {
      toast.error("Couldn't add the word", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  const aiDisabledReason = useMemo(() => {
    if (!provider) return "Configure a provider in Settings → Providers";
    if (!word.trim()) return "Enter a word first";
    return null;
  }, [provider, word]);

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a custom word</DialogTitle>
          <DialogDescription>
            Saves to your personal {lang ? languageName(lang) : ""} dictionary —
            every lookup in the app reads it alongside the built-in dictionaries.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className={readingCfg ? "grid grid-cols-2 gap-3" : ""}>
            <div className="space-y-1.5">
              <Label htmlFor="cw-word">Word</Label>
              <Input
                id="cw-word"
                value={word}
                onChange={(e) => setWord(e.target.value)}
                placeholder={lang === "ja" ? "勉強" : lang === "zh" ? "学习" : "word"}
                autoFocus
                className="font-serif text-base"
              />
            </div>
            {readingCfg && (
              <div className="space-y-1.5">
                <div className="flex h-5 items-center justify-between">
                  <Label htmlFor="cw-reading">{readingCfg.label}</Label>
                  {!readingCfg.local && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-1.5 text-[11px]"
                      disabled={!!aiDisabledReason || readingBusy}
                      title={
                        aiDisabledReason ??
                        `Generate the ${readingCfg.label.toLowerCase()} with AI`
                      }
                      onClick={() => void generateReading()}
                    >
                      {readingBusy ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Sparkles className="size-3" />
                      )}
                      Auto
                    </Button>
                  )}
                </div>
                <Input
                  id="cw-reading"
                  value={reading}
                  onChange={(e) => {
                    setReadingTouched(true);
                    setReading(e.target.value);
                  }}
                  placeholder={readingCfg.placeholder}
                />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="cw-gloss">Definition</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[11.5px]"
                disabled={!!aiDisabledReason || defBusy}
                title={aiDisabledReason ?? "Generate a definition with AI"}
                onClick={() => void generateDefinition()}
              >
                {defBusy ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
                Generate
              </Button>
            </div>
            <textarea
              id="cw-gloss"
              value={gloss}
              onChange={(e) => setGloss(e.target.value)}
              placeholder="What the word means. Separate senses with “;”."
              rows={2}
              className="w-full resize-none rounded-md border border-input bg-background p-2.5 text-[13.5px] leading-relaxed shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Example sentences</Label>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11.5px]"
                  onClick={addBlankExample}
                  title="Add a blank sentence to type yourself"
                >
                  <Plus className="size-3" />
                  Add
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11.5px]"
                  disabled={!!aiDisabledReason || exBusy}
                  title={aiDisabledReason ?? "Generate an example sentence with AI"}
                  onClick={() => void generateExample()}
                >
                  {exBusy ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Sparkles className="size-3" />
                  )}
                  Generate
                </Button>
              </div>
            </div>
            {examples.length === 0 ? (
              <p className="rounded-md border border-dashed border-border bg-card/40 px-3 py-3 text-center text-[11.5px] text-muted-foreground">
                Optional. Generate one with AI or add your own.
              </p>
            ) : (
              <ul className="space-y-2">
                {examples.map((ex) => (
                  <li
                    key={ex.id}
                    className="flex items-start gap-2 rounded-md border border-border bg-card px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <Input
                        value={ex.target}
                        onChange={(e) => updateExample(ex.id, { target: e.target.value })}
                        placeholder={`Sentence in ${targetName}`}
                        className="h-7 border-transparent bg-transparent font-serif text-[14px] focus-visible:border-input focus-visible:bg-background"
                      />
                      <Input
                        value={ex.native}
                        onChange={(e) => updateExample(ex.id, { native: e.target.value })}
                        placeholder="Translation"
                        className="h-6 border-transparent bg-transparent text-[12px] text-muted-foreground focus-visible:border-input focus-visible:bg-background"
                      />
                    </div>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => removeExample(ex.id)}
                      className="mt-0.5 shrink-0 text-muted-foreground hover:text-destructive"
                      title="Remove sentence"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={addToVocab}
              onChange={(e) => setAddToVocab(e.target.checked)}
              className="mt-0.5 cursor-pointer"
            />
            <span>
              <span className="font-medium">Also add to my vocabulary</span>
              <span className="block text-[11px] text-muted-foreground">
                Create a study card for this word
                {examples.length > 0 ? ", keeping your example sentences." : "."}
              </span>
              {examples.length > 0 && !addToVocab && (
                <span className="mt-0.5 block text-[11px] text-amber-600 dark:text-amber-400">
                  Turn this on to save your example sentences.
                </span>
              )}
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Add to dictionary
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
