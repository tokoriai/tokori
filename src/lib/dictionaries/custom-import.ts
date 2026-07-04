/**
 * Parser for user-supplied dictionary files. The same module backs the
 * Settings → "Custom dictionary" card and the (future) "Import this
 * file at workspace creation" flow, so it lives outside the UI tree.
 *
 * Accepted formats — auto-detected by file extension first, then by
 * content shape as a fallback:
 *
 *   1. JSON, array of rows (preferred):
 *        [
 *          { "word": "你好", "reading": "nǐ hǎo", "gloss": "hello" },
 *          { "word": "再见", "gloss": "goodbye" }
 *        ]
 *      `reading` is optional, `gloss` is required.
 *
 *   2. JSON, flat object:
 *        { "你好": "hello", "再见": "goodbye" }
 *      No reading — useful for two-column glossaries.
 *
 *   3. CSV / TSV, 2 or 3 columns (no header):
 *        word,gloss
 *        word,reading,gloss
 *      Tabs vs commas are sniffed automatically.
 *
 * Adding a new format means adding a branch in `parseCustomDict` and a
 * detection rule in `detectFormat` — nothing else changes.
 */
import type { DictEntry } from "@/lib/db";

export type CustomDictFormat = "json" | "csv" | "tsv";

export function detectFormat(filename: string, sample: string): CustomDictFormat {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "json") return "json";
  if (ext === "tsv") return "tsv";
  if (ext === "csv") return "csv";
  const head = sample.trimStart()[0];
  if (head === "[" || head === "{") return "json";
  const firstLine = sample.split("\n", 1)[0] ?? "";
  return (firstLine.match(/\t/g)?.length ?? 0) >
    (firstLine.match(/,/g)?.length ?? 0)
    ? "tsv"
    : "csv";
}

function parseDelimited(text: string, sep: string): DictEntry[] {
  const out: DictEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(sep).map((c) => c.trim());
    if (cols.length < 2) continue;
    if (cols.length === 2) {
      out.push({ word: cols[0], altWord: null, reading: null, gloss: cols[1] });
    } else {
      // 3+ columns: word, reading, gloss. Extra columns are folded into
      // gloss with "; " separators so a 4-column file with multiple
      // senses still imports cleanly.
      const [word, reading, ...rest] = cols;
      out.push({
        word,
        altWord: null,
        reading: reading || null,
        gloss: rest.join("; ").trim(),
      });
    }
  }
  return out;
}

function parseJson(text: string): DictEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const out: DictEntry[] = [];
  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const r = row as { word?: unknown; reading?: unknown; gloss?: unknown };
      if (typeof r.word !== "string" || typeof r.gloss !== "string") continue;
      out.push({
        word: r.word.trim(),
        altWord: null,
        reading: typeof r.reading === "string" ? r.reading.trim() : null,
        gloss: r.gloss.trim(),
      });
    }
    return out;
  }
  if (parsed && typeof parsed === "object") {
    for (const [word, gloss] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof gloss !== "string") continue;
      out.push({ word: word.trim(), altWord: null, reading: null, gloss: gloss.trim() });
    }
    return out;
  }
  throw new Error(
    "JSON must be an array of {word,gloss[,reading]} or a {word: gloss} object.",
  );
}

export function parseCustomDict(filename: string, text: string): DictEntry[] {
  const fmt = detectFormat(filename, text);
  if (fmt === "json") return parseJson(text);
  return parseDelimited(text, fmt === "tsv" ? "\t" : ",");
}
