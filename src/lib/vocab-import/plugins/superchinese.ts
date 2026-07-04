/**
 * SuperChinese vocabulary importer (best-guess format).
 *
 * SuperChinese doesn't ship a documented CSV exporter — what users
 * actually have varies by version and platform. The most common shape
 * floating around community share-outs is:
 *
 *   Hanzi, Pinyin, English, Lesson
 *
 * with optional `HSK Level` and `Status` columns. We auto-detect the
 * header row when present and fall back to positional (col 0 = hanzi,
 * col 1 = pinyin, col 2 = english) when it isn't. Status, when present,
 * maps the same way as the HackChinese importer does.
 *
 * If your export doesn't match, the Generic CSV importer with the right
 * header names will usually parse it — and it's a one-file PR to add a
 * proper plugin. Open an issue with a sample export to make this one
 * stricter.
 */

import { GraduationCap } from "lucide-react";
import type { ImportRow, VocabImporter, VocabStatus } from "../api";

const STATUS_MAP: Record<string, VocabStatus> = {
  new: "new",
  learning: "learning",
  reviewing: "review",
  review: "review",
  known: "mastered",
  mastered: "mastered",
};

function pickIndex(header: string[], keys: string[]): number {
  for (let i = 0; i < header.length; i++) {
    const h = header[i].toLowerCase();
    if (keys.some((k) => h.includes(k))) return i;
  }
  return -1;
}

export function parseSuperChinese(text: string): ImportRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const firstCols = lines[0].split(delim).map((c) => c.trim());
  const lower = firstCols.map((c) => c.toLowerCase());
  const looksLikeHeader = lower.some((c) =>
    ["hanzi", "chinese", "simplified", "word", "pinyin", "english"].includes(c),
  );
  let wordIdx = 0,
    pyIdx = 1,
    enIdx = 2,
    statusIdx = -1;
  let dataStart = 0;
  if (looksLikeHeader) {
    wordIdx = pickIndex(firstCols, ["hanzi", "chinese", "simplified", "word"]);
    pyIdx = pickIndex(firstCols, ["pinyin", "reading"]);
    enIdx = pickIndex(firstCols, ["english", "translation", "meaning", "definition"]);
    statusIdx = pickIndex(firstCols, ["status", "stage"]);
    if (wordIdx < 0) wordIdx = 0;
    dataStart = 1;
  }
  const out: ImportRow[] = [];
  for (let i = dataStart; i < lines.length; i++) {
    const cols = lines[i].split(delim).map((c) => c.trim());
    const word = cols[wordIdx];
    if (!word) continue;
    const reading = pyIdx >= 0 ? cols[pyIdx] : undefined;
    const gloss = enIdx >= 0 ? cols[enIdx] : undefined;
    const statusRaw = statusIdx >= 0 ? cols[statusIdx]?.toLowerCase() : undefined;
    const status = statusRaw ? STATUS_MAP[statusRaw] ?? "new" : "new";
    out.push({
      word,
      reading: reading || undefined,
      gloss: gloss || undefined,
      source: "superchinese",
      srsHint: status !== "new" ? { status } : undefined,
    });
  }
  return out;
}

const importer: VocabImporter = {
  meta: {
    id: "superchinese",
    name: "SuperChinese",
    description:
      "Best-guess CSV (Hanzi, Pinyin, English, optional Status). If your export looks different, use Generic CSV.",
    fileExt: ["csv", "tsv", "txt"],
    supportedLangs: ["zh"],
    icon: GraduationCap,
  },
  parse: parseSuperChinese,
};

export default importer;
