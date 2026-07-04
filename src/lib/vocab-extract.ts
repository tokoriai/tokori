/**
 * Vocabulary extractor.
 *
 * Given the text of a RAG source (a textbook chapter, a note, an article),
 * walks every word, looks up the dictionary, and produces a sortable list
 * the user can review and save into a collection — same end result as a
 * curated pack import, but generated from whatever document the user
 * dropped in.
 *
 * The pipeline:
 *   1. Tokenise the text. Chinese uses jieba via the Rust `tokenize_zh`
 *      command (better word boundaries than Intl.Segmenter); other
 *      languages fall back to Intl.Segmenter, which handles Japanese
 *      kana, Korean eojeol, and Latin scripts.
 *   2. Count occurrences, drop trivial tokens (single Latin letters, pure
 *      digits, anything stripped down to whitespace).
 *   3. Look up each unique word in the installed dictionary. Skip words
 *      with no entry by default — they're typically proper nouns or noise.
 *   4. Cross-reference with the user's existing vocabulary so the dialog
 *      can highlight already-known words and skip them on demand.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { lookupDict, lookupVocabBatch, type DictEntry, type VocabStatus } from "./db";
import type { LanguageCode } from "./languages";

export type ExtractedWord = {
  word: string;
  count: number;
  /** Dictionary reading + gloss if available; null if unknown. */
  reading: string | null;
  gloss: string | null;
  /** Vocab status if the word is already saved in the workspace; null if not. */
  status: VocabStatus | null;
};

const TRIVIAL_RX = /^[\s\d.,!?;:'"`~()\[\]{}\-_/\\]+$/;
/** Words shorter than this in a Latin language usually aren't worth
 *  studying ("a", "is", "the"). For CJK, single chars are kept since
 *  those *are* often headwords. */
const MIN_LATIN_LEN = 3;

export async function extractVocabulary(args: {
  workspaceId: number;
  text: string;
  lang: LanguageCode;
  /** Cap how many unique words we attempt to look up — protects against
   *  pathological inputs and keeps the dialog usable. */
  maxUnique?: number;
}): Promise<ExtractedWord[]> {
  const tokens = await tokenizeForExtract(args.text, args.lang);

  // Count occurrences of word-like tokens only.
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (!t.isWord) continue;
    const w = t.text.trim();
    if (!w || TRIVIAL_RX.test(w)) continue;
    if (isLatinScript(args.lang) && w.length < MIN_LATIN_LEN) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  if (counts.size === 0) return [];

  // Sort by descending frequency, take the top maxUnique.
  const ordered = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, args.maxUnique ?? 1000);

  // Bulk vocab status lookup so we hit the DB once instead of per-word.
  const words = ordered.map(([w]) => w);
  const vocabMap = await lookupVocabBatch(args.workspaceId, words).catch(
    () => new Map(),
  );

  // Per-word dictionary lookup. Run them in parallel batches of 32 so a
  // 1,000-word document doesn't spawn 1,000 concurrent SQL calls.
  const out: ExtractedWord[] = [];
  const BATCH = 32;
  for (let i = 0; i < ordered.length; i += BATCH) {
    const slice = ordered.slice(i, i + BATCH);
    const dictHits: (DictEntry | null)[] = await Promise.all(
      slice.map(([w]) => lookupDict(args.lang, w).catch(() => null)),
    );
    slice.forEach(([w, c], j) => {
      const dict = dictHits[j];
      const v = vocabMap.get(w);
      out.push({
        word: w,
        count: c,
        reading: dict?.reading ?? null,
        gloss: dict?.gloss ?? null,
        status: v?.status ?? null,
      });
    });
  }
  return out;
}

/** Walk the raw text into segments. Chinese uses Rust+jieba (when in
 *  Tauri); everything else uses Intl.Segmenter. */
async function tokenizeForExtract(
  text: string,
  lang: LanguageCode,
): Promise<{ text: string; isWord: boolean }[]> {
  if (lang === "zh" && isTauri()) {
    try {
      return await invoke<{ text: string; is_word: boolean }[]>("tokenize_zh", {
        text,
      }).then((rows) => rows.map((r) => ({ text: r.text, isWord: r.is_word })));
    } catch {
      // fall through to intl
    }
  }
  if (typeof Intl === "undefined" || typeof Intl.Segmenter === "undefined") {
    return text.split(/\s+/).map((t) => ({ text: t, isWord: true }));
  }
  const seg = new Intl.Segmenter(lang, { granularity: "word" });
  const out: { text: string; isWord: boolean }[] = [];
  for (const part of seg.segment(text)) {
    out.push({ text: part.segment, isWord: Boolean(part.isWordLike) });
  }
  return out;
}

function isLatinScript(lang: LanguageCode): boolean {
  return lang === "en" || lang === "de" || lang === "es" || lang === "fr" || lang === "it" || lang === "pt";
}

// ─── Structured-vocabulary detection ──────────────────────────────────────
//
// Many textbooks publish a clean vocabulary table per lesson — the chapter's
// prose isn't where the curriculum's vocab list lives, the explicit
// "Vocabulary" section is. This pass scans for those sections, parses each
// entry into (word, reading, gloss), and groups by the lesson heading we
// found right above it.

/** A lesson-shaped slice of structured vocabulary detected in source text. */
export type VocabLesson = {
  /** The lesson / chapter title we attached this list to. Falls back to a
   *  positional label like "Section near line 412" when no obvious title
   *  precedes the vocab block. */
  title: string;
  /** Where in the document this list starts (line index). Used for sort
   *  stability and as a tiebreaker for the title fallback. */
  position: number;
  /** Heading text we matched (e.g. "Vocabulary", "生词", "Wortschatz") —
   *  shown in the dialog so the user sees why we picked this block. */
  headingMatch: string;
  words: { word: string; reading: string | null; gloss: string | null }[];
};

/**
 * Look for explicit vocabulary lists inside `text` and return one entry per
 * detected list. Empty array means nothing structured was found — caller
 * should fall back to frequency-based extraction.
 *
 * The detector errs on the side of fewer false positives: a "vocab section"
 * needs both a heading we recognise AND ≥3 lines that parse cleanly as
 * vocab rows. A textbook that has neither will yield no lessons.
 */
export function extractStructuredVocab(
  text: string,
  lang: LanguageCode,
): VocabLesson[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const lessons: VocabLesson[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = matchVocabHeading(line);
    if (!headingMatch) continue;

    // Title: look back up to ~10 lines for a "Lesson N" / "Chapter N" / 第N课
    // pattern. If nothing matches, use the heading itself as the title.
    let lessonTitle = headingMatch;
    for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
      const prev = lines[j].trim();
      if (matchLessonHeading(prev)) {
        lessonTitle = prev;
        break;
      }
    }

    // Walk forward until we hit either another heading or a long run of
    // blank lines (3+). Parse each line; collect successful parses.
    const words: VocabLesson["words"] = [];
    let blankRun = 0;
    let j = i + 1;
    while (j < lines.length) {
      const cur = lines[j];
      if (matchVocabHeading(cur) || matchLessonHeading(cur.trim())) {
        // Don't consume the next heading — leave it for the outer loop.
        j -= 1;
        break;
      }
      if (!cur.trim()) {
        blankRun += 1;
        if (blankRun >= 3) break;
        j += 1;
        continue;
      }
      blankRun = 0;
      const parsed = parseVocabLine(cur, lang);
      if (parsed) words.push(parsed);
      j += 1;
    }

    // Only accept blocks that look genuinely tabular. Two stray hits in a
    // chapter aren't a vocab list — it's just prose with hanzi.
    if (words.length >= 3) {
      lessons.push({
        title: lessonTitle.length > 80 ? lessonTitle.slice(0, 80) + "…" : lessonTitle,
        position: i,
        headingMatch,
        words,
      });
    }
    i = j;
  }
  return lessons;
}

/** A regex of every "vocabulary section" heading we recognise. Match is
 *  case-insensitive; the line must be mostly the heading (heuristically:
 *  ≤ ~30 visible chars) so we don't pick up paragraph mentions like
 *  "his vocabulary is impressive". */
const VOCAB_HEADING_RX =
  /^\s*(?:[\d.]+\s*)?(?<head>vocabulary|new\s+words|word\s+list|words?\s+to\s+know|glossary|生词(?:表)?|新词|词汇|生字|新出単語|新出語|単語|新しい言葉|語彙|어휘|새\s*단어|단어|wortschatz|vokabeln|neue\s+w(?:ö|oe)rter|w(?:ö|oe)rter|vocabulario|l(?:é|e)xico|palabras|vocabulaire|vocabolario)\s*[:：—–-]?\s*$/i;

function matchVocabHeading(line: string): string | null {
  if (line.length > 60) return null; // keep it heading-like
  const m = VOCAB_HEADING_RX.exec(line);
  return m?.groups?.head ?? null;
}

/** Lesson / chapter heading. Matches the common textbook patterns we see
 *  in the wild. Used to *label* a vocab block — never to gate extraction. */
const LESSON_HEADING_RX =
  /^(?:lesson|chapter|unit|leçon|lektion|lección|lezione|第\s*[一二三四五六七八九十百千零\d]+\s*(?:课|课文|章|話|節)|レッスン\s*\d+|단원\s*\d+)\b.*$/i;

function matchLessonHeading(line: string): boolean {
  if (!line || line.length > 80) return false;
  return LESSON_HEADING_RX.test(line);
}

/**
 * Parse one candidate row of a vocabulary table into (word, reading,
 * gloss). Returns null when the line clearly isn't a vocab row.
 *
 * Strategy: strip a leading "1." numbering, split on the strongest
 * separator we can find (tab > 2+ spaces > em-dash > pipe), then assign
 * fields based on script.
 */
function parseVocabLine(
  raw: string,
  lang: LanguageCode,
): { word: string; reading: string | null; gloss: string | null } | null {
  const line = raw.replace(/^\s*\d+[.\)、]\s*/, "").trim();
  if (!line) return null;

  // Pick the first separator that splits the line into ≥2 fields. We try
  // strong → weak so a tab-separated row doesn't get over-split by a stray
  // run of spaces.
  const seps: RegExp[] = [/\t+/, /\s*\|\s*/, /\s+[—–]\s+/, /\s{2,}/, /\s+/];
  let parts: string[] = [];
  for (const sep of seps) {
    const candidate = line.split(sep).map((s) => s.trim()).filter(Boolean);
    if (candidate.length >= 2) {
      parts = candidate;
      break;
    }
  }
  if (parts.length < 2) return null;

  const wordIdx = parts.findIndex((p) => containsTargetScript(p, lang));
  if (wordIdx < 0) return null;
  const word = parts[wordIdx];
  // The fields after the headword are the reading + gloss (or just gloss).
  const tail = parts.slice(wordIdx + 1);
  if (tail.length === 0) return null;

  let reading: string | null = null;
  let glossParts = tail;
  // If the first tail field looks like a romanisation/reading — purely
  // Latin + diacritics + tone digits + spaces — promote it.
  if (tail.length > 1 && looksLikeReading(tail[0], lang)) {
    reading = tail[0];
    glossParts = tail.slice(1);
  }
  // Strip parenthesised readings inside the headword, e.g. "食べる(taberu)".
  let cleanWord = word;
  if (!reading) {
    const m = /^(.+?)[（(]([^)）]+)[)）]\s*$/u.exec(word);
    if (m && containsTargetScript(m[1], lang)) {
      cleanWord = m[1].trim();
      reading = m[2].trim();
    }
  }

  const gloss = glossParts.join(" ").trim();
  if (!gloss) return null;
  return { word: cleanWord, reading, gloss };
}

function containsTargetScript(s: string, lang: LanguageCode): boolean {
  if (lang === "zh") return /[一-鿿]/.test(s);
  if (lang === "ja") return /[一-鿿぀-ヿ]/.test(s);
  if (lang === "ko") return /[가-힯]/.test(s);
  // For Latin-script langs, "target script" = at least one alphabetic char.
  return /[\p{L}]/u.test(s);
}

/** A field "looks like a reading" if it's overwhelmingly Latin letters
 *  (with diacritics + tone digits + spaces). For CJK this is the typical
 *  pinyin / romaji / romanisation column. */
function looksLikeReading(s: string, lang: LanguageCode): boolean {
  if (!s) return false;
  // Allow Hiragana/Katakana as a "reading" for Japanese.
  if (lang === "ja" && /^[぀-ヿ\s]+$/.test(s)) return true;
  // Otherwise: Latin letters + diacritics + 1-5 (tone digits) + space.
  return /^[a-zA-Zà-ÿĀ-žǎǐǒǔǘǚǜĀĒĪŌŪǍǏǑǓǗǙǛ̀-ͯ\d\s'`-]+$/u.test(s) &&
    /[a-zA-Z]/.test(s);
}
