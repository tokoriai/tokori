/**
 * Pure grouping/derivation rules for the Immersion view.
 *
 * The view renders status *sections* (not a filter like Library):
 * "Continue watching" is what you reach for first, the planned queue
 * comes next, history last. Splitting the rules out keeps them
 * unit-testable (see `test/media-order.test.ts`) and the view focused
 * on layout.
 */

import type { LibraryItem } from "@/lib/db";

export type MediaGroups = {
  /** active + paused — the stuff mid-flight. Actives first (that's the
   *  "continue" shelf), paused after, each most-recently-touched first. */
  watching: LibraryItem[];
  /** planned — the backlog, in the order it was queued (oldest first),
   *  so the list reads top-to-bottom like a playlist. */
  upNext: LibraryItem[];
  /** finished — trophy shelf, most recent first. */
  finished: LibraryItem[];
  /** dropped — kept out of the way, most recent first. */
  dropped: LibraryItem[];
};

const byUpdatedDesc = (a: LibraryItem, b: LibraryItem) => b.updatedAt - a.updatedAt;
const byCreatedAsc = (a: LibraryItem, b: LibraryItem) => a.createdAt - b.createdAt;

export function groupMedia(items: readonly LibraryItem[]): MediaGroups {
  // Negative filter so a row with an unrecognized status (another
  // client, a future app version via sync) lands visibly in the
  // watching shelf instead of silently vanishing from every section.
  const watching = items.filter(
    (i) => i.status !== "planned" && i.status !== "finished" && i.status !== "dropped",
  );
  watching.sort(
    (a, b) =>
      Number(a.status === "paused") - Number(b.status === "paused") || byUpdatedDesc(a, b),
  );
  return {
    watching,
    upNext: items.filter((i) => i.status === "planned").sort(byCreatedAsc),
    finished: items.filter((i) => i.status === "finished").sort(byUpdatedDesc),
    dropped: items.filter((i) => i.status === "dropped").sort(byUpdatedDesc),
  };
}

/** Unit progress as 0–100, or null when there's no denominator to
 *  measure against (e.g. a channel you dip into, an unbounded podcast). */
export function mediaPercent(item: Pick<LibraryItem, "completedUnits" | "totalUnits">): number | null {
  if (!item.totalUnits || item.totalUnits <= 0) return null;
  return Math.min(100, Math.max(0, (item.completedUnits / item.totalUnits) * 100));
}

/** Whole minutes of tracked watch/listen time. */
export function minutesTracked(item: Pick<LibraryItem, "totalSeconds">): number {
  return Math.round(item.totalSeconds / 60);
}
