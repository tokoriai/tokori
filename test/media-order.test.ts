import { describe, expect, it } from "vitest";
import type { LibraryItem, LibraryStatus } from "@/lib/db";
import { groupMedia, mediaPercent, minutesTracked } from "@/lib/media/order";
import { isMediaKind, MEDIA_KINDS } from "@/lib/media/kinds";

let nextId = 1;
function item(overrides: Partial<LibraryItem> & { status: LibraryStatus }): LibraryItem {
  const id = nextId++;
  return {
    id,
    workspaceId: 1,
    kind: "video",
    title: `Item ${id}`,
    author: null,
    source: null,
    totalUnits: null,
    unitLabel: "minutes",
    completedUnits: 0,
    totalSeconds: 0,
    coverUrl: null,
    notes: null,
    createdAt: 1000 + id,
    updatedAt: 1000 + id,
    ...overrides,
  };
}

describe("groupMedia", () => {
  it("routes each status to its section", () => {
    const items = [
      item({ status: "planned" }),
      item({ status: "active" }),
      item({ status: "paused" }),
      item({ status: "finished" }),
      item({ status: "dropped" }),
    ];
    const g = groupMedia(items);
    expect(g.watching.map((i) => i.status)).toEqual(["active", "paused"]);
    expect(g.upNext).toHaveLength(1);
    expect(g.finished).toHaveLength(1);
    expect(g.dropped).toHaveLength(1);
  });

  it("puts the most recently touched active item first (continue watching)", () => {
    const stale = item({ status: "active", updatedAt: 100 });
    const fresh = item({ status: "active", updatedAt: 900 });
    const pausedFresh = item({ status: "paused", updatedAt: 999 });
    const g = groupMedia([stale, pausedFresh, fresh]);
    // Paused sinks below every active regardless of recency.
    expect(g.watching).toEqual([fresh, stale, pausedFresh]);
  });

  it("keeps the planned queue in add order, oldest first", () => {
    const second = item({ status: "planned", createdAt: 200 });
    const first = item({ status: "planned", createdAt: 100 });
    expect(groupMedia([second, first]).upNext).toEqual([first, second]);
  });

  it("shows freshly finished items first", () => {
    const old = item({ status: "finished", updatedAt: 10 });
    const recent = item({ status: "finished", updatedAt: 99 });
    expect(groupMedia([old, recent]).finished).toEqual([recent, old]);
  });
});

describe("mediaPercent", () => {
  it("derives percent from units and clamps to 0–100", () => {
    expect(mediaPercent({ completedUnits: 5, totalUnits: 10 })).toBe(50);
    expect(mediaPercent({ completedUnits: 15, totalUnits: 10 })).toBe(100);
    expect(mediaPercent({ completedUnits: -3, totalUnits: 10 })).toBe(0);
  });

  it("returns null without a denominator", () => {
    expect(mediaPercent({ completedUnits: 5, totalUnits: null })).toBeNull();
    expect(mediaPercent({ completedUnits: 5, totalUnits: 0 })).toBeNull();
  });
});

describe("minutesTracked", () => {
  it("rounds seconds to whole minutes", () => {
    expect(minutesTracked({ totalSeconds: 0 })).toBe(0);
    expect(minutesTracked({ totalSeconds: 90 })).toBe(2);
    expect(minutesTracked({ totalSeconds: 3600 })).toBe(60);
  });
});

describe("media kind split", () => {
  it("claims exactly the watch/listen kinds", () => {
    expect(MEDIA_KINDS).toEqual(["video", "series", "podcast"]);
    expect(isMediaKind("video")).toBe(true);
    expect(isMediaKind("series")).toBe(true);
    expect(isMediaKind("podcast")).toBe(true);
    expect(isMediaKind("book")).toBe(false);
    expect(isMediaKind("textbook")).toBe(false);
    expect(isMediaKind("article")).toBe(false);
    expect(isMediaKind("other")).toBe(false);
  });
});
