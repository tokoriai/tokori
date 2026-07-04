/**
 * Hangul → Revised Romanization (the Korean "pinyin" for the sentence
 * analyzer's reading toggle).
 *
 * Decomposes each syllable block via Unicode math (0xAC00 + (cho·21 +
 * jung)·28 + jong) and maps jamo through the official RR tables, plus
 * the sound-change rules that matter most for a pronunciation aid:
 *
 *   - liaison: a coda re-syllabifies onto a following silent ㅇ onset
 *     (한국어 → hangugeo, 좋아 → joa)
 *   - nasalisation: k/t/p codas become ng/n/m before ㄴ/ㅁ
 *     (합니다 → hamnida)
 *   - lateralisation: ㄴ+ㄹ and ㄹ+ㄹ/ㄹ+ㄴ surface as ll
 *     (한라 → halla, 달라 → dalla, 실내 → silla)
 *
 * Deliberately NOT handled (rare in running text, and wrong guesses are
 * worse than the plain reading): palatalisation (같이 → gachi),
 * ㅎ-aspiration merges (좋다 → jota), and word-specific tensing. Non-
 * hangul characters pass through untouched, so mixed sentences keep
 * their punctuation and Latin runs.
 */

// Indexed by the Unicode jamo position within a syllable block.
const ONSET = [
  "g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j",
  "jj", "ch", "k", "t", "p", "h",
] as const;

const VOWEL = [
  "a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae",
  "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i",
] as const;

/** Coda as pronounced in final position (index 0 = no coda). */
const CODA_FINAL = [
  "", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l",
  "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t",
] as const;

/** Liaison split per coda: what stays in the syllable and what carries
 *  over as the next syllable's onset when that onset is silent ㅇ.
 *  Double codas split (ㄺ → l + g); ㅎ is silent before a vowel. */
const CODA_LIAISON: readonly [stay: string, carry: string][] = [
  ["", ""], // (none)
  ["", "g"], // ㄱ
  ["", "kk"], // ㄲ
  ["k", "s"], // ㄳ
  ["", "n"], // ㄴ
  ["n", "j"], // ㄵ
  ["n", "h"], // ㄶ
  ["", "d"], // ㄷ
  ["", "r"], // ㄹ
  ["l", "g"], // ㄺ
  ["l", "m"], // ㄻ
  ["l", "b"], // ㄼ
  ["l", "s"], // ㄽ
  ["l", "t"], // ㄾ
  ["l", "p"], // ㄿ
  ["l", "h"], // ㅀ
  ["", "m"], // ㅁ
  ["", "b"], // ㅂ
  ["p", "s"], // ㅄ
  ["", "s"], // ㅅ
  ["", "ss"], // ㅆ
  ["ng", ""], // ㅇ
  ["", "j"], // ㅈ
  ["", "ch"], // ㅊ
  ["", "k"], // ㅋ
  ["", "t"], // ㅌ
  ["", "p"], // ㅍ
  ["", ""], // ㅎ (silent before a vowel)
];

const NASALISED: Record<string, string> = { k: "ng", t: "n", p: "m" };

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;

type Syllable = { cho: number; jung: number; jong: number };

function decompose(codePoint: number): Syllable | null {
  if (codePoint < HANGUL_BASE || codePoint > HANGUL_LAST) return null;
  const idx = codePoint - HANGUL_BASE;
  return {
    cho: Math.floor(idx / (21 * 28)),
    jung: Math.floor((idx % (21 * 28)) / 28),
    jong: idx % 28,
  };
}

/** Romanize a run of text. Hangul syllables become Revised
 *  Romanization; everything else (spaces, punctuation, Latin, digits)
 *  passes through unchanged. */
export function romanizeHangul(text: string): string {
  const chars = [...text];
  const sylls = chars.map((c) => decompose(c.codePointAt(0) ?? 0));
  const out: string[] = [];
  // Onset override left behind by the previous syllable's sound-change
  // rule (liaison carry / lateralisation). Null = use the jamo table.
  let onsetOverride: string | null = null;
  for (let i = 0; i < chars.length; i++) {
    const s = sylls[i];
    if (!s) {
      out.push(chars[i]);
      onsetOverride = null; // sound changes don't cross non-hangul chars
      continue;
    }
    const onset = onsetOverride ?? ONSET[s.cho];
    onsetOverride = null;
    let coda: string = CODA_FINAL[s.jong];
    const next = sylls[i + 1] ?? null;
    if (s.jong !== 0 && next) {
      if (next.cho === 11) {
        // Silent ㅇ onset — the coda re-syllabifies onto it.
        const [stay, carry] = CODA_LIAISON[s.jong];
        coda = stay;
        if (carry) onsetOverride = carry;
      } else if (next.cho === 2 || next.cho === 6) {
        // ㄴ / ㅁ onset — k/t/p codas nasalise (합니다 → hamnida).
        coda = NASALISED[coda] ?? coda;
      } else if (next.cho === 5) {
        // ㄹ onset after ㄴ or ㄹ coda — both surface as ll.
        if (coda === "l" || coda === "n") {
          coda = "l";
          onsetOverride = "l";
        }
      }
    }
    // ㄹ coda + ㄴ onset also assimilates to ll (실내 → silla).
    if (coda === "l" && next?.cho === 2) onsetOverride = "l";
    out.push(onset + VOWEL[s.jung] + coda);
  }
  return out.join("");
}

/**
 * Romaja per hangul syllable block — one entry for each block, glyph paired
 * with its own romanization. Non-hangul characters (spaces, Latin,
 * punctuation) are skipped entirely.
 *
 * Each block is romanized in ISOLATION, so cross-syllable sound changes
 * (liaison, nasalisation) intentionally do NOT apply here: 한국어 →
 * [한 han, 국 guk, 어 eo], which differs from the connected reading
 * `romanizeHangul("한국어")` → "hangugeo". This is the right call for a
 * per-syllable reference card — the connected form is shown alongside it —
 * so don't "fix" the difference.
 */
export function romanizeSyllables(
  text: string,
): { syllable: string; roman: string }[] {
  const out: { syllable: string; roman: string }[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < HANGUL_BASE || cp > HANGUL_LAST) continue;
    out.push({ syllable: ch, roman: romanizeHangul(ch) });
  }
  return out;
}
