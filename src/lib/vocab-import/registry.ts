/**
 * Built-in vocab importer registry.
 *
 * Adding an importer:
 *   1. Drop a file in `src/lib/vocab-import/plugins/<id>.ts` exporting a
 *      default `VocabImporter`.
 *   2. Append it here.
 *   3. Optionally restrict via `meta.supportedLangs`.
 *
 * Future: a "user importers" folder we can dynamic-`import()` at startup,
 * mirroring the plan in `lib/study/registry.ts`.
 */

import type { LanguageCode } from "../languages";
import { isImporterAvailable, type VocabImporter } from "./api";
import anki from "./plugins/anki";
import duolingo from "./plugins/duolingo";
import genericCsv from "./plugins/generic-csv";
import hackchinese from "./plugins/hackchinese";
import hellochinese from "./plugins/hellochinese";
import pleco from "./plugins/pleco";
import superchinese from "./plugins/superchinese";

export const IMPORTERS: VocabImporter[] = [
  genericCsv,    // universal default
  anki,          // universal — Anki Notes export
  duolingo,      // universal — duome.eu word list
  hackchinese,   // zh only — preserves SRS state
  pleco,         // zh only — Simplified/Traditional split
  superchinese,  // zh only — best-guess shape
  hellochinese,  // zh only — best-guess shape
];

/**
 * Importers contributed by enabled addons, loaded from disk into a sandbox
 * worker by `lib/addons/loader.ts`. Kept as a separate slot (rather than
 * pushed into the const `IMPORTERS`) so a re-scan can replace the whole set
 * atomically, and so the built-in list stays a static, tree-shakeable array.
 * The loader calls `setAddonImporters` after every (re)load.
 */
let addonImporters: VocabImporter[] = [];

export function setAddonImporters(list: VocabImporter[]): void {
  addonImporters = list;
}

/** Built-ins first (so a duplicate id from an addon can't shadow a built-in),
 *  then enabled addons. */
function allImporters(): VocabImporter[] {
  return [...IMPORTERS, ...addonImporters];
}

export function importersForLanguage(lang: LanguageCode): VocabImporter[] {
  return allImporters().filter((p) => isImporterAvailable(p, lang));
}

export function importerById(id: string): VocabImporter | null {
  return allImporters().find((p) => p.meta.id === id) ?? null;
}

/** Comma-joined short importer label list for the workspace's
 *  language, suitable to drop into copy like
 *      "Import vocab you already know from {names}, or any CSV."
 *
 *  Uses a curated short label per importer (e.g. "HackChinese",
 *  "Anki", "Duolingo") rather than `meta.name` which is verbose
 *  ("HackChinese export", "Anki (Notes export)"). Drops the
 *  generic-csv entry since the call sites always tack ", or any
 *  CSV" on themselves. Cap at four names so the line stays
 *  readable; the picker dialog itself has the full list. */
export function importerLabelsForLanguage(lang: LanguageCode): string[] {
  const out: string[] = [];
  for (const imp of importersForLanguage(lang)) {
    if (imp.meta.id === "generic-csv") continue;
    out.push(SHORT_LABEL[imp.meta.id] ?? imp.meta.name);
  }
  return out.slice(0, 4);
}

/** Join an importer label list with commas and a trailing "or"
 *  for natural-sounding prose. `["Anki", "Duolingo"]` →
 *  `"Anki or Duolingo"`. Returns empty string for an empty list
 *  so callers can fall back gracefully. */
export function joinImporterLabels(labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

const SHORT_LABEL: Record<string, string> = {
  anki: "Anki",
  duolingo: "Duolingo",
  hackchinese: "HackChinese",
  hellochinese: "HelloChinese",
  pleco: "Pleco",
  superchinese: "SuperChinese",
};
