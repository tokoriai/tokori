import { BookOpen, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { HOSTED } from "@/lib/build-flags";
import { useHasDictionary } from "@/lib/dict-availability";
import { languageName } from "@/lib/languages";
import { navigateToTab } from "@/lib/nav-event";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";

const DISMISS_KEY = "tokori.missingDictBanner.dismissed";

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function persistDismissed(set: Set<string>): void {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...set]));
  } catch {
    /* private mode / quota — ignore */
  }
}

/**
 * Slim sticky banner that nudges the user to install a dictionary for
 * the active workspace's target language. Click-to-define popovers,
 * dictionary search, the vocab extractor, and the SRS card editor all
 * degrade without one — the banner is the single visible thread tying
 * those degraded states back to a fix.
 *
 * Renders nothing while:
 *   - no active workspace yet (onboarding handles its own prompt),
 *   - the availability check is still in flight (avoids a boot flash —
 *     `useHasDictionary` returns null in that tri-state),
 *   - a real dictionary is installed for the target language, or
 *   - the user has dismissed it for this workspace + language pair.
 *
 * Dismissal is keyed on (workspaceId, targetLang) so the banner does
 * come back if the user switches to a workspace that still lacks one.
 * It's persisted to localStorage so the dismissal survives reloads,
 * which matches every other persistent UI choice in the app.
 */
export function MissingDictionaryBanner() {
  const { active } = useWorkspace();
  const has = useHasDictionary(active?.targetLang ?? null);
  // In HOSTED mode the dictionary lives cloud-side and is shared
  // across every user — there's nothing for the user to install,
  // and clicking through to the Dictionaries view would dead-end
  // on copy that talks about local SQLite files. The banner is a
  // desktop-only nudge.
  const dismissKey = active ? `${active.id}:${active.targetLang}` : null;
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);

  const dismiss = useCallback(() => {
    if (!dismissKey) return;
    setDismissed((prev) => {
      if (prev.has(dismissKey)) return prev;
      const next = new Set(prev);
      next.add(dismissKey);
      persistDismissed(next);
      return next;
    });
  }, [dismissKey]);

  // Re-hydrate when other tabs / windows dismiss the banner so a
  // multi-window Tauri build stays consistent. Cheap listener — only
  // fires on real storage writes.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === DISMISS_KEY) setDismissed(loadDismissed());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // HOSTED is a desktop-only nudge: in hosted builds dictionaries are
  // server-side + shared, so there's nothing to install — never show.
  // Folded in here (after the hooks) so the hook order is build-stable.
  if (HOSTED || !active || has !== false) return null;
  if (dismissKey && dismissed.has(dismissKey)) return null;

  const target = languageName(active.targetLang);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-3 border-b border-amber-500/30",
        "bg-amber-500/10 px-4 py-2 text-[12.5px] text-amber-800",
        "dark:text-amber-200",
      )}
    >
      <BookOpen className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">No {target} dictionary installed.</span>{" "}
        <span className="text-amber-800/85 dark:text-amber-200/85">
          Click-to-define popovers, search, and vocab extraction won't work
          until you install one.
        </span>
      </span>
      <button
        type="button"
        onClick={() => navigateToTab("dictionaries")}
        className={cn(
          "shrink-0 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1",
          "text-[11.5px] font-medium transition-colors hover:bg-amber-500/25",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60",
        )}
      >
        Install a dictionary →
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={`Dismiss missing-${target}-dictionary banner`}
        title="Dismiss for this workspace"
        className={cn(
          "shrink-0 rounded-md p-1 text-amber-700/80 transition-colors",
          "hover:bg-amber-500/15 hover:text-amber-900",
          "dark:text-amber-300/80 dark:hover:text-amber-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60",
        )}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
