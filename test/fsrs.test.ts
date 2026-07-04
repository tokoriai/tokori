import { describe, expect, it } from "vitest";
import {
  schedule,
  DEFAULT_SRS_CONFIG,
  formatInterval,
  gradeIntervalHints,
  type Grade,
} from "@/lib/fsrs";
import type { VocabEntry } from "@/lib/db";

// VocabEntry has a lot of fields the scheduler doesn't read. Build
// just enough of one to exercise the SRS path under test.
function newCard(overrides: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id: 1,
    workspaceId: 1,
    word: "你好",
    reading: null,
    gloss: null,
    source: "manual",
    status: "new",
    kind: "vocab",
    stability: 0,
    difficulty: 5,
    learningStep: 0,
    dueAt: null,
    lastReview: null,
    reviewCount: 0,
    createdAt: 1_700_000_000,
    imageData: null,
    hasImage: false,
    cardNotes: null,
    frontExtra: null,
    hasAudio: false,
    audioMime: null,
    isActive: true,
    ...overrides,
  };
}

const NOW = 1_700_000_000;

describe("fsrs — schedule (learning phase)", () => {
  it("first 'good' on a new card graduates to review at the FSRS interval", () => {
    const card = newCard({ status: "new", learningStep: 0 });
    const next = schedule(card, "good", DEFAULT_SRS_CONFIG, NOW);
    // No more minute-scale ladder: a recalled card graduates straight to
    // FSRS review scheduling, seeded from the initial-stability weight
    // S0(good) = w[2] ≈ 3.17d, so the first interval is ~3 days.
    expect(next.status).toBe("review");
    const days = (next.dueAt - NOW) / 86400;
    expect(days).toBeGreaterThanOrEqual(2);
    expect(days).toBeLessThanOrEqual(5);
  });

  it("'hard' on a new card schedules ~1 day and leaves learning", () => {
    const card = newCard({ status: "new", learningStep: 0 });
    const next = schedule(card, "hard", DEFAULT_SRS_CONFIG, NOW);
    // The crux of the fix: Hard no longer drops a new card into a
    // 6-minute step that resurfaces the same sitting. S0(hard) = w[1] ≈
    // 1.18d → ~1 day, status review.
    expect(next.status).toBe("review");
    const days = (next.dueAt - NOW) / 86400;
    expect(days).toBeGreaterThanOrEqual(1);
    expect(days).toBeLessThan(2);
  });

  it("'easy' graduates a learning card with the longest first interval", () => {
    const card = newCard({ status: "new", learningStep: 0 });
    const next = schedule(card, "easy", DEFAULT_SRS_CONFIG, NOW);
    expect(next.status).toBe("review");
    // S0(easy) = w[3] ≈ 15.7d → roughly two weeks, and always longer
    // than a 'good' graduation.
    const days = (next.dueAt - NOW) / 86400;
    const good = schedule(card, "good", DEFAULT_SRS_CONFIG, NOW);
    expect(days).toBeGreaterThan((good.dueAt - NOW) / 86400);
    expect(days).toBeGreaterThanOrEqual(7);
  });

  it("grades are monotonic for a fresh new card (again < hard < good < easy)", () => {
    const card = newCard({ status: "new", learningStep: 0 });
    const again = schedule(card, "again", DEFAULT_SRS_CONFIG, NOW);
    const hard = schedule(card, "hard", DEFAULT_SRS_CONFIG, NOW);
    const good = schedule(card, "good", DEFAULT_SRS_CONFIG, NOW);
    const easy = schedule(card, "easy", DEFAULT_SRS_CONFIG, NOW);
    expect(again.dueAt).toBeLessThan(hard.dueAt);
    expect(hard.dueAt).toBeLessThan(good.dueAt);
    expect(good.dueAt).toBeLessThan(easy.dueAt);
    // Only "Again" stays a short in-session step; the rest are day-scale.
    expect(again.status).toBe("learning");
    expect(hard.status).toBe("review");
  });

  it("'again' on a learning card resets to the first short step", () => {
    const card = newCard({ status: "learning", learningStep: 1 });
    const next = schedule(card, "again", DEFAULT_SRS_CONFIG, NOW);
    expect(next.status).toBe("learning");
    expect(next.learningStep).toBe(0);
    // Back to the first learning step (default 1 minute).
    expect(next.dueAt).toBe(NOW + DEFAULT_SRS_CONFIG.learningSteps[0] * 60);
  });
});

describe("fsrs — schedule (review phase)", () => {
  it("'again' on a review card reschedules at the first learning step (1 minute)", () => {
    const card = newCard({
      status: "review",
      stability: 7,
      difficulty: 5,
    });
    const next = schedule(card, "again", DEFAULT_SRS_CONFIG, NOW);
    // A lapse goes back to learning at the same short step a brand-new
    // card gets — Again ALWAYS means "again in a minute", never a
    // 10-minute relearning ladder.
    expect(next.status).toBe("learning");
    expect(next.learningStep).toBe(0);
    expect(next.dueAt).toBe(NOW + DEFAULT_SRS_CONFIG.learningSteps[0] * 60);
  });

  it("'again' stays at the first step no matter how mature the card is", () => {
    for (const stability of [0.5, 7, 60, 365]) {
      const card = newCard({
        status: stability >= 365 ? "mastered" : "review",
        stability,
        difficulty: 6,
        lastReview: NOW - Math.round(stability) * 86400,
      });
      const next = schedule(card, "again", DEFAULT_SRS_CONFIG, NOW);
      expect(next.dueAt).toBe(NOW + DEFAULT_SRS_CONFIG.learningSteps[0] * 60);
      const hints = gradeIntervalHints(card, DEFAULT_SRS_CONFIG, NOW);
      expect(hints.again).toBe("1m");
    }
  });

  it("'good' on a review card extends the interval", () => {
    // FSRS keys on elapsed-since-last-review. A card with stability=7
    // that was actually reviewed 7 days ago is "due now" — simulate
    // that, otherwise the algorithm sees a fresh card and returns the
    // same interval (correctly — re-reviewing too early shouldn't
    // boost the schedule).
    const card = newCard({
      status: "review",
      stability: 7,
      difficulty: 5,
      lastReview: NOW - 7 * 86400,
    });
    const next = schedule(card, "good", DEFAULT_SRS_CONFIG, NOW);
    expect(next.status).toBe("review");
    const newInterval = (next.dueAt - NOW) / 86400;
    expect(newInterval).toBeGreaterThan(7);
  });

  it("'easy' grows faster than 'good' on the same card", () => {
    const base = {
      status: "review" as const,
      stability: 7,
      difficulty: 5,
      lastReview: NOW - 7 * 86400,
    };
    const good = schedule(newCard(base), "good", DEFAULT_SRS_CONFIG, NOW);
    const easy = schedule(newCard(base), "easy", DEFAULT_SRS_CONFIG, NOW);
    expect(easy.dueAt).toBeGreaterThan(good.dueAt);
  });

  it("interval is capped by maximumInterval", () => {
    const card = newCard({
      status: "review",
      stability: 1000, // wildly long stability
      difficulty: 5,
    });
    const next = schedule(card, "easy", DEFAULT_SRS_CONFIG, NOW);
    const days = (next.dueAt - NOW) / 86400;
    expect(days).toBeLessThanOrEqual(DEFAULT_SRS_CONFIG.maximumInterval);
  });
});

describe("fsrs — schedule (mastery)", () => {
  it("a card whose stability passes masteredThreshold flips to mastered", () => {
    const cfg = {
      ...DEFAULT_SRS_CONFIG,
      // Force the threshold low so a single 'easy' grade can cross it.
      masteredThreshold: 5,
    };
    const card = newCard({
      status: "review",
      stability: 30,
      difficulty: 4,
    });
    const next = schedule(card, "easy", cfg, NOW);
    expect(next.status).toBe("mastered");
  });
});

describe("fsrs — schedule (per-grade tally regression)", () => {
  it("each grade returns a finite, non-negative dueAt", () => {
    const grades: Grade[] = ["again", "hard", "good", "easy"];
    for (const g of grades) {
      const next = schedule(
        newCard({ status: "review", stability: 5 }),
        g,
        DEFAULT_SRS_CONFIG,
        NOW,
      );
      expect(Number.isFinite(next.dueAt)).toBe(true);
      expect(next.dueAt).toBeGreaterThan(NOW);
    }
  });
});

describe("fsrs — interval labels", () => {
  it("formatInterval renders compact Anki-style buckets", () => {
    expect(formatInterval(30)).toBe("<1m");
    expect(formatInterval(60)).toBe("1m");
    expect(formatInterval(6 * 60)).toBe("6m");
    expect(formatInterval(2 * 3600)).toBe("2h");
    expect(formatInterval(86400)).toBe("1d");
    expect(formatInterval(12 * 86400)).toBe("12d");
    expect(formatInterval(60 * 86400)).toBe("2mo");
    expect(formatInterval(400 * 86400)).toBe("1.1y");
  });

  it("gradeIntervalHints reflect what each grade would schedule", () => {
    const card = newCard({ status: "new", learningStep: 0 });
    const hints = gradeIntervalHints(card, DEFAULT_SRS_CONFIG, NOW);
    // New card: Again is a short step, Hard ~1d, Good ~3d, Easy ~2w.
    expect(hints.again).toMatch(/^(<1m|\dm)$/);
    expect(hints.hard).toBe("1d");
    expect(hints.good).toBe("3d");
    expect(hints.easy).toMatch(/d$/); // ~16 days
  });

  it("gradeIntervalHints are honest for a mature review card (Hard isn't 1d)", () => {
    // A well-known card reviewed on time: Hard should extend well past a
    // day — the static '~1d' label would have been a lie here.
    const card = newCard({
      status: "review",
      stability: 60,
      difficulty: 5,
      lastReview: NOW - 60 * 86400,
    });
    const hints = gradeIntervalHints(card, DEFAULT_SRS_CONFIG, NOW);
    expect(hints.hard).not.toBe("1d");
    // Good extends further than Hard, Easy further still.
    const order = ["again", "hard", "good", "easy"] as const;
    const dues = order.map(
      (g) => schedule(card, g, DEFAULT_SRS_CONFIG, NOW).dueAt,
    );
    expect(dues[1]).toBeLessThan(dues[2]);
    expect(dues[2]).toBeLessThan(dues[3]);
  });
});
