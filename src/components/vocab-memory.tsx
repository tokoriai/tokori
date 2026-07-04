/**
 * Memory-strength + review-history surfaces shared by the dictionary
 * detail page (inline panel) and the vocabulary table (click-to-open
 * dialog). Centralises the FSRS stability → human-readable bucket
 * mapping so the two surfaces stay in lock-step — when we tune the
 * thresholds we only have to change them once.
 */

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  listVocabReviews,
  type VocabEntry,
  type VocabReview,
} from "@/lib/db";
import type { Grade } from "@/lib/fsrs";
import { cn } from "@/lib/utils";

/** Format an FSRS stability in days for display. The same value is
 *  used for review intervals, so the formatting follows Anki's
 *  convention: hours under a day, days under a month, months under a
 *  year, years past that. */
export function formatDays(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return "—";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 30) return `${Math.round(days * 10) / 10}d`;
  if (days < 365) return `${Math.max(1, Math.round(days / 30))}mo`;
  return `${Math.round((days / 365) * 10) / 10}y`;
}

/** Bucket FSRS stability into a 5-step strength category for the bar.
 *  Thresholds are loose — they roughly track Anki's "young / mature /
 *  buried" boundaries: <1d is brand-new / lapsed, 1–7d is the learning
 *  curve, 7–30d is consolidating, 30–90d is comfortable, 90+ is
 *  effectively known. The percentage is for the visual fill ratio. */
export function strengthBucket(stability: number): {
  label: string;
  fillClass: string;
  pct: number;
  rank: 0 | 1 | 2 | 3 | 4;
} {
  const s = Math.max(0, stability);
  if (s < 1) return { label: "Very weak", fillClass: "bg-rose-500", pct: 6, rank: 0 };
  if (s < 7) return { label: "Weak", fillClass: "bg-amber-500", pct: 25, rank: 1 };
  if (s < 30) return { label: "Building", fillClass: "bg-sky-500", pct: 50, rank: 2 };
  if (s < 90) return { label: "Strong", fillClass: "bg-violet-500", pct: 78, rank: 3 };
  return { label: "Mastered", fillClass: "bg-emerald-500", pct: 100, rank: 4 };
}

/** Compact horizontal strength bar + numeric badge. Width is fixed so
 *  it lines up cleanly inside a table cell; pass `wide` for the
 *  detail-page variant. */
export function StrengthBar({
  stability,
  wide = false,
  showLabel = false,
  className,
}: {
  stability: number | null;
  wide?: boolean;
  showLabel?: boolean;
  className?: string;
}) {
  if (stability == null || !Number.isFinite(stability) || stability <= 0) {
    return (
      <span className={cn("text-[11px] text-muted-foreground", className)}>
        —
      </span>
    );
  }
  const b = strengthBucket(stability);
  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <div
        className={cn(
          "h-1.5 overflow-hidden rounded-full bg-muted",
          wide ? "w-32" : "w-16",
        )}
      >
        <div
          className={cn("h-full transition-all", b.fillClass)}
          style={{ width: `${b.pct}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-muted-foreground">
        {formatDays(stability)}
      </span>
      {showLabel && (
        <span className="text-[11px] text-muted-foreground/80">{b.label}</span>
      )}
    </div>
  );
}

const GRADE_PILL: Record<Grade, string> = {
  again: "border-rose-500/40 text-rose-700 bg-rose-500/10 dark:text-rose-300",
  hard: "border-amber-500/40 text-amber-700 bg-amber-500/10 dark:text-amber-300",
  good: "border-sky-500/40 text-sky-700 bg-sky-500/10 dark:text-sky-300",
  easy: "border-emerald-500/40 text-emerald-700 bg-emerald-500/10 dark:text-emerald-300",
};

function GradeChip({ grade }: { grade: Grade }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-[10.5px] font-medium uppercase tracking-wider",
        GRADE_PILL[grade],
      )}
    >
      {grade}
    </span>
  );
}

/** Inline review-log list. Used by both the character-detail page
 *  (always rendered when there's a vocab row) and the modal dialog
 *  reached from the vocab table. Loads its own data so the parent
 *  doesn't have to thread the reviews list through. */
export function ReviewLogList({
  vocabId,
  limit = 50,
  empty,
}: {
  vocabId: number;
  limit?: number;
  /** Override the empty state — the dialog wants a cheerier copy than
   *  the inline page. */
  empty?: React.ReactNode;
}) {
  const [reviews, setReviews] = useState<VocabReview[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listVocabReviews(vocabId, limit)
      .then((rows) => {
        if (!cancelled) setReviews(rows);
      })
      .catch(() => {
        if (!cancelled) setReviews([]);
      });
    return () => {
      cancelled = true;
    };
  }, [vocabId, limit]);

  if (reviews === null) {
    return (
      <p className="text-[12.5px] text-muted-foreground">Loading review log…</p>
    );
  }
  if (reviews.length === 0) {
    return (
      <>
        {empty ?? (
          <p className="text-[12.5px] text-muted-foreground">
            No reviews yet — grade this card in a study session and the log
            will populate here.
          </p>
        )}
      </>
    );
  }
  return (
    <ul className="divide-y divide-border/40">
      {reviews.map((r) => {
        const interval =
          r.prevStability != null
            ? `${formatDays(r.prevStability)} → ${formatDays(r.newStability)}`
            : formatDays(r.newStability);
        return (
          <li
            key={r.id}
            className="flex items-center justify-between gap-3 py-1.5 text-[12.5px]"
          >
            <span className="flex items-center gap-2">
              <GradeChip grade={r.grade} />
              <span className="text-muted-foreground">
                {new Date(r.reviewedAt * 1000).toLocaleString()}
              </span>
            </span>
            <span className="tabular-nums text-muted-foreground">{interval}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Tall-form panel: strength bar + numeric stats + review log. Used
 *  inline on the character-detail page where there's plenty of room. */
export function MemoryPanel({ entry }: { entry: VocabEntry }) {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card/40 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Memory strength
          </p>
          <div className="mt-1.5">
            <StrengthBar stability={entry.stability} wide showLabel />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-right text-[12px]">
          <span className="text-muted-foreground">Reviews</span>
          <span className="tabular-nums">{entry.reviewCount}</span>
          <span className="text-muted-foreground">Difficulty</span>
          <span className="tabular-nums">
            {Number.isFinite(entry.difficulty) && entry.difficulty > 0
              ? entry.difficulty.toFixed(1)
              : "—"}
          </span>
          <span className="text-muted-foreground">Next due</span>
          <span className="tabular-nums">
            {entry.dueAt
              ? new Date(entry.dueAt * 1000).toLocaleDateString()
              : "—"}
          </span>
        </div>
      </div>
      <div className="border-t border-border/50 pt-3">
        <p className="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Review log
        </p>
        <ReviewLogList vocabId={entry.id} />
      </div>
    </div>
  );
}

/** Modal version — wraps `MemoryPanel` in a shadcn Dialog. The vocab
 *  table opens this from the strength column so a busy table view
 *  doesn't have to grow an inline expander. */
export function MemoryDialog({
  entry,
  open,
  onClose,
}: {
  entry: VocabEntry | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4" />
            <span className="font-serif text-2xl tracking-tight">
              {entry?.word ?? ""}
            </span>
            {entry?.reading && (
              <span className="text-[13px] text-muted-foreground">
                {entry.reading}
              </span>
            )}
          </DialogTitle>
          {entry?.gloss && (
            <DialogDescription className="line-clamp-2 text-left">
              {entry.gloss}
            </DialogDescription>
          )}
        </DialogHeader>
        {entry && <MemoryPanel entry={entry} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
