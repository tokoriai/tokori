import { Pinyin } from "@/components/pinyin";
import { detailCaps } from "@/lib/dict-detail";
import { pitchMora } from "@/lib/pitch";
import { cn } from "@/lib/utils";

/** Render a Japanese reading with per-mora pitch colour. When `accent` is
 *  null the kana stays uncoloured — the renderer degrades to a plain
 *  string. Shared by the word popover (per-token furigana + header) and
 *  the dictionary detail hero. */
export function PitchKana({
  reading,
  accent,
}: {
  reading: string;
  accent: number | null | undefined;
}) {
  // Without an accent number we have nothing to colour; render the raw
  // reading so callers don't have to special-case the null path.
  if (accent == null) return <>{reading}</>;
  const mora = pitchMora(reading, accent);
  return (
    <>
      {mora.map((m, i) => (
        <span
          key={i}
          // `pitch-high` / `pitch-low` are tiny utility classes defined in
          // `index.css` so the colour stays a theme token — no ad-hoc hex.
          className={
            m.pitch === "high"
              ? "pitch-high"
              : m.pitch === "low"
                ? "pitch-low"
                : undefined
          }
        >
          {m.mora}
        </span>
      ))}
    </>
  );
}

/**
 * One renderer for a headword's phonetic reading, dispatched by language:
 *   - pinyin   → tone-coloured `<Pinyin>` (Chinese)
 *   - furigana → pitch-coloured kana via `<PitchKana>` (Japanese)
 *   - romaja / none → plain text
 * Returns null when there's no reading to show, so callers can drop it in
 * unconditionally.
 */
export function Reading({
  lang,
  reading,
  pitchAccent,
  className,
}: {
  lang: string;
  reading: string | null | undefined;
  pitchAccent?: number | null;
  className?: string;
}) {
  if (!reading) return null;
  switch (detailCaps(lang).readingKind) {
    case "pinyin":
      return <Pinyin raw={reading} className={className} />;
    case "furigana":
      return (
        <span className={cn("font-medium", className)}>
          <PitchKana reading={reading} accent={pitchAccent} />
        </span>
      );
    case "romaja":
    case "none":
      return <span className={cn("font-medium", className)}>{reading}</span>;
  }
}
