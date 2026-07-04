/**
 * Learning Journey — the per-workspace plan that turns the user's
 * current level + target level into a concrete ladder of milestones
 * with vocab + immersion-hours targets, plus a list of suggested
 * habits drawn from the recommended-mix matrix in
 * `docs/guides/study-guide.md`.
 *
 * Pure function. Inputs are workspace data (vocab list, sessions
 * list) + persisted settings (target level, deadline, manual
 * overrides). Output is a `LearningJourney` snapshot that the
 * dashboard widget, the Journey tab, and the AI Coach read from.
 *
 * Persistence shape (settings table keys, scoped per workspace):
 *   - journey.<wsId>.targetLevelId         string
 *   - journey.<wsId>.deadline              epoch seconds | null
 *   - journey.<wsId>.weeklyMinutesTarget   number | null
 *   - journey.<wsId>.milestoneOverrides    JSON: { [levelId]: epoch }
 *
 * Why a pure function and not a hook: the journey is derived data —
 * cheap to recompute on every render. The dashboard widget and the
 * Journey tab both call it with the same input, so caching at the
 * call site (memoization) would risk staleness. The composer pattern
 * (just call with current inputs) keeps the truth in one place.
 */

import type { StudySession, VocabEntry, Workspace } from "./db";
import {
  hoursPerLevel,
  levelsForScale,
  type LevelInfo,
  type ScaleKind,
} from "./level";

export type MilestoneStatus = "completed" | "in-progress" | "locked";

export type JourneyMilestone = {
  /** Level id from the scale (e.g. "HSK 3", "N4", "B2"). */
  levelId: string;
  /** Display label ("HSK 3"). Today identical to `levelId`; carried
   *  separately so a future custom-scale UI can rename without
   *  breaking persisted overrides. */
  label: string;
  /** Short descriptor of the level ("Pre-intermediate"). Pulled from
   *  `LevelInfo.label`. */
  description: string;
  /** Vocab the user needs at `mastered` to clear this milestone. */
  vocabTarget: number;
  /** Recommended immersion hours by this milestone. Cumulative —
   *  starts at 0 for the first level and grows by `HOURS_PER_LEVEL`
   *  for each step. */
  hoursTarget: number;
  status: MilestoneStatus;
  /** Set when the user manually flipped this milestone to completed.
   *  Persisted so the milestone stays completed even if their vocab
   *  count later dips below the threshold (e.g. cards reclassified
   *  to "learning" after a long absence). */
  completedAt: number | null;
};

export type SuggestedHabit = {
  /** Matches the session `kind` strings the rest of the app uses. */
  activityKind: string;
  /** Display name for the habit row. */
  name: string;
  /** Target seconds per period. */
  targetSecs: number;
  frequency: "daily" | "weekly";
  /** One-line "why this matters at your current level". Shown as
   *  helper text under the adopt button. */
  rationale: string;
};

export type JourneyPace = "ahead" | "on" | "behind" | null;

export type LearningJourney = {
  workspaceId: number;
  scale: ScaleKind;
  /** Live counts pulled from the input vocab + sessions. */
  currentVocab: number;
  currentHours: number;
  /** Current level id derived from `currentVocab` against the scale.
   *  Matches what `level.ts:computeLevel` would derive at score
   *  parity — surfaced here so the journey UI doesn't have to
   *  re-compute. */
  currentLevelId: string;
  /** User's chosen target level id. */
  targetLevelId: string;
  /** Deadline (epoch seconds) for hitting `targetLevelId`. Optional —
   *  the alternative is `weeklyMinutesTarget`. */
  deadline: number | null;
  /** Weekly minutes of study the user wants to commit to. Optional. */
  weeklyMinutesTarget: number | null;
  /** Ordered list of milestones from the user's current level up to
   *  (and including) `targetLevelId`. Levels above the target are
   *  excluded — the journey is finite, the next journey starts when
   *  this one ends. */
  milestones: JourneyMilestone[];
  /** Suggested habits to adopt at the current phase. Not auto-created;
   *  shown as one-click adopt rows. */
  suggestedHabits: SuggestedHabit[];
  /** ahead | on | behind | null (null when no deadline set). */
  pace: JourneyPace;
  /** Estimated days remaining until the target at current pace.
   *  Null when no deadline or no measurable history yet. */
  projectedDaysRemaining: number | null;
};

export type ComputeJourneyInput = {
  workspace: Workspace;
  /** All vocab rows for the workspace. Used to count `mastered`. */
  vocab: VocabEntry[];
  /** All sessions for the workspace. Used to sum hours. */
  sessions: StudySession[];
  /** Resolved scale for the workspace (consult `scaleFor(lang)` if
   *  the caller doesn't already have it). */
  scale: ScaleKind;
  /** The user's target level id. */
  targetLevelId: string;
  /** Optional deadline (epoch seconds). */
  deadline: number | null;
  /** Optional weekly minutes commitment. */
  weeklyMinutesTarget: number | null;
  /** Per-level manual completion overrides. Key = levelId, value =
   *  epoch when the user flipped it. */
  manualOverrides: Record<string, number>;
  /** Optional custom-scale level table — required when scale is
   *  "custom". Falls back to CEFR via `levelsForScale`. */
  customLevels?: LevelInfo[];
};

/** Compute the journey snapshot. Pure — same inputs always produce
 *  the same output. */
export function computeLearningJourney(
  input: ComputeJourneyInput,
): LearningJourney {
  const levels = input.scale === "custom" && input.customLevels?.length
    ? [...input.customLevels].sort((a, b) => a.minVocab - b.minVocab)
    : levelsForScale(input.scale);

  const currentVocab = input.vocab.filter((v) => v.status === "mastered").length;
  const currentHours =
    input.sessions.reduce((acc, s) => acc + (s.durationSecs ?? 0), 0) / 3600;

  const currentLevelId = derivedCurrentLevel(levels, currentVocab).id;
  const targetIndex = Math.max(
    0,
    levels.findIndex((l) => l.id === input.targetLevelId),
  );
  const currentIndex = Math.max(
    0,
    levels.findIndex((l) => l.id === currentLevelId),
  );

  const hpl = hoursPerLevel(input.scale);

  // Build milestones from the current level up to and including the
  // target. We deliberately include the current level (status:
  // in-progress or completed) so the UI's progress bar has a
  // starting point.
  const start = Math.min(currentIndex, targetIndex);
  const stop = Math.max(currentIndex, targetIndex);
  const milestones: JourneyMilestone[] = [];
  for (let i = start; i <= stop; i++) {
    const lvl = levels[i];
    if (!lvl) continue;
    const hoursTarget = i * hpl;
    const manualAt = input.manualOverrides[lvl.id] ?? null;
    let status: MilestoneStatus;
    if (manualAt != null) {
      status = "completed";
    } else if (currentVocab >= lvl.minVocab && currentHours >= hoursTarget) {
      // Both gates cleared (vocab + hours). Hours is a soft gate —
      // see the comment on `currentHours >= hoursTarget` below.
      status = "completed";
    } else if (i === currentIndex + 1 || (i === currentIndex && i < stop)) {
      // The "next up" milestone is in-progress; everything past it
      // is locked.
      status = "in-progress";
    } else if (i <= currentIndex) {
      // Past milestones the user has already cleared by vocab but
      // not yet by hours fall here. Mark them completed too — the
      // hours gate is a soft target, not a hard requirement (some
      // learners are vocab-heavy / immersion-light by design).
      status = currentVocab >= lvl.minVocab ? "completed" : "in-progress";
    } else {
      status = "locked";
    }
    milestones.push({
      levelId: lvl.id,
      label: lvl.id,
      description: lvl.label,
      vocabTarget: lvl.minVocab,
      hoursTarget,
      status,
      completedAt: manualAt,
    });
  }

  const suggestedHabits = suggestHabitsForPhase(currentIndex, levels.length);

  const { pace, projectedDaysRemaining } = computePace({
    currentVocab,
    targetVocab: levels[targetIndex]?.minVocab ?? 0,
    deadline: input.deadline,
    sessions: input.sessions,
    weeklyMinutesTarget: input.weeklyMinutesTarget,
  });

  return {
    workspaceId: input.workspace.id,
    scale: input.scale,
    currentVocab,
    currentHours,
    currentLevelId,
    targetLevelId: levels[targetIndex]?.id ?? currentLevelId,
    deadline: input.deadline,
    weeklyMinutesTarget: input.weeklyMinutesTarget,
    milestones,
    suggestedHabits,
    pace,
    projectedDaysRemaining,
  };
}

/** Map current-level position to a phase, then return 2-3 habits
 *  that reflect the recommended activity mix from the study guide.
 *
 *  We use position-in-scale (`currentIndex / total`) rather than the
 *  level id directly so the same code works for HSK, JLPT, TOPIK,
 *  CEFR, and custom scales. The thresholds map to the four phases
 *  documented in study-guide.md:
 *    < 25% → Early
 *    25–55% → Building
 *    55–80% → Consolidating
 *    > 80% → Fluency
 */
function suggestHabitsForPhase(
  currentIndex: number,
  totalLevels: number,
): SuggestedHabit[] {
  const pos = totalLevels > 1 ? currentIndex / (totalLevels - 1) : 0;
  if (pos < 0.25) {
    // Early — review-heavy, build the base vocabulary.
    return [
      {
        activityKind: "review",
        name: "Daily review",
        targetSecs: 20 * 60,
        frequency: "daily",
        rationale:
          "At this stage SRS reviews are the highest-leverage minute. Even 20 min keeps your due queue clear.",
      },
      {
        activityKind: "reading",
        name: "Daily input",
        targetSecs: 15 * 60,
        frequency: "daily",
        rationale:
          "Short, level-matched reading sessions turn flashcard vocab into real recognition.",
      },
    ];
  }
  if (pos < 0.55) {
    // Building — input ramps up; first tutor sessions.
    return [
      {
        activityKind: "review",
        name: "Daily review",
        targetSecs: 15 * 60,
        frequency: "daily",
        rationale: "Maintain the floor while you ramp up input.",
      },
      {
        activityKind: "reading",
        name: "Reading + listening",
        targetSecs: 25 * 60,
        frequency: "daily",
        rationale:
          "Most of your growth at this phase comes from exposure — varied input pulls vocab into long-term memory.",
      },
      {
        activityKind: "chat",
        name: "Weekly tutor chat",
        targetSecs: 30 * 60,
        frequency: "weekly",
        rationale:
          "One conversation a week catches gaps your reading misses.",
      },
    ];
  }
  if (pos < 0.8) {
    // Consolidating — input dominates; output starts.
    return [
      {
        activityKind: "reading",
        name: "Daily immersion",
        targetSecs: 30 * 60,
        frequency: "daily",
        rationale:
          "Native content (podcasts, articles, video) is the main driver from here.",
      },
      {
        activityKind: "chat",
        name: "Tutor sessions",
        targetSecs: 60 * 60,
        frequency: "weekly",
        rationale: "Active practice closes the recognition-to-recall gap.",
      },
      {
        activityKind: "writing",
        name: "Weekly journal entry",
        targetSecs: 20 * 60,
        frequency: "weekly",
        rationale:
          "Writing forces production. The journal's sentence-by-sentence correction catches errors active speaking would miss.",
      },
    ];
  }
  // Fluency — output and immersion dominate.
  return [
    {
      activityKind: "reading",
      name: "Daily immersion",
      targetSecs: 45 * 60,
      frequency: "daily",
      rationale:
        "Volume of input is what carries you across the C1/C2 line.",
    },
    {
      activityKind: "writing",
      name: "Journal often",
      targetSecs: 30 * 60,
      frequency: "weekly",
      rationale:
        "Production becomes the slowest-growing skill — keep writing.",
    },
    {
      activityKind: "speaking",
      name: "Voice / speaking practice",
      targetSecs: 30 * 60,
      frequency: "weekly",
      rationale:
        "Real-time output is the last gate to native-feeling fluency.",
    },
  ];
}

function derivedCurrentLevel(levels: LevelInfo[], vocab: number): LevelInfo {
  // Same loop shape as `computeLevel` in level.ts so the journey's
  // currentLevelId matches what the dashboard already shows.
  let current = levels[0];
  for (let i = 0; i < levels.length; i++) {
    if (vocab >= levels[i].minVocab) current = levels[i];
  }
  return current;
}

/**
 * Words of long-term retention gained per minute of study. The whole
 * pace model keys off this single constant so the backward-looking
 * "are you on track?" projection (computePace / estimateDays) and the
 * forward-looking "how long will this take?" estimate the onboarding
 * goal step shows (estimateDaysForGap) can never quietly disagree.
 *
 * Deliberately a rough rule of thumb — it drives a pace *label* and a
 * ballpark date, never a hard gate.
 */
export const WORDS_PER_STUDY_MINUTE = 0.3;

/**
 * Forward estimate: calendar days to close a vocab gap at a planned
 * weekly study commitment. Pure; shared by the onboarding goal step so
 * the suggested deadline is grounded in the same arithmetic the
 * Journey tab uses to judge progress.
 *
 * Returns 0 for an already-closed gap, and null when the inputs can't
 * produce a positive rate (no committed minutes) — callers render that
 * as "set a weekly pace to estimate".
 */
export function estimateDaysForGap(
  wordsGap: number,
  weeklyMinutes: number,
): number | null {
  if (wordsGap <= 0) return 0;
  if (weeklyMinutes <= 0) return null;
  const dailyMinutes = weeklyMinutes / 7;
  const wordsPerDay = dailyMinutes * WORDS_PER_STUDY_MINUTE;
  if (wordsPerDay <= 0) return null;
  return Math.ceil(wordsGap / wordsPerDay);
}

/**
 * Inverse of estimateDaysForGap: the minutes-per-day needed to close a
 * vocab gap by a deadline `days` away. Pure; used by the onboarding
 * goal step to tell the user "that deadline is ambitious — closer to N
 * min/day". Returns 0 for an already-closed gap and null for a
 * non-positive horizon.
 */
export function estimateDailyMinutesForGap(
  wordsGap: number,
  days: number,
): number | null {
  if (wordsGap <= 0) return 0;
  if (days <= 0) return null;
  return Math.ceil(wordsGap / WORDS_PER_STUDY_MINUTE / days);
}

function computePace(input: {
  currentVocab: number;
  targetVocab: number;
  deadline: number | null;
  sessions: StudySession[];
  weeklyMinutesTarget: number | null;
}): { pace: JourneyPace; projectedDaysRemaining: number | null } {
  if (!input.deadline || input.targetVocab <= input.currentVocab) {
    return { pace: null, projectedDaysRemaining: null };
  }
  const now = Math.floor(Date.now() / 1000);
  const totalDaysLeft = Math.max(1, Math.ceil((input.deadline - now) / 86_400));
  const remaining = Math.max(0, input.targetVocab - input.currentVocab);

  // Project at the user's actual recent pace — last 30 days of
  // mastered-vocab growth. We use sessions as a proxy: if they're
  // logging activity at all, vocab is likely moving. Combined with
  // the gap, this gives a rough "are you on track" signal.
  const thirtyDaysAgo = now - 30 * 86_400;
  const recent = input.sessions.filter((s) => s.startedAt >= thirtyDaysAgo);
  const recentSecs = recent.reduce((acc, s) => acc + (s.durationSecs ?? 0), 0);
  const dailyMinutes = recentSecs / 60 / 30;

  // Compare against the weekly target if set; otherwise fall back to
  // a vocab-velocity heuristic (loose).
  if (input.weeklyMinutesTarget) {
    const targetDaily = input.weeklyMinutesTarget / 7;
    if (dailyMinutes >= targetDaily * 1.05) {
      return { pace: "ahead", projectedDaysRemaining: estimateDays(remaining, dailyMinutes) };
    }
    if (dailyMinutes >= targetDaily * 0.9) {
      return { pace: "on", projectedDaysRemaining: estimateDays(remaining, dailyMinutes) };
    }
    return { pace: "behind", projectedDaysRemaining: estimateDays(remaining, dailyMinutes) };
  }

  // No explicit weekly target — fall back to a "needed daily minutes"
  // heuristic keyed off the shared WORDS_PER_STUDY_MINUTE rate. The
  // number isn't load-bearing for anything beyond a pace label; the
  // Coach generates the actual advice.
  const minutesNeededDaily = remaining / WORDS_PER_STUDY_MINUTE / totalDaysLeft;
  if (dailyMinutes >= minutesNeededDaily * 1.05) {
    return { pace: "ahead", projectedDaysRemaining: estimateDays(remaining, dailyMinutes) };
  }
  if (dailyMinutes >= minutesNeededDaily * 0.9) {
    return { pace: "on", projectedDaysRemaining: estimateDays(remaining, dailyMinutes) };
  }
  return { pace: "behind", projectedDaysRemaining: estimateDays(remaining, dailyMinutes) };
}

function estimateDays(remaining: number, dailyMinutes: number): number | null {
  if (dailyMinutes <= 0) return null;
  const wordsPerDay = dailyMinutes * WORDS_PER_STUDY_MINUTE;
  if (wordsPerDay <= 0) return null;
  return Math.ceil(remaining / wordsPerDay);
}

// ── Persistence helpers ──────────────────────────────────────────
//
// Thin getters/setters around the settings table so call sites don't
// have to spell out the key prefix everywhere. Each helper falls back
// to a sensible default when the setting is missing.

export function journeySettingKey(workspaceId: number, name: string): string {
  return `journey.${workspaceId}.${name}`;
}

export type JourneySettings = {
  targetLevelId: string | null;
  deadline: number | null;
  weeklyMinutesTarget: number | null;
  manualOverrides: Record<string, number>;
};

/** Parse the four journey settings out of a `{key: value}` snapshot
 *  (use `getSettings([...keys])` to fetch them in one shot, then
 *  pass the result here). Returns null fields when settings are
 *  missing rather than throwing. */
export function parseJourneySettings(
  workspaceId: number,
  raw: Record<string, string | null>,
): JourneySettings {
  const k = (n: string) => journeySettingKey(workspaceId, n);
  const target = raw[k("targetLevelId")];
  const deadline = raw[k("deadline")];
  const weekly = raw[k("weeklyMinutesTarget")];
  const overridesJson = raw[k("milestoneOverrides")];

  let overrides: Record<string, number> = {};
  if (overridesJson) {
    try {
      const parsed = JSON.parse(overridesJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        overrides = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
            .map(([k, v]) => [k, v as number]),
        );
      }
    } catch {
      /* corrupt JSON — drop, the user can re-mark milestones */
    }
  }

  return {
    targetLevelId: target?.trim() || null,
    deadline: deadline ? Number(deadline) : null,
    weeklyMinutesTarget: weekly ? Number(weekly) : null,
    manualOverrides: overrides,
  };
}

/** List the four setting keys for a workspace — convenient input to
 *  `getSettings([...])`. */
export function journeySettingKeys(workspaceId: number): string[] {
  return [
    journeySettingKey(workspaceId, "targetLevelId"),
    journeySettingKey(workspaceId, "deadline"),
    journeySettingKey(workspaceId, "weeklyMinutesTarget"),
    journeySettingKey(workspaceId, "milestoneOverrides"),
  ];
}
