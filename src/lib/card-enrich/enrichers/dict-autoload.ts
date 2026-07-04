/**
 * dict-autoload — fills `reading` and `gloss` from the installed
 * dictionary, with a translate-engine fallback when the dictionary
 * has no entry for the word.
 *
 * Lifted from the inline `runLookup` in
 * `src/components/card-create-dialog.tsx` so the same behaviour is
 * reusable from the composer, the quick-add palette, and (later) the
 * HTTP/MCP create-vocab endpoints. Translate fallback is wired through
 * the composer-supplied `ctx.translateFallback` — the enricher itself
 * never reaches into the React tree for translate config.
 *
 * Trigger: `auto`. Runs on word-set with the composer's 500 ms debounce.
 *
 * Rule: never overwrite a field the user already filled. The composer
 * resets the draft on open, so on a fresh card any pre-filled values
 * came from a previous enricher run or seed (e.g. opened from a
 * click-to-define popover with a known word). Both are valid reasons
 * to leave them alone.
 */

import { BookOpen } from "lucide-react";
import type { CardDraft, CardEnricher, CardPatch, EnricherContext } from "../api";
import { prettyPinyin } from "../../pinyin";

export const dictAutoload: CardEnricher = {
  meta: {
    id: "dict-autoload",
    name: "Dict autoload",
    description: "Pulls reading + definition from the installed dictionary.",
    icon: BookOpen,
    targets: ["reading", "gloss"],
    trigger: "auto",
    priority: 100,
  },

  async run(draft: CardDraft, ctx: EnricherContext): Promise<CardPatch> {
    const word = draft.word.trim();
    if (!word) return {};

    // Nothing to do if both fields are already filled — the composer's
    // "user input wins" rule. If only one is missing the enricher still
    // runs but only patches the blank.
    const needsReading = !draft.reading?.trim();
    const needsGloss = !draft.gloss?.trim();
    if (!needsReading && !needsGloss) return {};

    let hit;
    try {
      hit = await ctx.lookupDict(draft.targetLang, word);
    } catch {
      // Dict unavailable / cloud down — treat as a miss so the
      // fallback can still try. Empty patch on total failure.
      hit = null;
    }

    if (hit) {
      const patch: CardPatch = {};
      if (needsReading && hit.reading) {
        // CC-CEDICT stores pinyin in numeric form ("ni3 hao3"). Save
        // the tone-marked form ("nǐ hǎo") so the reading reads as
        // pinyin everywhere it surfaces (input field, preview, vocab
        // list, flashcard) without per-call-site formatting.
        // prettyPinyin is idempotent on already-marked input and a
        // no-op on non-Chinese readings, so this is safe to always run.
        patch.reading =
          draft.targetLang === "zh" ? prettyPinyin(hit.reading) : hit.reading;
      }
      if (needsGloss && hit.gloss) patch.gloss = hit.gloss;
      return patch;
    }

    // No dict entry. Try translate fallback if the composer wired one.
    // Translate only fills gloss (it has no notion of phonetic
    // readings) — leave `reading` alone for the user to fill manually.
    if (!needsGloss || !ctx.translateFallback) return {};

    try {
      const translated = await ctx.translateFallback(
        draft.targetLang,
        draft.nativeLang,
        word,
      );
      if (translated && translated.trim()) {
        return { gloss: translated.trim() };
      }
    } catch {
      /* network blip — return empty patch silently */
    }
    return {};
  },
};

export default dictAutoload;
