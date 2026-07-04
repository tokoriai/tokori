/**
 * tts-audio — synthesizes spoken audio for the target word and
 * attaches it to the card as `audioBytes` + `audioMime`.
 *
 * The composer also renders a richer `CardAudioField` inline (which
 * supports play / regenerate / clear), but the enricher exists so the
 * "Apply all" sweep can fill blank audio in one click, and so future
 * addons / the HTTP API can run TTS server-side without invoking the
 * audio-field React component.
 *
 * Trigger: `manual`. TTS calls can take 1–5 s (model load + synthesis)
 * and may incur cost on metered providers — never run automatically.
 *
 * Provider config is owned by the composer via `useTTS()`; the
 * enricher only sees the resulting `(text, lang) → bytes` capability,
 * which keeps it provider-agnostic and unit-testable.
 */

import { Mic } from "lucide-react";
import type { CardDraft, CardEnricher, CardPatch, EnricherContext } from "../api";

export const ttsAudio: CardEnricher = {
  meta: {
    id: "tts-audio",
    name: "TTS audio",
    description: "Synthesises spoken audio for the word and caches it on the card.",
    icon: Mic,
    targets: ["audioBytes", "audioMime"],
    trigger: "manual",
    priority: 25,
  },

  async run(draft: CardDraft, ctx: EnricherContext): Promise<CardPatch> {
    const word = draft.word.trim();
    if (!word) return {};
    if (!ctx.synthesize) return {}; // TTS not configured

    // Don't clobber existing audio — the composer's "Apply all" sweep
    // calls every enricher whose target is blank, so audio_bytes
    // already being present means the user already has audio they
    // care about. The audio-field's "Regen" button is the explicit
    // path for overwrite.
    if (draft.audioBytes && draft.audioBytes.byteLength > 0) return {};

    try {
      const out = await ctx.synthesize(word, draft.targetLang);
      if (!out.bytes || out.bytes.byteLength === 0) return {};
      return { audioBytes: out.bytes, audioMime: out.mime };
    } catch {
      // Composer surfaces user-facing errors when the user clicks the
      // button directly. In a sweep, swallow and continue — partial
      // success is better than aborting the whole batch on one failure.
      return {};
    }
  },
};

export default ttsAudio;
