/**
 * Public language API. All implementation lives in `language-profiles.ts`;
 * this file is the stable surface that the rest of the app imports against.
 *
 * Adding a language:
 *   1. Drop a new entry in LANGUAGE_PROFILES (in language-profiles.ts).
 *   2. If it has a dedicated dictionary, add a pack in dictionaries-section.tsx.
 *   3. Optionally tune the tokenizer hint or pinyin/ruby flags.
 * Nothing else in the app needs to change.
 */

import {
  ALL_LANGUAGES,
  LANGUAGE_PROFILES,
  profileFor,
  SUPPORTED_LANGUAGES,
  type LanguageProfile,
} from "./language-profiles";

export type { LanguageCode, LanguageProfile, TokenizerKind } from "./language-profiles";
export {
  ALL_LANGUAGES,
  LANGUAGE_PROFILES,
  SUPPORTED_LANGUAGES,
  profileFor,
  tutorOpenerWithName,
} from "./language-profiles";

// ── Back-compat shape: keep the old { code, name, nativeName, glyph } objects
// the workspace switcher and a few other places already consume by keying on
// `.code`/`.name`/etc. Behaviour is identical; older callers don't need to know
// about profiles.
export type Language = Pick<
  LanguageProfile,
  "code" | "name" | "nativeName" | "glyph"
> & { flag?: string };

/** All languages in the system (including hidden / coming-soon ones). */
export const LANGUAGES: Language[] = ALL_LANGUAGES.map(toShort);

function toShort(p: LanguageProfile): Language {
  return {
    code: p.code,
    name: p.name,
    nativeName: p.nativeName,
    glyph: p.glyph,
  };
}

/** Languages selectable in the workspace picker. */
export const PICKABLE_LANGUAGES: Language[] = SUPPORTED_LANGUAGES.map(toShort);

export function languageName(code: string): string {
  return LANGUAGE_PROFILES[code as keyof typeof LANGUAGE_PROFILES]?.name ?? code;
}

export function languageGlyph(code: string): string {
  return (
    LANGUAGE_PROFILES[code as keyof typeof LANGUAGE_PROFILES]?.glyph ??
    code.toUpperCase()
  );
}

export function languageNative(code: string): string {
  return (
    LANGUAGE_PROFILES[code as keyof typeof LANGUAGE_PROFILES]?.nativeName ?? code
  );
}

/** BCP-47 string for Intl.Segmenter, SpeechSynthesis, and TTS providers. */
export function bcp47(code: string): string {
  return profileFor(code).bcp47;
}

/** Localised "Hello" for the workspace's target language — e.g.
 *  `你好`, `こんにちは`, `Hallo`. Used by the dashboard's per-
 *  workspace welcome line so the greeting reads in the language
 *  the user is learning. Falls back to "Hello" for unknown codes. */
export function helloFor(code: string): string {
  return LANGUAGE_PROFILES[code as keyof typeof LANGUAGE_PROFILES]?.hello ?? "Hello";
}
