import { useEffect, useRef, useState } from "react";
import { ArrowRight, BookOpen, Loader2, Search } from "lucide-react";
import { DictionariesSection } from "@/components/settings/dictionaries-section";
import { PersonalDictSection } from "@/components/settings/personal-dict-section";
import { Pinyin } from "@/components/pinyin";
import { GlossList, parseGlossSenses } from "@/components/gloss-list";
import { searchDict, type DictEntry } from "@/lib/db";
import { useSearch } from "@/lib/search-context";
import { useWorkspace } from "@/lib/workspace-context";
import { navigateToTab } from "@/lib/nav-event";
import { prettyPinyin } from "@/lib/pinyin";
import { cn } from "@/lib/utils";

export function DictionariesView() {
  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl space-y-10">
        <div>
          <h1 className="font-serif text-3xl tracking-tight">Dictionaries</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            Lookups feed the click-to-define popover, the search bar, and
            the vocabulary extractor. Type in the box below to look up a
            word, or manage installed packs further down. Packs for other
            languages live in{" "}
            <span className="font-medium text-foreground">
              Settings → Dictionaries
            </span>
            .
          </p>
        </div>

        <DictionarySearch />

        {/* Workspace scope — only shows the pack for the active target
            language. The full multi-language catalog is in Settings. */}
        <DictionariesSection scope="workspace" />
        <PersonalDictSection />
      </div>
    </div>
  );
}

// ─── Inline dictionary search ────────────────────────────────────────────
//
// Centred search bar at the top of the dictionaries page so the user
// can run a quick lookup without bouncing through the Ctrl+K modal or
// the Search tab. Hits the same `searchDict` helper everything else
// uses; clicking a result hands off to the SearchProvider + Search tab
// so the user lands on the full detail page.

function DictionarySearch() {
  const { active: workspace } = useWorkspace();
  const search = useSearch();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<DictEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounce → keeps typing smooth while still trimming network calls.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!workspace) return;
    if (!debounced) {
      setResults([]);
      setSelected(0);
      return;
    }
    let cancelled = false;
    setLoading(true);
    searchDict(workspace.targetLang, debounced, 50)
      .then((rows) => {
        if (!cancelled) {
          setResults(rows);
          setSelected(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, workspace?.id, workspace?.targetLang]);

  function pick(entry: DictEntry) {
    // Hand the entry to the global SearchProvider so the Search tab
    // shows the detail view immediately on arrival, then route there.
    search.setQuery(entry.word);
    search.setActive(entry);
    navigateToTab("search");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(0, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = results[selected];
      if (entry) pick(entry);
    }
  }

  if (!workspace) return null;

  const showResults = debounced.length > 0;

  return (
    <section className="rounded-2xl border border-border bg-card/60 p-5 shadow-sm">
      <div className="mx-auto max-w-2xl space-y-4">
        <label
          htmlFor="dict-search"
          className="block text-center text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
        >
          Look up a word
        </label>
        <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-3 shadow-sm focus-within:border-foreground/40 focus-within:ring-2 focus-within:ring-foreground/15">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            id="dict-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Search the ${workspace.targetLang.toUpperCase()} dictionary…`}
            className="flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>

        {showResults && (
          <ul className="space-y-1.5">
            {results.length === 0 && !loading ? (
              <li className="rounded-lg border border-dashed border-border bg-background/40 px-4 py-6 text-center text-[13px] text-muted-foreground">
                No matches for{" "}
                <span className="font-medium text-foreground">
                  “{debounced}”
                </span>
                . Try a simpler form, the reading, or part of the gloss.
              </li>
            ) : (
              results.map((entry, idx) => {
                const reading = prettyPinyin(entry.reading);
                const senses = parseGlossSenses(entry.gloss);
                const isSel = idx === selected;
                return (
                  <li key={`${entry.word}-${idx}`}>
                    <button
                      type="button"
                      onClick={() => pick(entry)}
                      onMouseEnter={() => setSelected(idx)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-lg border bg-background/60 px-4 py-3 text-left transition-colors",
                        isSel
                          ? "border-foreground/30 bg-accent shadow-sm"
                          : "border-border/60 hover:bg-accent/40",
                      )}
                    >
                      <BookOpen className="mt-1 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="font-serif text-[18px] font-medium leading-tight">
                            {entry.word}
                          </span>
                          {entry.altWord && entry.altWord !== entry.word && (
                            <span className="text-[12px] text-muted-foreground">
                              {entry.altWord}
                            </span>
                          )}
                          {reading && (
                            <Pinyin
                              raw={entry.reading}
                              className="text-[12px]"
                            />
                          )}
                        </div>
                        <div className="mt-1">
                          {senses.length > 0 ? (
                            <GlossList gloss={entry.gloss} inline />
                          ) : (
                            <span className="text-[12.5px] text-muted-foreground">
                              {entry.gloss}
                            </span>
                          )}
                        </div>
                      </div>
                      <ArrowRight
                        className={cn(
                          "mt-1 size-4 shrink-0",
                          isSel ? "text-foreground/70" : "text-muted-foreground/60",
                        )}
                      />
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}

        {!showResults && (
          <p className="text-center text-[11.5px] text-muted-foreground">
            Tip: <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px]">↑↓</kbd>{" "}
            to navigate,{" "}
            <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px]">↵</kbd>{" "}
            to open the detail page.
          </p>
        )}
      </div>
    </section>
  );
}
