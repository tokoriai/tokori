import { describe, expect, it } from "vitest";
import {
  computeVocabGrowth,
  type GrowthReview,
  type GrowthVocab,
} from "@/lib/vocab-growth";

const DAY = 86_400;

// Fixed clock so day-boundaries are deterministic. `NOW` is 2024-01-15
// 12:00:00 UTC; day-ends fall on 23:59:59 local each day. Tests use
// timestamps measured relative to NOW so they're robust to timezone.
const NOW_MS = new Date("2024-01-15T12:00:00Z").getTime();
const NOW_S = Math.floor(NOW_MS / 1000);

function v(overrides: Partial<GrowthVocab> & { id: number }): GrowthVocab {
  return {
    createdAt: NOW_S - 60 * DAY,
    lastReview: null,
    stability: 0,
    dueAt: null,
    status: "new",
    ...overrides,
  };
}

function r(overrides: Partial<GrowthReview> & { vocabId: number }): GrowthReview {
  return {
    grade: "good",
    newStatus: "review",
    newDueAt: null,
    reviewedAt: NOW_S,
    ...overrides,
  };
}

describe("computeVocabGrowth", () => {
  it("returns [] for empty vocab", () => {
    const rows = computeVocabGrowth({ vocab: [], reviews: [], days: 7, now: NOW_MS });
    expect(rows).toEqual([]);
  });

  it("returns [] for days <= 0", () => {
    const rows = computeVocabGrowth({
      vocab: [v({ id: 1 })],
      reviews: [],
      days: 0,
      now: NOW_MS,
    });
    expect(rows).toEqual([]);
  });

  it("a never-reviewed card counts as Learning on every day after its creation", () => {
    const rows = computeVocabGrowth({
      vocab: [v({ id: 1, createdAt: NOW_S - 3 * DAY })],
      reviews: [],
      days: 5,
      now: NOW_MS,
    });
    expect(rows).toHaveLength(5);
    // Day-ends count back from NOW. With NOW at noon, the day-end 3
    // days before NOW lands AFTER the createdAt timestamp (which is
    // exactly 3 * 86400 seconds before NOW), so the card already
    // counts on that day. Only the earliest day-end (4d ago) is
    // before creation.
    expect(rows.map((row) => row.learning)).toEqual([0, 1, 1, 1, 1]);
    expect(rows.every((row) => row.known === 0 && row.due === 0 && row.leeches === 0)).toBe(
      true,
    );
  });

  it("a graduated card with future dueAt is Known on the day of graduation", () => {
    // Card created 2d ago, graduated to review yesterday with a due
    // date 30 days from now → should read Known yesterday + today.
    const rows = computeVocabGrowth({
      vocab: [
        v({
          id: 1,
          createdAt: NOW_S - 2 * DAY,
          status: "review",
          stability: 30,
          dueAt: NOW_S + 30 * DAY,
          lastReview: NOW_S - 1 * DAY,
        }),
      ],
      reviews: [
        r({
          vocabId: 1,
          newStatus: "review",
          newDueAt: NOW_S + 30 * DAY,
          reviewedAt: NOW_S - 1 * DAY,
        }),
      ],
      days: 4,
      now: NOW_MS,
    });
    // Day order: [-3d, -2d, -1d, today]. Creation was -2d, grad -1d.
    expect(rows.map((row) => row.known)).toEqual([0, 0, 1, 1]);
    // Before graduation, the card is in Learning.
    expect(rows.map((row) => row.learning)).toEqual([0, 1, 0, 0]);
  });

  it("a graduated card stays Known after dueAt passes (Due overlays it)", () => {
    // Graduated 5 days ago with a 2-day interval — overdue by 3 days.
    // Under inclusive semantics, Known should remain 1 throughout —
    // user hasn't forgotten the word, they just owe a review.
    const rows = computeVocabGrowth({
      vocab: [
        v({
          id: 1,
          createdAt: NOW_S - 10 * DAY,
          status: "review",
          stability: 2,
          dueAt: NOW_S - 3 * DAY,
          lastReview: NOW_S - 5 * DAY,
        }),
      ],
      reviews: [
        r({
          vocabId: 1,
          newStatus: "review",
          newDueAt: NOW_S - 3 * DAY,
          reviewedAt: NOW_S - 5 * DAY,
        }),
      ],
      days: 7,
      now: NOW_MS,
    });
    expect(rows.length).toBe(7);
    // Before review: Learning (created -10d, no review yet).
    expect(rows[0].learning).toBe(1); // -6d
    // After review: Known stays 1 every day, regardless of due-state.
    for (let i = 1; i < 7; i++) {
      expect(rows[i].known).toBe(1);
    }
    // Due overlays Known on days where dueAt is in the past.
    // dueAt = NOW - 3d (noon). Day-ends at -2d, -1d, 0d are all
    // strictly after dueAt — so Due = 1 there.
    expect(rows[4].due).toBe(1);
    expect(rows[5].due).toBe(1);
    expect(rows[6].due).toBe(1);
    // Sanity: Due is never larger than Known.
    for (const row of rows) {
      expect(row.due).toBeLessThanOrEqual(row.known);
    }
  });

  it("counts lapses across reviews and flips to Leech at the threshold", () => {
    // Card lapses 4 times in a row; threshold=4 → should appear in Leeches.
    const reviews: GrowthReview[] = [];
    for (let i = 0; i < 4; i++) {
      reviews.push(
        r({
          vocabId: 1,
          grade: "again",
          newStatus: "learning",
          newDueAt: NOW_S - (3 - i) * DAY,
          reviewedAt: NOW_S - (4 - i) * DAY,
        }),
      );
    }
    const rows = computeVocabGrowth({
      vocab: [
        v({
          id: 1,
          createdAt: NOW_S - 10 * DAY,
          status: "learning",
          lastReview: NOW_S - 1 * DAY,
        }),
      ],
      reviews,
      days: 6,
      leechThreshold: 4,
      now: NOW_MS,
    });
    // After the 4th lapse (reviewedAt = NOW - 1d), it's a Leech for
    // every day-end from -1d onward.
    expect(rows[rows.length - 1].leeches).toBe(1);
    expect(rows[rows.length - 1].learning).toBe(0);
    // Before any lapse landed, it was Learning.
    expect(rows[0].learning).toBe(1);
  });

  it("Due overlay grows as dueAt slides past day-end (Known stays put)", () => {
    // Graduated 3 days ago with a 1-day interval — due 2 days ago.
    // Known is 1 from review onward; Due flips from 0 → 1 once
    // dueAt is in the past relative to the day-end.
    const lastReview = NOW_S - 3 * DAY;
    const rows = computeVocabGrowth({
      vocab: [
        v({
          id: 1,
          createdAt: NOW_S - 10 * DAY,
          status: "review",
          stability: 1,
          dueAt: lastReview + 1 * DAY,
          lastReview,
        }),
      ],
      reviews: [
        r({
          vocabId: 1,
          newStatus: "review",
          newDueAt: lastReview + 1 * DAY,
          reviewedAt: lastReview,
        }),
      ],
      days: 6,
      now: NOW_MS,
    });
    // Day-ends: -5..0. Review at -3d, due at -2d.
    expect(rows[2].known).toBe(1); // -3d, review lands
    expect(rows[5].known).toBe(1); // 0d, still Known
    // By -1d (idx 4) and 0d (idx 5) the card is overdue.
    expect(rows[5].due).toBe(1);
    expect(rows[4].due).toBe(1);
  });

  it("Known is inclusive — overdue cards still count, Due is the subset overlay", () => {
    // Three cards graduated long ago. Card A is due in the future,
    // card B is overdue, card C lapsed back to Learning. Known
    // should be 2 (A + B); Due should be 1 (just B); Learning 1 (C).
    const reviewAt = NOW_S - 10 * DAY;
    const rows = computeVocabGrowth({
      vocab: [
        v({
          id: 1,
          createdAt: NOW_S - 30 * DAY,
          status: "review",
          stability: 30,
          dueAt: NOW_S + 20 * DAY,
          lastReview: reviewAt,
        }),
        v({
          id: 2,
          createdAt: NOW_S - 30 * DAY,
          status: "review",
          stability: 5,
          dueAt: NOW_S - 5 * DAY,
          lastReview: reviewAt,
        }),
        v({
          id: 3,
          createdAt: NOW_S - 30 * DAY,
          status: "learning",
          stability: 0.01,
          dueAt: NOW_S - 1 * DAY,
          lastReview: reviewAt,
        }),
      ],
      reviews: [
        r({ vocabId: 1, newStatus: "review", newDueAt: NOW_S + 20 * DAY, reviewedAt: reviewAt }),
        r({ vocabId: 2, newStatus: "review", newDueAt: NOW_S - 5 * DAY, reviewedAt: reviewAt }),
        r({ vocabId: 3, newStatus: "review", newDueAt: NOW_S - 5 * DAY, reviewedAt: reviewAt - DAY }),
        r({ vocabId: 3, grade: "again", newStatus: "learning", newDueAt: NOW_S - 1 * DAY, reviewedAt: reviewAt }),
      ],
      days: 3,
      now: NOW_MS,
    });
    const today = rows[rows.length - 1];
    expect(today.known).toBe(2);
    expect(today.due).toBe(1);
    expect(today.learning).toBe(1);
    expect(today.leeches).toBe(0);
    expect(today.due).toBeLessThanOrEqual(today.known);
  });

  it("real review log wins over synthetic fallback for the same vocab id", () => {
    // The vocab row says "review, due in 30 days" — if we used the
    // synthetic fallback we'd see Known. But the only real review
    // event we have is a recent lapse, which should flip the row
    // into Learning (and not generate a second synthetic event).
    const lapseAt = NOW_S - 1 * DAY;
    const rows = computeVocabGrowth({
      vocab: [
        v({
          id: 1,
          createdAt: NOW_S - 10 * DAY,
          status: "review",
          stability: 30,
          dueAt: NOW_S + 30 * DAY,
          lastReview: lapseAt,
        }),
      ],
      reviews: [
        r({
          vocabId: 1,
          grade: "again",
          newStatus: "learning",
          newDueAt: NOW_S + 10 * 60, // 10 minutes from now (relearning)
          reviewedAt: lapseAt,
        }),
      ],
      days: 3,
      now: NOW_MS,
    });
    // Today's bucket should be Learning, not Known.
    expect(rows[rows.length - 1].learning).toBe(1);
    expect(rows[rows.length - 1].known).toBe(0);
  });
});
