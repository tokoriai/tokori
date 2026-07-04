import { CEDICT_MINI } from "@/data/cedict-mini";
import type { DictEntry } from "@/lib/db";

export type ExampleSentence = { target: string; native: string };

export type LookupResult = {
  reading: string | null;
  gloss: string;
  /** Traditional-Chinese headword, when the dictionary carries one.
   *  CC-CEDICT stores both forms; this is the entry's `altWord`. The
   *  click-to-define popover renders this as the headword when the
   *  workspace's Chinese script preference is "traditional". Null /
   *  absent for languages with no traditional variant, and for words
   *  whose traditional form equals the simplified one. */
  traditional?: string | null;
  /** Optional example sentences. Populated by the LLM-translate path
   *  (not present on packaged-dict hits) and rendered as a small
   *  numbered list at the bottom of the popover. */
  examples?: ExampleSentence[];
  /** Populated when the dict lookup matched a lemma rather than the
   *  surface form the user clicked (e.g. clicked "geht", matched
   *  "gehen"). The popover renders this as a small "inflected form
   *  of …" hint above the gloss so the learner sees the connection. */
  inflectionOf?: string;
  /** Japanese pitch-accent number (drop position over the reading's
   *  mora). Populated when the JMdict row carries augmented kanjium
   *  data. Null on non-JA dicts and on JA words without coverage —
   *  the renderer falls back to plain kana when null. */
  pitchAccent?: number | null;
};

export function fromMini(word: string): LookupResult | null {
  const e = CEDICT_MINI[word];
  return e ? { reading: e.pinyin, gloss: e.gloss } : null;
}

// Marker we use to round-trip examples through the dict's `gloss`
// column (which is the only text field we have on dict_entries — no
// schema migration needed). The popover splits on this back out so
// the user sees a clean definition + a separate "Examples" block,
// even after a reload that re-reads the saved entry.
export const EXAMPLES_DELIMITER = "\n\n— examples —\n";

export function parseGlossWithExamples(gloss: string): {
  gloss: string;
  examples: ExampleSentence[];
} {
  const idx = gloss.indexOf(EXAMPLES_DELIMITER);
  if (idx === -1) return { gloss, examples: [] };
  const head = gloss.slice(0, idx).trim();
  const tail = gloss.slice(idx + EXAMPLES_DELIMITER.length);
  const examples: ExampleSentence[] = [];
  for (const line of tail.split("\n")) {
    const t = line.replace(/^[•\-*\s]+/, "").trim();
    if (!t) continue;
    // Format we write: "TARGET — NATIVE". Split on " — " (em dash)
    // first, fall back to " - " (hyphen) for legacy edits.
    const m = t.split(/\s+—\s+|\s+-\s+/);
    if (m.length >= 2) {
      examples.push({ target: m[0].trim(), native: m.slice(1).join(" - ").trim() });
    } else {
      examples.push({ target: t, native: "" });
    }
  }
  return { gloss: head, examples };
}

export function fromDict(e: DictEntry): LookupResult {
  const { gloss, examples } = parseGlossWithExamples(e.gloss);
  return {
    reading: e.reading,
    gloss,
    traditional: e.altWord,
    examples: examples.length > 0 ? examples : undefined,
    inflectionOf: e.inflectionOf,
    pitchAccent: e.pitchAccent ?? null,
  };
}
