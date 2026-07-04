import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddCustomWordDialog } from "@/components/add-custom-word-dialog";
import { CharacterDetail } from "@/components/character-detail";
import { useSearch } from "@/lib/search-context";
import { useWorkspace } from "@/lib/workspace-context";

export function SearchView() {
  const { active: workspace } = useWorkspace();
  const { query, setQuery, debounced, loading, active, refresh } = useSearch();

  if (!workspace) return null;

  // No active entry yet — show a hero search input so the user can look
  // something up without bouncing to the sidebar. The shared SearchProvider
  // drives the same query state the sidebar reads, so once results arrive
  // `active` flips and we transition into the detail view automatically.
  if (!active) {
    return (
      <SearchHero
        query={query}
        setQuery={setQuery}
        loading={loading}
        debounced={debounced}
        targetLang={workspace.targetLang}
        onAdded={refresh}
      />
    );
  }

  // Every language uses the rich detail page. It adapts per language via
  // `detailCaps` — pinyin/furigana + stroke order for CJK, romaja +
  // pronunciation for Korean, an AI grammar profile for German/Spanish —
  // and handles multi-char input (one stroke panel per hanzi/kanji).
  return (
    <div className="h-full overflow-y-auto">
      <CharacterDetail char={active.word} lang={workspace.targetLang} />
    </div>
  );
}

// ─── Hero search input (empty-state) ─────────────────────────────────────
//
// Centred search bar shown when no entry is active yet. Wired to the
// shared SearchProvider so it stays in sync with whatever's in the
// shell sidebar; typing here updates both. Once at least one match
// resolves the provider's `active` flips and the detail view takes
// over — at which point this component unmounts.

function SearchHero({
  query,
  setQuery,
  loading,
  debounced,
  targetLang,
  onAdded,
}: {
  query: string;
  setQuery: (q: string) => void;
  loading: boolean;
  debounced: string;
  targetLang: string;
  /** Re-run the search after a custom entry is added so it shows up. */
  onAdded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // Surface the "add it yourself" affordance once a query has clearly
  // come up empty (debounced + not loading); otherwise keep a quieter
  // proactive entry point so power users can pre-seed words.
  const noMatch = debounced.length > 0 && !loading;
  return (
    <div className="flex h-full items-start justify-center px-6 py-16 sm:py-24">
      <div className="w-full max-w-xl space-y-4 text-center">
        <div>
          <h2 className="font-serif text-3xl tracking-tight">
            Dictionary search
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Type a word, reading, or part of a meaning to look it up in your
            installed {targetLang.toUpperCase()} dictionary.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-sm focus-within:border-foreground/40 focus-within:ring-2 focus-within:ring-foreground/15">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`e.g. ${
              targetLang === "zh"
                ? "你好 or nihao"
                : targetLang === "ja"
                  ? "こんにちは"
                  : "hello"
            }`}
            className="flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <p className="text-[12px] text-muted-foreground">
          {loading ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" /> Searching…
            </span>
          ) : debounced ? (
            <>
              No matches for{" "}
              <span className="font-medium text-foreground">
                “{debounced}”
              </span>
              . Try a different form, the reading, or part of the gloss.
            </>
          ) : (
            "Or use the search box in the sidebar — both stay in sync."
          )}
        </p>

        <div className="pt-1">
          <Button
            variant={noMatch ? "default" : "outline"}
            size="sm"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="size-3.5" />
            {noMatch ? `Add “${debounced}” to your dictionary` : "Add a custom word"}
          </Button>
        </div>
      </div>

      <AddCustomWordDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        initialWord={debounced}
        onAdded={onAdded}
      />
    </div>
  );
}
