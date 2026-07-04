#!/usr/bin/env node
/**
 * Build the Chinese (HSK 3.0 + Standard Course) pack JSON from the source
 * CSVs. Output is a single `polot-pack/v1` file importable through the
 * Pack Importer dialog.
 *
 * Usage:
 *   node scripts/build-chinese-pack.mjs \
 *     --source ./path/to/source \
 *     --out packs/chinese-hsk30-bundle.json
 *
 * Inputs (relative to the source root):
 *   tonghuikang.csv                    HSK 3.0 master vocab (≈ 11k rows, lev 1-7)
 *   scrape/data/textbooks/hsk_standard_course_*.csv
 *                                      One CSV per lesson of the HSK Standard
 *                                      Course series. Filenames are 1..N in
 *                                      lesson order.
 *
 * Why a script and not a runtime ingest:
 *   - Source files are large and we don't want them inside the desktop app.
 *   - Generating the pack once gives a deterministic, reusable artefact.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Args ──────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const SOURCE_ROOT = args["source"] ?? args["s"];
const OUT_PATH = args["out"] ?? args["o"] ?? "packs/chinese-hsk30-bundle.json";

if (!SOURCE_ROOT) {
  console.error("Pass --source <dir> pointing at the source CSV root.");
  process.exit(1);
}
if (!fs.existsSync(SOURCE_ROOT)) {
  console.error(`Source root not found: ${SOURCE_ROOT}`);
  process.exit(1);
}

// ── HSK 3.0 collections ──────────────────────────────────────────────────
//
// `tonghuikang.csv` columns: traditional, simplified, pinyin, translation,
// level, numerical_pinyin, pinyin_check, exclude.
// Levels 1-6 are the per-band groups. Level 7 is the 7-9 super-band.

const tongPath = path.join(SOURCE_ROOT, "tonghuikang.csv");
console.log(`reading ${tongPath}`);
const tongRows = parseCsv(fs.readFileSync(tongPath, "utf8"));
const wordsByBand = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
for (const r of tongRows) {
  const level = parseInt(r.level, 10);
  if (!(level >= 1 && level <= 7)) continue;
  if (r.exclude && r.exclude.toLowerCase() === "true") continue;
  wordsByBand[level].push({
    word: r.simplified.trim(),
    reading: r.pinyin.trim(),
    gloss: cleanGloss(r.translation),
  });
}

const collections = [];
for (const band of [1, 2, 3, 4, 5, 6, 7]) {
  const words = wordsByBand[band];
  if (words.length === 0) continue;
  const label = band === 7 ? "Bands 7-9 (advanced)" : `Band ${band}`;
  collections.push({
    id: `hsk30-band-${band}`,
    name: `HSK 3.0 · ${label}`,
    description: `${words.length.toLocaleString()} words at the new HSK ${
      band === 7 ? "7-9 super-band" : `Level ${band}`
    }.`,
    words,
  });
}
console.log(
  `HSK 3.0: ${collections.length} bands, ${collections
    .reduce((s, c) => s + c.words.length, 0)
    .toLocaleString()} words`,
);

// ── HSK Standard Course textbook ─────────────────────────────────────────
//
// 72 lesson CSVs in scrape/data/textbooks/hsk_standard_course_<N>.csv. Each
// file is one lesson's vocab list. We map them onto HSK Standard Course
// volumes by published lesson counts:
//   Course 1: lessons 1-15
//   Course 2: lessons 1-15
//   Course 3 (vol A+B): 24 lessons
//   Course 4 (vol A+B): 20 lessons (10+10)
//   Course 5 (vol A+B): 18 lessons (9+9)
//   Course 6 (vol A+B): not always shipped — fold remaining lessons into 6.
// The source's flat numbering is sequential, so we can split via cumulative
// boundaries.

const textbookDir = path.join(SOURCE_ROOT, "scrape/data/textbooks");
const lessonFiles = fs
  .readdirSync(textbookDir)
  .filter((f) => /^hsk_standard_course_\d+\.csv$/.test(f))
  .map((f) => ({
    n: parseInt(f.replace("hsk_standard_course_", "").replace(".csv", ""), 10),
    file: path.join(textbookDir, f),
  }))
  .sort((a, b) => a.n - b.n);

// Volume boundaries (cumulative lesson index, exclusive upper bound). These
// match the published HSK Standard Course series — 6 volumes plus the 7-9
// super-band book. Counts come from the publisher's own lesson maps.
const VOLUMES = [
  { name: "HSK Standard Course 1", upTo: 15 },  //  15 lessons
  { name: "HSK Standard Course 2", upTo: 30 },  // +15
  { name: "HSK Standard Course 3", upTo: 54 },  // +24 (12 + 12)
  { name: "HSK Standard Course 4", upTo: 74 },  // +20 (10 + 10)
  { name: "HSK Standard Course 5", upTo: 92 },  // +18 (9 + 9)
  { name: "HSK Standard Course 6", upTo: 116 }, // +24 (12 + 12)
];
// Anything past Course 6 goes into the 7-9 super-band book.
VOLUMES.push({ name: "HSK Standard Course 7-9", upTo: lessonFiles.length });

const textbooks = [];
let cursor = 0;
for (const vol of VOLUMES) {
  const slice = lessonFiles.slice(cursor, vol.upTo);
  if (slice.length === 0) continue;
  const chapters = [];
  let position = 0;
  for (const lesson of slice) {
    const rows = parseCsv(fs.readFileSync(lesson.file, "utf8"), {
      // textbook CSVs use lower-case headers `chinese,pinyin,english`
      lower: true,
    });
    const vocab = rows
      .map((r) => ({
        word: (r.chinese ?? "").trim(),
        reading: (r.pinyin ?? "").trim(),
        gloss: cleanGloss(r.english ?? ""),
      }))
      .filter((w) => w.word);
    chapters.push({
      position,
      title: `Lesson ${position + 1}`,
      vocab,
    });
    position += 1;
  }
  textbooks.push({
    id: vol.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title: vol.name,
    author: "高等教育出版社",
    totalUnits: chapters.length,
    unitLabel: "lessons",
    chapters,
  });
  cursor = vol.upTo;
}
console.log(
  `Textbooks: ${textbooks.length} volumes, ${textbooks
    .reduce((s, t) => s + t.chapters.length, 0)
    .toLocaleString()} chapters`,
);

// ── Assemble + write ──────────────────────────────────────────────────────

const pack = {
  schema: "polot-pack/v1",
  id: "chinese-hsk30-bundle",
  name: "Chinese: HSK 3.0 + Standard Course",
  language: "zh",
  description:
    "All HSK 3.0 (2021) bands plus the HSK Standard Course textbook series, organised by lesson. Drop into any Chinese workspace to get every word and chapter at once.",
  version: "1.0.0",
  license: "HSK Standard Course vocabulary; for personal study use.",
  collections,
  textbooks,
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(pack));
const sizeKb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
console.log(`wrote ${OUT_PATH} (${sizeKb} KB)`);

// ── Helpers ───────────────────────────────────────────────────────────────

/** Quote-aware CSV parser that returns an array of {header: value} maps. */
function parseCsv(text, opts = {}) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let header = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = parseCsvRow(line);
    if (!header) {
      header = opts.lower ? row.map((h) => h.toLowerCase().trim()) : row.map((h) => h.trim());
      continue;
    }
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = row[i] ?? "";
    });
    out.push(obj);
  }
  return out;
}

function parseCsvRow(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          q = false;
        }
      } else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Trim CC-CEDICT-style multi-gloss strings to something readable. */
function cleanGloss(s) {
  if (!s) return "";
  return s
    .replace(/\s+/g, " ")
    .split(/\/|;/) // CC-CEDICT separator + semicolon-glosses
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 3) // top 3 glosses keeps the cards readable
    .join("; ");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        out[k] = v;
        i++;
      } else {
        out[k] = "true";
      }
    }
  }
  return out;
}
