/**
 * Public vocab-importer plugin API.
 *
 * An "importer" parses a file dumped from some external SRS / dictionary tool
 * (HackChinese, Anki export, Pleco flashcards, …) into a normalised
 * `ImportRow[]` list the dialog can preview, dictionary-match, and write
 * into `vocab_entries`.
 *
 * Authoring a plugin
 * ──────────────────
 *   1. Drop a file in `src/lib/vocab-import/plugins/<id>.ts` exporting
 *      `export default { meta, parse } satisfies VocabImporter`.
 *   2. Append it to `IMPORTERS` in `./registry.ts`.
 *   3. (Optional) gate by language via `meta.supportedLangs` so the picker
 *      hides it for unrelated workspaces (e.g. HackChinese only shows for
 *      Chinese workspaces).
 *
 * Importers MUST be pure functions of their input text: no DB, no network,
 * no side effects. The dialog handles dictionary lookup, translation, and
 * persistence after parsing. That keeps importers easy to test and lets us
 * preview the parsed rows before any data is written.
 */

import type { ComponentType } from "react";
import type { LanguageCode } from "../languages";
import type { VocabStatus } from "../db";

export type { LanguageCode, VocabStatus };

/** One parsed line ready to import. Fields beyond `word` are optional —
 *  the importer fills in what the source actually provides. */
export type ImportRow = {
  /** Headword as the user will see it (e.g. simplified for Chinese). */
  word: string;
  /** Alternate form — Traditional Chinese, kanji-only fallback, etc. */
  altWord?: string | null;
  /** Pinyin / furigana / romanisation when the file carries one. */
  reading?: string | null;
  /** Definition / translation when the file carries one. */
  gloss?: string | null;
  /** Free-form per-row provenance string written into `vocab_entries.source`. */
  source?: string;
  /**
   * Optional FSRS seed. Imports from a tool that already tracks SRS state
   * (HackChinese, Anki) can hand it over so the user doesn't restart from
   * scratch. The dialog converts this into a `saveVocab(...)` call with
   * status / stability / dueAt.
   */
  srsHint?: {
    status: VocabStatus;
    /** Days until next review. The importer translates the source's own
     *  unit into days before handing it over. */
    intervalDays?: number;
  };
};

export type VocabImporterMeta = {
  /** Stable kebab-case identifier. Persisted in user settings (last picked importer). */
  id: string;
  /** Display name in the picker. */
  name: string;
  /** One-liner shown under the name. */
  description: string;
  /** File extensions this importer accepts (no leading dot). Joined with the
   *  generic-csv extensions so the file picker is permissive. */
  fileExt: string[];
  /**
   * Workspaces where this importer should appear. Same semantics as
   * `StudyPlugin.supportedLangs` — omit for universal, list codes for
   * language-specific tools.
   */
  supportedLangs?: LanguageCode[];
  excludedLangs?: LanguageCode[];
  /** Optional Lucide-style icon. */
  icon?: ComponentType<{ className?: string }>;
};

export type VocabImporter = {
  meta: VocabImporterMeta;
  /**
   * Parse raw file text into normalised rows.
   *
   * Built-in importers are pure + synchronous (no IO). Addon importers
   * loaded from disk run inside a sandbox worker, so their `parse` returns
   * a Promise — callers must `await`. Awaiting a synchronous return is a
   * no-op, so a single `await importer.parse(text)` handles both.
   */
  parse: (text: string) => ImportRow[] | Promise<ImportRow[]>;
};

export function isImporterAvailable(
  imp: VocabImporter,
  lang: LanguageCode,
): boolean {
  if (imp.meta.excludedLangs?.includes(lang)) return false;
  if (!imp.meta.supportedLangs || imp.meta.supportedLangs.length === 0)
    return true;
  return imp.meta.supportedLangs.includes(lang);
}
