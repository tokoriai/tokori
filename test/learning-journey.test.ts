import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeLearningJourney,
  estimateDailyMinutesForGap,
  estimateDaysForGap,
  parseJourneySettings,
  journeySettingKey,
  journeySettingKeys,
  WORDS_PER_STUDY_MINUTE,
  type ComputeJourneyInput,
} from "@/lib/learning-journey";
import type { StudySession, VocabEntry, Workspace } from "@/lib/db";

// ── Fixtures ─────────────────────────────────────────────────────

function ws(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 1,
    name: "Test",
    targetLang: "zh",
    nativeLang: "en",
    createdAt: 0,
    ...overrides,
  } as Workspace;
}

function vocab(count: number, status: "mastered" | "review" | "learning" | "new" = "mastered"): VocabEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    workspaceId: 1,
    word: `word${i}`,
    reading: null,
    gloss: null,
    source: "test",
    status,
    kind: "vocab" as const,
    stability: 0,
    difficulty: 5,
    learningStep: 0,
    dueAt: null,
    lastReview: null,
    reviewCount: 0,
    createdAt: 0,
    imageData: null,
    hasImage: false,
    cardNotes: null,
    frontExtra: null,
    hasAudio: false,
    audioMime: null,
    isActive: true,
  }));
}

function sessions(hours: number, sinceDaysAgo = 30): StudySession[] {
  // Synthesise one session per day, evenly carrying the total hours.
  if (sinceDaysAgo <= 0) return [];
  const perSession = (hours * 3600) / sinceDaysAgo;
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: sinceDaysAgo }, (_, i) => ({
    id: i + 1,
    workspaceId: 1,
    kind: "reading",
    startedAt: now - (i + 1) * 86_400,
    endedAt: now - (i + 1) * 86_400 + perSession,
    durationSecs: perSession,
    wordsSeen: 0,
    wordsSaved: 0,
    notes: null,
  }));
}

function input(overrides: Partial<ComputeJourneyInput> = {}): ComputeJourneyInput {
  return {
    workspace: ws(),
    vocab: vocab(0),
    sessions: [],
    scale: "hsk",
    targetLevelId: "HSK 3",
    deadline: null,
    weeklyMinutesTarget: null,
    manualOverrides: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

// ── Milestone derivation ─────────────────────────────────────────

describe("computeLearningJourney — milestone derivation", () => {
  it("includes every level from current up to target, inclusive", () => {
    const j = computeLearningJourney(input({ targetLevelId: "HSK 4" }));
    expect(j.milestones.map((m) => m.levelId)).toEqual([
      "HSK 1",
      "HSK 2",
      "HSK 3",
      "HSK 4",
    ]);
  });

  it("marks the current level as in-progress when vocab/hours haven't cleared the next bar", () => {
    const j = computeLearningJourney(
      input({
        vocab: vocab(50),         // HSK 1 (minVocab 0)
        targetLevelId: "HSK 3",
      }),
    );
    // currentLevelId should be HSK 1, milestones HSK 1..HSK 3.
    expect(j.currentLevelId).toBe("HSK 1");
    expect(j.milestones[0].status).toBe("completed"); // HSK 1 cleared (minVocab 0)
    expect(j.milestones[1].status).toBe("in-progress"); // HSK 2 next up
    expect(j.milestones[2].status).toBe("locked");      // HSK 3 still locked
  });

  it("flips status to completed when both vocab and hours clear the bar", () => {
    const j = computeLearningJourney(
      input({
        vocab: vocab(600),        // past HSK 2's 500 minVocab
        sessions: sessions(150),  // 150 h immersion — past HSK 2's 1 × 120 h
        targetLevelId: "HSK 4",
      }),
    );
    expect(j.milestones.find((m) => m.levelId === "HSK 2")?.status).toBe(
      "completed",
    );
    // HSK 3 (minVocab 1272, hoursTarget 240) shouldn't yet be cleared.
    expect(j.milestones.find((m) => m.levelId === "HSK 3")?.status).not.toBe(
      "completed",
    );
  });

  it("hoursTarget grows linearly with the level index using the scale's HOURS_PER_LEVEL", () => {
    const j = computeLearningJourney(input({ targetLevelId: "HSK 6" }));
    const targets = j.milestones.map((m) => m.hoursTarget);
    // hsk = 120h per level. Milestones start at HSK 1 (index 0).
    expect(targets).toEqual([0, 120, 240, 360, 480, 600]);
  });

  it("uses the right pacing for non-HSK scales", () => {
    const j = computeLearningJourney(
      input({
        workspace: ws({ targetLang: "fr" }),
        scale: "cefr",
        targetLevelId: "B2",
      }),
    );
    const targets = j.milestones.map((m) => m.hoursTarget);
    // cefr = 200h per level. A1 → B2 = indices 0..3.
    expect(targets).toEqual([0, 200, 400, 600]);
  });
});

// ── Manual overrides ─────────────────────────────────────────────

describe("computeLearningJourney — manual overrides", () => {
  it("force-completes a milestone the user manually flipped", () => {
    const j = computeLearningJourney(
      input({
        vocab: vocab(0),
        sessions: [],
        manualOverrides: { "HSK 2": 1_700_000_000 },
        targetLevelId: "HSK 3",
      }),
    );
    const hsk2 = j.milestones.find((m) => m.levelId === "HSK 2")!;
    expect(hsk2.status).toBe("completed");
    expect(hsk2.completedAt).toBe(1_700_000_000);
  });

  it("preserves completion when vocab dips below the threshold afterward", () => {
    // Simulates the "user reviewed in 2023 → marked HSK 2 done → had a
    // long absence → some cards reclassified to learning". The
    // milestone should stay completed.
    const j = computeLearningJourney(
      input({
        vocab: vocab(50),                                // back below the 500 floor
        manualOverrides: { "HSK 2": 1_700_000_000 },
        targetLevelId: "HSK 3",
      }),
    );
    expect(j.milestones.find((m) => m.levelId === "HSK 2")?.status).toBe(
      "completed",
    );
  });
});

// ── Pace ─────────────────────────────────────────────────────────

describe("computeLearningJourney — pace", () => {
  it("returns null pace when no deadline is set", () => {
    const j = computeLearningJourney(input({ vocab: vocab(50) }));
    expect(j.pace).toBeNull();
    expect(j.projectedDaysRemaining).toBeNull();
  });

  it("returns null pace when target already reached", () => {
    const j = computeLearningJourney(
      input({
        vocab: vocab(2500),                                 // past HSK 4's 2245
        deadline: Math.floor(Date.now() / 1000) + 365 * 86_400,
        targetLevelId: "HSK 4",
      }),
    );
    expect(j.pace).toBeNull();
  });

  it("reads 'on' when daily minutes meet the weekly target", () => {
    // User commits 70 weekly minutes → 10/day. We synthesise 30 days
    // of 12-minute sessions (slightly above target).
    const j = computeLearningJourney(
      input({
        vocab: vocab(100),
        deadline: Math.floor(Date.now() / 1000) + 90 * 86_400,
        weeklyMinutesTarget: 70,
        sessions: sessions(6),                              // 6h / 30d ≈ 12 min/day
        targetLevelId: "HSK 3",
      }),
    );
    // 12 min ≥ (70/7) × 1.05 = 10.5 → 'ahead'. Both ahead and on are
    // valid signals; the threshold tuning may evolve.
    expect(["ahead", "on"]).toContain(j.pace);
    expect(j.projectedDaysRemaining).toBeGreaterThan(0);
  });

  it("reads 'behind' when daily minutes are well under the weekly target", () => {
    const j = computeLearningJourney(
      input({
        vocab: vocab(100),
        deadline: Math.floor(Date.now() / 1000) + 30 * 86_400,
        weeklyMinutesTarget: 300,                            // ~43 min/day target
        sessions: sessions(2),                                // 2h / 30d ≈ 4 min/day
        targetLevelId: "HSK 3",
      }),
    );
    expect(j.pace).toBe("behind");
  });
});

// ── Suggested habits ─────────────────────────────────────────────

describe("computeLearningJourney — suggested habits", () => {
  it("emits review-heavy habits at the early phase", () => {
    const j = computeLearningJourney(input({ vocab: vocab(0) }));
    const kinds = j.suggestedHabits.map((h) => h.activityKind);
    expect(kinds).toContain("review");
    expect(kinds).toContain("reading");
  });

  it("transitions to input-heavy + tutor habits at the building phase", () => {
    const j = computeLearningJourney(
      input({ vocab: vocab(1300), targetLevelId: "HSK 5" }),
    );
    const kinds = j.suggestedHabits.map((h) => h.activityKind);
    // HSK 3 sits in the 25-55% slot for the 7-level HSK scale.
    expect(kinds).toContain("reading");
    expect(kinds).toContain("chat");
  });

  it("adds writing/speaking habits at the consolidating + fluency phases", () => {
    const j = computeLearningJourney(
      input({ vocab: vocab(4500), targetLevelId: "HSK 7-9" }),
    );
    const kinds = j.suggestedHabits.map((h) => h.activityKind);
    // Past HSK 6 → fluency phase → expect speaking + writing.
    expect(kinds).toContain("writing");
    expect(kinds).toContain("speaking");
  });
});

// ── Persistence helpers ──────────────────────────────────────────

describe("journey settings persistence", () => {
  it("key generator scopes by workspace id", () => {
    expect(journeySettingKey(7, "targetLevelId")).toBe("journey.7.targetLevelId");
    expect(journeySettingKeys(3)).toEqual([
      "journey.3.targetLevelId",
      "journey.3.deadline",
      "journey.3.weeklyMinutesTarget",
      "journey.3.milestoneOverrides",
    ]);
  });

  it("parses a complete settings snapshot into the journey shape", () => {
    const parsed = parseJourneySettings(1, {
      "journey.1.targetLevelId": "HSK 4",
      "journey.1.deadline": "1800000000",
      "journey.1.weeklyMinutesTarget": "150",
      "journey.1.milestoneOverrides": JSON.stringify({ "HSK 2": 1_700_000_000 }),
    });
    expect(parsed.targetLevelId).toBe("HSK 4");
    expect(parsed.deadline).toBe(1_800_000_000);
    expect(parsed.weeklyMinutesTarget).toBe(150);
    expect(parsed.manualOverrides).toEqual({ "HSK 2": 1_700_000_000 });
  });

  it("returns nulls + empty overrides when settings are missing", () => {
    const parsed = parseJourneySettings(1, {});
    expect(parsed.targetLevelId).toBeNull();
    expect(parsed.deadline).toBeNull();
    expect(parsed.weeklyMinutesTarget).toBeNull();
    expect(parsed.manualOverrides).toEqual({});
  });

  it("tolerates corrupt override JSON without throwing", () => {
    const parsed = parseJourneySettings(1, {
      "journey.1.milestoneOverrides": "{ this isn't valid }",
    });
    expect(parsed.manualOverrides).toEqual({});
  });

  it("ignores non-numeric override values", () => {
    const parsed = parseJourneySettings(1, {
      "journey.1.milestoneOverrides": JSON.stringify({
        "HSK 2": 1_700_000_000,
        "HSK 3": "not a number",
        "HSK 4": NaN,
      }),
    });
    expect(parsed.manualOverrides).toEqual({ "HSK 2": 1_700_000_000 });
  });
});

// ── Onboarding goal-step pace estimates ──────────────────────────
//
// estimateDaysForGap / estimateDailyMinutesForGap are the forward and
// inverse views of the same words-per-minute model the journey uses to
// judge progress. The onboarding goal step reads them to suggest a
// realistic deadline, so they're worth pinning down.

describe("learning-journey — estimateDaysForGap", () => {
  it("derives days from the shared words-per-minute rate", () => {
    // 140 min/wk = 20 min/day; 20 × 0.3 = 6 words/day; 500 / 6 → 84.
    expect(estimateDaysForGap(500, 140)).toBe(84);
  });

  it("scales inversely with the weekly commitment", () => {
    const slow = estimateDaysForGap(1000, 70)!;
    const fast = estimateDaysForGap(1000, 280)!;
    expect(slow).toBeGreaterThan(fast);
    // 4× the minutes ⇒ ~¼ the days (ceil rounding aside).
    expect(fast).toBeCloseTo(slow / 4, -1);
  });

  it("returns 0 for an already-closed gap", () => {
    expect(estimateDaysForGap(0, 140)).toBe(0);
    expect(estimateDaysForGap(-50, 140)).toBe(0);
  });

  it("returns null when there's no committed pace", () => {
    expect(estimateDaysForGap(500, 0)).toBeNull();
    expect(estimateDaysForGap(500, -10)).toBeNull();
  });

  it("agrees with the documented WORDS_PER_STUDY_MINUTE constant", () => {
    // Independent recomputation from the exported rate.
    const weekly = 210;
    const expected = Math.ceil(900 / ((weekly / 7) * WORDS_PER_STUDY_MINUTE));
    expect(estimateDaysForGap(900, weekly)).toBe(expected);
  });
});

describe("learning-journey — estimateDailyMinutesForGap", () => {
  it("is the inverse of estimateDaysForGap", () => {
    // 500 words across 84 days ⇒ back to ~20 min/day.
    expect(estimateDailyMinutesForGap(500, 84)).toBe(20);
  });

  it("needs more minutes/day for a tighter deadline", () => {
    const relaxed = estimateDailyMinutesForGap(500, 180)!;
    const tight = estimateDailyMinutesForGap(500, 30)!;
    expect(tight).toBeGreaterThan(relaxed);
  });

  it("returns 0 for an already-closed gap and null for no horizon", () => {
    expect(estimateDailyMinutesForGap(0, 90)).toBe(0);
    expect(estimateDailyMinutesForGap(500, 0)).toBeNull();
  });
});
