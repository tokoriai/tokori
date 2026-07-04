import { describe, expect, it } from "vitest";
import {
  computeStreak,
  sessionCountsForStreak,
} from "@/lib/streak";
import type { StudySession } from "@/lib/db";

// Helper: build a minimal StudySession. `daysAgo: 0` = today,
// `daysAgo: 1` = yesterday's noon, etc. Returns epoch seconds.
function mkSession(overrides: Partial<StudySession> & { daysAgo: number }): StudySession {
  const ts = new Date();
  ts.setDate(ts.getDate() - overrides.daysAgo);
  ts.setHours(12, 0, 0, 0);
  return {
    id: 0,
    workspaceId: 1,
    kind: "writing",
    startedAt: Math.floor(ts.getTime() / 1000),
    endedAt: Math.floor(ts.getTime() / 1000) + 600,
    durationSecs: 600,
    wordsSeen: 0,
    wordsSaved: 0,
    notes: null,
    ...overrides,
  };
}

describe("sessionCountsForStreak", () => {
  it("counts a flashcard review session", () => {
    expect(sessionCountsForStreak(mkSession({ daysAgo: 0, kind: "review" }))).toBe(true);
  });

  it("counts a reading session", () => {
    expect(sessionCountsForStreak(mkSession({ daysAgo: 0, kind: "reading" }))).toBe(true);
  });

  it("counts a live-voice (speaking) session", () => {
    expect(sessionCountsForStreak(mkSession({ daysAgo: 0, kind: "speaking" }))).toBe(true);
  });

  it("counts a manually-logged activity (notes set)", () => {
    expect(
      sessionCountsForStreak(mkSession({ daysAgo: 0, kind: "chat", notes: "italki lesson" })),
    ).toBe(true);
  });

  it("does NOT count an empty chat/writing session (the 'just opened the app' case)", () => {
    expect(sessionCountsForStreak(mkSession({ daysAgo: 0, kind: "writing" }))).toBe(false);
    expect(sessionCountsForStreak(mkSession({ daysAgo: 0, kind: "chat" }))).toBe(false);
  });

  it("counts a chat session if the user actually engaged (words seen)", () => {
    expect(
      sessionCountsForStreak(mkSession({ daysAgo: 0, kind: "writing", wordsSeen: 50 })),
    ).toBe(true);
    expect(
      sessionCountsForStreak(mkSession({ daysAgo: 0, kind: "writing", wordsSaved: 1 })),
    ).toBe(true);
  });

  it("ignores empty-string `notes` (manual logger always writes meaningful text)", () => {
    expect(
      sessionCountsForStreak(mkSession({ daysAgo: 0, kind: "writing", notes: "" })),
    ).toBe(false);
  });
});

describe("computeStreak", () => {
  it("returns 0 for no sessions", () => {
    expect(computeStreak([])).toBe(0);
  });

  it("ignores 'just opened chat' sessions even on consecutive days", () => {
    const sessions = [
      mkSession({ daysAgo: 0, kind: "writing" }),
      mkSession({ daysAgo: 1, kind: "writing" }),
      mkSession({ daysAgo: 2, kind: "writing" }),
    ];
    expect(computeStreak(sessions)).toBe(0);
  });

  it("counts a single review session today as 1", () => {
    expect(computeStreak([mkSession({ daysAgo: 0, kind: "review" })])).toBe(1);
  });

  it("counts consecutive qualifying days", () => {
    const sessions = [
      mkSession({ daysAgo: 0, kind: "review" }),
      mkSession({ daysAgo: 1, kind: "reading" }),
      mkSession({ daysAgo: 2, kind: "writing", notes: "logged immersion" }),
    ];
    expect(computeStreak(sessions)).toBe(3);
  });

  it("breaks the streak at the first missing qualifying day (with today's gap allowed)", () => {
    const sessions = [
      // No session today; allowed.
      mkSession({ daysAgo: 1, kind: "review" }),
      mkSession({ daysAgo: 2, kind: "review" }),
      // Day 3: only a noise session, doesn't count.
      mkSession({ daysAgo: 3, kind: "writing" }),
      mkSession({ daysAgo: 4, kind: "review" }),
    ];
    expect(computeStreak(sessions)).toBe(2);
  });

  it("a noise session on the same day as a real one still counts the day once", () => {
    const sessions = [
      mkSession({ daysAgo: 0, kind: "writing" }),
      mkSession({ daysAgo: 0, kind: "review" }),
    ];
    expect(computeStreak(sessions)).toBe(1);
  });
});
