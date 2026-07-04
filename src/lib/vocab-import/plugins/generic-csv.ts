/**
 * Generic CSV / TSV importer.
 *
 * Default fallback that handles the common shapes:
 *   - One column        → just the word.
 *   - Two columns       → word, gloss.
 *   - Three+ columns    → word, reading, gloss.
 *   - Headered files    → header keys are matched against `HEADER_KEYS`
 *                         (word | hanzi | term | …, pinyin | reading | …,
 *                         gloss | meaning | translation | …).
 *
 * Tab-separated files are auto-detected on the first row (presence of `\t`).
 */

import { FileSpreadsheet } from "lucide-react";
import type { ImportRow, VocabImporter } from "../api";

function parseCsvLine(line: string, delim: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delim && !inQuotes) {
      cols.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

const HEADER_KEYS = {
  word: ["word", "hanzi", "term", "front", "kanji", "vocab", "vocabulary", "simplified"],
  reading: ["reading", "pinyin", "furigana", "kana", "romaji", "pronunciation"],
  gloss: [
    "gloss",
    "definition",
    "meaning",
    "english",
    "translation",
    "back",
    "def",
  ],
};

function detectHeader(cols: string[]): {
  word: number;
  reading: number;
  gloss: number;
} | null {
  const lower = cols.map((c) => c.toLowerCase());
  const find = (keys: string[]) =>
    lower.findIndex((c) => keys.some((k) => c === k || c.includes(k)));
  const w = find(HEADER_KEYS.word);
  const r = find(HEADER_KEYS.reading);
  const g = find(HEADER_KEYS.gloss);
  if (w === -1 && r === -1 && g === -1) return null;
  return { word: w === -1 ? 0 : w, reading: r, gloss: g };
}

export function parseGenericCsv(text: string): ImportRow[] {
  const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (rawLines.length === 0) return [];
  const delim = rawLines[0].includes("\t") ? "\t" : ",";
  const firstCols = parseCsvLine(rawLines[0], delim);
  const header = detectHeader(firstCols);
  const dataLines = header ? rawLines.slice(1) : rawLines;
  const out: ImportRow[] = [];
  for (const line of dataLines) {
    const cols = parseCsvLine(line, delim);
    if (cols.length === 0 || !cols[0]) continue;
    let word = "";
    let reading: string | undefined;
    let gloss: string | undefined;
    if (header) {
      word = (cols[header.word] ?? "").trim();
      reading = header.reading >= 0 ? cols[header.reading]?.trim() : undefined;
      gloss = header.gloss >= 0 ? cols[header.gloss]?.trim() : undefined;
    } else if (cols.length === 1) {
      word = cols[0].trim();
    } else if (cols.length === 2) {
      word = cols[0].trim();
      gloss = cols[1].trim();
    } else {
      word = cols[0].trim();
      reading = cols[1]?.trim() || undefined;
      gloss = cols[2]?.trim() || undefined;
    }
    if (!word) continue;
    out.push({
      word,
      reading: reading || undefined,
      gloss: gloss || undefined,
      source: "import",
    });
  }
  return out;
}

const importer: VocabImporter = {
  meta: {
    id: "generic-csv",
    name: "Generic CSV / TSV",
    description:
      "One row per word. Auto-detects headers (word / pinyin / english) and tabs vs commas.",
    fileExt: ["csv", "tsv", "txt"],
    icon: FileSpreadsheet,
  },
  parse: parseGenericCsv,
};

export default importer;
