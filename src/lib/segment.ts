import { invoke, isTauri } from "@tauri-apps/api/core";
import { HOSTED } from "@/lib/build-flags";
import { cloudTokenize } from "@/lib/cloud-dict";
import type { LanguageCode } from "@/lib/languages";

/** One token from the segmenter. `isWord` drives whether it becomes a
 *  clickable define cell (true) or inert punctuation/whitespace (false). */
export type Segment = { text: string; isWord: boolean };

export function intlSegment(text: string, lang: LanguageCode): Segment[] {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter === "undefined") {
    return [{ text, isWord: false }];
  }
  const seg = new Intl.Segmenter(lang, { granularity: "word" });
  const out: Segment[] = [];
  for (const part of seg.segment(text)) {
    out.push({ text: part.segment, isWord: Boolean(part.isWordLike) });
  }
  return out;
}

export async function segmentText(
  text: string,
  lang: LanguageCode,
): Promise<Segment[]> {
  // Chinese gets jieba via Rust when available — better word boundaries than
  // Intl.Segmenter, which over-splits compounds. In HOSTED (browser, no
  // Tauri) we route to the cloud's `/api/v1/tokenize` which does
  // dict-based max-match segmentation; same `{text, isWord}` shape as
  // the Rust command so the caller stays identical. Falls back to
  // Intl.Segmenter only when both desktop jieba and the cloud
  // tokenizer are unavailable (e.g. dev browser with no cloud).
  if (lang === "zh") {
    if (isTauri()) {
      try {
        const tokens = await invoke<{ text: string; is_word: boolean }[]>(
          "tokenize_zh",
          { text },
        );
        return tokens.map((t) => ({ text: t.text, isWord: t.is_word }));
      } catch {
        /* fall through */
      }
    } else if (HOSTED) {
      try {
        const tokens = await cloudTokenize(lang, text);
        return tokens;
      } catch {
        /* fall through */
      }
    }
  }
  return intlSegment(text, lang);
}
