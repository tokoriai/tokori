/**
 * Pure filter + sort helpers for the Flashcards → Browse table (the
 * Anki-style card browser). Kept out of the view so the column-sort and
 * filter logic — the bit with null-handling and ordering edge cases — is
 * unit-testable in isolation. The view layer owns formatting + state.
 */

import type { VocabEntry, VocabKind, VocabStatus } from "./db";

export type BrowseSortKey =
  | "word"
  | "type"
  | "status"
  | "due"
  | "interval"
  | "added"
  | "reviews";

export type SortDir = "asc" | "desc";

/** Every card status, in learning-progression order. The Browse status
 *  filter is a "show these" set seeded from this list. */
export const ALL_VOCAB_STATUSES: readonly VocabStatus[] = [
  "unseen",
  "new",
  "learning",
  "review",
  "mastered",
];

export type BrowseFilter = {
  search: string;
  /** Statuses to show. A card passes when its status is in the set —
   *  so hiding "known + unseen" is just dropping those two members. */
  statuses: ReadonlySet<VocabStatus>;
  kind: "all" | VocabKind;
};

// Learning progression, used to sort the Status column in a sensible
// order (unseen → … → mastered) rather than alphabetically.
const STATUS_RANK: Record<VocabStatus, number> = {
  unseen: 0,
  new: 1,
  learning: 2,
  review: 3,
  mastered: 4,
};

/** A card is overdue when it's an active, already-seen card whose due
 *  date has passed. New/unseen cards are never "overdue" — they've just
 *  never been scheduled. */
export function isOverdue(card: VocabEntry, nowSec: number): boolean {
  return (
    card.isActive &&
    card.dueAt != null &&
    card.dueAt < nowSec &&
    card.status !== "new" &&
    card.status !== "unseen"
  );
}

/** Current scheduling interval in whole days. FSRS stability is the
 *  memory half-life in days, which is the natural "interval" to show —
 *  it's what the next due gap is built from. */
export function intervalDays(card: VocabEntry): number {
  return Math.max(0, Math.round(card.stability));
}

export function filterVocab(
  rows: readonly VocabEntry[],
  filter: BrowseFilter,
): VocabEntry[] {
  let out = rows.filter((v) => filter.statuses.has(v.status));
  if (filter.kind !== "all") {
    out = out.filter((v) => v.kind === filter.kind);
  }
  const q = filter.search.trim().toLowerCase();
  if (q) {
    out = out.filter(
      (v) =>
        v.word.toLowerCase().includes(q) ||
        (v.reading?.toLowerCase().includes(q) ?? false) ||
        (v.gloss?.toLowerCase().includes(q) ?? false),
    );
  }
  return out;
}

// Map each sort key to a comparable primitive. Nulls (a card that has
// never been scheduled / reviewed) sort to the end regardless of
// direction, so toggling asc/desc never floats "no due date" cards to
// the top where they'd bury the actionable rows.
const NULL_LAST = Number.POSITIVE_INFINITY;

function sortValue(card: VocabEntry, key: BrowseSortKey): number | string {
  switch (key) {
    case "word":
      return card.word;
    case "type":
      return card.kind;
    case "status":
      return STATUS_RANK[card.status];
    case "due":
      return card.dueAt ?? NULL_LAST;
    case "interval":
      return intervalDays(card);
    case "added":
      return card.createdAt;
    case "reviews":
      return card.reviewCount;
  }
}

/** Stable sort by `key`/`dir`. Ties break on `word` (ascending) so the
 *  order is deterministic across re-renders. Null-valued numeric keys
 *  (e.g. due date on a new card) always sink to the bottom. */
export function sortVocab(
  rows: readonly VocabEntry[],
  key: BrowseSortKey,
  dir: SortDir,
): VocabEntry[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    let cmp: number;
    if (typeof va === "string" && typeof vb === "string") {
      cmp = va.localeCompare(vb);
    } else {
      // Push NULL_LAST to the bottom independent of direction.
      if (va === NULL_LAST && vb !== NULL_LAST) return 1;
      if (vb === NULL_LAST && va !== NULL_LAST) return -1;
      cmp = (va as number) - (vb as number);
    }
    if (cmp !== 0) return cmp * sign;
    // Deterministic tiebreak — same word ordering regardless of dir.
    return a.word.localeCompare(b.word);
  });
}
