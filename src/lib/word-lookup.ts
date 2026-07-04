/**
 * Shared word-lookup cache for click-to-define.
 *
 * Every `Tokenized` run (one per chat bubble, note, reader line…) needs the
 * dictionary entry + vocab status for each word it renders. Previously each
 * one fired its own `lookupDictBatch` / `lookupVocabBatch`, so a screen full
 * of bubbles re-looked-up the same words many times over — on desktop that's
 * repeated SQLite scans (the slow-query warnings), on the cloud it's a POST
 * per bubble. This module collapses all of that:
 *
 *   • A microtask-coalescing batch loader: every word requested in the same
 *     tick — across all components on screen — folds into ONE batch call per
 *     scope, and identical in-flight words share a single promise.
 *   • Dictionary entries are immutable, so they're cached for the session:
 *     each (lang, word) is fetched at most once. Misses are cached too, so a
 *     word that isn't in the dict isn't re-queried on every render.
 *   • Vocab status is mutable (the user marks words known/unknown), so it is
 *     NOT cached long-term — only coalesced within a tick. Every render reads
 *     a fresh status, so the known/unknown underline never goes stale.
 *
 * The cache lives in the shared code path (it wraps `lookupDictBatch`, which
 * already branches desktop-SQLite vs cloud-HTTP internally), so both builds
 * benefit — the cloud especially, since it turns a flood of batch-lookup
 * POSTs into a handful.
 */

import {
  lookupDictBatch,
  lookupVocabBatch,
  type DictEntry,
  type VocabStatus,
} from "@/lib/db";

// Chunk size for a coalesced batch. The cloud's /dict/batch-lookup rejects
// >200 words (413), and SQLite has a 999-bound-parameter ceiling — 180 keeps
// us comfortably under both even after many bubbles fold into one flush.
const CHUNK = 180;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function scoped<T>(map: Map<string, Map<string, T>>, scope: string): Map<string, T> {
  let inner = map.get(scope);
  if (!inner) {
    inner = new Map();
    map.set(scope, inner);
  }
  return inner;
}

/**
 * Build a coalescing batch loader. `scope` partitions the keyspace (a language
 * code for dictionaries, a workspace id for vocab). With `persist`, resolved
 * values are kept for the session; without it, the loader only dedupes within
 * a tick and re-fetches afterwards.
 */
function makeLoader<V>(
  fetchBatch: (scope: string, items: string[]) => Promise<Map<string, V>>,
  persist: boolean,
) {
  const cache = new Map<string, Map<string, V | null>>();
  const inflight = new Map<string, Map<string, Deferred<V | null>>>();
  const queue = new Map<string, Set<string>>();
  let scheduled = false;

  async function flush(): Promise<void> {
    scheduled = false;
    for (const scope of Array.from(queue.keys())) {
      const items = Array.from(queue.get(scope) ?? []);
      queue.delete(scope);
      if (items.length === 0) continue;
      const pending = inflight.get(scope);
      const store = persist ? scoped(cache, scope) : null;
      for (let i = 0; i < items.length; i += CHUNK) {
        const chunk = items.slice(i, i + CHUNK);
        let found: Map<string, V>;
        try {
          found = await fetchBatch(scope, chunk);
        } catch {
          found = new Map();
        }
        for (const item of chunk) {
          const value = found.get(item) ?? null;
          if (store) store.set(item, value);
          pending?.get(item)?.resolve(value);
          pending?.delete(item);
        }
      }
    }
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      void flush();
    });
  }

  function one(scope: string, item: string): Promise<V | null> {
    if (persist) {
      const store = cache.get(scope);
      if (store?.has(item)) return Promise.resolve(store.get(item) ?? null);
    }
    const pending = scoped(inflight, scope);
    const existing = pending.get(item);
    if (existing) return existing.promise;
    const d = defer<V | null>();
    pending.set(item, d);
    let waiting = queue.get(scope);
    if (!waiting) {
      waiting = new Set();
      queue.set(scope, waiting);
    }
    waiting.add(item);
    schedule();
    return d.promise;
  }

  async function load(scope: string, items: string[]): Promise<Map<string, V>> {
    const out = new Map<string, V>();
    await Promise.all(
      items.map(async (item) => {
        const value = await one(scope, item);
        if (value != null) out.set(item, value);
      }),
    );
    return out;
  }

  function invalidate(scope?: string): void {
    if (scope == null) cache.clear();
    else cache.delete(scope);
  }

  return { load, invalidate };
}

const dictLoader = makeLoader<DictEntry>(
  (lang, words) => lookupDictBatch(lang, words),
  true,
);

const vocabLoader = makeLoader<VocabStatus>(async (scope, words) => {
  const rows = await lookupVocabBatch(Number(scope), words);
  const out = new Map<string, VocabStatus>();
  for (const [word, entry] of rows) out.set(word, entry.status);
  return out;
}, false);

/** Dictionary entries for `words`, deduped + session-cached. Returns a map of
 *  hits only (a missing key means "not in the dictionary") — same shape as
 *  `lookupDictBatch`, so it's a drop-in replacement. */
export function lookupDictCached(
  lang: string,
  words: string[],
): Promise<Map<string, DictEntry>> {
  return dictLoader.load(lang, words);
}

/** Vocab status for `words` in a workspace, coalesced per tick but always
 *  fetched fresh (status changes when the user marks a word, and the
 *  underline must reflect that immediately on the next render). */
export function lookupVocabStatus(
  workspaceId: number,
  words: string[],
): Promise<Map<string, VocabStatus>> {
  return vocabLoader.load(String(workspaceId), words);
}

/** Drop cached dictionary entries (all langs, or one). Call after a dict is
 *  installed/removed or a personal-dict entry is added, so freshly-available
 *  words stop resolving to their previously-cached miss. */
export function invalidateDictLookupCache(lang?: string): void {
  dictLoader.invalidate(lang);
}
