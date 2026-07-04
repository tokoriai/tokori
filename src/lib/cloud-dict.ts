/**
 * Cloud dictionary client. Only loaded in HOSTED builds — see the
 * `if (HOSTED)` guards at every call site in `db.ts` and
 * `dict-availability.ts`. The desktop bundle never imports this
 * module's behaviour because terser dead-strips the `if (HOSTED)`
 * blocks (HOSTED is a build-time constant from `build-flags.ts`).
 *
 * Endpoint contract (kept in sync with tokori-cloud/src/app/api/v1/dict):
 *   - GET  /api/v1/dict/languages
 *   - GET  /api/v1/dict/search?lang=&q=&limit=
 *   - POST /api/v1/dict/batch-lookup  { lang, words }
 *
 * No auth: dictionaries are shared static data. The cloud caches
 * responses at the CDN edge so the hot path is fast.
 */

import { CLOUD_API_BASE as API_BASE } from "@/lib/build-flags";
import type { DictEntry } from "@/lib/db";
import { invalidateDictionaryAvailabilityCache } from "@/lib/dict-availability";

// ── Languages ────────────────────────────────────────────────────────

type LanguagesResponse = {
  langs: string[];
  packs: {
    id: number;
    lang: string;
    name: string;
    version: string | null;
    entryCount: number;
    installedAt: number;
  }[];
};

let languagesCache: Promise<LanguagesResponse> | null = null;
// When the response says "no langs", we keep the cache but expire it
// fast so the banner doesn't stay stuck on "install a dict" if the
// operator seeds while the app is open. A successful response with
// langs is cached for the page lifetime — those don't appear and
// disappear at runtime.
const EMPTY_TTL_MS = 30_000;
let emptyCachedAt: number | null = null;

function fetchLanguages(): Promise<LanguagesResponse> {
  // Refresh an empty result after EMPTY_TTL_MS so a seed-mid-session
  // becomes visible without a page reload.
  if (
    languagesCache &&
    emptyCachedAt != null &&
    Date.now() - emptyCachedAt > EMPTY_TTL_MS
  ) {
    languagesCache = null;
    emptyCachedAt = null;
  }
  if (!languagesCache) {
    languagesCache = (async () => {
      const r = await fetch(`${API_BASE}/api/v1/dict/languages`);
      if (!r.ok) {
        // Don't poison the cache on a one-off failure — a dropped
        // request shouldn't make the banner permanently lie about
        // "no dict installed" until the user reloads. Throw so the
        // caller's catch falls back to "empty set".
        languagesCache = null;
        throw new Error(`languages: HTTP ${r.status}`);
      }
      const body = (await r.json()) as LanguagesResponse;
      emptyCachedAt = body.langs.length === 0 ? Date.now() : null;
      return body;
    })();
  }
  return languagesCache;
}

/** Returns the set of languages with at least one populated dictionary
 *  on the server. Cached for the lifetime of the page; callers wanting
 *  fresh state should reload (this list rarely changes — a new pack
 *  is an operator-side action). */
export async function cloudDictLanguages(): Promise<Set<string>> {
  try {
    const { langs } = await fetchLanguages();
    return new Set(langs);
  } catch {
    // Conservative fallback: assume nothing installed, so the
    // banner / install hint surfaces. Better than pretending
    // dictionaries exist when they don't.
    return new Set();
  }
}

/** Drop the cached `langs` list. Called from the cache-bust paths
 *  in `cloudDictSearch` / `cloudDictBatchLookup` when a hit proves
 *  the dict really is seeded (so the banner can clear immediately)
 *  and after operator-side admin flows. We also nudge the shared
 *  `dict-availability` hook through its own invalidate channel so
 *  every consumer (banner, popover, onboarding) re-resolves. */
export function invalidateCloudDictLanguagesCache(): void {
  if (languagesCache == null) return;
  languagesCache = null;
  emptyCachedAt = null;
  invalidateDictionaryAvailabilityCache();
}

// ── Search ───────────────────────────────────────────────────────────

export async function cloudDictSearch(
  lang: string,
  query: string,
  limit = 50,
): Promise<DictEntry[]> {
  if (!query.trim()) return [];
  // When API_BASE is "" (same-origin / app:build) the concatenated
  // string starts with `/`, which `new URL(s)` rejects as relative.
  // Fall back to window.location.origin so the URL constructor sees
  // a valid absolute base.
  const url = new URL(
    `${API_BASE}/api/v1/dict/search`,
    API_BASE ||
      (typeof window !== "undefined" ? window.location.origin : undefined),
  );
  url.searchParams.set("lang", lang);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`dict search: HTTP ${r.status}`);
  const data = (await r.json()) as { results: DictEntry[] };
  // A non-empty search result proves the dict is seeded — if a
  // previous /languages fetch lied about that (e.g. seeded after
  // the app loaded), bust the cache so the banner / availability
  // hook re-resolve next time.
  if (data.results.length > 0) {
    invalidateCloudDictLanguagesCache();
  }
  return data.results;
}

// ── Batch lookup ─────────────────────────────────────────────────────

export async function cloudDictBatchLookup(
  lang: string,
  words: string[],
): Promise<Map<string, DictEntry | null>> {
  const unique = Array.from(new Set(words.filter((w) => w.length > 0)));
  if (unique.length === 0) return new Map();
  const r = await fetch(`${API_BASE}/api/v1/dict/batch-lookup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lang, words: unique }),
  });
  if (!r.ok) throw new Error(`dict batch lookup: HTTP ${r.status}`);
  const data = (await r.json()) as { results: Record<string, DictEntry | null> };
  const out = new Map<string, DictEntry | null>();
  for (const w of unique) out.set(w, data.results[w] ?? null);
  // Same cache-bust as cloudDictSearch — any hit proves the dict is
  // actually seeded; refresh availability so the banner clears.
  if (Object.values(data.results).some((v) => v != null)) {
    invalidateCloudDictLanguagesCache();
  }
  return out;
}

// ── Tokenize ────────────────────────────────────────────────────────

/** Server-side tokenizer for languages where the browser's
 *  `Intl.Segmenter` falls short (most importantly Chinese — jieba's
 *  word boundaries materially improve click-to-define + pinyin
 *  alignment). The cloud's `/api/v1/tokenize` does max-match
 *  segmentation over the shared dict and returns the same
 *  `{text, is_word}[]` shape the desktop's `tokenize_zh` Tauri
 *  command does, so the caller stays identical across builds. */
export async function cloudTokenize(
  lang: string,
  text: string,
): Promise<{ text: string; isWord: boolean }[]> {
  if (!text) return [];
  const r = await fetch(`${API_BASE}/api/v1/tokenize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lang, text }),
  });
  if (!r.ok) throw new Error(`tokenize: HTTP ${r.status}`);
  const data = (await r.json()) as {
    tokens: { text: string; isWord: boolean }[];
  };
  return data.tokens;
}
