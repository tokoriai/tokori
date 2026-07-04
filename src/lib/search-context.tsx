import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { searchDict, type DictEntry } from "./db";
import { useWorkspace } from "./workspace-context";

type SearchContextValue = {
  query: string;
  setQuery: (q: string) => void;
  debounced: string;
  results: DictEntry[];
  loading: boolean;
  active: DictEntry | null;
  setActive: (e: DictEntry | null) => void;
  clear: () => void;
  /** Re-run the current search against the dictionary — used after the
   *  user adds a custom entry so it shows up without retyping. */
  refresh: () => void;
  isActive: boolean;
};

const SearchContext = createContext<SearchContextValue | null>(null);

export function SearchProvider({ children }: { children: ReactNode }) {
  const { active: workspace } = useWorkspace();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<DictEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<DictEntry | null>(null);
  // Bumped by `refresh()` to force the search effect to re-run the same
  // query (e.g. after a custom entry is added to the personal dict).
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    if (!workspace) return;
    if (!debounced) {
      setResults([]);
      setActive(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    searchDict(workspace.targetLang, debounced, 100)
      .then((rows) => {
        if (cancelled) return;
        setResults(rows);
        setActive(rows[0] ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, workspace?.id, workspace?.targetLang, reloadNonce]);

  const refresh = useCallback(() => setReloadNonce((n) => n + 1), []);

  function clear() {
    setQuery("");
    setActive(null);
  }

  const isActive = query.trim().length > 0;

  return (
    <SearchContext.Provider
      value={{
        query,
        setQuery,
        debounced,
        results,
        loading,
        active,
        setActive,
        clear,
        refresh,
        isActive,
      }}
    >
      {children}
    </SearchContext.Provider>
  );
}

export function useSearch() {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error("useSearch must be used inside SearchProvider");
  return ctx;
}
