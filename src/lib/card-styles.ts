/**
 * Card style registry — drives the `CardComposerDialog`'s style tabs
 * and the multi-row save dispatch.
 *
 * Each style is a tiny shape: metadata for the tab, optional form
 * overrides (labels / placeholders), an auto-enricher whitelist, and
 * a `produce()` that turns the composer's draft into 1+ vocab rows
 * to save. The composer iterates the produce result and calls
 * `saveVocab` + `updateVocabFields` for each — one round-trip per
 * row, idempotent on `(workspaceId, word)`.
 *
 * Styles map to existing storage shapes — no schema change. The
 * study plugins already render rows by inspecting `kind` and
 * `frontExtra`:
 *
 *   - "standard"   → kind="vocab", frontExtra=null   → vocab-recall
 *   - "cloze"      → kind="vocab", frontExtra=cloze  → sentence-mining
 *                                                      (and vocab-recall
 *                                                       with cloze face)
 *   - "sentence"   → kind="sentence", word=sentence  → sentence-cards
 *   - "bundle"     → emits BOTH a cloze-flavoured
 *                    vocab row AND a sentence row, so
 *                    one input fills two surfaces.
 *
 * "Reverse" (gloss → word direction) is intentionally NOT a separate
 * style here — vocab-recall already has a per-session production
 * round that drills every standard card in reverse. Surfacing it as
 * a creation choice would create duplicate rows; the session toggle
 * is the right place for the user to ask for reverse drilling.
 */

import type { ComponentType } from "react";
import {
  Boxes,
  Layers,
  ScanSearch,
  Sparkles,
  TextSelect,
} from "lucide-react";
import type { CardDraft } from "./card-enrich/api";
import type { VocabKind } from "./db";

export type CardStyleId = "standard" | "cloze" | "sentence" | "bundle";

/** One row's worth of data the composer will save. Mirrors
 *  `saveVocab` + `updateVocabFields` field names so the composer can
 *  call those in a tight loop without per-row remapping. */
export type ProducedCard = {
  word: string;
  reading: string | null;
  gloss: string | null;
  kind: VocabKind;
  frontExtra: string | null;
  cardNotes: string | null;
  /** Natural / native translation, alongside `gloss`. */
  translation: string | null;
  imageData: string | null;
  audioBytes: Uint8Array | null;
  audioMime: string | null;
};

export type CardStyle = {
  id: CardStyleId;
  name: string;
  /** Short pitch shown under the tab name in tooltips. */
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** Override the "Word" form label (e.g. "Sentence" for sentence
   *  style). Optional. */
  wordLabel?: string;
  /** Override the word input's placeholder. */
  wordPlaceholder?: string;
  /** Override the gloss form label (e.g. "Translation" for sentence
   *  style). Optional. */
  glossLabel?: string;
  /** When set, ONLY these auto-trigger enrichers run on word change.
   *  Use an empty array to disable all auto-enrichers (e.g. the
   *  sentence style has no use for dict-autoload). Omitting the
   *  field keeps the default behaviour (all auto enrichers run). */
  autoEnricherIds?: string[];
  /** Whether the inline dict typeahead in the word input is useful
   *  for this style. Off for sentence (the "word" is prose). */
  showTypeahead?: boolean;
  /** Turn the composer's draft into 1+ rows to save. Called on
   *  Save; the composer iterates the array. */
  produce: (draft: CardDraft) => ProducedCard[];
};

// ── Helpers ──────────────────────────────────────────────────────

/** Strip the `{{c1::word}}` markers from a cloze sentence, leaving
 *  the bare prose. Used by the bundle style to derive a plain
 *  sentence card from the cloze the user authored. */
function revealCloze(s: string): string {
  return s.replace(/\{\{c\d+::([^}]+)\}\}/g, "$1");
}

/** Build a row payload from the draft — all media + notes shared
 *  by every style. The caller overrides `kind` / `frontExtra` /
 *  `word` per style. */
function baseRow(d: CardDraft): Omit<ProducedCard, "kind" | "frontExtra"> {
  return {
    word: d.word,
    reading: d.reading,
    gloss: d.gloss,
    cardNotes: d.cardNotes,
    translation: d.translation,
    imageData: d.imageData,
    audioBytes: d.audioBytes,
    audioMime: d.audioMime,
  };
}

// ── Styles ───────────────────────────────────────────────────────

const standard: CardStyle = {
  id: "standard",
  name: "Standard",
  description: "Word on front, reading + meaning on back.",
  icon: Layers,
  showTypeahead: true,
  produce: (d) => [
    {
      ...baseRow(d),
      kind: "vocab",
      frontExtra: null,
    },
  ],
};

const cloze: CardStyle = {
  id: "cloze",
  name: "Cloze",
  description: "Sentence with the target word blanked out.",
  icon: ScanSearch,
  showTypeahead: true,
  // Auto-run dict-autoload (defaults) + ai-cloze so a fresh word
  // gets a sentence without the user clicking "Run". The user can
  // still edit the cloze before saving.
  autoEnricherIds: ["dict-autoload", "ai-cloze"],
  produce: (d) => [
    {
      ...baseRow(d),
      kind: "vocab",
      // Cloze cards REQUIRE a frontExtra to be meaningful. The
      // composer's Save button blocks if it's empty (validated
      // there, not here — the producer just emits what it gets).
      frontExtra: d.frontExtra,
    },
  ],
};

const sentence: CardStyle = {
  id: "sentence",
  name: "Sentence",
  description: "A full sentence as the unit of study.",
  icon: TextSelect,
  wordLabel: "Sentence",
  wordPlaceholder: "Type or paste a full sentence",
  glossLabel: "Translation",
  showTypeahead: false,
  // Dict-autoload would try to look up the entire sentence in the
  // dictionary, which is never useful. Disable all auto-enrichers
  // for this style — the user types translation + reading manually,
  // or runs a manual enricher (TTS) explicitly.
  autoEnricherIds: [],
  produce: (d) => [
    {
      ...baseRow(d),
      kind: "sentence",
      frontExtra: null,
    },
  ],
};

const bundle: CardStyle = {
  id: "bundle",
  name: "Bundle",
  description: "One input → a cloze-equipped vocab row + a sentence row.",
  icon: Boxes,
  showTypeahead: true,
  // Bundle wants a sentence — auto-run dict-autoload + ai-cloze so
  // the second row (the sentence) has content to derive from.
  autoEnricherIds: ["dict-autoload", "ai-cloze"],
  produce: (d) => {
    const rows: ProducedCard[] = [];
    // First row: the vocab card with cloze attached (if we have
    // one). The cloze flows into both `frontExtra` (the cloze
    // display) and `cardNotes` (translation, if ai-cloze populated
    // it).
    rows.push({
      ...baseRow(d),
      kind: "vocab",
      frontExtra: d.frontExtra,
    });
    // Second row: a standalone sentence card, ONLY when we actually
    // have a sentence. Without one, bundle degrades to "standard"
    // — single vocab row, no second row.
    if (d.frontExtra && d.frontExtra.trim()) {
      const sentenceText = revealCloze(d.frontExtra).trim();
      if (sentenceText && sentenceText !== d.word) {
        rows.push({
          ...baseRow(d),
          word: sentenceText,
          kind: "sentence",
          // Sentence card's "gloss" = the translation. ai-cloze
          // stores translations in cardNotes; fall back to the
          // vocab row's gloss if cardNotes is empty.
          gloss: d.cardNotes?.trim() || d.gloss,
          // Reading on a whole-sentence card is rarely useful; the
          // study surface speaks the sentence via TTS instead.
          reading: null,
          frontExtra: null,
        });
      }
    }
    return rows;
  },
};

export const CARD_STYLES: readonly CardStyle[] = [
  standard,
  cloze,
  sentence,
  bundle,
];

export function getCardStyle(id: CardStyleId): CardStyle {
  return CARD_STYLES.find((s) => s.id === id) ?? standard;
}

/** Marker icon for the per-style sparkle in the preview. Exported
 *  so the composer can render it without importing all the styles. */
export const STYLE_ACCENT_ICON = Sparkles;
