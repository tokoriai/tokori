/**
 * HackChinese export importer.
 *
 * The hackchinese.com word-list export ships rows shaped like:
 *
 *   Simplified | Traditional | Status      | Interval
 *   你好       | 你好        | learning    | 3
 *   谢谢       | 謝謝        | review      | 30
 *
 * The header line is always present in the exports the user sees in-app, so
 * we anchor on it. Status maps to our `VocabStatus`; Interval is a number of
 * days that we hand to the dialog as `srsHint.intervalDays`. The dialog
 * converts that into FSRS state when writing to `vocab_entries` so the
 * user's existing review schedule survives the migration.
 *
 * Glosses aren't in the file (HackChinese keeps them in their own dict). The
 * dialog will handle that — it joins each row against the workspace's
 * dictionary and offers translation for anything still missing.
 */

import { Languages } from "lucide-react";
import type { ImportRow, VocabImporter, VocabStatus } from "../api";

function parseTabOrCommaLine(line: string): string[] {
  const delim = line.includes("\t") ? "\t" : ",";
  // HackChinese's exports never quote, so a simple split is fine.
  return line.split(delim).map((c) => c.trim());
}

const HC_STATUS_MAP: Record<string, VocabStatus> = {
  // The strings HackChinese actually uses in their export header.
  new: "new",
  learning: "learning",
  reviewing: "review",
  review: "review",
  known: "mastered",
  mastered: "mastered",
};

function normaliseStatus(raw: string | undefined): VocabStatus {
  if (!raw) return "new";
  const v = raw.toLowerCase().trim();
  return HC_STATUS_MAP[v] ?? "new";
}

export function parseHackChinese(text: string): ImportRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  // Skip the header row when we recognise it.
  const first = lines[0].toLowerCase();
  const start = first.includes("simplified") || first.includes("hanzi") ? 1 : 0;
  const out: ImportRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const cols = parseTabOrCommaLine(lines[i]);
    const simplified = cols[0];
    if (!simplified) continue;
    const traditional = cols[1] || null;
    const status = normaliseStatus(cols[2]);
    const intervalRaw = cols[3];
    const intervalDays = intervalRaw ? Number.parseFloat(intervalRaw) : NaN;
    out.push({
      word: simplified,
      altWord: traditional && traditional !== simplified ? traditional : null,
      source: "hackchinese",
      srsHint: {
        status,
        intervalDays: Number.isFinite(intervalDays) ? intervalDays : undefined,
      },
    });
  }
  return out;
}

const importer: VocabImporter = {
  meta: {
    id: "hackchinese",
    name: "HackChinese export",
    description:
      "CSV/TSV with Simplified, Traditional, Status, Interval. Preserves SRS state.",
    fileExt: ["csv", "tsv", "txt"],
    supportedLangs: ["zh"],
    icon: Languages,
  },
  parse: parseHackChinese,
};

export default importer;
