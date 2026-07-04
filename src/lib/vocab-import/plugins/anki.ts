/**
 * Anki Notes-export importer.
 *
 * Anki's "File → Export → Notes in Plain Text (.txt)" produces a
 * tab-separated file that looks like:
 *
 *   #separator:tab
 *   #html:true
 *   #notetype column:1
 *   Front<TAB>Back<TAB>Tags
 *   你好<TAB>hello<TAB>greeting basics
 *
 * The lines starting with `#` are Anki metadata that we ignore. Anki
 * doesn't natively distinguish "reading" from "definition", so we treat
 * the first column as the word and the second as the gloss. If the user
 * has a custom note type with three or more columns we fall back to
 * (word, reading, gloss) like the generic CSV importer — that handles
 * the common Mandarin/Japanese deck shapes (Hanzi/Pinyin/English,
 * Kanji/Furigana/Meaning).
 *
 * HTML stripping is best-effort: Anki cards often store rich HTML in
 * fields, but vocab cards are usually plain text. We strip the obvious
 * <br> / <div> wrappers and keep the rest as-is.
 */

import { Layers } from "lucide-react";
import type { ImportRow, VocabImporter } from "../api";

function stripAnkiHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(div|span|p|b|i|u|strong|em|font)[^>]*>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAnki(text: string): ImportRow[] {
  const lines = text.split(/\r?\n/);
  const out: ImportRow[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Skip Anki's metadata header lines (#separator:tab, #html:true, etc.).
    if (line.startsWith("#")) continue;
    // Anki defaults to tabs but users sometimes re-save as CSV.
    const delim = line.includes("\t") ? "\t" : ",";
    const cols = line.split(delim).map((c) => stripAnkiHtml(c));
    const word = cols[0];
    if (!word) continue;
    let reading: string | undefined;
    let gloss: string | undefined;
    let tags: string | undefined;
    if (cols.length === 2) {
      gloss = cols[1] || undefined;
    } else if (cols.length >= 3) {
      // Heuristic: if column 2 looks like pinyin/furigana/romaji
      // (lowercase ASCII + tone marks), treat it as the reading and
      // column 3 as the gloss. Otherwise assume column 2 is the gloss
      // and column 3 is tags (the Anki default).
      const c2 = cols[1] ?? "";
      const looksLikeReading = /^[a-zà-žā-ǖ̄́̌̀\s\d:]+$/i.test(c2) && c2.length < 40;
      if (looksLikeReading) {
        reading = c2 || undefined;
        gloss = cols[2] || undefined;
        tags = cols[3] || undefined;
      } else {
        gloss = c2 || undefined;
        tags = cols[2] || undefined;
      }
    }
    out.push({
      word,
      reading,
      gloss,
      source: tags ? `anki:${tags.replace(/\s+/g, ",")}` : "anki",
    });
  }
  return out;
}

const importer: VocabImporter = {
  meta: {
    id: "anki",
    name: "Anki (Notes export)",
    description:
      "Anki's File → Export → Notes in Plain Text. Strips HTML and detects pinyin/furigana columns.",
    fileExt: ["txt", "tsv", "csv"],
    icon: Layers,
  },
  parse: parseAnki,
};

export default importer;
