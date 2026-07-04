/**
 * HelloChinese vocabulary importer (best-guess format).
 *
 * Like SuperChinese, HelloChinese has no documented exporter. Community
 * scrapes / shared lists most often look like:
 *
 *   Chinese, Pinyin, Translation, Lesson
 *
 * The lesson column is preserved into `source` so the user can see
 * provenance ("hellochinese:Lesson 5") in the vocab list. Same caveat
 * as SuperChinese applies — if your export shape differs, the Generic
 * CSV importer should still work.
 */

import { MessageCircle } from "lucide-react";
import type { ImportRow, VocabImporter } from "../api";

function pickIndex(header: string[], keys: string[]): number {
  for (let i = 0; i < header.length; i++) {
    const h = header[i].toLowerCase();
    if (keys.some((k) => h.includes(k))) return i;
  }
  return -1;
}

export function parseHelloChinese(text: string): ImportRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const firstCols = lines[0].split(delim).map((c) => c.trim());
  const lower = firstCols.map((c) => c.toLowerCase());
  const looksLikeHeader = lower.some((c) =>
    ["chinese", "hanzi", "pinyin", "translation", "english", "lesson"].includes(c),
  );
  let wordIdx = 0,
    pyIdx = 1,
    enIdx = 2,
    lessonIdx = -1;
  let dataStart = 0;
  if (looksLikeHeader) {
    wordIdx = pickIndex(firstCols, ["chinese", "hanzi", "simplified", "word"]);
    pyIdx = pickIndex(firstCols, ["pinyin", "reading"]);
    enIdx = pickIndex(firstCols, ["translation", "english", "meaning"]);
    lessonIdx = pickIndex(firstCols, ["lesson", "unit", "chapter"]);
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
    const lesson = lessonIdx >= 0 ? cols[lessonIdx] : undefined;
    out.push({
      word,
      reading: reading || undefined,
      gloss: gloss || undefined,
      source: lesson ? `hellochinese:${lesson}` : "hellochinese",
    });
  }
  return out;
}

const importer: VocabImporter = {
  meta: {
    id: "hellochinese",
    name: "HelloChinese",
    description:
      "Best-guess CSV (Chinese, Pinyin, Translation, optional Lesson). If your export looks different, use Generic CSV.",
    fileExt: ["csv", "tsv", "txt"],
    supportedLangs: ["zh"],
    icon: MessageCircle,
  },
  parse: parseHelloChinese,
};

export default importer;
