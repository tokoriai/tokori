/**
 * AI text simplifier.
 *
 * Used by the reader to generate "intermediate" / "beginner" variants of a
 * chapter. Routes through whatever provider is currently active via the
 * provider context's sendChat, so it works with OpenAI, Anthropic, Gemini,
 * Ollama, MiniMax, or the demo mock.
 *
 * Each generated variant is saved as a child reader_document linked back to
 * the original via parent_id, so the next time the user clicks the same level
 * it loads instantly from disk.
 */

import type { LanguageCode } from "./languages";
import { computeLevel } from "./level";
import type { ReaderLevel, VocabEntry } from "./db";

export type SimplifyArgs = {
  body: string;
  level: ReaderLevel;
  targetLang: LanguageCode;
  nativeLang: LanguageCode;
  vocab: VocabEntry[];
  /** Computed user level from level.ts — drives "intermediate" target. */
  studentLevelId: string;
};

/**
 * Build a system prompt that asks the active LLM to rewrite `body` at the
 * requested difficulty level. Returns a `messages` array ready to feed into
 * `useProviderConfigs().sendChat()`.
 */
export function buildSimplifyMessages(args: SimplifyArgs): {
  role: "system" | "user";
  content: string;
}[] {
  const { body, level, targetLang, vocab, studentLevelId } = args;

  const known = vocab
    .filter((v) => v.status === "mastered" || v.status === "review")
    .slice(0, 100)
    .map((v) => v.word);

  const target = humanLang(targetLang);
  const learning =
    level === "beginner"
      ? "an absolute beginner (~300 known words)"
      : level === "intermediate"
        ? `an intermediate learner around ${studentLevelId}`
        : "a fluent reader";

  const system =
    `Rewrite this ${target} passage for ${learning}. Keep the meaning; adapt the difficulty:\n` +
    `- Swap rare vocab for everyday synonyms; break long sentences; plain phrasing.\n` +
    `- Preserve paragraph structure. Keep proper nouns. Idioms only if level-appropriate.\n` +
    `- Output ONLY the rewritten ${target} passage. No preamble, commentary, or translation.\n` +
    (known.length > 0
      ? `\nKnown words (${known.length}; lean on these): ${known.join(", ")}`
      : `\nAssume only the most common words are known.`);

  return [
    { role: "system", content: system },
    { role: "user", content: body },
  ];
}

function humanLang(code: LanguageCode): string {
  switch (code) {
    case "zh":
      return "Chinese";
    case "ja":
      return "Japanese";
    case "ko":
      return "Korean";
    case "de":
      return "German";
    case "es":
      return "Spanish";
    case "en":
      return "English";
    case "fr":
      return "French";
    case "it":
      return "Italian";
    case "pt":
      return "Portuguese";
    default:
      return code;
  }
}

/** Build a label/title for the saved variant — "Original title · Beginner" etc. */
export function levelTitle(originalTitle: string, level: ReaderLevel): string {
  if (level === "original") return originalTitle;
  const tag = level === "beginner" ? "Beginner" : "Intermediate";
  return `${originalTitle} · ${tag}`;
}

/** Compute the student's current level id for the simplifier prompt. */
export function studentLevelFor(args: {
  lang: LanguageCode;
  vocab: VocabEntry[];
  immersionHours: number;
  goalLevelId: string | null;
}): string {
  // Status-only approximation of the app-wide "words known" (studied
  // and not lapsing) — this module has no review log to replay, and a
  // coarse prompt-level estimate doesn't need leech precision.
  const known = args.vocab.filter(
    (v) => v.status === "mastered" || v.status === "review",
  ).length;
  const lvl = computeLevel(args.lang, known, args.immersionHours, args.goalLevelId);
  return lvl.current.id;
}
