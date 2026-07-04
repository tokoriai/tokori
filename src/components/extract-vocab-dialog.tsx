/**
 * Extract-vocabulary dialog. Opens from the Knowledge view's per-row
 * "Extract vocabulary" button. Walks the source's text via
 * `extractVocabulary`, shows a sortable + filterable preview, and lets the
 * user save a chosen subset into a brand-new or existing collection.
 *
 * The flow is the same shape as the pack importer: parse → preview →
 * confirm → write. Re-extracting the same source is safe — the underlying
 * `saveVocab` is idempotent on (workspace, word).
 */

import { useEffect, useMemo, useState } from "react";
import { BookmarkPlus, ChevronDown, ChevronRight, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addWordToCollection,
  createCollection,
  listCollections,
  lookupVocabBatch,
  type Collection,
  type VocabEntry,
} from "@/lib/db";
import { getSourceContent, type SourceKind } from "@/lib/knowledge";
import {
  extractStructuredVocab,
  extractVocabulary,
  type ExtractedWord,
  type VocabLesson,
} from "@/lib/vocab-extract";
import type { LanguageCode } from "@/lib/languages";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";

/** Two extraction modes. "Lessons" reads structured vocab tables out of
 *  the source ("Vocabulary" sections, etc.); "Frequency" walks every word
 *  and ranks by occurrence. The dialog auto-picks Lessons when structure
 *  is found, falls back to Frequency otherwise. */
type ExtractMode = "lessons" | "frequency";

type LessonWithStatus = VocabLesson & {
  /** Per-word vocab status, parallel to `words`. Drives the "already in
   *  vocab" badge and the default-pick filter. */
  statuses: (VocabEntry["status"] | null)[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  source: { kind: SourceKind; id: number; title: string | null } | null;
  onSaved?: (count: number) => void;
};

const NEW_COLLECTION_VALUE = "__new__";

export function ExtractVocabDialog({ open, onClose, source, onSaved }: Props) {
  const { active: workspace } = useWorkspace();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ExtractMode>("lessons");
  const [lessons, setLessons] = useState<LessonWithStatus[]>([]);
  const [words, setWords] = useState<ExtractedWord[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** For frequency mode: set of `word` keys. For lessons mode: set of
   *  `${lessonPosition}:${word}` keys so the same word appearing in two
   *  lessons can be picked independently. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [hideKnown, setHideKnown] = useState(true);
  // Default OFF so words without dict entries still surface — many imports
  // are from custom-built dictionaries or non-Chinese languages where the
  // dict isn't comprehensive. The user can still hide them via the toggle.
  const [hideNoEntry, setHideNoEntry] = useState(false);
  const [minCount, setMinCount] = useState(1);
  const [search, setSearch] = useState("");
  // User-typed custom rows. Treated as if they were extracted from the
  // source — same key shape ("custom:<n>:<word>" so frequency mode can
  // tell them apart from real hits) and the same save path.
  const [customRows, setCustomRows] = useState<
    { id: string; word: string; reading: string; gloss: string }[]
  >([]);
  /** Collapsed state per lesson — defaults to expanded. */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollectionId] = useState<string>(NEW_COLLECTION_VALUE);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [saving, setSaving] = useState(false);

  // Run extraction whenever the dialog opens with a source. We deliberately
  // re-run on each open instead of caching — the source could have been
  // edited or re-indexed since last time.
  useEffect(() => {
    if (!open || !source || !workspace) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPicked(new Set());
    setCollapsed(new Set());
    setCustomRows([]);
    setNewCollectionName(source.title ? `${source.title} — vocab` : "Extracted vocab");

    (async () => {
      try {
        const text = await getSourceContent(workspace.id, source.kind, source.id);
        if (!text) {
          if (!cancelled) {
            setError("This source has no indexed content yet.");
            setWords([]);
            setLessons([]);
            setLoading(false);
          }
          return;
        }
        const lang = workspace.targetLang as LanguageCode;

        // 1. Try the structured detector first — it's the highly-targeted
        //    pass that finds explicit "Vocabulary" sections.
        const rawLessons = extractStructuredVocab(text, lang);
        let withStatus: LessonWithStatus[] = [];
        if (rawLessons.length > 0) {
          // Bulk vocab status lookup so the dialog can highlight already-
          // known words and pre-pick only the new ones.
          const allWords = Array.from(
            new Set(rawLessons.flatMap((l) => l.words.map((w) => w.word))),
          );
          const vocabMap = await lookupVocabBatch(workspace.id, allWords).catch(
            () => new Map<string, VocabEntry>(),
          );
          withStatus = rawLessons.map((l) => ({
            ...l,
            statuses: l.words.map((w) => vocabMap.get(w.word)?.status ?? null),
          }));
        }
        if (cancelled) return;
        setLessons(withStatus);

        // 2. Always also run the frequency pass — cheap on small docs and
        //    gives the user a fallback when structure detection misses.
        const freq = await extractVocabulary({
          workspaceId: workspace.id,
          text,
          lang,
          maxUnique: 1500,
        });
        if (cancelled) return;
        setWords(freq);

        // 3. Default mode + initial picks.
        if (withStatus.length > 0) {
          setMode("lessons");
          // Pre-pick every word that isn't already mastered.
          const next = new Set<string>();
          for (const l of withStatus) {
            l.words.forEach((w, i) => {
              if (l.statuses[i] !== "mastered") {
                next.add(`${l.position}:${w.word}`);
              }
            });
          }
          setPicked(next);
        } else {
          setMode("frequency");
          const good = new Set<string>();
          for (const w of freq) {
            if (w.gloss && !w.status) good.add(w.word);
          }
          setPicked(good);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setWords([]);
          setLessons([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    void listCollections(workspace.id)
      .then((cs) => {
        if (!cancelled) setCollections(cs);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [open, source?.kind, source?.id, source?.title, workspace?.id]);

  /** Reset picks when the user switches mode — the key shape is different
   *  between lessons (`<pos>:<word>`) and frequency (`<word>`). */
  useEffect(() => {
    if (loading) return;
    if (mode === "lessons") {
      const next = new Set<string>();
      for (const l of lessons) {
        l.words.forEach((w, i) => {
          if (l.statuses[i] !== "mastered") {
            next.add(`${l.position}:${w.word}`);
          }
        });
      }
      setPicked(next);
    } else {
      const next = new Set<string>();
      for (const w of words) {
        if (w.gloss && !w.status) next.add(w.word);
      }
      setPicked(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return words.filter((w) => {
      if (hideKnown && w.status === "mastered") return false;
      if (hideNoEntry && !w.gloss) return false;
      if (w.count < minCount) return false;
      if (!q) return true;
      return (
        w.word.toLowerCase().includes(q) ||
        (w.reading?.toLowerCase().includes(q) ?? false) ||
        (w.gloss?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [words, hideKnown, hideNoEntry, minCount, search]);

  // Master checkbox state across the currently-visible rows.
  const visiblePickedCount = visible.filter((w) => picked.has(w.word)).length;
  const allVisibleChecked =
    visible.length > 0 && visiblePickedCount === visible.length;
  const someVisibleChecked =
    visiblePickedCount > 0 && visiblePickedCount < visible.length;

  function toggleAllVisible(on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const w of visible) {
        if (on) next.add(w.word);
        else next.delete(w.word);
      }
      return next;
    });
  }
  function toggleOne(word: string, on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(word);
      else next.delete(word);
      return next;
    });
  }

  async function save() {
    if (!workspace || !source) return;
    const customCount = customRows.filter((r) => r.word.trim()).length;
    if (picked.size === 0 && customCount === 0) {
      toast.info("Pick at least one word — or add a custom row.");
      return;
    }
    setSaving(true);
    try {
      // Resolve which collection to save into. "New" creates one named after
      // the source so the user has a stable place to drill from later.
      let target: Collection;
      if (collectionId === NEW_COLLECTION_VALUE) {
        target = await createCollection({
          workspaceId: workspace.id,
          name: newCollectionName.trim() || "Extracted vocab",
          description: source.title
            ? `Extracted from ${source.title}.`
            : "Extracted from a knowledge source.",
          source: "imported",
        });
      } else {
        const existing = collections.find((c) => String(c.id) === collectionId);
        if (!existing) {
          toast.error("Collection not found");
          return;
        }
        target = existing;
      }

      // Per-word writes — addWordToCollection is idempotent (saveVocab uses
      // upsert) so re-saving never produces duplicates.
      let count = 0;
      // User-typed custom rows always go into the chosen collection,
      // regardless of mode. They're "extra" entries the user wants saved
      // alongside whatever was extracted from the source.
      for (const row of customRows) {
        const word = row.word.trim();
        if (!word) continue;
        await addWordToCollection({
          workspaceId: workspace.id,
          collectionId: target.id,
          word,
          reading: row.reading.trim() || null,
          gloss: row.gloss.trim() || null,
        });
        count += 1;
      }
      if (mode === "frequency") {
        const lookup = new Map(words.map((w) => [w.word, w]));
        for (const word of picked) {
          const w = lookup.get(word);
          if (!w) continue;
          await addWordToCollection({
            workspaceId: workspace.id,
            collectionId: target.id,
            word: w.word,
            reading: w.reading,
            gloss: w.gloss,
          });
          count += 1;
        }
      } else {
        // Lessons mode. One collection per lesson when the user picked
        // "+ New collection", so the saved structure mirrors the source
        // textbook (e.g. "Lesson 3 vocab", "Lesson 4 vocab"). When the
        // user picked an existing collection, everything goes there in a
        // flat list — they explicitly opted out of the per-lesson split.
        for (const lesson of lessons) {
          const lessonPicks = lesson.words.filter((w) =>
            picked.has(`${lesson.position}:${w.word}`),
          );
          if (lessonPicks.length === 0) continue;
          let perLessonTarget = target;
          if (collectionId === NEW_COLLECTION_VALUE && lessons.length > 1) {
            perLessonTarget = await createCollection({
              workspaceId: workspace.id,
              name: lesson.title,
              description: source.title
                ? `Vocab from ${source.title} → ${lesson.title}.`
                : `Vocab list "${lesson.headingMatch}".`,
              source: "imported",
            });
          }
          for (const w of lessonPicks) {
            await addWordToCollection({
              workspaceId: workspace.id,
              collectionId: perLessonTarget.id,
              word: w.word,
              reading: w.reading,
              gloss: w.gloss,
            });
            count += 1;
          }
        }
      }
      const collectionDescription =
        mode === "lessons" && collectionId === NEW_COLLECTION_VALUE && lessons.length > 1
          ? `Across ${lessons.filter((l) => l.words.some((w) => picked.has(`${l.position}:${w.word}`))).length} lesson collections`
          : `Added to "${target.name}"`;
      toast.success(`Saved ${count} word${count === 1 ? "" : "s"}`, {
        description: collectionDescription,
      });
      onSaved?.(count);
      onClose();
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookmarkPlus className="size-5" />
            Extract vocabulary
            {source?.title && (
              <span className="text-[12.5px] font-normal text-muted-foreground">
                · {source.title}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-3">
          {/* Mode toggle. Two pills — Lessons (structured detection) and
              All words (frequency). Auto-picked on dialog open: Lessons if
              the source had recognisable vocab sections, Frequency
              otherwise. The user can flip between them at any time. */}
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-full border border-border bg-muted/40 p-0.5 text-[12.5px]">
              <button
                type="button"
                onClick={() => setMode("lessons")}
                disabled={lessons.length === 0}
                className={cn(
                  "rounded-full px-3 py-1 transition-colors",
                  mode === "lessons"
                    ? "bg-background font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground",
                )}
                title={
                  lessons.length === 0
                    ? "No structured vocabulary lists detected in this source"
                    : `${lessons.length} lesson${lessons.length === 1 ? "" : "s"} detected`
                }
              >
                Detected lessons
                {lessons.length > 0 && (
                  <span className="ml-1 rounded-full bg-foreground/10 px-1.5 text-[10.5px]">
                    {lessons.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setMode("frequency")}
                className={cn(
                  "rounded-full px-3 py-1 transition-colors",
                  mode === "frequency"
                    ? "bg-background font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                All words by frequency
              </button>
            </div>
          </div>

          <p className="text-[12.5px] text-muted-foreground">
            {mode === "lessons"
              ? "Pulled directly out of explicit “Vocabulary” sections we found in this source. Each lesson can save into its own collection."
              : "Walks every word in this source. Useful for sources that don’t have a curated vocab list — pick the words you want."}
          </p>

          {/* Filters — only meaningful in frequency mode. */}
          {mode === "frequency" && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter words…"
                className="h-8 pl-8 text-[12.5px]"
              />
            </div>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Checkbox
                checked={hideKnown}
                onCheckedChange={(v) => setHideKnown(v === true)}
              />
              Hide known
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Checkbox
                checked={hideNoEntry}
                onCheckedChange={(v) => setHideNoEntry(v === true)}
              />
              Dict entry only
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              Min freq
              <Input
                type="number"
                min={1}
                max={50}
                value={minCount}
                onChange={(e) => setMinCount(Math.max(1, Number(e.target.value) || 1))}
                className="h-7 w-14 text-[12px]"
              />
            </label>
          </div>
          )}

          {/* Custom rows — user-typed entries that save alongside whatever
              was detected from the source. Useful for vocab the source
              missed, or for paying-down a custom dictionary as you go. */}
          <CustomRowsBlock rows={customRows} setRows={setCustomRows} />

          {/* Body. Two distinct renders — lesson groups vs flat
              frequency table. */}
          <div className="rounded-md border border-border bg-card">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Tokenising and looking up words…
              </div>
            ) : error ? (
              <p className="px-3 py-3 text-[12.5px] text-destructive">{error}</p>
            ) : mode === "lessons" ? (
              <div className="max-h-[45vh] overflow-y-auto p-2">
                {lessons.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">
                    No structured vocabulary lists detected. Switch to "All
                    words by frequency" above.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {lessons.map((l) => {
                      const isCollapsed = collapsed.has(l.position);
                      const lessonPicked = l.words.filter((w) =>
                        picked.has(`${l.position}:${w.word}`),
                      ).length;
                      const allLessonChecked =
                        lessonPicked === l.words.length && l.words.length > 0;
                      const someLessonChecked =
                        lessonPicked > 0 && lessonPicked < l.words.length;
                      return (
                        <li
                          key={l.position}
                          className="rounded-md border border-border bg-background"
                        >
                          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
                            <Checkbox
                              checked={
                                allLessonChecked
                                  ? true
                                  : someLessonChecked
                                    ? "indeterminate"
                                    : false
                              }
                              onCheckedChange={(v) => {
                                setPicked((prev) => {
                                  const next = new Set(prev);
                                  for (const w of l.words) {
                                    const k = `${l.position}:${w.word}`;
                                    if (v === true) next.add(k);
                                    else next.delete(k);
                                  }
                                  return next;
                                });
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setCollapsed((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(l.position)) next.delete(l.position);
                                  else next.add(l.position);
                                  return next;
                                });
                              }}
                              className="flex flex-1 items-center gap-1 text-left text-[13px] font-medium"
                            >
                              {isCollapsed ? (
                                <ChevronRight className="size-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="size-3.5 text-muted-foreground" />
                              )}
                              <span className="truncate">{l.title}</span>
                            </button>
                            <span className="text-[11px] text-muted-foreground">
                              {lessonPicked}/{l.words.length} words ·{" "}
                              <span className="italic">{l.headingMatch}</span>
                            </span>
                          </div>
                          {!isCollapsed && (
                            <ul className="grid divide-y divide-border/50">
                              {l.words.map((w, i) => {
                                const k = `${l.position}:${w.word}`;
                                const checked = picked.has(k);
                                const status = l.statuses[i];
                                return (
                                  <li
                                    key={i}
                                    className={cn(
                                      "flex items-baseline gap-2 px-3 py-1.5 text-[13px]",
                                      checked && "bg-accent/30",
                                    )}
                                  >
                                    <Checkbox
                                      checked={checked}
                                      onCheckedChange={(v) =>
                                        setPicked((prev) => {
                                          const next = new Set(prev);
                                          if (v === true) next.add(k);
                                          else next.delete(k);
                                          return next;
                                        })
                                      }
                                    />
                                    <span className="font-serif text-[15px]">
                                      {w.word}
                                    </span>
                                    {w.reading && (
                                      <span className="text-[12px] text-muted-foreground">
                                        {w.reading}
                                      </span>
                                    )}
                                    <span className="ml-1 flex-1 truncate text-[12.5px] text-muted-foreground">
                                      {w.gloss ?? <em>(no gloss)</em>}
                                    </span>
                                    {status && (
                                      <span className="text-[10.5px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                                        {status}
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ) : (
              <div className="max-h-[40vh] overflow-y-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="sticky top-0 bg-muted/40 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="w-9 px-3 py-1.5">
                        <Checkbox
                          checked={
                            allVisibleChecked
                              ? true
                              : someVisibleChecked
                                ? "indeterminate"
                                : false
                          }
                          onCheckedChange={(v) => toggleAllVisible(v === true)}
                          aria-label="Select all visible"
                        />
                      </th>
                      <th className="px-2 py-1.5 font-medium">Word</th>
                      <th className="px-2 py-1.5 font-medium">Reading</th>
                      <th className="px-2 py-1.5 font-medium">Gloss</th>
                      <th className="w-12 px-2 py-1.5 text-right font-medium">×</th>
                      <th className="w-16 px-2 py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((w) => {
                      const checked = picked.has(w.word);
                      return (
                        <tr
                          key={w.word}
                          className={cn(
                            "border-t border-border/60",
                            checked && "bg-accent/30",
                          )}
                        >
                          <td className="px-3 py-1.5">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(v) => toggleOne(w.word, v === true)}
                            />
                          </td>
                          <td className="px-2 py-1.5 font-serif text-[15px]">{w.word}</td>
                          <td className="px-2 py-1.5 text-[12px] text-muted-foreground">
                            {w.reading ?? "—"}
                          </td>
                          <td className="max-w-[280px] truncate px-2 py-1.5 text-[12.5px] text-muted-foreground">
                            {w.gloss ?? <em>(no entry)</em>}
                          </td>
                          <td className="px-2 py-1.5 text-right text-[12px] text-muted-foreground">
                            {w.count}
                          </td>
                          <td className="px-2 py-1.5 text-[10.5px] uppercase tracking-wider">
                            {w.status ? (
                              <span className="text-emerald-700 dark:text-emerald-400">
                                {w.status}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/60">new</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {visible.length === 0 && !loading && (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-3 py-6 text-center text-[12.5px] text-muted-foreground"
                        >
                          No words match the current filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Collection picker. In lessons mode + "+ New collection" we
              create one collection per lesson (named after the lesson
              heading) so the saved structure mirrors the textbook. Picking
              an existing collection consolidates everything into that one
              list — the user can opt out of the per-lesson split. */}
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
            <div className="grid gap-1.5">
              <Label>Save into</Label>
              <Select
                value={collectionId}
                onValueChange={setCollectionId}
                disabled={saving}
              >
                <SelectTrigger className="h-8 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NEW_COLLECTION_VALUE}>
                    + New collection
                  </SelectItem>
                  {collections.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {collectionId === NEW_COLLECTION_VALUE && (
              <div className="grid gap-1.5">
                <Label>Collection name</Label>
                <Input
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  placeholder={
                    mode === "lessons" && lessons.length > 1
                      ? `One collection per lesson (auto-named) — fallback: ${
                          newCollectionName || "Extracted vocab"
                        }`
                      : "e.g. Genki I — Lesson 3 vocab"
                  }
                  className="h-8 text-[13px]"
                  disabled={saving || (mode === "lessons" && lessons.length > 1)}
                />
                {mode === "lessons" && lessons.length > 1 && (
                  <p className="text-[10.5px] text-muted-foreground">
                    Each detected lesson saves into its own collection (named
                    after the lesson heading). Pick an existing collection
                    above to consolidate them instead.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="items-center">
          <span className="mr-auto text-[12px] text-muted-foreground">
            {picked.size + customRows.filter((r) => r.word.trim()).length} word
            {picked.size + customRows.filter((r) => r.word.trim()).length === 1 ? "" : "s"} selected
            {mode === "lessons" &&
              lessons.length > 0 &&
              ` · ${lessons.length} lesson${lessons.length === 1 ? "" : "s"}`}
            {customRows.filter((r) => r.word.trim()).length > 0 &&
              ` · ${customRows.filter((r) => r.word.trim()).length} custom`}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={
              saving ||
              (picked.size === 0 &&
                customRows.filter((r) => r.word.trim()).length === 0)
            }
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {(() => {
              const total =
                picked.size + customRows.filter((r) => r.word.trim()).length;
              return total > 0 ? `Save ${total}` : "Save";
            })()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Inline editor for free-typed vocabulary rows. The user adds a row,
 *  fills in word + (optional) reading + gloss, and the parent saves them
 *  alongside whatever was extracted from the source. */
function CustomRowsBlock({
  rows,
  setRows,
}: {
  rows: { id: string; word: string; reading: string; gloss: string }[];
  setRows: React.Dispatch<
    React.SetStateAction<
      { id: string; word: string; reading: string; gloss: string }[]
    >
  >;
}) {
  function addBlank() {
    setRows((prev) => [
      ...prev,
      {
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2),
        word: "",
        reading: "",
        gloss: "",
      },
    ]);
  }
  function update(
    id: string,
    field: "word" | "reading" | "gloss",
    value: string,
  ) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }
  function remove(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20 p-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
          Custom words ({rows.length})
        </p>
        <Button size="sm" variant="ghost" onClick={addBlank} className="h-7">
          + Add row
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          Add words the source missed. Saves into the same collection on
          confirm.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.map((r) => (
            <li
              key={r.id}
              className="grid grid-cols-[2fr_2fr_3fr_auto] items-center gap-1.5"
            >
              <Input
                value={r.word}
                onChange={(e) => update(r.id, "word", e.target.value)}
                placeholder="word"
                className="h-7 font-serif text-[14px]"
              />
              <Input
                value={r.reading}
                onChange={(e) => update(r.id, "reading", e.target.value)}
                placeholder="reading (optional)"
                className="h-7 text-[12.5px]"
              />
              <Input
                value={r.gloss}
                onChange={(e) => update(r.id, "gloss", e.target.value)}
                placeholder="gloss (optional)"
                className="h-7 text-[12.5px]"
              />
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => remove(r.id)}
                title="Remove"
                className="text-muted-foreground hover:text-destructive"
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
