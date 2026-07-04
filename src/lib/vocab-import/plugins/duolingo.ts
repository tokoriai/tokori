/**
 * Duolingo word-list importer (via duome.eu).
 *
 * Duolingo doesn't expose an official vocabulary export. The community
 * standard is duome.eu — paste your username, copy the words list out
 * as TSV/CSV. Rows look like:
 *
 *   word    pos     translation     strength    learned    last_practiced
 *   bonjour interj  hello           4           2024-01-12 2024-03-04
 *
 * `strength` (0–4 in Duolingo's pre-2024 model, 0–5 after) becomes our
 * srsHint.status: 0 → new, 1–3 → learning, 4–5 → review. We don't have
 * an interval, so we leave intervalDays unset and let FSRS treat the
 * card as "due today" — better than fabricating a number that misleads
 * the scheduler.
 *
 * Duome also publishes JSON dumps; for now we only handle the TSV/CSV
 * variant since that's what the in-page "copy" button produces.
 */

import { Languages } from "lucide-react";
import type { ImportRow, VocabImporter, VocabStatus } from "../api";

function strengthToStatus(raw: string | undefined): VocabStatus {
  const n = raw == null ? NaN : Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return "new";
  if (n < 4) return "learning";
  return "review";
}

export function parseDuolingo(text: string): ImportRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  // duome rows can be tab- or comma-separated; the column order is stable.
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const first = lines[0].toLowerCase();
  const hasHeader =
    first.includes("word") ||
    first.includes("strength") ||
    first.includes("translation");
  const start = hasHeader ? 1 : 0;
  const out: ImportRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(delim).map((c) => c.trim());
    const word = cols[0];
    if (!word) continue;
    // Layout shipped by duome's "copy as TSV" button:
    //   word, pos, translation, strength, learned, last_practiced
    // Some older exports skip `pos`, so we sniff: if column 2 looks like
    // a part-of-speech tag (≤ 6 chars, lowercase), treat it as such.
    const c1 = cols[1] ?? "";
    const posLike = c1 && c1.length <= 6 && /^[a-z.]+$/.test(c1);
    const gloss = posLike ? cols[2] : c1;
    const strength = posLike ? cols[3] : cols[2];
    out.push({
      word,
      gloss: gloss || undefined,
      source: "duolingo",
      srsHint: { status: strengthToStatus(strength) },
    });
  }
  return out;
}

const importer: VocabImporter = {
  meta: {
    id: "duolingo",
    name: "Duolingo (via duome.eu)",
    description:
      "Word list copied from duome.eu/<username>. Maps Duolingo's strength score to learning/review status.",
    fileExt: ["txt", "tsv", "csv"],
    icon: Languages,
  },
  parse: parseDuolingo,
};

export default importer;
