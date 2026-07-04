/**
 * Global Ctrl/Cmd+K dictionary search.
 *
 * - Listens on `window` so any focused element can trigger the modal.
 * - 80vw modal with a backdrop blur — the page is still legible behind
 *   it so the user keeps context.
 * - The result list is collapsed when there's no query and expands as
 *   matches arrive, so the modal grows from compact-input to results-
 *   view in one motion.
 * - cmdk (CommandPrimitive) handles arrow-key navigation + Enter,
 *   matching the platform-standard command palette UX. We disable its
 *   built-in fuzzy filter (`shouldFilter={false}`) because we delegate
 *   to the dictionary's ranked search, which understands tones / pinyin
 *   / readings better than a generic substring match.
 *
 * Picking a result populates the global SearchProvider so the Search
 * tab can render the detail page, then routes the user there via the
 * shared nav-event bus.
 */

import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowRight, BookOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { saveVocab, searchDict, type DictEntry, type VocabEntry } from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";
import { useSearch } from "@/lib/search-context";
import { navigateToTab } from "@/lib/nav-event";
import { prettyPinyin } from "@/lib/pinyin";
// (prettyPinyin is re-used below in `formatReadingForLang`.)
import { cn } from "@/lib/utils";
import { CardComposerDialog } from "@/components/card-composer-dialog";

export function DictSearchModal() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<DictEntry[]>([]);
  const [composerSeed, setComposerSeed] = useState<VocabEntry | null>(null);
  const { active: workspace } = useWorkspace();
  const search = useSearch();

  // Global Ctrl/Cmd+K — toggle the modal regardless of focused element.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Debounce the query to keep typing responsive while still trimming
  // network calls. 150 ms is the same value the in-app SearchProvider
  // uses, for consistency.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(id);
  }, [query]);

  // Run the lookup whenever the debounced query (or workspace) changes.
  useEffect(() => {
    if (!workspace) return;
    if (!debounced) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    searchDict(workspace.targetLang, debounced, 50)
      .then((rows) => {
        if (!cancelled) setResults(rows);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, workspace?.id, workspace?.targetLang]);

  // Reset on close so re-opening starts fresh.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
      setResults([]);
    }
  }, [open]);

  // cmdk's CommandItem fires `onSelect` on both Enter and click, but
  // doesn't expose the originating event — so we can't tell ↵ from
  // ⌘↵ from inside the callback. Instead, sniff the last keydown's
  // modifier state on the window (capture phase, so we win the race
  // against cmdk's own listener) and stash it in a ref the onSelect
  // path can read.
  const enterModRef = useState(() => ({ modPressed: false }))[0];
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter") {
        enterModRef.modPressed = e.metaKey || e.ctrlKey;
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, enterModRef]);

  /** Format the dict row's stored reading into something a learner
   *  wants to see — tone-marked pinyin for Chinese, untouched for
   *  every other language (prettyPinyin is a no-op on non-numeric
   *  input). Applied at save time so the stored value matches what
   *  shows up on the card. */
  function formatReadingForLang(reading: string | null): string | null {
    if (!reading) return reading;
    return workspace?.targetLang === "zh" ? prettyPinyin(reading) : reading;
  }

  /** Plain ↵ — silent quick-add. Saves the dict row's reading +
   *  gloss, toasts, leaves the modal open so the user can keep
   *  collecting words. The cmdk cursor stays where it was. */
  async function quickAdd(entry: DictEntry) {
    if (!workspace) return;
    try {
      await saveVocab({
        workspaceId: workspace.id,
        word: entry.word,
        reading: formatReadingForLang(entry.reading),
        gloss: entry.gloss,
        source: "dict-search",
      });
      toast.success(`Added ${entry.word}`);
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** ⌘↵ — save then open the composer pre-filled so the user can
   *  attach image / AI sentence / TTS to the new row. */
  async function quickAddAndCompose(entry: DictEntry) {
    if (!workspace) return;
    try {
      const created = await saveVocab({
        workspaceId: workspace.id,
        word: entry.word,
        reading: formatReadingForLang(entry.reading),
        gloss: entry.gloss,
        source: "dict-search",
      });
      setOpen(false);
      setComposerSeed(created);
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The legacy "→ detail" path. Still available via the right-arrow
   *  icon next to each row; ↵ no longer triggers it. */
  function openDetail(entry: DictEntry) {
    search.setQuery(entry.word);
    search.setActive(entry);
    setOpen(false);
    navigateToTab("search");
  }

  function pick(entry: DictEntry) {
    // Branch on whether ⌘/Ctrl was held when Enter fired (sniffed in
    // the capture-phase keydown listener above). Plain click also lands
    // here with modPressed=false → silent quick-add.
    const composerAfter = enterModRef.modPressed;
    enterModRef.modPressed = false; // reset for the next press
    if (composerAfter) void quickAddAndCompose(entry);
    else void quickAdd(entry);
  }

  if (!workspace) return null;

  // The result list only mounts once the user has typed something —
  // that's what creates the "expand" animation: an empty modal with
  // just an input grows to include results as they arrive.
  const showList = query.trim().length > 0;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-background/60 backdrop-blur-2xl",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[80vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 outline-none",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
          onOpenAutoFocus={(e) => {
            // Let the CommandInput take focus naturally instead of the
            // dialog content's wrapper. Without this, arrow-key nav
            // races with the input's caret-move handlers.
            e.preventDefault();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            Dictionary search
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Type to search the installed dictionary. Use the arrow keys and
            Enter to open a result.
          </DialogPrimitive.Description>
          <div className="overflow-hidden rounded-2xl border border-border bg-card/95 shadow-2xl backdrop-blur-xl">
            <Command
              shouldFilter={false}
              className="bg-transparent **:data-[slot=command-input-wrapper]:h-14 [&_[cmdk-input]]:text-[13px]"
            >
              {/* Use CommandInput directly — it owns the search icon and
                  the border-b. The wrapper expands to the full modal
                  width so the input feels edge-to-edge. */}
              <CommandInput
                value={query}
                onValueChange={setQuery}
                autoFocus
                placeholder={`Search the ${workspace.targetLang.toUpperCase()} dictionary…`}
                className="text-[13px] placeholder:text-[12.5px]"
              />

              {showList && (
                <CommandList className="max-h-[60vh]">
                  {loading && results.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      Searching…
                    </div>
                  ) : results.length === 0 ? (
                    <CommandEmpty className="py-8 text-[12.5px]">
                      No matches for{" "}
                      <span className="font-medium text-foreground">
                        “{debounced}”
                      </span>
                      .
                    </CommandEmpty>
                  ) : (
                    <div className="p-2">
                      {results.map((e, i) => (
                        <CommandItem
                          key={`${e.word}-${i}`}
                          value={`${i}-${e.word}`}
                          onSelect={() => pick(e)}
                          className="cursor-pointer rounded-lg px-3 py-2.5 text-[13.5px] data-[selected=true]:bg-accent data-[selected=true]:ring-1 data-[selected=true]:ring-foreground/30"
                        >
                          <BookOpen className="size-4 text-muted-foreground" />
                          <span className="font-serif text-[16px] font-medium leading-none">
                            {e.word}
                          </span>
                          {e.altWord && e.altWord !== e.word && (
                            <span className="text-[12px] text-muted-foreground">
                              {e.altWord}
                            </span>
                          )}
                          {e.reading && (
                            <span className="text-[12px] text-muted-foreground/80">
                              {prettyPinyin(e.reading)}
                            </span>
                          )}
                          <span className="ml-2 truncate text-[12.5px] text-muted-foreground">
                            {e.gloss}
                          </span>
                          <button
                            type="button"
                            // Stop cmdk seeing the click as a row pick — this is
                            // the discrete "go to detail" affordance, not the
                            // primary save action.
                            onMouseDown={(ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              openDetail(e);
                            }}
                            className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            title="Open detail in Search tab"
                            aria-label={`Open detail for ${e.word}`}
                          >
                            <ArrowRight className="size-3.5" />
                          </button>
                        </CommandItem>
                      ))}
                    </div>
                  )}
                </CommandList>
              )}

              <div className="flex items-center gap-3 border-t border-border/60 bg-muted/30 px-4 py-2 text-[10.5px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px]">↑↓</kbd>
                  navigate
                </span>
                <span className="inline-flex items-center gap-1">
                  <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px]">↵</kbd>
                  quick-add
                </span>
                <span className="inline-flex items-center gap-1">
                  <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px]">⌘↵</kbd>
                  add + refine
                </span>
                <span className="inline-flex items-center gap-1">
                  <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px]">→</kbd>
                  detail
                </span>
                <span className="inline-flex items-center gap-1">
                  <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px]">Esc</kbd>
                  close
                </span>
                <span className="ml-auto">
                  {results.length > 0
                    ? `${results.length} match${results.length === 1 ? "" : "es"}`
                    : "Ctrl K from anywhere"}
                </span>
              </div>
            </Command>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>

      {composerSeed && (
        <CardComposerDialog
          mode="edit"
          open
          card={composerSeed}
          onClose={() => setComposerSeed(null)}
          onSaved={() => setComposerSeed(null)}
        />
      )}
    </DialogPrimitive.Root>
  );
}
