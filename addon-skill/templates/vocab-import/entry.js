/**
 * Tokori addon — vocab importer (template).
 *
 * Tokori loads this file's DEFAULT EXPORT and expects it to match the
 * `VocabImporter` contract: { meta, parse(text) -> ImportRow[] }.
 *
 * Hard rules for this kind:
 *   • `parse` MUST be a pure function of `text` — no network, no DOM, no
 *     imports from the Tokori app. The host handles dictionary lookup,
 *     translation, preview, and writing rows to the database.
 *   • An ImportRow is: { word, altWord?, reading?, gloss?, source? }.
 *     Only `word` is required.
 *
 * This example parses a Markdown-ish vocab list, e.g.:
 *     # Lesson 1        (heading — ignored)
 *     喝 (hē) — to drink
 *     你好 (nǐ hǎo): hello
 *     - 谢谢 — thank you
 *     猫                 (bare headword, no reading/gloss)
 */

/** @typedef {{ word: string, reading?: string|null, gloss?: string|null, source?: string }} ImportRow */

const meta = {
  id: "markdown-vocab-list", // must equal manifest.id
  name: "Markdown vocab list",
  description: "Import 'word (reading) — meaning' lines.",
  // Extensions WITHOUT a leading dot. Joined with the generic CSV/TSV
  // extensions by the host, so the file picker stays permissive.
  fileExt: ["txt", "md"],
  // supportedLangs omitted → this importer shows up in every workspace.
};

/**
 * Turn one line into a row, or return null to skip it.
 * @param {string} raw
 * @returns {ImportRow | null}
 */
function parseLine(raw) {
  let line = raw.trim();
  if (line === "" || line.startsWith("#")) return null; // blank / heading
  line = line.replace(/^[-*+]\s+/, ""); // strip a leading bullet

  // Pull out an optional "(reading)" anywhere in the line.
  let reading = null;
  const r = line.match(/\(([^)]*)\)/);
  if (r) {
    reading = r[1].trim() || null;
    line = (line.slice(0, r.index) + line.slice(r.index + r[0].length)).trim();
  }

  // Split word from gloss on the first separator: em/en dash, colon,
  // " - " (spaced hyphen), or a tab.
  const sep = line.match(/\s*(?:—|–|:|\t|\s-\s)\s*/);
  let word;
  let gloss = null;
  if (sep && sep.index !== undefined) {
    word = line.slice(0, sep.index).trim();
    gloss = line.slice(sep.index + sep[0].length).trim() || null;
  } else {
    word = line.trim();
  }

  if (!word) return null;
  return { word, reading, gloss, source: "markdown-vocab-list" };
}

/**
 * @param {string} text
 * @returns {ImportRow[]}
 */
function parse(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const row = parseLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

export default { meta, parse };
