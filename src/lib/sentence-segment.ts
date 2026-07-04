/**
 * Find the sentence that contains a given character position in a
 * piece of text. Used by the "analyze sentence" affordance in the
 * reader / chat — the user clicks a word, we walk outwards until we
 * hit sentence enders on both sides.
 *
 * Sentence enders cover Latin punctuation (.!?), CJK punctuation
 * (。！？), Arabic (؟), and hard line breaks. We don't try to be
 * clever about edge cases (e.g. "Mr." abbreviations) — a slightly-too-
 * long context window is harmless for the modal's use case and beats
 * a complex tokenizer.
 */

const SENTENCE_ENDERS = /[.!?。！？؟…\n\r]/;

export function sentenceAround(
  text: string,
  index: number,
): { sentence: string; start: number; end: number } {
  if (!text) return { sentence: "", start: 0, end: 0 };
  const i = Math.max(0, Math.min(text.length - 1, index));

  // Walk left until the previous sentence-ender (or text start).
  let start = i;
  while (start > 0) {
    const ch = text[start - 1];
    if (SENTENCE_ENDERS.test(ch)) break;
    start -= 1;
  }
  // Walk right past the current sentence's enders.
  let end = i;
  while (end < text.length) {
    const ch = text[end];
    end += 1;
    if (SENTENCE_ENDERS.test(ch)) break;
  }
  // Trim leading whitespace + closing quotes/spaces — keeps the modal
  // header clean. We don't strip the trailing punctuation because the
  // user wants to see it.
  let s = text.slice(start, end);
  const leading = s.length - s.trimStart().length;
  start += leading;
  s = s.slice(leading).trimEnd();
  end = start + s.length;
  return { sentence: s, start, end };
}

/** Every sentence in `text`, in order, with char ranges — drives the
 *  analyzer's prev/next navigation. Same ender rules as
 *  `sentenceAround`; runs that are nothing but punctuation (a stray
 *  "!!" tail after a sentence was consumed) are skipped. */
export function splitSentences(
  text: string,
): { sentence: string; start: number; end: number }[] {
  const out: { sentence: string; start: number; end: number }[] = [];
  const junk = /^[.!?。！？؟…\s]+$/;
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    const seg = sentenceAround(text, i);
    if (seg.sentence && !junk.test(seg.sentence)) out.push(seg);
    i = Math.max(seg.end, i + 1);
  }
  return out;
}
