/**
 * Pure ordering helpers for the Library view.
 *
 * The view's "All" tab keeps the original chronological order from
 * `listLibrary()` but floats active items to the top. Splitting the
 * ranking out of the component lets us unit-test the ordering rules
 * without rendering React (see `test/library-order.test.ts`) and keeps
 * the view itself focused on layout + interaction.
 */

import type { LibraryItem, LibraryStatus } from "@/lib/db";

/** Active first, then the rest in their original order. Stable. */
export function sortActiveFirst<T extends { status: LibraryStatus }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active"));
}

/** Apply the Library view's filter + sort in one pass. Mirrors the
 *  semantics the LibraryView component uses: a specific status is a
 *  plain `where` filter; "all" preserves chronological order but
 *  surfaces active items first. */
export function filterAndOrderLibrary(
  items: readonly LibraryItem[],
  filter: LibraryStatus | "all",
): LibraryItem[] {
  if (filter === "all") return sortActiveFirst(items);
  return items.filter((i) => i.status === filter);
}
