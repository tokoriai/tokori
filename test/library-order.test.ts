import { describe, expect, it } from "vitest";
import { filterAndOrderLibrary, sortActiveFirst } from "@/lib/library-order";
import type { LibraryItem, LibraryStatus } from "@/lib/db";

// Build a barebones LibraryItem — only the fields the order helpers
// inspect matter. The rest are filled with sensible defaults so test
// fixtures stay short and the next reader's eye lands on the bits
// that actually drive the assertions.
function mkItem(
  id: number,
  status: LibraryStatus,
  overrides: Partial<LibraryItem> = {},
): LibraryItem {
  return {
    id,
    workspaceId: 1,
    kind: "book",
    title: `item-${id}`,
    author: null,
    source: null,
    totalUnits: null,
    unitLabel: "pages",
    completedUnits: 0,
    totalSeconds: 0,
    status,
    coverUrl: null,
    notes: null,
    createdAt: id,
    updatedAt: id,
    ...overrides,
  };
}

describe("sortActiveFirst", () => {
  it("returns a new array (does not mutate input)", () => {
    const input = [mkItem(1, "paused"), mkItem(2, "active")];
    const out = sortActiveFirst(input);
    expect(out).not.toBe(input);
    expect(input.map((i) => i.id)).toEqual([1, 2]);
  });

  it("floats active items to the top", () => {
    const items = [
      mkItem(1, "paused"),
      mkItem(2, "active"),
      mkItem(3, "finished"),
      mkItem(4, "active"),
    ];
    expect(sortActiveFirst(items).map((i) => i.id)).toEqual([2, 4, 1, 3]);
  });

  it("preserves the original order within each group (stable)", () => {
    const items = [
      mkItem(1, "paused"),
      mkItem(2, "dropped"),
      mkItem(3, "finished"),
      mkItem(4, "active"),
      mkItem(5, "paused"),
      mkItem(6, "active"),
    ];
    // Two active (4, 6) up front, then non-active in their original order.
    expect(sortActiveFirst(items).map((i) => i.id)).toEqual([4, 6, 1, 2, 3, 5]);
  });

  it("is a no-op when no active items exist", () => {
    const items = [mkItem(1, "paused"), mkItem(2, "finished")];
    expect(sortActiveFirst(items).map((i) => i.id)).toEqual([1, 2]);
  });
});

describe("filterAndOrderLibrary", () => {
  const items = [
    mkItem(1, "active"),
    mkItem(2, "paused"),
    mkItem(3, "active"),
    mkItem(4, "finished"),
    mkItem(5, "dropped"),
  ];

  it("'all' keeps everything, with active first", () => {
    expect(filterAndOrderLibrary(items, "all").map((i) => i.id)).toEqual([
      1, 3, 2, 4, 5,
    ]);
  });

  it("a specific status filters to that status (no reordering needed)", () => {
    expect(filterAndOrderLibrary(items, "active").map((i) => i.id)).toEqual([1, 3]);
    expect(filterAndOrderLibrary(items, "paused").map((i) => i.id)).toEqual([2]);
    expect(filterAndOrderLibrary(items, "finished").map((i) => i.id)).toEqual([4]);
    expect(filterAndOrderLibrary(items, "dropped").map((i) => i.id)).toEqual([5]);
  });

  it("handles an empty list for every filter", () => {
    for (const f of ["all", "active", "paused", "finished", "dropped"] as const) {
      expect(filterAndOrderLibrary([], f)).toEqual([]);
    }
  });
});
