/**
 * Single source of truth for everything language-specific.
 *
 * Adding a new language means dropping a new entry in `LANGUAGE_PROFILES`
 * and — if it has its own packaged dictionary — adding an entry in
 * `src/lib/dictionaries/registry.ts`. No other files need to change.
 *
 * Field guide
 *   code              ISO 639-1 short code, used everywhere as the workspace key.
 *   name / nativeName Display strings.
 *   glyph             1-char monogram for sidebar avatars when no flag is shown.
 *   bcp47             Locale string passed to Intl.Segmenter and SpeechSynthesisUtterance.
 *   tokenizer         "jieba" → call into the Rust tokenize_zh command;
 *                     "intl"  → use the browser's Intl.Segmenter (fine for Latin
 *                               scripts, Korean phrasal eojeol, and Japanese
 *                               with the bundled ICU dictionary).
 *   hasReadings       Whether words have a separate phonetic reading (pinyin / furigana).
 *                     Drives ruby rendering and tone-color CSS.
 *   recommendedDict   Stable pack id from `DICTIONARY_PACKS` (or null if no
 *                     packaged dict ships yet — click-to-define then falls
 *                     back to the active LLM provider for translations).
 *   greeting          Chat-empty-state opener.
 *   hello             Just "Hello" / "Hi" in the language. Used by the
 *                     dashboard's per-workspace welcome line so a Japanese
 *                     workspace says "こんにちは, Flo" instead of "Welcome
 *                     back, Flo". Keep it short — one greeting word, no
 *                     punctuation, no exclamation; the caller decides how
 *                     to wrap it in prose.
 *   onboardingPreview Greeting shown in the onboarding dialog's right column.
 *   ttsSample         "Test voice" sample sentence in the target language.
 *   minimaxVoice      Default MiniMax voice_id for this language.
 *   supported         Hide unfinished languages from the workspace picker
 *                     without deleting the data — old workspaces keep working.
 */

export type LanguageCode =
  | "zh"
  | "ja"
  | "ko"
  | "de"
  | "es"
  | "en"
  // ── kept around for back-compat with workspaces created before the picker
  // was trimmed; new workspaces can no longer pick these. ──
  | "fr"
  | "it"
  | "pt";

export type TokenizerKind = "jieba" | "intl";

export type LanguageProfile = {
  code: LanguageCode;
  name: string;
  nativeName: string;
  glyph: string;
  bcp47: string;
  tokenizer: TokenizerKind;
  hasReadings: boolean;
  recommendedDict: string | null;
  greeting: string;
  hello: string;
  onboardingPreview: string;
  ttsSample: string;
  minimaxVoice: string;
  supported: boolean;
};

export const LANGUAGE_PROFILES: Record<LanguageCode, LanguageProfile> = {
  zh: {
    code: "zh",
    name: "Chinese (Mandarin)",
    nativeName: "中文",
    glyph: "中",
    bcp47: "zh-CN",
    tokenizer: "jieba",
    hasReadings: true,
    recommendedDict: "cc-cedict",
    greeting: "今天想练什么？",
    hello: "你好",
    onboardingPreview: "你好！我是你的中文老师。",
    ttsSample: "你好！今天怎么样？",
    minimaxVoice: "Chinese (Mandarin)_Warm_Bestie",
    supported: true,
  },
  ja: {
    code: "ja",
    name: "Japanese",
    nativeName: "日本語",
    glyph: "あ",
    bcp47: "ja-JP",
    tokenizer: "intl",
    hasReadings: true,
    recommendedDict: "jmdict-eng",
    greeting: "今日は何を練習しますか？",
    hello: "こんにちは",
    onboardingPreview: "こんにちは。日本語の練習を始めましょう。",
    ttsSample: "こんにちは。今日はどうですか？",
    minimaxVoice: "Japanese_Hashimoto",
    supported: true,
  },
  ko: {
    code: "ko",
    name: "Korean",
    nativeName: "한국어",
    glyph: "가",
    bcp47: "ko-KR",
    tokenizer: "intl",
    hasReadings: false,
    recommendedDict: "ko-krdict-yomitan",
    greeting: "오늘 무엇을 연습할까요?",
    hello: "안녕하세요",
    onboardingPreview: "안녕하세요! 함께 한국어를 연습합시다.",
    ttsSample: "안녕하세요. 오늘 어떠세요?",
    minimaxVoice: "Korean_CalmWoman",
    supported: true,
  },
  de: {
    code: "de",
    name: "German",
    nativeName: "Deutsch",
    glyph: "De",
    bcp47: "de-DE",
    tokenizer: "intl",
    hasReadings: false,
    recommendedDict: "de-yomitan-wiktionary",
    greeting: "Was möchtest du heute üben?",
    hello: "Hallo",
    onboardingPreview: "Hallo! Ich bin dein Deutschlehrer.",
    ttsSample: "Hallo, wie geht es dir heute?",
    minimaxVoice: "German_PlayfulMan",
    supported: true,
  },
  es: {
    code: "es",
    name: "Spanish",
    nativeName: "Español",
    glyph: "Es",
    bcp47: "es-ES",
    tokenizer: "intl",
    hasReadings: false,
    recommendedDict: "es-yomitan-wiktionary",
    greeting: "¿Qué quieres practicar hoy?",
    hello: "Hola",
    onboardingPreview: "¡Hola! Soy tu tutor de español.",
    ttsSample: "Hola, ¿cómo estás hoy?",
    minimaxVoice: "Spanish_DeepFemale",
    supported: true,
  },
  en: {
    code: "en",
    name: "English",
    nativeName: "English",
    glyph: "En",
    bcp47: "en-US",
    tokenizer: "intl",
    hasReadings: false,
    recommendedDict: null,
    greeting: "What would you like to practice today?",
    hello: "Hello",
    onboardingPreview: "Hi! I'm your conversation partner.",
    ttsSample: "Hello, how's your day going?",
    minimaxVoice: "English_Trustworth_Man",
    supported: true,
  },

  // ── Reserved entries for workspaces created before the picker was reduced.
  // These render correctly when loaded from the DB but are hidden from the
  // onboarding language list (supported: false). Reactivate by flipping the flag.
  fr: {
    code: "fr",
    name: "French",
    nativeName: "Français",
    glyph: "Fr",
    bcp47: "fr-FR",
    tokenizer: "intl",
    hasReadings: false,
    recommendedDict: null,
    greeting: "Que veux-tu pratiquer aujourd'hui ?",
    hello: "Bonjour",
    onboardingPreview: "Bonjour ! Je suis votre tuteur de français.",
    ttsSample: "Bonjour, comment vas-tu aujourd'hui ?",
    minimaxVoice: "French_Female_News",
    supported: false,
  },
  it: {
    code: "it",
    name: "Italian",
    nativeName: "Italiano",
    glyph: "It",
    bcp47: "it-IT",
    tokenizer: "intl",
    hasReadings: false,
    recommendedDict: null,
    greeting: "Cosa vuoi praticare oggi?",
    hello: "Ciao",
    onboardingPreview: "Ciao! Sono il tuo tutor di italiano.",
    ttsSample: "Ciao, come stai oggi?",
    minimaxVoice: "Italian_Female_News",
    supported: false,
  },
  pt: {
    code: "pt",
    name: "Portuguese",
    nativeName: "Português",
    glyph: "Pt",
    bcp47: "pt-PT",
    tokenizer: "intl",
    hasReadings: false,
    recommendedDict: null,
    greeting: "O que você quer praticar hoje?",
    hello: "Olá",
    onboardingPreview: "Olá! Sou o seu tutor de português.",
    ttsSample: "Olá, como você está hoje?",
    minimaxVoice: "Portuguese_Female_News",
    supported: false,
  },
};

/** All known languages in declaration order (includes hidden ones for back-compat). */
export const ALL_LANGUAGES: LanguageProfile[] = Object.values(LANGUAGE_PROFILES);

/** Languages selectable in the workspace onboarding picker. */
export const SUPPORTED_LANGUAGES: LanguageProfile[] = ALL_LANGUAGES.filter(
  (l) => l.supported,
);

/** Look up a profile by code; returns the English profile as a safe fallback. */
export function profileFor(code: string): LanguageProfile {
  return LANGUAGE_PROFILES[code as LanguageCode] ?? LANGUAGE_PROFILES.en;
}

// Vocative comma per script: fullwidth for Chinese, ideographic for
// Japanese, ASCII (with a trailing space) everywhere else — Korean and
// the Latin scripts all read naturally with ", ".
const NAME_COMMA: Partial<Record<LanguageCode, string>> = {
  zh: "，",
  ja: "、",
};

/**
 * Weave the learner's name into a language's tutor opener as a vocative
 * — "Hi, Sam!", "你好，Sam！", "Bonjour, Sam !". The name slots in right
 * after the greeting word (before the opener's first sentence
 * punctuation), preserving any space the script puts before that
 * punctuation, e.g. the French "Bonjour !". Returns the plain opener
 * unchanged when `name` is blank, so the onboarding preview reads
 * naturally before the user has typed anything.
 *
 * Pure + script-aware (the comma is chosen by `code`, not sniffed from
 * the text), so it's safe to call on every keystroke.
 */
export function tutorOpenerWithName(code: string, name: string): string {
  const opener = profileFor(code).onboardingPreview;
  const trimmed = name.trim();
  if (!trimmed) return opener;
  const comma = NAME_COMMA[code as LanguageCode] ?? ", ";
  const punct = opener.match(/[!！。.?？]/u);
  if (!punct || punct.index == null) return `${opener}${comma}${trimmed}`;
  const idx = punct.index;
  const head = opener.slice(0, idx);
  // Split off any space sitting before the punctuation so the comma
  // hugs the greeting word; re-attach the space after the name.
  const trailingSpace = head.match(/\s*$/)?.[0] ?? "";
  const greeting = head.slice(0, head.length - trailingSpace.length);
  return `${greeting}${comma}${trimmed}${trailingSpace}${opener.slice(idx)}`;
}
