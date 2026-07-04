import { describe, expect, it } from "vitest";
import {
  startOfToday,
  studyTotals,
  summarizeReviews,
  vocabStatusCounts,
  wordsAddedSince,
} from "@/lib/study-stats";
import { longestStreak } from "@/lib/streak";
import type { StudySession, VocabEntry, VocabReview } from "@/lib/db";

// Fixed "now" + day boundaries anchored to the function's own local-midnight
// math, so the assertions are timezone-independent (we never place a
// timestamp near a midnight a different TZ would bucket differently).
const NOW = 1_700_000_000;
const TODAY = startOfToday(NOW);
const today1am = TODAY + 3600;
const yesterday = TODAY - 3600; // 11pm "yesterday" local
const DAY = 86_400;

function mkVocab(over: Partial<VocabEntry>): VocabEntry {
  return {
    id: 1,
    workspaceId: 1,
    word: "x",
    reading: null,
    gloss: null,
    source: "manual",
    status: "new",
    kind: "vocab",
    stability: 0,
    difficulty: 0,
    learningStep: 0,
    dueAt: null,
    lastReview: null,
    reviewCount: 0,
    createdAt: TODAY,
    imageData: null,
    hasImage: false,
    cardNotes: null,
    frontExtra: null,
    translation: null,
    layout: null,
    hasAudio: false,
    audioMime: null,
    isActive: true,
    ...over,
  };
}

function mkSession(over: Partial<StudySession>): StudySession {
  return {
    id: 1,
    workspaceId: 1,
    kind: "review",
    startedAt: today1am,
    endedAt: today1am + 600,
    durationSecs: 600,
    wordsSeen: 0,
    wordsSaved: 0,
    notes: null,
    ...over,
  };
}

function mkReview(over: Partial<VocabReview>): VocabReview {
  return {
    id: 1,
    vocabId: 1,
    grade: "good",
    prevStatus: null,
    newStatus: "review",
    prevStability: null,
    newStability: 1,
    prevDueAt: null,
    newDueAt: null,
    reviewedAt: today1am,
    ...over,
  };
}

describe("study-stats — vocabStatusCounts", () => {
  it("counts by status, total, and active", () => {
    const counts = vocabStatusCounts([
      mkVocab({ status: "mastered" }),
      mkVocab({ status: "mastered" }),
      mkVocab({ status: "learning" }),
      mkVocab({ status: "review", isActive: false }),
      mkVocab({ status: "new" }),
    ]);
    expect(counts.mastered).toBe(2);
    expect(counts.learning).toBe(1);
    expect(counts.review).toBe(1);
    expect(counts.new).toBe(1);
    expect(counts.total).toBe(5);
    expect(counts.active).toBe(4); // one review row is library-only
  });

  it("is all-zero for an empty list", () => {
    const counts = vocabStatusCounts([]);
    expect(counts.total).toBe(0);
    expect(counts.mastered).toBe(0);
    expect(counts.active).toBe(0);
  });
});

describe("study-stats — summarizeReviews", () => {
  it("computes retention as the non-again share", () => {
    const s = summarizeReviews(
      [
        mkReview({ grade: "again" }),
        mkReview({ grade: "hard" }),
        mkReview({ grade: "good" }),
        mkReview({ grade: "easy" }),
      ],
      NOW,
    );
    expect(s.total).toBe(4);
    expect(s.byGrade).toEqual({ again: 1, hard: 1, good: 1, easy: 1 });
    expect(s.retention).toBeCloseTo(0.75); // 3 of 4 recalled
  });

  it("counts only today's reviews in reviewsToday", () => {
    const s = summarizeReviews(
      [
        mkReview({ reviewedAt: today1am }),
        mkReview({ reviewedAt: today1am + 100 }),
        mkReview({ reviewedAt: yesterday }),
        mkReview({ reviewedAt: TODAY - 5 * DAY }),
      ],
      NOW,
    );
    expect(s.total).toBe(4);
    expect(s.reviewsToday).toBe(2);
  });

  it("returns 0 retention with no reviews (no divide-by-zero)", () => {
    expect(summarizeReviews([], NOW).retention).toBe(0);
  });
});

describe("study-stats — studyTotals", () => {
  it("rolls up total / today / week windows", () => {
    const totals = studyTotals(
      [
        mkSession({ startedAt: today1am, durationSecs: 600 }), // today + week + total
        mkSession({ startedAt: TODAY - 3 * DAY, durationSecs: 1200 }), // week + total
        mkSession({ startedAt: TODAY - 10 * DAY, durationSecs: 1800 }), // total only
        mkSession({ startedAt: today1am, durationSecs: null }), // running — 0
      ],
      NOW,
    );
    expect(totals.totalSecs).toBe(3600);
    expect(totals.todaySecs).toBe(600);
    expect(totals.weekSecs).toBe(1800); // 600 + 1200
    expect(totals.sessions).toBe(4);
    expect(totals.longestSecs).toBe(1800);
  });
});

describe("study-stats — wordsAddedSince", () => {
  it("counts vocab created on/after the cutoff", () => {
    const vocab = [
      mkVocab({ createdAt: today1am }),
      mkVocab({ createdAt: TODAY + 100 }),
      mkVocab({ createdAt: yesterday }),
    ];
    expect(wordsAddedSince(vocab, TODAY)).toBe(2);
  });
});

describe("streak — longestStreak", () => {
  it("finds the longest consecutive run anywhere in history", () => {
    const sessions = [
      mkSession({ startedAt: today1am }),
      mkSession({ startedAt: today1am - DAY }),
      mkSession({ startedAt: today1am - 2 * DAY }),
      mkSession({ startedAt: today1am - 10 * DAY }), // isolated, breaks the run
    ];
    expect(longestStreak(sessions)).toBe(3);
  });

  it("ignores non-qualifying sessions (chat/writing with no words)", () => {
    const sessions = [
      mkSession({ startedAt: today1am, kind: "writing", wordsSeen: 0, wordsSaved: 0 }),
      mkSession({
        startedAt: today1am - DAY,
        kind: "writing",
        wordsSeen: 0,
        wordsSaved: 0,
      }),
    ];
    expect(longestStreak(sessions)).toBe(0);
  });

  it("is 0 for no sessions", () => {
    expect(longestStreak([])).toBe(0);
  });
});
