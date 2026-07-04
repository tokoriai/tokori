/**
 * Public study-plugin API.
 *
 * A "study plugin" is a self-contained study mode that the user can pick when
 * they open the flashcards screen. Each plugin owns its own UI (a React
 * component) and its own state machine. The framework only:
 *
 *   1. Lists registered plugins, filtered by the active workspace's target lang
 *   2. Mounts the chosen plugin's <StudyView />, passing it a stable `ctx`
 *   3. Refreshes the vocab list when the plugin says it changed something
 *
 * Plugins should treat this file as their stable surface — fields here will
 * not break across minor versions. Internal helpers in /lib/study/* may change.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  Authoring a plugin
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   1. Create a file in `src/lib/study/plugins/<your-plugin>.tsx`.
 *   2. `export default { meta, StudyView } satisfies StudyPlugin`
 *   3. Add the import to `src/lib/study/registry.ts`.
 *   4. (Optional) Restrict to languages via `meta.supportedLangs`.
 *
 * Your StudyView gets:
 *   - `ctx.workspace`         the active workspace
 *   - `ctx.vocab`             the user's full vocab snapshot
 *   - `ctx.dueVocab`          cards FSRS says are due today
 *   - `ctx.reviewVocab(...)`  push an FSRS review back to the DB
 *   - `ctx.setStatus(...)`    set vocab status without disturbing FSRS state
 *   - `ctx.speak(text, lang?)` route audio through the user's TTS provider
 *
 * Keep a plugin focused: pick a queue, render one card at a time, call
 * `ctx.reviewVocab` when the user grades a card, and call `ctx.onSessionEnd`
 * when you're done so the host can show a summary screen.
 */

import { useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { LanguageCode } from "../languages";
import type { Workspace } from "../db";
import { getSetting, setSetting, type VocabEntry, type VocabStatus } from "../db";

export type { LanguageCode, VocabEntry, VocabStatus, Workspace };

/** Display + filtering metadata. The id is the stable identifier — don't change it once shipped. */
export type StudyPluginMeta = {
  /** Stable kebab-case identifier. Persisted in user settings. */
  id: string;
  /** Display name shown in the picker. */
  name: string;
  /** One-liner description shown under the name. */
  description: string;
  /**
   * Workspace target languages where this plugin should appear.
   *
   *   - **Omit / leave empty** for *universal* plugins (work in every language —
   *     e.g. cloze, sentence-mining, simple flashcards).
   *   - **List specific codes** for plugins whose UX only makes sense for those
   *     scripts — e.g. `["zh", "ja"]` for kanji/character production drills.
   *
   * The picker hides plugins automatically when the active workspace's target
   * language isn't in this list. There's no "fallback to English" behaviour —
   * if you don't list a language, the plugin simply doesn't show up there.
   */
  supportedLangs?: LanguageCode[];
  /**
   * Languages where this plugin should be hidden, even if it's universal
   * by default. Lets you ship a globally-applicable mode but exclude it
   * from a specific workspace where a richer alternative exists — e.g.
   * the single-step Anki flip is hidden for Chinese workspaces because
   * the multi-step Vocab Recall flow is strictly better there.
   */
  excludedLangs?: LanguageCode[];
  /** Optional Lucide-style icon component. */
  icon?: ComponentType<{ className?: string }>;
  /** Plugin author for display. */
  author?: string;
};

/** One card the user actually graded during the session. The host renders
 *  these on the SessionSummary screen so the user can see *what* they
 *  studied (not just totals). Fields mirror VocabEntry minus FSRS state
 *  so the summary survives even if the underlying row gets edited later. */
export type ReviewedCardSummary = {
  word: string;
  reading: string | null;
  gloss: string | null;
  grade: Grade;
};

/** Stats handed to the plugin host when a study session ends. */
export type StudySessionStats = {
  cardsReviewed: number;
  durationSecs: number;
  /** Per-grade tally — Anki-style. */
  grades?: { again: number; hard: number; good: number; easy: number };
  /** Per-card breakdown, in grading order. Optional so plugins that
   *  don't track cards individually (pinyin trainer) can still call
   *  onSessionEnd. */
  reviewedCards?: ReviewedCardSummary[];
  /** Free-form per-plugin stats (e.g. typing accuracy). */
  extra?: Record<string, number | string>;
};

/** Subset of FSRS grades — same shape as `lib/fsrs.ts`. */
export type Grade = "again" | "hard" | "good" | "easy";

/**
 * Everything a plugin needs to read state and write changes back. Treat this
 * as the only allowed coupling between plugins and the rest of the app —
 * plugins should NOT import from `lib/db` directly.
 */
export type StudyContext = {
  workspace: Workspace;
  /** All vocab in the workspace (fresh snapshot at session start).
   *  Under a custom scope (see `customScope`), narrowed to the scope's
   *  word list instead. */
  vocab: VocabEntry[];
  /** Subset that FSRS says is due today. Under a custom scope this is
   *  the scope's FULL word list (ordered most-urgent-first) — the
   *  session queue IS the scope, regardless of due dates. */
  dueVocab: VocabEntry[];
  /** Non-null when the session is restricted to a user-bounded pool:
   *  a custom-study cram over one collection's subtree (e.g. a textbook
   *  chapter launched from the Library — `collectionId` set), or the
   *  "study today's cards again" re-run after the daily pass is done
   *  (no `collectionId`). Plugins that apply daily limits should skip
   *  them in this mode — the user bounded the session by picking the
   *  scope, so pass `UNCAPPED_DAILY_LIMITS` to `buildStudySessionQueue`. */
  customScope: { collectionId?: number; name: string } | null;
  /** Non-null when today's SRS pass is done but the day's reviewed
   *  cards can be re-studied as a drill. `start()` swaps the host's
   *  pools to that re-study queue (drill mode comes on with it), so an
   *  "All caught up" screen can offer the re-run instead of dead-ending.
   *  Null while a re-study or custom scope is already active. */
  restudyToday: { count: number; start: () => void } | null;
  /** Push a review back into FSRS scheduling. When `drillMode` is on
   *  the host silently no-ops this call — the plugin still gets the
   *  fulfilled promise so its own session bookkeeping (grade tallies,
   *  card pointer) works the same in both modes. */
  reviewVocab: (cardId: number, grade: Grade) => Promise<void>;
  /** Manually set status without changing FSRS state. Useful for "Mark as known". */
  setStatus: (cardId: number, status: VocabStatus) => Promise<void>;
  /** Speak text through the user's configured TTS provider. */
  speak: (text: string, lang?: string) => Promise<void>;
  /** Mark a session as started in the session tracker (counts toward streak). */
  ensureSessionStarted: (kind: "review" | "writing" | "speaking") => Promise<void>;
  /** Freeze / resume the session clock + auto-idle timer. Call these
   *  when the plugin shows / hides its own pause UI so paused time
   *  doesn't count as study time (the sidebar clock, the idle auto-end,
   *  and the persisted `duration_secs` all honour it). No-ops when no
   *  session is running. */
  pauseSession: () => void;
  resumeSession: () => void;
  /** Bump a per-session counter ("words_seen", "words_saved"). */
  bump: (kind: "words_seen" | "words_saved") => Promise<void>;
  /** Fire when the plugin is done. Pass stats for the summary screen. */
  onSessionEnd: (stats: StudySessionStats) => void;
  /** Host-owned flag — when true, `reviewVocab` is a no-op so the
   *  user can drill cards without poisoning their FSRS schedule.
   *  Plugins read this for chrome (the "drill — no SRS" badge) and
   *  flip it from their prestart screen via `setDrillMode`. */
  drillMode: boolean;
  setDrillMode: (next: boolean) => void;
  /** Has the user already moved their FSRS schedule for this workspace
   *  today? Drives the prestart banner copy + the auto-pre-flip of
   *  `drillMode`. `"unknown"` while the lookup is in flight so the UI
   *  doesn't flicker — plugins should treat it the same as `"free"` for
   *  rendering purposes (i.e. no banner). */
  srsAnchorState: "unknown" | "free" | "alreadyAnchored";
};

/** Props the framework hands a plugin's StudyView. */
export type StudyViewProps = {
  ctx: StudyContext;
};

/** A study plugin is a metadata blob + a React component. That's it.
 *
 * Plugins can OPTIONALLY expose a `Settings` component which the host's
 * settings page mounts under "Settings → Study → <plugin name>". Use
 * `usePluginSetting` (below) for any persistent prefs; that hook
 * namespaces the storage key with the plugin id so two plugins can
 * use the same field name without colliding. */
export type StudyPlugin = {
  meta: StudyPluginMeta;
  StudyView: ComponentType<StudyViewProps>;
  /** Optional settings panel rendered in Settings → Study. The
   *  component receives no props — it should manage its own state via
   *  `usePluginSetting`. */
  Settings?: ComponentType;
};

/**
 * React hook for plugin-owned settings.
 *
 * Reads & writes through the existing per-app `settings` k/v table,
 * with keys auto-namespaced as `plugin.<pluginId>.<key>` so plugins
 * can't accidentally trample on each other (or on the base app's
 * settings keys).
 *
 * The value can be any JSON-serialisable type. Returns:
 *   [value, setValue, loaded]
 *
 * `loaded` flips true after the initial DB read so the consumer can
 * disable form controls until the persisted value lands. Updates are
 * fire-and-forget (we don't expose a Promise) — the new value is
 * applied to local state synchronously and the DB write happens in
 * the background. Failures are logged, not surfaced.
 *
 * Schema-changes / migrations are the plugin's responsibility — if
 * you change a field's shape, version your key (e.g. `mySetting.v2`)
 * or branch on the parsed type at read time.
 */
export function usePluginSetting<T>(
  pluginId: string,
  key: string,
  defaultValue: T,
): [T, (next: T) => void, boolean] {
  const fullKey = `plugin.${pluginId}.${key}`;
  const [value, setLocal] = useState<T>(defaultValue);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSetting(fullKey)
      .then((raw) => {
        if (cancelled) return;
        if (raw == null) {
          setLoaded(true);
          return;
        }
        try {
          const parsed = JSON.parse(raw) as T;
          setLocal(parsed);
        } catch {
          // Persisted value isn't JSON — probably a stale plain string
          // from an older plugin version. Fall back to default rather
          // than crashing the plugin's settings panel.
        }
        setLoaded(true);
      })
      .catch((err) => {
        console.warn(`[plugin-setting] read ${fullKey} failed`, err);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fullKey]);

  const set = useCallback(
    (next: T) => {
      setLocal(next);
      void setSetting(fullKey, JSON.stringify(next)).catch((err) => {
        console.warn(`[plugin-setting] write ${fullKey} failed`, err);
      });
    },
    [fullKey],
  );

  return [value, set, loaded];
}

/** True if this plugin is allowed to run for the given workspace target lang. */
export function isPluginAvailable(p: StudyPlugin, lang: LanguageCode): boolean {
  if (p.meta.excludedLangs?.includes(lang)) return false;
  if (!p.meta.supportedLangs || p.meta.supportedLangs.length === 0) return true;
  return p.meta.supportedLangs.includes(lang);
}
