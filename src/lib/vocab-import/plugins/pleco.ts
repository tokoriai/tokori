/**
 * Pleco flashcard exporter.
 *
 * Pleco's Flashcards → Export produces a TSV with one row per card.
 * The shipped formats are:
 *
 *   Simplified  TAB  Pinyin  TAB  Definition
 *   Simplified/Traditional  TAB  Pinyin  TAB  Definition
 *
 * Where the headword cell uses `[simplified]/[traditional]` notation
 * when the two forms differ (e.g. `电脑/電腦`). Pinyin uses Pleco's own
 * tone-number format (`dian4 nao3`) by default; we leave it as-is since
 * the user's dictionary likely matches the same convention.
 *
 * Definitions can carry inline `​`-separated subentries with part-of-
 * speech markers — we keep them whole and let the user clean up post-import.
 */

import { BookOpen } from "lucide-react";
import type { ImportRow, VocabImporter } from "../api";

function splitHeadword(raw: string): { simp: string; trad: string | null } {
  const trimmed = raw.trim();
  // Pleco joins differing forms with `/`. We avoid splitting on `/` inside
  // glosses by anchoring this only to the first column.
  const parts = trimmed.split("/");
  if (parts.length === 2 && parts[0] !== parts[1]) {
    return { simp: parts[0].trim(), trad: parts[1].trim() };
  }
  return { simp: trimmed, trad: null };
}

export function parsePleco(text: string): ImportRow[] {
  const out: ImportRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Pleco exports are always tabs. If the user converted to commas
    // they should use the generic CSV importer instead.
    const cols = line.split("\t").map((c) => c.trim());
    const head = cols[0];
    if (!head) continue;
    const { simp, trad } = splitHeadword(head);
    out.push({
      word: simp,
      altWord: trad,
      reading: cols[1] || undefined,
      gloss: cols[2] || undefined,
      source: "pleco",
    });
  }
  return out;
}

const importer: VocabImporter = {
  meta: {
    id: "pleco",
    name: "Pleco flashcards",
    description:
      "Pleco's TSV flashcard export. Splits Simplified/Traditional headwords into word + altWord.",
    fileExt: ["txt", "tsv"],
    supportedLangs: ["zh"],
    icon: BookOpen,
  },
  parse: parsePleco,
};

export default importer;
