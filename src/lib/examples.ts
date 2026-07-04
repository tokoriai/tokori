/**
 * Per-word example sentences.
 *
 * Saved sentences live alongside the vocabulary row in
 * `vocab_entries.card_notes` as a JSON blob, prefixed with a sentinel
 * so the field stays compatible with handwritten notes that pre-date
 * this feature. Each entry tracks where it came from (`source`) so the
 * UI can distinguish user-saved sentences from unconfirmed AI output.
 *
 * Shared between the dict-detail page (where sentences are added /
 * generated) and the personal-dict Sentences view (where they're
 * browsed across all words).
 */

export type ExampleSentence = {
  /** Stable client id, used as React key + for delete operations. */
  id: string;
  /** Target-language sentence. */
  target: string;
  /** Native-language translation. Optional but encouraged. */
  native?: string;
  /** Where this sentence came from. Used for the small badge under each row. */
  source: "user" | "ai";
};

/** Sentinel that prefixes the JSON in `card_notes`. Lets us tell
 *  apart structured example data from free-form notes a user might
 *  have written before this feature shipped. Pre-tokori-rename rows
 *  used `POLOT_EXAMPLES_V1` and were rewritten in migration v25. */
export const EXAMPLE_KEY = "TOKORI_EXAMPLES_V1";

/** Extract examples from a `card_notes` blob. Returns an empty list
 *  for null / non-prefixed values so the caller doesn't have to
 *  branch on every read. */
export function parseExamples(raw: string | null | undefined): ExampleSentence[] {
  if (!raw) return [];
  if (!raw.startsWith(EXAMPLE_KEY)) return [];
  try {
    const json = raw.slice(EXAMPLE_KEY.length).trim();
    const parsed = JSON.parse(json) as ExampleSentence[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.target === "string");
  } catch {
    return [];
  }
}

export function serialiseExamples(list: ExampleSentence[]): string {
  return `${EXAMPLE_KEY}${JSON.stringify(list)}`;
}

/** Stable id for a freshly-minted example. crypto.randomUUID is missing
 *  on some older Tauri webviews (Linux WebKitGTK), so fall back to a
 *  64-bit random hex string — the id is only a React key + delete
 *  handle, so collision safety at this scale is fine. */
export function newExampleId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pick the best saved example for `word` from a `card_notes` blob, or
 *  null when none fit. "Best" = the most recently saved entry whose
 *  target sentence actually contains the word, so a cloze mask /
 *  word-highlight still lands. Shared by sentence-mining (reuse a saved
 *  generation instead of re-spending tokens) and sentence-cards (fall
 *  back to a saved sentence when the library / AI yields nothing).
 *
 *  Containment is NFC-normalised and case-insensitive. CJK has no word
 *  boundaries so a plain substring test is correct there; for everything
 *  else we still substring-match because the saved sentence was written
 *  to contain the exact form we're looking for. */
export function pickSavedExample(
  cardNotes: string | null | undefined,
  word: string,
): ExampleSentence | null {
  if (!word) return null;
  const list = parseExamples(cardNotes);
  const w = word.normalize("NFC").toLowerCase();
  for (let i = list.length - 1; i >= 0; i--) {
    const ex = list[i];
    const target = ex.target?.normalize("NFC").toLowerCase();
    if (target && target.includes(w)) return ex;
  }
  return null;
}
