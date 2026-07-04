import { useMemo } from "react";
import { SpeakButton } from "@/components/speak-button";
import { romanizeHangul, romanizeSyllables } from "@/lib/romanize-ko";

/**
 * Korean right-rail card: the connected Revised-Romanization reading
 * (with liaison / nasalisation applied) over a per-syllable breakdown,
 * plus TTS. Hangul has no stroke-order dataset, so this is Korean's
 * answer to the CJK stroke panel. Renders nothing for a non-hangul
 * headword (e.g. a Latin loanword), so the rail collapses cleanly.
 */
export function PronunciationCard({ word }: { word: string }) {
  const syllables = useMemo(() => romanizeSyllables(word), [word]);
  const connected = useMemo(() => romanizeHangul(word), [word]);
  if (syllables.length === 0) return null;
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Pronunciation
      </h3>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="font-serif text-2xl leading-none">{word}</div>
          <div className="text-[13px] font-medium text-emerald-600 dark:text-emerald-400">
            {connected}
          </div>
        </div>
        <SpeakButton text={word} lang="ko" size="sm" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {syllables.map((s, i) => (
          <div
            key={i}
            className="flex min-w-[2.75rem] flex-col items-center rounded-lg border border-border bg-background/50 px-2.5 py-1.5"
          >
            <span className="font-serif text-lg leading-none">{s.syllable}</span>
            <span className="mt-1 text-[11px] text-muted-foreground">
              {s.roman}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
