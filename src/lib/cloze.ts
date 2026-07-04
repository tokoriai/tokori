/**
 * Tiny cloze helpers shared between the AI cloze enricher and any UI
 * that builds a cloze sentence from an existing string (e.g. the
 * click-to-define popover that turns "the sentence the click was in"
 * into a card's `front_extra`).
 *
 * The cloze syntax matches Anki's `{{c1::word}}` convention. The
 * composer renders the masked variant on the card's front and the
 * revealed variant on the back; the sentence-mining study plugin
 * uses the same shape for its drill.
 */

/** Wrap the first occurrence of `word` in `sentence` with a
 *  `{{c1::…}}` marker. Tries an exact match first (CJK + any locale
 *  with no case folding), then falls back to a case-insensitive
 *  match for Latin scripts so "Geht" inside the sentence stays
 *  "Geht" but matches a lookup of "geht". Returns null when the
 *  word can't be located — caller decides whether to ship the
 *  unmarked sentence anyway or discard. */
export function wrapAsCloze(sentence: string, word: string): string | null {
  if (!sentence || !word) return null;
  const exact = sentence.indexOf(word);
  if (exact >= 0) {
    return (
      sentence.slice(0, exact) +
      `{{c1::${word}}}` +
      sentence.slice(exact + word.length)
    );
  }
  const lower = sentence.toLowerCase().indexOf(word.toLowerCase());
  if (lower >= 0) {
    const surface = sentence.slice(lower, lower + word.length);
    return (
      sentence.slice(0, lower) +
      `{{c1::${surface}}}` +
      sentence.slice(lower + word.length)
    );
  }
  return null;
}
