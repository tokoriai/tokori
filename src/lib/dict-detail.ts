/**
 * Per-language capabilities for the dictionary detail page
 * (`CharacterDetail`). One flat switch keyed on the language code is the
 * single source of truth for what the rich detail view renders — which
 * reading style sits in the hero, whether stroke order applies, whether
 * the AI grammar profile is offered, and which right-rail variant shows.
 *
 * Kept as plain data (no classes, no profile coupling) so it's trivial to
 * read, diff, and unit-test. Adding a language = one `case`.
 */

export type ReadingKind = "pinyin" | "furigana" | "romaja" | "none";

export type SidebarKind = "stroke" | "pronunciation" | "glance" | "none";

export type DetailCaps = {
  /** How the hero renders `entry.reading`. */
  readingKind: ReadingKind;
  /** CJK ideograph stroke order is available (zh always; ja for kanji). */
  strokeOrder: boolean;
  /** Offer the AI-generated grammar profile (Latin languages). */
  grammar: boolean;
  /** Show the "words containing this character" list (zh only). */
  compounds: boolean;
  /** Right-rail variant. */
  sidebar: SidebarKind;
};

export function detailCaps(lang: string): DetailCaps {
  switch (lang) {
    case "zh":
      return {
        readingKind: "pinyin",
        strokeOrder: true,
        grammar: false,
        compounds: true,
        sidebar: "stroke",
      };
    case "ja":
      return {
        readingKind: "furigana",
        strokeOrder: true,
        grammar: false,
        compounds: false,
        sidebar: "stroke",
      };
    case "ko":
      return {
        readingKind: "romaja",
        strokeOrder: false,
        grammar: false,
        compounds: false,
        sidebar: "pronunciation",
      };
    case "de":
    case "es":
      return {
        readingKind: "none",
        strokeOrder: false,
        grammar: true,
        compounds: false,
        sidebar: "glance",
      };
    default:
      // English + the back-compat romance languages: a clean, bare detail
      // page with no script-specific affordances.
      return {
        readingKind: "none",
        strokeOrder: false,
        grammar: false,
        compounds: false,
        sidebar: "none",
      };
  }
}

/**
 * The characters in `word` that have HanziWriter stroke data: the CJK
 * Unified Ideographs block (U+4E00–U+9FFF). This matches Chinese hanzi
 * AND Japanese kanji while excluding kana and hangul, so a Japanese word
 * yields only its kanji (食べる → ["食"]) and a Korean / Latin word yields
 * none. Per-character availability inside the bundled dataset is handled
 * downstream by the stroke panel (some kokuji are absent).
 */
export function strokeOrderChars(word: string): string[] {
  return [...word].filter((c) => /[一-鿿]/.test(c));
}
