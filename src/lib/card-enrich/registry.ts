/**
 * Flat registry of built-in card enrichers. The composer iterates over
 * this list to render the "Enrichment" column and to dispatch the
 * `auto` / `manual` triggers.
 *
 * Adding a built-in: drop a file under `enrichers/`, default-export a
 * `CardEnricher`, append it here. Higher `meta.priority` runs first
 * when "Apply all" sweeps remaining enrichers.
 *
 * User-installable addons (manifest `kind: "card-enrichment"`) will
 * merge into this list at runtime once the Stage-2 sandboxed loader
 * lands — same staging as the study-plugin addons. The public surface
 * (`CardEnricher`) won't change between stages.
 */

import type { CardEnricher } from "./api";
import dictAutoload from "./enrichers/dict-autoload";
import aiCloze from "./enrichers/ai-cloze";
import ttsAudio from "./enrichers/tts-audio";

export const CARD_ENRICHERS: CardEnricher[] = [
  dictAutoload, // auto, priority 100 — cheap + deterministic
  aiCloze, //      manual, priority 50 — LLM call
  ttsAudio, //     manual, priority 25 — TTS call
];
