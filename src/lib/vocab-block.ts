/**
 * Parser for the ```vocab fenced block the tutor emits when presenting a
 * vocabulary list (see `buildSystemPrompt` in chat-view.tsx). Each line is
 *   word | reading | meaning      (3 columns)
 *   word | meaning                (2 columns — reading blank)
 * The chat renderer turns the parsed rows into an interactive table with
 * save / add-to-list actions (`src/components/vocab-table.tsx`).
 *
 * Pure + tolerant: blank lines, markdown table separator rows (`---|---`),
 * the optional surrounding pipes of a markdown table, and a leading header
 * row (word/reading/meaning labels) are all skipped, since the model
 * occasionally formats this as a real markdown table.
 */

export type VocabRow = { word: string; reading: string; meaning: string };

const HEADER_LABEL =
  /^(reading|pinyin|furigana|romaji|romaja|pronunciation|meaning|translation|gloss|definition|english)$/i;

function isHeaderRow(word: string, reading: string, meaning: string): boolean {
  const w = word.toLowerCase();
  const wordLabel =
    w === "word" || w === "hanzi" || w === "vocab" || w === "vocabulary" || w === "term";
  return wordLabel && (HEADER_LABEL.test(reading) || HEADER_LABEL.test(meaning));
}

export function parseVocabBlock(raw: string): VocabRow[] {
  const rows: VocabRow[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // Markdown table separator row, e.g. "|---|:--:|---|".
    if (/^[|\-:\s]+$/.test(t)) continue;
    const cells = t.split("|").map((c) => c.trim());
    // Drop the empty edge cells from "| a | b |".
    if (cells.length && cells[0] === "") cells.shift();
    if (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (cells.length === 0 || !cells[0]) continue;
    const word = cells[0];
    let reading = "";
    let meaning = "";
    if (cells.length >= 3) {
      reading = cells[1];
      meaning = cells.slice(2).join(" ");
    } else if (cells.length === 2) {
      meaning = cells[1];
    }
    if (isHeaderRow(word, reading, meaning)) continue;
    rows.push({ word, reading, meaning });
  }
  return rows;
}
