/**
 * Per-workspace study configuration.
 *
 * Persists in the existing `settings` k/v table (keyed by workspace id) so a
 * user studying both Mandarin and German can have totally different SRS
 * limits, default plugins, and reveal styles. Each value comes back to the
 * plugin host as a typed object via `useStudyConfig(workspaceId)`.
 *
 * The defaults are language-aware: a Chinese workspace opens with the
 * "vocab-recall" plugin (character → reveal reading + gloss) and reading
 * hidden until reveal; a German workspace opens with classic two-sided
 * flashcards and the reading shown immediately because there's no
 * separate phonetic system to drill there.
 *
 * Add a new field:
 *   1. Add to `StudyConfig` + `DEFAULT_VALUES`.
 *   2. Add to `KEY_FOR` so persistence works.
 *   3. Surface it in the Study settings section.
 *   4. Plugins read via `useStudyConfig(...)`.
 */

import { useEffect, useState, useCallback } from "react";
import { getSettings, setSetting } from "./db";
import { DEFAULT_SRS_CONFIG, type SRSConfig } from "./fsrs";
import type { LanguageCode } from "./languages";

export type StudyConfig = {
  /** Stable plugin id loaded by default when the user opens Study. */
  defaultPlugin: string;
  /** Cards per day to introduce from `status='new'`. 0 = no new cards today. */
  dailyNewLimit: number;
  /** Reviews per day cap (status='review' or 'learning' that's due). */
  dailyReviewLimit: number;
  /** Read the headword aloud automatically when a card flips. */
  autoplayAudio: boolean;
  /** "hidden" — reveal-on-click; "shown" — show pinyin/romaji from the start. */
  readingMode: "hidden" | "shown";
  /** Show example sentences on the back of the card by default. */
  showExamples: boolean;
  /** Plugin IDs the user has hidden for this workspace. Filtered out
   *  of the picker so users who don't care about (e.g.) handwriting
   *  practice for Chinese can banish the mode without losing it for
   *  other workspaces. Stored as a JSON-encoded string[]. */
  hiddenPlugins: string[];
  /** SRS scheduler knobs — passed straight to fsrs.ts `schedule()`.
   *  Stored as a single JSON-encoded settings row so the whole config
   *  lives or dies as one unit (no half-applied tweaks if the user's
   *  midway through editing). */
  srs: SRSConfig;
};

const KEY = (workspaceId: number, field: keyof StudyConfig) =>
  `workspace.${workspaceId}.study.${field}`;

/** Best per-workspace defaults. Picks "vocab-recall" for CJK languages
 *  (the recognition-style two-step flow); classic Anki for everything
 *  else, since alphabetic scripts don't gain much from hiding the
 *  reading. The user can override any of these in Settings → Study. */
export function defaultsFor(lang: LanguageCode): StudyConfig {
  const cjk = lang === "zh" || lang === "ja" || lang === "ko";
  return {
    // Vocab Recall is the universal spaced-repetition default for every
    // workspace — CJK and Latin scripts alike. (The old per-language
    // "Spaced repetition" / anki-classic default was retired in favour
    // of standardising on one SRS flow.)
    defaultPlugin: "vocab-recall",
    dailyNewLimit: 20,
    dailyReviewLimit: 200,
    autoplayAudio: cjk, // CJK readers benefit more from hearing the word
    readingMode: cjk ? "hidden" : "shown",
    showExamples: true,
    hiddenPlugins: [],
    srs: { ...DEFAULT_SRS_CONFIG, weights: [...DEFAULT_SRS_CONFIG.weights] },
  };
}

async function loadConfig(
  workspaceId: number,
  lang: LanguageCode,
): Promise<StudyConfig> {
  const def = defaultsFor(lang);
  // Single IPC round-trip — `getSettings` does one SQL with IN clause
  // rather than firing one query per field, which on heavy workspaces
  // could pile up enough Win32 PostMessage traffic to break the
  // webview message queue.
  const fields: (keyof StudyConfig)[] = [
    "defaultPlugin",
    "dailyNewLimit",
    "dailyReviewLimit",
    "autoplayAudio",
    "readingMode",
    "showExamples",
    "hiddenPlugins",
    "srs",
  ];
  const got = await getSettings(fields.map((f) => KEY(workspaceId, f)));
  const get = (f: keyof StudyConfig): string | null =>
    got[KEY(workspaceId, f)] ?? null;
  const readingModeRaw = get("readingMode");
  return {
    defaultPlugin: get("defaultPlugin") ?? def.defaultPlugin,
    dailyNewLimit:
      get("dailyNewLimit") != null
        ? Number(get("dailyNewLimit")) || 0
        : def.dailyNewLimit,
    dailyReviewLimit:
      get("dailyReviewLimit") != null
        ? Number(get("dailyReviewLimit")) || 0
        : def.dailyReviewLimit,
    autoplayAudio:
      get("autoplayAudio") != null ? get("autoplayAudio") === "1" : def.autoplayAudio,
    readingMode:
      readingModeRaw === "hidden" || readingModeRaw === "shown"
        ? readingModeRaw
        : def.readingMode,
    showExamples:
      get("showExamples") != null ? get("showExamples") === "1" : def.showExamples,
    hiddenPlugins: parseHiddenPluginsBlob(get("hiddenPlugins")),
    srs: parseSrsBlob(get("srs"), def.srs),
  };
}

/** Parse the JSON-encoded hidden-plugins list. Rejects any non-array
 *  shape and any non-string entries so a corrupt row can't crash the
 *  picker. Returns `[]` for missing / malformed values. */
function parseHiddenPluginsBlob(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** Parse the JSON-encoded `srs` blob and merge it onto the defaults so
 *  fields added after a row was last saved still get sane values
 *  (otherwise loading an older row would yield `undefined` weights /
 *  retention). Reject malformed input outright. */
function parseSrsBlob(raw: string | null, fallback: SRSConfig): SRSConfig {
  if (!raw) return { ...fallback, weights: [...fallback.weights] };
  try {
    const parsed = JSON.parse(raw) as Partial<SRSConfig>;
    if (!parsed || typeof parsed !== "object") return fallback;
    return {
      learningSteps: Array.isArray(parsed.learningSteps)
        ? parsed.learningSteps.map((n) => Number(n) || 0).filter((n) => n > 0)
        : fallback.learningSteps,
      graduatingInterval:
        typeof parsed.graduatingInterval === "number"
          ? parsed.graduatingInterval
          : fallback.graduatingInterval,
      easyInterval:
        typeof parsed.easyInterval === "number"
          ? parsed.easyInterval
          : fallback.easyInterval,
      desiredRetention:
        typeof parsed.desiredRetention === "number"
          ? Math.max(0.7, Math.min(0.99, parsed.desiredRetention))
          : fallback.desiredRetention,
      maximumInterval:
        typeof parsed.maximumInterval === "number"
          ? parsed.maximumInterval
          : fallback.maximumInterval,
      masteredThreshold:
        typeof parsed.masteredThreshold === "number"
          ? parsed.masteredThreshold
          : fallback.masteredThreshold,
      leechThreshold:
        typeof parsed.leechThreshold === "number"
          ? parsed.leechThreshold
          : fallback.leechThreshold,
      leechAction:
        parsed.leechAction === "tag" || parsed.leechAction === "suspend"
          ? parsed.leechAction
          : fallback.leechAction,
      weights:
        Array.isArray(parsed.weights) && parsed.weights.length === fallback.weights.length
          ? parsed.weights.map((n, i) =>
              typeof n === "number" && Number.isFinite(n) ? n : fallback.weights[i],
            )
          : [...fallback.weights],
    };
  } catch {
    return { ...fallback, weights: [...fallback.weights] };
  }
}

async function saveField<K extends keyof StudyConfig>(
  workspaceId: number,
  field: K,
  value: StudyConfig[K],
): Promise<void> {
  let stringified: string;
  if (field === "srs" || field === "hiddenPlugins") {
    stringified = JSON.stringify(value);
  } else if (typeof value === "boolean") {
    stringified = value ? "1" : "0";
  } else {
    stringified = String(value);
  }
  await setSetting(KEY(workspaceId, field), stringified);
}

export function useStudyConfig(
  workspaceId: number | null,
  lang: LanguageCode,
): {
  config: StudyConfig;
  loaded: boolean;
  set: <K extends keyof StudyConfig>(field: K, value: StudyConfig[K]) => Promise<void>;
} {
  const [config, setConfig] = useState<StudyConfig>(() => defaultsFor(lang));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!workspaceId) {
      setConfig(defaultsFor(lang));
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    void loadConfig(workspaceId, lang).then((c) => {
      if (cancelled) return;
      setConfig(c);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, lang]);

  const set = useCallback(
    async <K extends keyof StudyConfig>(field: K, value: StudyConfig[K]) => {
      if (!workspaceId) return;
      setConfig((prev) => ({ ...prev, [field]: value }));
      await saveField(workspaceId, field, value);
    },
    [workspaceId],
  );

  return { config, loaded, set };
}

/** Limit config that disables both daily caps. Custom-scope sessions
 *  (chapter / collection cram via `ctx.customScope`) pass this to
 *  `buildStudySessionQueue` so the whole scope loads — clipping a
 *  40-word chapter to `dailyNewLimit` would defeat "study this
 *  chapter". The user already bounded the session by picking a scope. */
export const UNCAPPED_DAILY_LIMITS: Pick<
  StudyConfig,
  "dailyNewLimit" | "dailyReviewLimit"
> = {
  dailyNewLimit: Infinity,
  dailyReviewLimit: Infinity,
};

/** Cap a vocab queue by the workspace's `dailyNewLimit` /
 *  `dailyReviewLimit`. Plugins call this on session start so the user
 *  isn't drowned in 500 reviews on a backlog day. */
export function applyDailyLimits<T extends { status: string }>(
  cards: T[],
  cfg: Pick<StudyConfig, "dailyNewLimit" | "dailyReviewLimit">,
): T[] {
  const newCards: T[] = [];
  const reviews: T[] = [];
  for (const c of cards) {
    if (c.status === "new") newCards.push(c);
    else reviews.push(c);
  }
  return [
    ...reviews.slice(0, cfg.dailyReviewLimit),
    ...newCards.slice(0, cfg.dailyNewLimit),
  ];
}

/**
 * Build the same study queue the recall plugin builds.
 *
 * Used by both the flashcards plugin AND the dashboard's
 * "X cards due" badge so the two surfaces never disagree on the
 * count. Logic:
 *   1. Start from due cards (reviewed + due-now + new with no due_at).
 *   2. Add `status === "new"` cards that aren't already in `due`.
 *   3. Apply daily review + new limits.
 *
 * Both inputs are typed via duck-typing (just `id` + `status`) so the
 * function works against any vocab-shaped object — the dashboard
 * passes its `VocabEntry[]` arrays through unchanged.
 */
export function buildStudySessionQueue<
  T extends { id: number; status: string },
>(
  due: T[],
  allVocab: T[],
  cfg: Pick<StudyConfig, "dailyNewLimit" | "dailyReviewLimit">,
): T[] {
  const seen = new Set<number>();
  const pool: T[] = [];
  for (const v of due) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    pool.push(v);
  }
  for (const v of allVocab) {
    if (v.status !== "new") continue;
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    pool.push(v);
  }
  return applyDailyLimits(pool, cfg);
}
