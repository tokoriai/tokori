/**
 * Japanese pitch-accent helpers.
 *
 * The JA analogue of pinyin tone colours. A word's pronunciation has a
 * single "accent" number — the *drop* position — and that, combined
 * with the mora count, fully determines the per-mora high/low pattern
 * the renderer paints above the reading.
 *
 * Notation we accept (matches the kanjium / Yomitan compilations):
 *
 *   0 (heiban / 平板)         — no drop. Pattern: LHHH…H. Continues high
 *                               onto any following particle.
 *   1 (atamadaka / 頭高)      — drop after mora 1. Pattern: HLLL…L.
 *   N where 1<N<=moraCount    — nakadaka or odaka. Pattern: LHH…H(N) then
 *                               L on every mora past position N. When
 *                               N === moraCount the visible word pattern
 *                               matches heiban; the drop only shows on
 *                               the following particle.
 *
 * All exports are pure and synchronous; no DOM, no Intl. Renderer side
 * keeps `<Tokenized>` clean.
 */

/** High or low pitch on a single mora. Null when we don't have an
 *  accent number for the word (the caller still gets the mora split so
 *  it can render plain kana). */
export type Pitch = "high" | "low";

// Small kana that *attach* to the preceding base mora rather than
// counting as their own. Hiragana + katakana digraph helpers.
const SMALL_KANA = new Set("ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ");

/** Split a kana reading into mora. Handles digraphs (きょ, ちゃ, …),
 *  the moraic nasal (ん / ン), the geminate consonant (っ / ッ), and the
 *  katakana long-vowel mark (ー) — each of the last three counts as its
 *  own mora, per the standard pitch-accent convention. */
export function splitMora(reading: string): string[] {
  const mora: string[] = [];
  for (const ch of reading) {
    if (SMALL_KANA.has(ch) && mora.length > 0) {
      mora[mora.length - 1] += ch;
    } else {
      mora.push(ch);
    }
  }
  return mora;
}

/** Per-mora pitch pattern for an `accent` over `moraCount` mora. */
export function pitchPattern(moraCount: number, accent: number): Pitch[] {
  // Defensive: a negative or NaN accent reads as heiban so the caller
  // gets at least a sane shape instead of an empty / wrong array.
  const a = Number.isFinite(accent) && accent >= 0 ? Math.floor(accent) : 0;
  const out: Pitch[] = [];
  for (let i = 0; i < moraCount; i++) {
    if (i === 0) {
      out.push(a === 1 ? "high" : "low");
      continue;
    }
    if (a === 0) {
      out.push("high");
      continue;
    }
    out.push(i + 1 <= a ? "high" : "low");
  }
  return out;
}

export type MoraWithPitch = { mora: string; pitch: Pitch | null };

/** Convenience: split a reading into mora and tag each with its pitch
 *  for the renderer. Pass `accent === null` when there's no pitch data
 *  for this word — every mora gets `pitch: null`. */
export function pitchMora(
  reading: string,
  accent: number | null | undefined,
): MoraWithPitch[] {
  const mora = splitMora(reading);
  if (accent == null || !Number.isFinite(accent)) {
    return mora.map((m) => ({ mora: m, pitch: null }));
  }
  const pattern = pitchPattern(mora.length, accent);
  return mora.map((m, i) => ({ mora: m, pitch: pattern[i] }));
}

/** Short kind label — used by the popover to show the named category
 *  ("Heiban", "Atamadaka", …) so a learner who recognises one builds
 *  pattern recognition for the rest. */
export type PitchKind = "heiban" | "atamadaka" | "nakadaka" | "odaka";

export function pitchKind(moraCount: number, accent: number): PitchKind {
  if (accent === 0) return "heiban";
  if (accent === 1) return "atamadaka";
  if (accent >= moraCount) return "odaka";
  return "nakadaka";
}
