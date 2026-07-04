import { useMemo } from "react";
import { parsePinyin } from "@/lib/pinyin";
import { cn } from "@/lib/utils";

export function Pinyin({
  raw,
  className,
}: {
  raw: string | null | undefined;
  className?: string;
}) {
  // <Pinyin> is a leaf rendered once per vocab row across long lists; parsePinyin
  // does NFD-normalize + regex + a backtracking syllable segmenter, so memoize on
  // `raw` to keep parent re-renders (hover, scroll, selection) from re-parsing.
  const syllables = useMemo(() => parsePinyin(raw), [raw]);
  if (syllables.length === 0) return null;
  return (
    <span className={cn("font-medium", className)}>
      {syllables.map((s, i) => (
        <span key={i} data-tone={s.tone} className="mr-0.5">
          {s.pretty}
        </span>
      ))}
    </span>
  );
}
