/**
 * Personal-dictionary editor.
 *
 * Surfaces the user's per-language "Personal" dictionary as an editable
 * table. Add a row, fill in word/reading/gloss, save — the entry lands
 * in `dict_entries` and the click-to-define popover, the search bar, and
 * the vocab extractor all pick it up immediately. No restart, no
 * re-install.
 *
 * Acts as the "edit the dictionary" affordance the user asked for: a
 * project-specific dictionary that lives next to (and on top of) the
 * shipped CC-CEDICT / JMdict / Ding packs.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
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
import {
  addDictEntry,
  deleteDictEntry,
  getOrCreatePersonalDict,
  listDictEntries,
  listVocab,
  updateDictEntry,
  updateVocabFields,
  type DictEntryRow,
  type Dictionary,
  type VocabEntry,
} from "@/lib/db";
import {
  parseExamples,
  serialiseExamples,
  type ExampleSentence,
} from "@/lib/examples";
import { languageName } from "@/lib/languages";
import { useSearch } from "@/lib/search-context";
import { useWorkspace } from "@/lib/workspace-context";
import { navigateToTab } from "@/lib/nav-event";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

type View = "words" | "sentences";

export function PersonalDictSection() {
  const { active: workspace } = useWorkspace();
  const [view, setView] = useState<View>("words");
  const [dict, setDict] = useState<Dictionary | null>(null);
  const [entries, setEntries] = useState<DictEntryRow[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  /** Edits buffered locally so the user can tab through cells without
   *  a write per keystroke. Flushed on blur / explicit save. */
  const [edits, setEdits] = useState<Map<number, Partial<DictEntryRow>>>(
    new Map(),
  );
  const [pendingDelete, setPendingDelete] = useState<DictEntryRow | null>(null);

  // Debounce the search input.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(id);
  }, [search]);

  // Bootstrap the dict + load page 0 whenever the workspace lang changes.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    setLoading(true);
    void getOrCreatePersonalDict(workspace.targetLang)
      .then((d) => {
        if (cancelled) return;
        setDict(d);
        return listDictEntries(d.id, "", PAGE_SIZE, 0);
      })
      .then((rows) => {
        if (!rows || cancelled) return;
        setEntries(rows);
        setPage(0);
      })
      .catch((err) => console.error("personal dict load", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.targetLang]);

  // Re-fetch on search / page change.
  useEffect(() => {
    if (!dict) return;
    let cancelled = false;
    setLoading(true);
    void listDictEntries(dict.id, debouncedSearch, PAGE_SIZE, page * PAGE_SIZE)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dict, debouncedSearch, page]);

  async function refresh() {
    if (!dict) return;
    const rows = await listDictEntries(
      dict.id,
      debouncedSearch,
      PAGE_SIZE,
      page * PAGE_SIZE,
    );
    setEntries(rows);
    // Refresh the dict header so the entry count is accurate.
    if (workspace) {
      const fresh = await getOrCreatePersonalDict(workspace.targetLang);
      setDict(fresh);
    }
  }

  async function addBlank() {
    if (!dict) return;
    await addDictEntry({
      dictId: dict.id,
      word: "(new entry)",
      reading: null,
      gloss: "(write here)",
    });
    setSearch("");
    setDebouncedSearch("");
    setPage(0);
    await refresh();
  }

  function bufferEdit(id: number, patch: Partial<DictEntryRow>) {
    setEdits((prev) => {
      const next = new Map(prev);
      next.set(id, { ...next.get(id), ...patch });
      return next;
    });
  }

  async function flushEdit(id: number) {
    const patch = edits.get(id);
    if (!patch) return;
    try {
      await updateDictEntry({
        id,
        word: patch.word,
        altWord: patch.altWord,
        reading: patch.reading,
        gloss: patch.gloss,
      });
      setEdits((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      await refresh();
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function flushAll() {
    if (edits.size === 0) return;
    for (const [id] of edits) {
      // eslint-disable-next-line no-await-in-loop
      await flushEdit(id);
    }
  }

  async function confirmDelete(row: DictEntryRow) {
    if (!dict) return;
    try {
      await deleteDictEntry(row.id, dict.id);
      await refresh();
    } catch (err) {
      toast.error("Couldn't delete", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!workspace) return null;

  // Render-time merge of buffered edits so the table reflects unsaved
  // changes immediately.
  const visible = entries.map((e) => ({ ...e, ...(edits.get(e.id) ?? {}) }));

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold tracking-tight">
            Personal dictionary
          </h3>
          <p className="text-[12px] text-muted-foreground">
            Your own {languageName(workspace.targetLang)} entries — added
            here or saved during vocab extraction. Read alongside CC-CEDICT
            / JMdict / etc. by every lookup in the app.
            {dict && view === "words" && (
              <span className="ml-1.5 text-foreground">
                {dict.entryCount} entr{dict.entryCount === 1 ? "y" : "ies"}.
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Words / Sentences toggle. Words = the dict_entries table
              (CC-CEDICT-style headwords). Sentences = saved example
              sentences scraped from each vocab row's card_notes; they
              live with their source word, not as standalone dict
              entries. */}
          <div
            className="inline-flex rounded-full border border-border bg-card p-0.5"
            role="group"
            aria-label="Personal dictionary view"
          >
            {(["words", "sentences"] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  "rounded-full px-3 py-1 text-[11.5px] font-medium capitalize transition-colors",
                  view === v
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v}
              </button>
            ))}
          </div>
          {view === "words" && edits.size > 0 && (
            <Button size="sm" variant="outline" onClick={() => void flushAll()}>
              <Save className="size-3.5" />
              Save {edits.size} edit{edits.size === 1 ? "" : "s"}
            </Button>
          )}
          {view === "words" && (
            <Button size="sm" onClick={() => void addBlank()}>
              <Plus className="size-3.5" />
              Add entry
            </Button>
          )}
        </div>
      </div>

      {view === "sentences" && <SavedSentencesView />}

      {view === "words" && (
      <>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="Search entries by word / reading / gloss…"
          className="h-8 pl-8 text-[12.5px]"
        />
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-card">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-muted/30 text-[10.5px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="w-[22%] px-2 py-1.5 font-medium">Word</th>
              <th className="w-[14%] px-2 py-1.5 font-medium">Alt</th>
              <th className="w-[18%] px-2 py-1.5 font-medium">Reading</th>
              <th className="px-2 py-1.5 font-medium">Gloss</th>
              <th className="w-9 px-1 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">
                  <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">
                  No entries yet. Click <strong>Add entry</strong> to start
                  one.
                </td>
              </tr>
            ) : (
              visible.map((e) => (
                <tr key={e.id} className="border-t border-border/60">
                  <td className="px-1.5 py-0.5">
                    <Input
                      defaultValue={e.word}
                      onChange={(ev) => bufferEdit(e.id, { word: ev.target.value })}
                      onBlur={() => void flushEdit(e.id)}
                      className="h-7 border-transparent bg-transparent font-serif text-[15px] focus-visible:border-input focus-visible:bg-background"
                    />
                  </td>
                  <td className="px-1.5 py-0.5">
                    <Input
                      defaultValue={e.altWord ?? ""}
                      onChange={(ev) =>
                        bufferEdit(e.id, { altWord: ev.target.value || null })
                      }
                      onBlur={() => void flushEdit(e.id)}
                      placeholder="—"
                      className="h-7 border-transparent bg-transparent text-[12.5px] focus-visible:border-input focus-visible:bg-background"
                    />
                  </td>
                  <td className="px-1.5 py-0.5">
                    <Input
                      defaultValue={e.reading ?? ""}
                      onChange={(ev) =>
                        bufferEdit(e.id, { reading: ev.target.value || null })
                      }
                      onBlur={() => void flushEdit(e.id)}
                      placeholder="—"
                      className="h-7 border-transparent bg-transparent text-[12.5px] focus-visible:border-input focus-visible:bg-background"
                    />
                  </td>
                  <td className="px-1.5 py-0.5">
                    <Input
                      defaultValue={e.gloss}
                      onChange={(ev) => bufferEdit(e.id, { gloss: ev.target.value })}
                      onBlur={() => void flushEdit(e.id)}
                      className="h-7 border-transparent bg-transparent text-[12.5px] focus-visible:border-input focus-visible:bg-background"
                    />
                  </td>
                  <td className="px-1.5 py-0.5">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => setPendingDelete(e)}
                      className="text-muted-foreground hover:text-destructive"
                      title="Delete entry"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination — keep it minimal. The search box covers the cases
          where the user wants to jump straight to a particular entry. */}
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        <span>
          {dict
            ? `Page ${page + 1} · showing ${visible.length} of ${dict.entryCount}`
            : ""}
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            ← Prev
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPage((p) => p + 1)}
            disabled={visible.length < PAGE_SIZE}
          >
            Next →
          </Button>
        </div>
      </div>
      </>
      )}

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(v) => !v && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete "{pendingDelete?.word}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This entry is removed from your personal dictionary. Click-to-
              define lookups for this word will fall back to the other
              installed dictionaries (if any).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) await confirmDelete(target);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Saved sentences view ────────────────────────────────────────────────
//
// Browses every "user"-sourced example sentence saved across the
// active workspace's vocabulary. Sentences themselves live with their
// source word in `vocab_entries.card_notes` (see `lib/examples.ts`),
// so this view is purely a flatten + filter — no schema change.
//
// Each row links back to the source word's dictionary detail and lets
// the user pop the sentence off the word's record from here. Editing
// the sentence inline isn't supported yet — happens on the word's
// detail page where the original context lives.

type SentenceRow = {
  word: VocabEntry;
  example: ExampleSentence;
};

function SavedSentencesView() {
  const { active: workspace } = useWorkspace();
  const search = useSearch();
  const [vocab, setVocab] = useState<VocabEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SentenceRow | null>(null);

  async function refresh() {
    if (!workspace) return;
    const list = await listVocab(workspace.id);
    setVocab(list);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  /** Flatten every word's saved sentences into one list. Both user-
   *  and AI-sourced examples appear — AI examples come from the
   *  click-to-define popover's "Generate with AI" flow and are saved
   *  with intent (the user explicitly clicked Save), so they're not
   *  noise. The badge under each row distinguishes the two. */
  const rows = useMemo<SentenceRow[]>(() => {
    if (!vocab) return [];
    const out: SentenceRow[] = [];
    for (const v of vocab) {
      const examples = parseExamples(v.cardNotes);
      for (const ex of examples) {
        out.push({ word: v, example: ex });
      }
    }
    return out.sort((a, b) => a.word.word.localeCompare(b.word.word));
  }, [vocab]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.word.word.toLowerCase().includes(q) ||
        r.example.target.toLowerCase().includes(q) ||
        (r.example.native ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  function openInDict(word: string) {
    search.setQuery(word);
    navigateToTab("search");
  }

  async function deleteSentence(row: SentenceRow) {
    const examples = parseExamples(row.word.cardNotes);
    const next = examples.filter((e) => e.id !== row.example.id);
    try {
      await updateVocabFields({
        id: row.word.id,
        cardNotes: next.length === 0 ? null : serialiseExamples(next),
      });
      toast.success("Sentence removed");
      await refresh();
    } catch (err) {
      toast.error("Couldn't delete", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sentences by word, target, or translation…"
          className="h-8 pl-8 text-[12.5px]"
        />
      </div>

      {vocab == null ? (
        <div className="rounded-md border border-border bg-card px-4 py-8 text-center text-[12.5px] text-muted-foreground">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-card/40 px-4 py-8 text-center text-[12.5px] text-muted-foreground">
          {rows.length === 0 ? (
            <>
              No saved sentences yet. Open a word's dictionary detail page,
              generate examples with AI, then click the{" "}
              <span className="font-mono">+ bookmark</span> button next to
              one to save it here.
            </>
          ) : (
            <>
              No sentences match{" "}
              <span className="font-medium text-foreground">"{query}"</span>.
            </>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((row) => (
            <li
              key={`${row.word.id}-${row.example.id}`}
              className="rounded-lg border border-border bg-card px-4 py-3 transition-shadow hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-serif text-[15px] leading-snug">
                    {row.example.target}
                  </p>
                  {row.example.native && (
                    <p className="mt-1 text-[12.5px] text-muted-foreground">
                      {row.example.native}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => openInDict(row.word.word)}
                    className="mt-2 inline-flex items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                    title={`Open ${row.word.word} in the dictionary`}
                  >
                    <span className="font-serif text-[12px] normal-case text-foreground">
                      {row.word.word}
                    </span>
                    <ArrowRight className="size-3" />
                  </button>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => openInDict(row.word.word)}
                    title="Open word in dictionary"
                  >
                    <BookOpen className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setPendingDelete(row)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Remove sentence"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(v) => !v && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this sentence?</AlertDialogTitle>
            <AlertDialogDescription>
              The sentence is unlinked from{" "}
              <span className="font-mono">{pendingDelete?.word.word}</span>'s
              dictionary record. Other examples on the same word are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) await deleteSentence(target);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
