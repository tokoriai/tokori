import { memo, useEffect, useMemo, useRef, useState } from "react";
import { type DictEntry, type VocabStatus } from "@/lib/db";
import { lookupDictCached, lookupVocabStatus } from "@/lib/word-lookup";
import type { LanguageCode } from "@/lib/languages";
import { useWorkspace } from "@/lib/workspace-context";
import { useDisplay } from "@/lib/display-context";
import { type Segment, intlSegment, segmentText } from "@/lib/segment";
import { type LookupResult, fromDict, fromMini } from "@/lib/lookup-result";
import { WordPopover } from "@/components/word-popover";

/**
 * Wrapped in `memo` so a parent re-render with the same `text`/`lang`/`showRuby`
 * doesn't re-fire the async jieba + dict pipeline. Without this, every
 * keystroke up the tree re-segmented every chat bubble — visible flicker on
 * the click-to-define underlines and laggy typing.
 */
export const Tokenized = memo(TokenizedInner);

function TokenizedInner({
  text,
  lang,
  showRuby,
  activeRange,
}: {
  text: string;
  lang: LanguageCode;
  /** Override the global pinyin toggle (e.g. live-voice transcript hides ruby). */
  showRuby?: boolean;
  /** [startChar, endChar) in `text` — the segment(s) overlapping this
   *  range get a karaoke-style highlight. Used by the reader's audio
   *  player to follow word/sentence position during TTS playback.
   *  `null` clears the highlight. */
  activeRange?: [number, number] | null;
}) {
  const display = useDisplay();
  const { active: workspace } = useWorkspace();
  // Synchronous fallback so the text renders immediately; jieba result swaps in.
  const [segments, setSegments] = useState<Segment[]>(() => intlSegment(text, lang));

  const seeded = useRef(true);
  useEffect(() => {
    let cancelled = false;
    // The useState initializer already segmented the initial text/lang, so the
    // synchronous fallback only needs to re-run when they CHANGE (to clear stale
    // segments before jieba resolves). Skipping it on mount drops a redundant
    // segmentation + the extra render it triggered — this is the per-word leaf.
    if (seeded.current) {
      seeded.current = false;
    } else {
      setSegments(intlSegment(text, lang));
    }
    void segmentText(text, lang).then((segs) => {
      if (!cancelled) setSegments(segs);
    });
    return () => {
      cancelled = true;
    };
  }, [text, lang]);

  const words = useMemo(
    () =>
      Array.from(new Set(segments.filter((s) => s.isWord).map((s) => s.text))),
    [segments],
  );
  const [entries, setEntries] = useState<Map<string, LookupResult | null>>(
    () => new Map(),
  );
  const [vocabStatus, setVocabStatus] = useState<Map<string, VocabStatus>>(
    () => new Map(),
  );
  // zh-only: composed per-character pinyin for tokens the dictionaries
  // don't know as whole words (jieba compounds, names, neologisms) —
  // keeps the ruby rail unbroken instead of leaving silent gaps.
  const [readingFallbacks, setReadingFallbacks] = useState<Map<string, string>>(
    () => new Map(),
  );

  const effectiveShowRuby = showRuby ?? display.showPinyin;

  useEffect(() => {
    if (words.length === 0) return;
    let cancelled = false;
    // Both lookups go through the shared coalescing cache in word-lookup.ts:
    //   - lookupDictCached: dict entries are immutable, so each (lang, word)
    //     is fetched at most once per session and every bubble on screen
    //     folds into one batch. This is what stops the repeated dict scans
    //     (the slow-query warnings) and the per-bubble cloud POSTs.
    //   - lookupVocabStatus: coalesced per tick but never cached, so the
    //     known/unknown underline always reflects the latest status.
    void (async () => {
      const [dictMap, statusMap] = await Promise.all([
        lookupDictCached(lang, words).catch(() => new Map<string, DictEntry>()),
        workspace
          ? lookupVocabStatus(workspace.id, words).catch(
              () => new Map<string, VocabStatus>(),
            )
          : Promise.resolve(new Map<string, VocabStatus>()),
      ]);
      if (cancelled) return;
      const pairs: [string, LookupResult | null][] = words.map((w) => {
        const hit = dictMap.get(w);
        if (hit) return [w, fromDict(hit)];
        // Mini bundled CC-CEDICT only matters for Chinese.
        return [w, lang === "zh" ? fromMini(w) : null];
      });

      // Pinyin fallback: jieba sometimes emits a multi-char token that
      // isn't a CC-CEDICT headword. Without a reading, those characters
      // rendered with a blank ruby rail. Compose a reading from the
      // individual characters instead — but only when EVERY character
      // resolves, so the syllable↔character alignment stays truthful
      // (a partial reading would float syllables over the wrong hanzi).
      const fallbacks = new Map<string, string>();
      if (lang === "zh") {
        const entryByWord = new Map(pairs);
        const unreadable = words.filter((w) => {
          if (entryByWord.get(w)?.reading) return false;
          return Array.from(w).length > 1;
        });
        if (unreadable.length > 0) {
          const chars = Array.from(
            new Set(unreadable.flatMap((w) => Array.from(w))),
          );
          const charMap = await lookupDictCached("zh", chars).catch(
            () => new Map<string, DictEntry>(),
          );
          if (cancelled) return;
          for (const w of unreadable) {
            const sylls = Array.from(w).map((ch) => {
              const reading =
                charMap.get(ch)?.reading ?? fromMini(ch)?.reading ?? "";
              // Single hanzi = single syllable; defensively take the
              // first in case a dict row carries a multi-syllable blob.
              return reading.trim().split(/\s+/)[0] ?? "";
            });
            if (sylls.every(Boolean)) fallbacks.set(w, sylls.join(" "));
          }
        }
      }

      setEntries(new Map(pairs));
      setVocabStatus(new Map(statusMap));
      setReadingFallbacks(fallbacks);
    })();
    return () => {
      cancelled = true;
    };
  }, [words, lang, workspace?.id]);

  // Walk the segments once + remember the running character offset
  // for each one. The WordPopover uses this offset to find the
  // sentence containing the word it represents, which the analyzer
  // modal then opens with.
  let cursor = 0;
  // Returns true when [offset, offset+len) overlaps activeRange. Half-
  // open intervals on both sides — the boundary case where a segment
  // ends exactly at the active range's start does NOT count as active.
  const isActive = (offset: number, len: number): boolean => {
    if (!activeRange) return false;
    const [start, end] = activeRange;
    return offset < end && offset + len > start;
  };
  // Languages that get a reading rail above the base text. Chinese
  // renders per-character (pinyin syllable per hanzi); Japanese renders
  // per-word (kana reading over the whole token, since we don't have
  // mecab-style char↔mora alignment in the browser). Both lanes share
  // the same `ruby-pinyin` flex column so the line-box stays uniform —
  // punctuation and non-word runs use the same empty skeleton.
  const rubyContext =
    effectiveShowRuby && (lang === "zh" || lang === "ja");
  return (
    <span className="inline">
      {segments.map((s, i) => {
        const offset = cursor;
        cursor += s.text.length;
        const active = isActive(offset, s.text.length);
        if (!s.isWord) {
          // Non-word segments — punctuation, whitespace, latin runs
          // dropped into Chinese prose. In a ruby context the
          // surrounding word tokens render each char inside an
          // inline-flex column with an `<rt>` row on top; a bare
          // span sits at the natural text baseline, which is well
          // above that column's char row. The result: punctuation
          // floats up beside the ruby chars. Wrap each char in the
          // same empty-ruby skeleton so every glyph in the line has
          // the same line-box shape.
          if (rubyContext) {
            return (
              <span key={i} className={active ? "tts-active" : undefined}>
                {[...s.text].map((ch, j) => (
                  <ruby key={j} className="ruby-pinyin">
                    <rt className="ruby-pinyin-rt" aria-hidden="true">
                      {" "}
                    </rt>
                    <span>{ch}</span>
                  </ruby>
                ))}
              </span>
            );
          }
          return (
            <span key={i} className={active ? "tts-active" : undefined}>
              {s.text}
            </span>
          );
        }
        const entry =
          entries.get(s.text) ??
          (lang === "zh" ? fromMini(s.text) : null);
        const status = vocabStatus.get(s.text) ?? null;
        // Render every word as an underlined hover trigger — even when we
        // don't have a dict entry yet. Without this, words that aren't in
        // the installed dictionary lost their underline + popover and
        // there was no way for the user to look them up. The fallback
        // popover offers a "search dictionary" jump so the user can dig
        // deeper from there.
        return (
          <WordPopover
            key={i}
            word={s.text}
            entry={entry}
            status={status}
            showRuby={rubyContext}
            lang={lang}
            sourceText={text}
            sourceOffset={offset}
            ttsActive={active}
            fallbackReading={readingFallbacks.get(s.text) ?? null}
          />
        );
      })}
    </span>
  );
}
