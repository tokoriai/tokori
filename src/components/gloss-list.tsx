/**
 * Renders a CC-CEDICT-style gloss as a numbered list of senses.
 *
 * Dictionary glosses for Chinese (and many JMdict entries) come back
 * as a single string with senses separated by semicolons:
 *   "to greet; to welcome; hello"
 *
 * Showing that as one run-on sentence makes it harder for the user to
 * pick out distinct senses. We split on `;` (with a fallback to `|`
 * which a few dumps use as the separator) and render each item with
 * a small "1, 2, 3" chip — same UX as Pleco / MDBG.
 *
 * `inline` lays the chips out in a wrapping row (good for compact
 * surfaces like flashcard backs); the default stacked layout is for
 * detail pages where readability beats density.
 */

import { cn } from "@/lib/utils";

export function parseGlossSenses(raw: string | null | undefined): string[] {
  if (!raw) return [];
  // Common separators across dictionary dumps.
  return raw
    .split(/\s*[;|]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function GlossList({
  gloss,
  inline = false,
  className,
}: {
  gloss: string | null | undefined;
  /** Lay the senses out in a wrapping row instead of a vertical list. */
  inline?: boolean;
  className?: string;
}) {
  const senses = parseGlossSenses(gloss);
  if (senses.length === 0) return null;

  // Single sense — drop the numbering, render as plain prose.
  if (senses.length === 1) {
    return (
      <p
        className={cn(
          "text-[14.5px] leading-relaxed text-foreground/90",
          className,
        )}
      >
        {senses[0]}
      </p>
    );
  }

  if (inline) {
    return (
      <ul
        className={cn(
          "flex flex-wrap items-baseline gap-x-3 gap-y-1.5",
          className,
        )}
      >
        {senses.map((s, i) => (
          <li
            key={i}
            className="inline-flex items-baseline gap-1.5 text-[13.5px] text-foreground/90"
          >
            <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium tabular-nums text-muted-foreground">
              {i + 1}
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ol className={cn("space-y-1.5", className)}>
      {senses.map((s, i) => (
        <li
          key={i}
          className="flex items-baseline gap-2 text-[14.5px] leading-relaxed text-foreground/90"
        >
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums text-muted-foreground">
            {i + 1}
          </span>
          <span className="flex-1">{s}</span>
        </li>
      ))}
    </ol>
  );
}
