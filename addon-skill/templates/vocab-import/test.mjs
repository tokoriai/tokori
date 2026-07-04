// Local test harness for a vocab-import addon — run: node test.mjs
//
// Addon execution inside Tokori isn't wired up yet (Stage 2), and a
// `vocab-import` parse() is a pure function — so this is the fastest way to
// check your parser. It imports the entry point and runs parse() over
// sample.md, prints the rows, and exits non-zero if any row is missing a word.
//
// Copy this file into your own addon folder and point sample.md at your own
// input. For `translate` / `card-enrichment` addons, call the exported
// translate() / run() the same way (stub the request / ctx object).

import { readFileSync } from "node:fs";
import importer from "./entry.js";

const text = readFileSync(new URL("./sample.md", import.meta.url), "utf8");
const rows = importer.parse(text);

console.log(`Importer: ${importer.meta.name} (${importer.meta.id})`);
console.log(`Parsed ${rows.length} row(s) from sample.md:\n`);
for (const r of rows) {
  const reading = r.reading ? ` (${r.reading})` : "";
  const gloss = r.gloss ? ` — ${r.gloss}` : "";
  console.log(`  • ${r.word}${reading}${gloss}`);
}

const ok =
  rows.length > 0 &&
  rows.every((r) => typeof r.word === "string" && r.word.trim().length > 0);
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — every row has a non-empty word.`);
process.exit(ok ? 0 : 1);
