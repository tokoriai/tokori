import { describe, expect, it } from "vitest";
import {
  applyDailyLimits,
  buildStudySessionQueue,
} from "@/lib/study-config";

// Minimal shape — applyDailyLimits and buildStudySessionQueue are
// generic over `{ id, status }`, so the tests don't need to mint
// full VocabEntry rows.
type Card = { id: number; status: string };

const cfg = (review: number, neu: number) => ({
  dailyReviewLimit: review,
  dailyNewLimit: neu,
});

describe("study-config — applyDailyLimits", () => {
  it("returns the same list when nothing exceeds the caps", () => {
    const cards: Card[] = [
      { id: 1, status: "review" },
      { id: 2, status: "new" },
    ];
    expect(applyDailyLimits(cards, cfg(100, 100))).toEqual(cards);
  });

  it("caps reviews and new cards independently", () => {
    const cards: Card[] = [
      { id: 1, status: "review" },
      { id: 2, status: "review" },
      { id: 3, status: "review" },
      { id: 4, status: "new" },
      { id: 5, status: "new" },
    ];
    const result = applyDailyLimits(cards, cfg(2, 1));
    expect(result.map((c) => c.id)).toEqual([1, 2, 4]);
  });

  it("zero new limit removes new cards entirely", () => {
    const cards: Card[] = [
      { id: 1, status: "review" },
      { id: 2, status: "new" },
    ];
    expect(applyDailyLimits(cards, cfg(100, 0))).toEqual([
      { id: 1, status: "review" },
    ]);
  });

  it("returns reviews before new (matters for picker order)", () => {
    const cards: Card[] = [
      { id: 1, status: "new" },
      { id: 2, status: "review" },
    ];
    expect(applyDailyLimits(cards, cfg(10, 10)).map((c) => c.id)).toEqual([
      2, 1,
    ]);
  });
});

describe("study-config — buildStudySessionQueue", () => {
  it("dedupes due against vocab and applies daily limits", () => {
    const due: Card[] = [
      { id: 1, status: "learning" },
      { id: 2, status: "review" },
      { id: 3, status: "new" }, // already due, but status=new
    ];
    const allVocab: Card[] = [
      { id: 1, status: "learning" }, // already in due
      { id: 3, status: "new" }, // already in due — skip
      { id: 4, status: "new" }, // new candidate
      { id: 5, status: "new" }, // new candidate
      { id: 6, status: "mastered" }, // never picked
    ];
    const out = buildStudySessionQueue(due, allVocab, cfg(10, 10));
    // Reviews come first, then new; mastered is dropped, due-but-new
    // gets sorted with the news.
    const ids = out.map((c) => c.id).sort();
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    // Cards are unique.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("respects daily caps after deduping", () => {
    const due: Card[] = [
      { id: 1, status: "review" },
      { id: 2, status: "review" },
    ];
    const allVocab: Card[] = [
      { id: 1, status: "review" }, // dedupes against due
      { id: 9, status: "new" },
      { id: 10, status: "new" },
      { id: 11, status: "new" },
    ];
    const out = buildStudySessionQueue(due, allVocab, cfg(1, 2));
    expect(out).toHaveLength(3); // 1 review + 2 new
  });
});
