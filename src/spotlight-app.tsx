/**
 * Spotlight popup UI.
 *
 * Loaded into a small frameless always-on-top webview window when the
 * user hits the global Ctrl/Cmd+Shift+F shortcut (registered by the
 * Tauri side when the Global Search feature is enabled).
 *
 * The whole point of this surface is to be summonable from anywhere in
 * the OS without disturbing the focused app — type a word, see
 * dictionary matches, hit Enter to open the full detail page in the
 * main Tokori window.
 *
 * Why it's not the same React tree as <App />:
 *   • We don't need profile / cloud / TTS / chat-list providers — just
 *     a workspace lookup and the dict search.
 *   • A second mount of all the providers would slow the spotlight
 *     down (its main job is to feel instant) and double-subscribe
 *     to upstream events.
 *
 * It still shares localStorage + the SQLite DB with the main window
 * (same Tauri origin), so the active-workspace selection always lines
 * up with what the user sees in the main app.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowRight, BookOpen, Loader2, Search } from "lucide-react";
import {
  listWorkspaces,
  searchDict,
  type DictEntry,
  type Workspace,
} from "@/lib/db";
import { prettyPinyin } from "@/lib/pinyin";
import { cn } from "@/lib/utils";

const ACTIVE_ID_KEY = "polyglot.activeWorkspaceId";

// The popup's window is sized once on the Rust side to fit the maximum
// useful card height (header + ~12 result rows + footer). The card
// itself sits flush at the top with `items-start`, so the rest of the
// transparent window is just empty space — invisible to the user.
// Anything beyond MAX_VISIBLE_RESULTS scrolls inside the list.
const RESULT_ROW_HEIGHT = 44; // each result li (px-3 py-2.5 + line-height)
const MAX_VISIBLE_RESULTS = 12;

export function SpotlightApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<DictEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Resolve the active workspace from shared state (localStorage),
  // mirroring the main app's WorkspaceProvider logic.
  useEffect(() => {
    void (async () => {
      const all = await listWorkspaces();
      const raw = localStorage.getItem(ACTIVE_ID_KEY);
      const id = raw ? Number(raw) : null;
      setWorkspace(all.find((w) => w.id === id) ?? all[0] ?? null);
    })();
  }, []);

  // Wipe the previous summon's query / results / selection. Called on
  // hide (the cheap path — by the time the window is re-shown, state
  // is already clean) AND on the post-show event as belt-and-braces
  // for any path that hid the window without going through close()/onBlur.
  const resetState = useCallback(() => {
    setQuery("");
    setDebounced("");
    setResults([]);
    setSelected(0);
  }, []);

  // Auto-focus the input on initial mount AND every time the window
  // is re-shown via the global shortcut. We listen on three sources
  // to cover every summon path:
  //   1. `tokori:spotlight-shown` — emitted by Rust ~500ms after
  //      show (end of the focus dance). Late, but reliable: by the
  //      time it fires the WM has finished mapping/focusing the
  //      window, so grabbing DOM focus on the input is rock solid.
  //   2. `window.focus` — fires when the webview gets focus naturally.
  //      Useful on macOS / Windows where the Rust event isn't strictly
  //      needed but doesn't hurt.
  //   3. A short setTimeout chain on mount as belt-and-suspenders for
  //      the very first summon (window just created, before the Rust
  //      delayed-focus fires).
  // Each refocus also wipes leftover state — defensive only, since
  // close()/onBlur already do this when the window is hidden.
  useEffect(() => {
    function refocus() {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    function freshOpen() {
      resetState();
      refocus();
    }
    refocus();
    const t1 = setTimeout(refocus, 50);
    const t2 = setTimeout(refocus, 200);
    window.addEventListener("focus", refocus);

    let unlistenShown: (() => void) | undefined;
    void listen("tokori:spotlight-shown", freshOpen).then((fn) => {
      unlistenShown = fn;
    });

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("focus", refocus);
      unlistenShown?.();
    };
  }, [resetState]);

  // Dismiss-on-blur: when the spotlight window loses keyboard focus
  // (user clicked another app, or the desktop), hide it. This is the
  // standard "click outside the popup to close" behaviour for native
  // spotlight UIs — the window itself takes the focus loss as the
  // signal, so we don't need to install a global click listener.
  //
  // The `tokori:spotlight-shown` listener above re-focuses the <input>
  // each time the window is re-summoned, so closing on blur doesn't
  // leave us in a state where the user can't type next time.
  //
  // A small grace period at the top guards against the very first
  // summon: between window creation and the WM granting it keyboard
  // focus, a transient blur sometimes fires. Without this, the popup
  // would appear and immediately close before the user could type.
  useEffect(() => {
    let armed = false;
    const armT = setTimeout(() => {
      armed = true;
    }, 250);
    function onBlur() {
      if (!armed) return;
      // Wipe state BEFORE hiding so the next summon starts clean —
      // without this the user briefly sees the previous query +
      // results until the post-show event fires (~500ms later).
      resetState();
      void invoke("hide_spotlight");
    }
    function onWindowFocus() {
      // Re-arm on every fresh focus event so subsequent summons get
      // the same grace period as the initial one.
      armed = false;
      setTimeout(() => {
        armed = true;
      }, 250);
    }
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      clearTimeout(armT);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [resetState]);

  // Debounced query → search call.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 120);
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
    searchDict(workspace.targetLang, debounced, 30)
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
    // Hand the chosen word to the main window. The Tauri command
    // hides the spotlight, brings Tokori forward, and emits an
    // event so the main shell opens the search detail.
    void invoke("focus_main_with_query", { query: entry.word });
  }

  function close() {
    resetState();
    void invoke("hide_spotlight");
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
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  // Frameless transparent window — paint our own card so the visible
  // bounds match the rounded corner radius. The body is set to
  // background:transparent in index.css fallback; here the outer card
  // owns the visible surface.
  //
  // The outer wrapper also handles "click on the empty area inside
  // the spotlight window" (the transparent strip below the card).
  // Clicks that bubble all the way up to it without being caught by
  // the card itself are treated as a request to close — same UX as
  // macOS Spotlight / Raycast. e.target === e.currentTarget filters
  // out clicks that originated inside the card and bubbled up via
  // some shared handler.
  //
  // Compositing hints on the wrapper (rgba(0,0,0,0.001) bg, isolate,
  // transform-gpu, contain:paint) exist to force WebKit2GTK on Linux
  // to allocate + clear a full-window backing layer every frame.
  // Without them, when the card shrinks (e.g. results list collapses
  // from 12 rows to 1), the previously-painted larger card's pixels
  // stay visible below the new smaller card — the bg-transparent
  // wrapper was a "skip paint" hint the compositor would drop on
  // transparent + frameless + always-on-top windows.
  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="isolate flex h-screen w-screen transform-gpu items-start justify-center p-1 [contain:paint]"
      style={{ backgroundColor: "rgba(0,0,0,0.001)" }}
    >
      <div
        className="w-full overflow-hidden rounded-2xl border border-border bg-card/95 shadow-2xl backdrop-blur-xl"
      >
        <div
          data-tauri-drag-region
          className="flex items-center gap-2 border-b border-border/60 px-4 py-3"
        >
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              workspace
                ? `Search the ${workspace.targetLang.toUpperCase()} dictionary…`
                : "No active workspace"
            }
            className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
          />
          {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        {debounced.length > 0 && (
          // max-h holds 12 rows visible; anything beyond scrolls inside
          // this list rather than overflowing the window.
          <ul
            className="overflow-y-auto p-1"
            style={{
              maxHeight: `${MAX_VISIBLE_RESULTS * RESULT_ROW_HEIGHT}px`,
            }}
          >
            {results.length === 0 && !loading ? (
              <li className="px-3 py-3 text-center text-[12.5px] text-muted-foreground">
                No matches for{" "}
                <span className="font-medium text-foreground">“{debounced}”</span>.
              </li>
            ) : (
              results.map((entry, idx) => {
                const reading = prettyPinyin(entry.reading);
                const isSel = idx === selected;
                return (
                  <li
                    key={`${entry.word}-${idx}`}
                    onClick={() => pick(entry)}
                    onMouseEnter={() => setSelected(idx)}
                    className={cn(
                      // Soft grey selection — subtle accent fill plus
                      // a thin foreground ring on the active row so it
                      // reads clearly in light mode without the harsh
                      // black inversion.
                      "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 text-[13px] transition-colors",
                      isSel
                        ? "bg-accent ring-1 ring-foreground/30"
                        : "hover:bg-accent/40",
                    )}
                  >
                    <BookOpen className="size-3.5 text-muted-foreground" />
                    <span className="font-serif text-[15px] font-medium leading-none">
                      {entry.word}
                    </span>
                    {reading && (
                      <span className="text-[11.5px] text-muted-foreground/80">
                        {reading}
                      </span>
                    )}
                    <span className="ml-2 truncate text-[12px] text-muted-foreground">
                      {entry.gloss}
                    </span>
                    {isSel && (
                      <ArrowRight className="ml-auto size-3.5 text-foreground/60" />
                    )}
                  </li>
                );
              })
            )}
          </ul>
        )}
        <div className="flex items-center gap-3 border-t border-border/60 bg-muted/30 px-4 py-2 text-[10.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px]">
              ↑↓
            </kbd>
            navigate
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px]">
              ↵
            </kbd>
            open
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px]">
              Esc
            </kbd>
            close
          </span>
          <span className="ml-auto">Tokori spotlight</span>
        </div>
      </div>
    </div>
  );
}
