import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BookmarkPlus, Check, FolderPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Reading } from "@/components/reading";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  addWordToCollection,
  getOrCreateDefaultCollection,
  listCollections,
  saveVocab,
  type Collection,
} from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";
import { parseVocabBlock } from "@/lib/vocab-block";
import type { LanguageCode } from "@/lib/languages";
import { cn } from "@/lib/utils";

/**
 * Rich rendering of a ```vocab block inside an assistant reply: a compact
 * table with the word + colour-coded reading + direct meaning, and inline
 * actions to save each word to vocabulary or add it to a collection. The
 * meanings are always visible (no translation blur) — this is a reference
 * list, not immersion prose.
 */
export function VocabTable({ raw }: { raw: string }) {
  const rows = useMemo(() => parseVocabBlock(raw), [raw]);
  const { active: workspace } = useWorkspace();
  const lang = (workspace?.targetLang ?? "en") as LanguageCode;
  const workspaceId = workspace?.id ?? null;
  const [savedRows, setSavedRows] = useState<Set<number>>(() => new Set());
  const [busyRow, setBusyRow] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  if (rows.length === 0) return null;

  async function saveOne(i: number) {
    if (workspaceId == null) return;
    setBusyRow(i);
    try {
      const r = rows[i];
      await saveVocab({
        workspaceId,
        word: r.word,
        reading: r.reading || null,
        gloss: r.meaning || null,
        source: "chat",
      });
      setSavedRows((p) => new Set(p).add(i));
      toast.success(`Saved ${rows[i].word}`);
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyRow(null);
    }
  }

  async function saveAll() {
    if (workspaceId == null) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        rows.map((r) =>
          saveVocab({
            workspaceId,
            word: r.word,
            reading: r.reading || null,
            gloss: r.meaning || null,
            source: "chat",
          }),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      setSavedRows(new Set(rows.map((_, i) => i)));
      toast.success(`Saved ${ok} word${ok === 1 ? "" : "s"} to vocabulary`);
    } finally {
      setBulkBusy(false);
    }
  }

  async function addOneToCollection(i: number, c: Collection) {
    if (workspaceId == null) return;
    const r = rows[i];
    await addWordToCollection({
      workspaceId,
      collectionId: c.id,
      word: r.word,
      reading: r.reading || null,
      gloss: r.meaning || null,
    });
    setSavedRows((p) => new Set(p).add(i));
    toast.success(`Added ${r.word} to ${c.name}`);
  }

  async function addAllToCollection(c: Collection) {
    if (workspaceId == null) return;
    await Promise.allSettled(
      rows.map((r) =>
        addWordToCollection({
          workspaceId,
          collectionId: c.id,
          word: r.word,
          reading: r.reading || null,
          gloss: r.meaning || null,
        }),
      ),
    );
    setSavedRows(new Set(rows.map((_, i) => i)));
    toast.success(`Added ${rows.length} words to ${c.name}`);
  }

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Vocabulary · {rows.length}
        </span>
        {workspaceId != null && (
          <div className="flex items-center gap-1.5">
            <CollectionPicker
              workspaceId={workspaceId}
              onPick={addAllToCollection}
              trigger={
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-accent/60 hover:text-foreground"
                  title="Add all to a collection"
                >
                  <FolderPlus className="size-3" />
                  All to list
                </button>
              }
            />
            <button
              type="button"
              onClick={() => void saveAll()}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 disabled:opacity-60 dark:text-emerald-300"
              title="Save every word as new vocabulary"
            >
              {bulkBusy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <BookmarkPlus className="size-3" />
              )}
              Save all
            </button>
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <tbody>
            {rows.map((r, i) => {
              const saved = savedRows.has(i);
              return (
                <tr
                  key={i}
                  className="border-b border-border/40 last:border-0 hover:bg-accent/20"
                >
                  <td className="px-3 py-2 align-top">
                    <div className="font-serif text-[16px] leading-tight">
                      {r.word}
                    </div>
                    {r.reading && (
                      <div className="mt-0.5">
                        <Reading
                          lang={lang}
                          reading={r.reading}
                          className="text-[12px]"
                        />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-foreground/85">
                    {r.meaning}
                  </td>
                  {workspaceId != null && (
                    <td className="w-px whitespace-nowrap px-2 py-2 align-top">
                      <div className="flex items-center justify-end gap-1">
                        <CollectionPicker
                          workspaceId={workspaceId}
                          onPick={(c) => addOneToCollection(i, c)}
                          trigger={
                            <button
                              type="button"
                              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                              title={`Add ${r.word} to a list`}
                              aria-label={`Add ${r.word} to a list`}
                            >
                              <FolderPlus className="size-3.5" />
                            </button>
                          }
                        />
                        <button
                          type="button"
                          onClick={() => void saveOne(i)}
                          disabled={busyRow === i || saved}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                            saved
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                              : "border-border bg-card text-foreground/80 hover:bg-accent/60 hover:text-foreground",
                          )}
                          title={saved ? "In vocabulary" : "Save as new vocabulary"}
                        >
                          {saved ? (
                            <Check className="size-3" />
                          ) : busyRow === i ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <BookmarkPlus className="size-3" />
                          )}
                          {saved ? "Saved" : "Save"}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Small collection-picker popover shared by the per-row and bulk "add to
 * list" actions. Loads (and ensures a default) collection on open, then
 * calls `onPick` with the chosen collection.
 */
function CollectionPicker({
  workspaceId,
  trigger,
  onPick,
}: {
  workspaceId: number;
  trigger: ReactNode;
  onPick: (c: Collection) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      await getOrCreateDefaultCollection(workspaceId);
      const list = await listCollections(workspaceId);
      if (!cancelled) setCollections(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  async function pick(c: Collection) {
    setBusy(c.id);
    try {
      await onPick(c);
      setOpen(false);
    } catch (err) {
      toast.error("Couldn't add", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-60 p-1">
        <div className="px-2 pb-1 pt-0.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Add to collection
        </div>
        {collections.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">
            Loading collections…
          </p>
        ) : (
          <ul className="flex max-h-64 flex-col overflow-y-auto">
            {collections.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => void pick(c)}
                  disabled={busy != null}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/60"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{c.name}</span>
                    {c.isDefault && (
                      <span className="rounded border border-border px-1 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                        default
                      </span>
                    )}
                  </span>
                  {busy === c.id ? (
                    <Loader2 className="size-3 animate-spin text-muted-foreground" />
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
