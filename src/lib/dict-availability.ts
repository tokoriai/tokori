/**
 * Shared "is there a real dictionary for this language?" check.
 *
 * A language counts as "set up" only when at least one installed
 * dictionary for it has entries. The DB also holds two empty rows that
 * look installed but aren't usable — the per-language Personal dict
 * (entry_count = 0 until the user adds something) and any pack the
 * user added but never finished downloading. Those shouldn't suppress
 * the install nudge.
 *
 * The cache is module-level so every consumer (popover, banner,
 * onboarding) shares one in-flight request and one invalidation point.
 */

import { useEffect, useState } from "react";
import { HOSTED } from "@/lib/build-flags";
import { cloudDictLanguages } from "@/lib/cloud-dict";
import { listDictionaries, type Dictionary } from "@/lib/db";
import type { LanguageCode } from "@/lib/languages";

/** Pure: derive the set of "set up" languages from a dictionary list.
 *  Exposed for testing — the cache + hook below layer state on top. */
export function languagesWithRealDictionary(
  dicts: readonly Dictionary[],
): Set<string> {
  // entryCount > 0 filters out the per-language Personal placeholder
  // and any pack that was inserted but never finished downloading.
  return new Set(dicts.filter((d) => d.entryCount > 0).map((d) => d.lang));
}

let dictListCache: Promise<Set<string>> | null = null;
// Bumped on every cache invalidation. The hook depends on this so it
// re-reads from the (newly-empty) cache after an install or removal,
// without us having to thread per-consumer callbacks around. Standard
// observable-store pattern: one source of truth, many subscribers.
const listeners = new Set<() => void>();

function loadInstalledLangs(): Promise<Set<string>> {
  if (!dictListCache) {
    // HOSTED: resolve against the cloud's `/api/v1/dict/languages`.
    // Dictionaries are shared static data — they live server-side
    // and every user gets the same list. The cloud-dict module
    // already memoizes its fetch, so we layer no extra cache here
    // beyond the local Promise we hand out.
    if (HOSTED) {
      dictListCache = cloudDictLanguages().catch(() => new Set<string>());
    } else {
      dictListCache = listDictionaries()
        .then(languagesWithRealDictionary)
        .catch(() => new Set<string>());
    }
  }
  return dictListCache;
}

/** Drop the cache and notify every subscribed `useHasDictionary` hook
 *  so the new state propagates without a reload. Wire this into
 *  install / uninstall paths. */
export function invalidateDictionaryAvailabilityCache(): void {
  dictListCache = null;
  for (const fn of listeners) fn();
}

/** Returns null while the first listDictionaries call is in flight —
 *  callers should treat null as "don't show a hint yet" so the UI
 *  doesn't flash a spurious "no dictionary" message during boot.
 *  Re-resolves automatically when the cache is invalidated, so a
 *  successful install elsewhere in the app flips this to `true`. */
export function useHasDictionary(lang: LanguageCode | null | undefined): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  // Bumped via the subscription below to force a re-read after a
  // cache invalidation. Doesn't surface in the rendered output.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const onInvalidate = () => setRevision((r) => r + 1);
    listeners.add(onInvalidate);
    return () => {
      listeners.delete(onInvalidate);
    };
  }, []);

  useEffect(() => {
    if (!lang) {
      setHas(null);
      return;
    }
    let cancelled = false;
    void loadInstalledLangs().then((langs) => {
      if (!cancelled) setHas(langs.has(lang));
    });
    return () => {
      cancelled = true;
    };
  }, [lang, revision]);
  return has;
}
