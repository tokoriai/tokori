/**
 * ai-cloze — generates a single example sentence containing the target
 * word and writes it into `frontExtra` with `{{c1::word}}` cloze markers.
 *
 * Reuses the production cloze generator that the sentence-mining study
 * plugin uses (`generateClozeSentences`), wired down to a one-card batch.
 * Same prompt, same parsing, same fallback behaviour — so the sentence
 * a user sees on Edit-card matches what they'd see in a Sentence-Mining
 * session.
 *
 * Trigger: `manual`. Costs an LLM call and ~1–3s of latency, so we
 * never run it automatically.
 *
 * If the model returns a sentence that doesn't actually contain the
 * word (small local models drift like this), the enricher returns an
 * empty patch instead of writing garbage — the user keeps whatever's
 * already in the field.
 */

import { Sparkles } from "lucide-react";
import type { CardDraft, CardEnricher, CardPatch, EnricherContext } from "../api";
import { generateClozeSentences } from "../../study/plugins/sentence-mining";
import type { LanguageCode } from "../../language-profiles";
import type { VocabEntry } from "../../db";
import { wrapAsCloze } from "../../cloze";

export const aiCloze: CardEnricher = {
  meta: {
    id: "ai-cloze",
    name: "AI cloze sentence",
    description: "Generates an example sentence with the target word masked.",
    icon: Sparkles,
    targets: ["frontExtra"],
    trigger: "manual",
    priority: 50,
  },

  async run(draft: CardDraft, ctx: EnricherContext): Promise<CardPatch> {
    const word = draft.word.trim();
    if (!word) return {};
    if (!ctx.sendChat) return {}; // no provider configured

    // Build a minimal VocabEntry stand-in for the existing batch API.
    // The generator only reads `word`, `gloss`, and `status` for prompt
    // building; the rest stays untouched. We use a synthetic id of 0
    // because the function never persists the card itself.
    const seedCard = {
      id: 0,
      workspaceId: draft.workspaceId,
      word,
      reading: draft.reading,
      gloss: draft.gloss,
      source: "card-enrich",
      status: "new" as const,
      kind: draft.kind,
      stability: 0,
      difficulty: 5,
      learningStep: 0,
      dueAt: null,
      lastReview: null,
      reviewCount: 0,
      createdAt: 0,
      imageData: null,
      hasImage: false,
      cardNotes: null,
      frontExtra: null,
      translation: null,
      layout: null,
      hasAudio: false,
      audioMime: null,
      isActive: true,
    };

    let knownVocab: VocabEntry[];
    try {
      knownVocab = await ctx.knownVocab();
    } catch {
      knownVocab = [];
    }

    let result;
    try {
      result = await generateClozeSentences({
        cards: [seedCard],
        knownVocab,
        level: "random", // no vocab gating from the card editor
        targetLang: draft.targetLang as LanguageCode,
        nativeLang: draft.nativeLang as LanguageCode,
        sendChat: ctx.sendChat,
      });
    } catch {
      // Provider error / network blip — toast comes from the composer.
      return {};
    }

    const first = result[0];
    if (!first?.sentence) return {};
    const cloze = wrapAsCloze(first.sentence, word);
    if (!cloze) return {};

    const patch: CardPatch = { frontExtra: cloze };
    // If the user has no card notes yet AND the model also returned a
    // translation, stash the translation in notes so the back of the
    // card shows what the sentence means. Don't overwrite existing
    // notes — that's user content.
    if (first.translation && !draft.cardNotes?.trim()) {
      patch.cardNotes = first.translation.trim();
    }
    return patch;
  },
};

export default aiCloze;
