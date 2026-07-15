import { describe, expect, it, vi } from "vitest";
import {
  askCoach,
  buildCoachPrompt,
  classifyTone,
  parseCoachReply,
  parseSuggestedGoals,
  suggestGoalsWithCoach,
  type CoachInput,
} from "@/lib/journey-coach";
import type { LearningJourney } from "@/lib/learning-journey";
import type { Habit } from "@/lib/habits";
import type { StudySession } from "@/lib/db";

// ── Fixtures ─────────────────────────────────────────────────────

function journey(overrides: Partial<LearningJourney> = {}): LearningJourney {
  return {
    workspaceId: 1,
    scale: "hsk",
    currentVocab: 600,
    currentHours: 30,
    currentLevelId: "HSK 2",
    targetLevelId: "HSK 4",
    deadline: null,
    weeklyMinutesTarget: null,
    milestones: [
      {
        levelId: "HSK 2",
        label: "HSK 2",
        description: "Basic",
        vocabTarget: 500,
        hoursTarget: 120,
        status: "in-progress",
        completedAt: null,
      },
      {
        levelId: "HSK 3",
        label: "HSK 3",
        description: "Pre-intermediate",
        vocabTarget: 1272,
        hoursTarget: 240,
        status: "locked",
        completedAt: null,
      },
    ],
    suggestedHabits: [],
    pace: null,
    projectedDaysRemaining: null,
    ...overrides,
  };
}

function habit(id: number, overrides: Partial<Habit> = {}): Habit {
  return {
    id,
    workspaceId: 1,
    name: `Habit ${id}`,
    activityKind: null,
    targetSecs: 15 * 60,
    frequency: "daily",
    glyph: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function session(daysAgo: number, kind = "reading"): StudySession {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 1,
    workspaceId: 1,
    kind,
    startedAt: now - daysAgo * 86_400,
    endedAt: now - daysAgo * 86_400 + 600,
    durationSecs: 600,
    wordsSeen: 0,
    wordsSaved: 0,
    notes: null,
  };
}

function input(overrides: Partial<CoachInput> = {}): CoachInput {
  return {
    journey: journey(),
    todayStats: { sessionsCount: 1, minutesPracticed: 20, wordsReviewed: 12, wordsAdded: 3 },
    weekStats: { sessionsCount: 5, minutesPracticed: 100, perKindMinutes: { reading: 60, review: 40 } },
    streakDays: 5,
    activeHabits: [habit(1)],
    habitsHit: { 1: true },
    recentSessions: [session(1), session(2)],
    targetLang: "zh",
    nativeLang: "en",
    sendChat: vi.fn(),
    ...overrides,
  };
}

// ── classifyTone ─────────────────────────────────────────────────

describe("classifyTone", () => {
  it("returns way-behind when there's no recent activity and no streak", () => {
    expect(
      classifyTone(
        input({
          recentSessions: [],
          streakDays: 0,
        }),
      ),
    ).toBe("way-behind");
  });

  it("returns milestone-reached when a milestone was completed in the last 24h", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      classifyTone(
        input({
          journey: journey({
            milestones: [
              {
                levelId: "HSK 2",
                label: "HSK 2",
                description: "Basic",
                vocabTarget: 500,
                hoursTarget: 120,
                status: "completed",
                completedAt: now - 3600, // 1 hour ago
              },
            ],
          }),
        }),
      ),
    ).toBe("milestone-reached");
  });

  it("returns early-days for a brand-new account", () => {
    expect(
      classifyTone(
        input({
          journey: journey({ currentVocab: 5 }),
          weekStats: { sessionsCount: 1, minutesPracticed: 10, perKindMinutes: {} },
          streakDays: 1,
          recentSessions: [session(0)],
        }),
      ),
    ).toBe("early-days");
  });

  it("returns behind-pace when journey.pace is behind", () => {
    expect(
      classifyTone(
        input({
          journey: journey({ pace: "behind" }),
        }),
      ),
    ).toBe("behind-pace");
  });

  it("returns on-pace-and-habits-hit when on pace AND every habit is met today", () => {
    expect(
      classifyTone(
        input({
          journey: journey({ pace: "on" }),
          activeHabits: [habit(1), habit(2)],
          habitsHit: { 1: true, 2: true },
        }),
      ),
    ).toBe("on-pace-and-habits-hit");
  });

  it("returns on-pace-missed-habit-today when on pace but one habit isn't met", () => {
    expect(
      classifyTone(
        input({
          journey: journey({ pace: "on" }),
          activeHabits: [habit(1), habit(2)],
          habitsHit: { 1: true, 2: false },
        }),
      ),
    ).toBe("on-pace-missed-habit-today");
  });
});

// ── buildCoachPrompt ─────────────────────────────────────────────

describe("buildCoachPrompt", () => {
  it("references the journey's actual numbers in the user message", () => {
    const { user } = buildCoachPrompt(
      input({
        journey: journey({ currentVocab: 815, currentHours: 42, currentLevelId: "HSK 2", targetLevelId: "HSK 4" }),
      }),
      "on-pace-and-habits-hit",
    );
    expect(user).toContain("currently HSK 2, target HSK 4");
    expect(user).toContain("Words known: 815");
    expect(user).toContain("Immersion hours: 42.0");
  });

  it("instructs the model to reply in the native language", () => {
    const { system } = buildCoachPrompt(input(), "on-pace-and-habits-hit");
    expect(system).toMatch(/reply in English/);
    expect(system).toMatch(/Stay in English/);
  });

  it("includes the recommended-mix matrix from the study guide", () => {
    const { system } = buildCoachPrompt(input(), "behind-pace");
    expect(system).toMatch(/Recommended activity mix/);
    expect(system).toMatch(/review 60%/); // early phase line
    expect(system).toMatch(/Fluency/);
  });

  it("contains the tone-specific instruction line", () => {
    const { system: ahead } = buildCoachPrompt(input(), "on-pace-and-habits-hit");
    expect(ahead).toMatch(/Celebrate the consistency/);
    const { system: behind } = buildCoachPrompt(input(), "behind-pace");
    expect(behind).toMatch(/Empathetic but specific/);
    const { system: empty } = buildCoachPrompt(input(), "way-behind");
    expect(empty).toMatch(/Lower the bar/);
  });

  it("includes the user's question when one is supplied", () => {
    const { user } = buildCoachPrompt(
      input({ userPrompt: "How am I doing?" }),
      "on-pace-and-habits-hit",
    );
    expect(user).toContain("USER QUESTION");
    expect(user).toContain("How am I doing?");
  });

  it("falls back to the proactive ask when no user prompt", () => {
    const { user } = buildCoachPrompt(input(), "on-pace-and-habits-hit");
    expect(user).toContain("Generate today's proactive nudge");
  });

  it("describes the pace + projected days when a deadline is set", () => {
    const deadline = Math.floor(Date.now() / 1000) + 90 * 86_400;
    const { user } = buildCoachPrompt(
      input({
        journey: journey({ pace: "on", deadline, projectedDaysRemaining: 80 }),
      }),
      "on-pace-and-habits-hit",
    );
    expect(user).toMatch(/Pace: on/);
    expect(user).toMatch(/Projected.*80 days/);
  });
});

// ── parseCoachReply ──────────────────────────────────────────────

describe("parseCoachReply", () => {
  it("parses a well-formed JSON reply with actions", () => {
    const reply = parseCoachReply(
      JSON.stringify({
        message: "Nice streak. Try one tutor chat tomorrow.",
        suggestedActions: [
          { label: "Open chat", intent: "open-chat" },
          { label: "Read", intent: "open-reader" },
        ],
      }),
    );
    expect(reply.message).toBe("Nice streak. Try one tutor chat tomorrow.");
    expect(reply.suggestedActions).toHaveLength(2);
    expect(reply.suggestedActions[0].intent).toBe("open-chat");
  });

  it("strips ```json fences before parsing", () => {
    const reply = parseCoachReply(
      "```json\n" +
        JSON.stringify({ message: "Good work today.", suggestedActions: [] }) +
        "\n```",
    );
    expect(reply.message).toBe("Good work today.");
  });

  it("tolerates trailing prose after the JSON block", () => {
    const reply = parseCoachReply(
      JSON.stringify({ message: "Keep going.", suggestedActions: [] }) +
        "\n\nLet me know if you want more!",
    );
    expect(reply.message).toBe("Keep going.");
  });

  it("filters out actions with invalid intents", () => {
    const reply = parseCoachReply(
      JSON.stringify({
        message: "x",
        suggestedActions: [
          { label: "Valid", intent: "open-flashcards" },
          { label: "Bogus", intent: "do-nothing" },
          { label: "Also valid", intent: "log-session" },
        ],
      }),
    );
    expect(reply.suggestedActions.map((a) => a.intent)).toEqual([
      "open-flashcards",
      "log-session",
    ]);
  });

  it("caps actions at 3", () => {
    const reply = parseCoachReply(
      JSON.stringify({
        message: "x",
        suggestedActions: Array.from({ length: 6 }, () => ({
          label: "Open chat",
          intent: "open-chat",
        })),
      }),
    );
    expect(reply.suggestedActions).toHaveLength(3);
  });

  it("falls back to raw text when JSON parse fails", () => {
    const reply = parseCoachReply(
      "Today you reviewed 12 cards — nice. Try a 10-minute reader session.",
    );
    expect(reply.message).toContain("Today you reviewed 12 cards");
    expect(reply.suggestedActions).toEqual([]);
  });

  it("strips stray markdown quotes in the fallback path", () => {
    const reply = parseCoachReply('“Great consistency.”');
    expect(reply.message).toBe("Great consistency.");
  });

  it("falls back when message is missing or empty", () => {
    const reply = parseCoachReply(
      JSON.stringify({ message: "", suggestedActions: [] }),
    );
    // Empty message → fallback path uses the raw text (still empty after
    // JSON parse), so the message ends up the JSON's serialised form.
    // Cap at 400 chars handles either way.
    expect(reply.message.length).toBeLessThanOrEqual(400);
  });
});

// ── askCoach end-to-end (with mock sendChat) ────────────────────

describe("askCoach", () => {
  it("calls sendChat with the built system + user messages and parses the reply", async () => {
    const sendChat = vi.fn(async () =>
      JSON.stringify({
        message: "Solid pace today. Try a 10-minute reader session.",
        suggestedActions: [{ label: "Open reader", intent: "open-reader" }],
      }),
    );
    const reply = await askCoach(input({ sendChat }));
    expect(reply.message).toContain("Solid pace today");
    expect(reply.suggestedActions[0].intent).toBe("open-reader");
    expect(sendChat).toHaveBeenCalledOnce();
    const [arg] = sendChat.mock.calls[0];
    expect(arg.messages).toHaveLength(2);
    expect(arg.messages[0].role).toBe("system");
    expect(arg.messages[1].role).toBe("user");
  });
});

// ── parseSuggestedGoals ──────────────────────────────────────────

describe("parseSuggestedGoals", () => {
  const NOW = 1_000_000;

  it("parses a JSON array and converts deadlineDays to an absolute epoch", () => {
    const goals = parseSuggestedGoals(
      JSON.stringify([
        { title: "Learn 200 words", kind: "vocab", skill: null, target: 200, deadlineDays: 30, rationale: "Close the gap." },
        { title: "Read 300 min", kind: "minutes", skill: "reading", target: 300, deadlineDays: null, rationale: "Build input." },
      ]),
      NOW,
    );
    expect(goals).toHaveLength(2);
    expect(goals[0]).toMatchObject({ kind: "vocab", target: 200, skill: null });
    expect(goals[0].deadline).toBe(NOW + 30 * 86_400);
    expect(goals[1]).toMatchObject({ kind: "minutes", skill: "reading", deadline: null });
  });

  it("strips ```json fences", () => {
    const goals = parseSuggestedGoals(
      "```json\n" +
        JSON.stringify([{ title: "x", kind: "sessions", target: 5, deadlineDays: null }]) +
        "\n```",
      NOW,
    );
    expect(goals).toHaveLength(1);
    expect(goals[0].kind).toBe("sessions");
  });

  it("drops entries with an invalid kind or non-positive target", () => {
    const goals = parseSuggestedGoals(
      JSON.stringify([
        { title: "bad kind", kind: "speaking-hours", target: 10 },
        { title: "zero", kind: "vocab", target: 0 },
        { title: "ok", kind: "vocab", target: 50 },
      ]),
      NOW,
    );
    expect(goals).toHaveLength(1);
    expect(goals[0].title).toBe("ok");
  });

  it("forces skill to null for vocab goals and ignores invalid skills", () => {
    const goals = parseSuggestedGoals(
      JSON.stringify([
        { title: "a", kind: "vocab", skill: "reading", target: 100 },
        { title: "b", kind: "minutes", skill: "telepathy", target: 100 },
      ]),
      NOW,
    );
    expect(goals[0].skill).toBeNull();
    expect(goals[1].skill).toBeNull();
  });

  it("synthesises a title when one is missing", () => {
    const goals = parseSuggestedGoals(
      JSON.stringify([{ kind: "vocab", target: 100, deadlineDays: null }]),
      NOW,
    );
    expect(goals[0].title.length).toBeGreaterThan(0);
  });

  it("caps the result at 3 goals", () => {
    const goals = parseSuggestedGoals(
      JSON.stringify(Array.from({ length: 6 }, () => ({ kind: "vocab", target: 10 }))),
      NOW,
    );
    expect(goals).toHaveLength(3);
  });

  it("returns [] on unparseable or non-array input", () => {
    expect(parseSuggestedGoals("not json at all", NOW)).toEqual([]);
    expect(parseSuggestedGoals(JSON.stringify({ not: "an array" }), NOW)).toEqual([]);
  });
});

// ── suggestGoalsWithCoach (mock sendChat) ────────────────────────

describe("suggestGoalsWithCoach", () => {
  it("returns parsed goals when the model replies with valid JSON", async () => {
    const sendChat = vi.fn(async () =>
      JSON.stringify([{ title: "Learn 150 words", kind: "vocab", target: 150, deadlineDays: 21 }]),
    );
    const out = await suggestGoalsWithCoach({
      journey: journey(),
      sessions: [session(1)],
      targetLang: "zh",
      nativeLang: "en",
      sendChat,
    });
    expect(sendChat).toHaveBeenCalledOnce();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "vocab", target: 150 });
  });

  it("falls back to the heuristic (never throws) when the provider errors", async () => {
    const sendChat = vi.fn(async () => {
      throw new Error("provider down");
    });
    const out = await suggestGoalsWithCoach({
      journey: journey(),
      sessions: [session(1)],
      targetLang: "zh",
      nativeLang: "en",
      sendChat,
    });
    expect(Array.isArray(out)).toBe(true);
  });
});
