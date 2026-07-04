import type {
  Goal,
  GoalKind,
  GoalSkill,
  StudySession,
  VocabEntry,
} from "./db";
import type { LearningJourney } from "./learning-journey";

export type GoalProgress = {
  current: number;
  target: number;
  pct: number;            // 0..1
  unit: string;
  daysLeft: number | null;
  pace: "ahead" | "on" | "behind" | null;
  expectedAtNow: number | null;
  isComplete: boolean;
  isExpired: boolean;
};

const SKILL_KIND_MAP: Record<NonNullable<GoalSkill>, string[]> = {
  reading: ["reading"],
  writing: ["writing", "chat"],
  speaking: ["speaking", "voice"],
  listening: ["listening", "podcast", "video"],
};

function matchesSkill(sessionKind: string, skill: GoalSkill): boolean {
  if (skill == null) return true;
  return SKILL_KIND_MAP[skill]?.includes(sessionKind) ?? false;
}

export function computeGoalProgress(
  goal: Goal,
  vocab: VocabEntry[],
  sessions: StudySession[],
  now = Math.floor(Date.now() / 1000),
): GoalProgress {
  let current = 0;
  let unit = "";

  if (goal.kind === "vocab") {
    unit = "words";
    // Count words MASTERED (or saved at) since the goal was created.
    current = vocab.filter((v) => {
      if (v.status !== "mastered") return false;
      const at = v.lastReview ?? v.createdAt;
      return at >= goal.createdAt;
    }).length;
  } else if (goal.kind === "minutes") {
    unit = "min";
    let secs = 0;
    for (const s of sessions) {
      if (s.startedAt < goal.createdAt) continue;
      if (!matchesSkill(s.kind, goal.skill)) continue;
      secs += s.durationSecs ?? 0;
    }
    current = Math.round(secs / 60);
  } else {
    unit = "sessions";
    current = sessions.filter(
      (s) => s.startedAt >= goal.createdAt && matchesSkill(s.kind, goal.skill),
    ).length;
  }

  const pct = goal.target > 0 ? Math.min(1, current / goal.target) : 0;
  const isComplete = current >= goal.target;

  let daysLeft: number | null = null;
  let expectedAtNow: number | null = null;
  let pace: GoalProgress["pace"] = null;
  let isExpired = false;

  if (goal.deadline) {
    const dayMs = 86_400;
    daysLeft = Math.ceil((goal.deadline - now) / dayMs);
    isExpired = daysLeft < 0 && !isComplete;
    const totalSpan = Math.max(1, goal.deadline - goal.createdAt);
    const elapsed = Math.max(0, Math.min(totalSpan, now - goal.createdAt));
    expectedAtNow = (goal.target * elapsed) / totalSpan;
    if (isComplete) pace = "ahead";
    else if (current >= expectedAtNow * 1.05) pace = "ahead";
    else if (current >= expectedAtNow * 0.92) pace = "on";
    else pace = "behind";
  }

  return {
    current,
    target: goal.target,
    pct,
    unit,
    daysLeft,
    pace,
    expectedAtNow,
    isComplete,
    isExpired,
  };
}

/** A goal the user could one-click adopt from the Journey view.
 *  Carries enough context to be turned into a `Goal` row via
 *  `createGoal` without further input from the user. */
export type SuggestedGoal = {
  /** Same shape as the manual-create dialog, ready to pass to
   *  `createGoal`. */
  title: string;
  kind: GoalKind;
  skill: GoalSkill;
  target: number;
  deadline: number | null;
  /** One-line "why this goal at this point" — shown as helper text
   *  next to the adopt button. */
  rationale: string;
};

/** Pick 1-3 candidate goals derived from the user's current journey
 *  state. Designed for the Journey view's "Suggested goals" panel —
 *  the user clicks "Adopt" → existing `createGoal` handles the rest.
 *
 *  Heuristics (intentionally simple — the user is meant to override):
 *    - If the journey has a target with a vocab gap, suggest a vocab
 *      goal sized to close that gap by the deadline (or 90 days if
 *      no deadline is set).
 *    - If `weeklyMinutesTarget` is set but they're not hitting it,
 *      suggest a weekly minutes goal at that target.
 *    - If any of the recommended skills (reading/listening/writing/
 *      speaking) has had 0 sessions in the past 14 days at a level
 *      that should be using it, suggest a small sessions goal for
 *      that skill.
 */
export function suggestGoalsForJourney(
  journey: LearningJourney,
  sessions: StudySession[],
  now = Math.floor(Date.now() / 1000),
): SuggestedGoal[] {
  const out: SuggestedGoal[] = [];
  const targetMilestone = journey.milestones.find(
    (m) => m.levelId === journey.targetLevelId,
  );

  // 1. Vocab-to-target goal (only when there's a real gap).
  if (targetMilestone && journey.currentVocab < targetMilestone.vocabTarget) {
    const gap = targetMilestone.vocabTarget - journey.currentVocab;
    const deadline = journey.deadline ?? now + 90 * 86_400;
    out.push({
      title: defaultGoalTitle("vocab", null, gap, deadline),
      kind: "vocab",
      skill: null,
      target: gap,
      deadline,
      rationale: `Closes the vocab gap to ${journey.targetLevelId}.`,
    });
  }

  // 2. Weekly minutes goal — only when the user committed to one.
  if (journey.weeklyMinutesTarget && journey.weeklyMinutesTarget > 0) {
    out.push({
      title: defaultGoalTitle(
        "minutes",
        null,
        journey.weeklyMinutesTarget,
        null,
      ),
      kind: "minutes",
      skill: null,
      target: journey.weeklyMinutesTarget,
      deadline: null,
      rationale:
        "Holds you to the weekly commitment you set for this journey.",
    });
  }

  // 3. Lagging-skill nudge — pick the first skill with 0 sessions in
  //    the last 14 days that the user's phase suggests they should be
  //    using. We use the suggested-habits list as the source of truth
  //    for "should be using" so the goal aligns with the study guide.
  const fourteenDaysAgo = now - 14 * 86_400;
  const recent = sessions.filter((s) => s.startedAt >= fourteenDaysAgo);
  const recentKinds = new Set(recent.map((s) => s.kind));
  for (const hint of journey.suggestedHabits) {
    if (recentKinds.has(hint.activityKind)) continue;
    out.push({
      title: defaultGoalTitle("sessions", hintKindToSkill(hint.activityKind), 3, now + 14 * 86_400),
      kind: "sessions",
      skill: hintKindToSkill(hint.activityKind),
      target: 3,
      deadline: now + 14 * 86_400,
      rationale: `Hasn't been logged in the last 14 days. ${hint.rationale}`,
    });
    // Only one lagging-skill suggestion — too many goals overwhelms.
    break;
  }

  return out.slice(0, 3);
}

/** Map a session `kind` (the loose string the timer uses) to the
 *  closed `GoalSkill` enum. Returns null when the kind doesn't map
 *  cleanly — the goal will then aggregate every session kind, which
 *  is the right behaviour for generic kinds like "review". */
function hintKindToSkill(kind: string): GoalSkill {
  switch (kind) {
    case "reading":
      return "reading";
    case "writing":
      return "writing";
    case "speaking":
      return "speaking";
    case "listening":
      return "listening";
    case "chat":
      // Chat → writing skill (the user is composing target-language text).
      return "writing";
    case "voice":
      return "speaking";
    case "podcast":
    case "video":
      return "listening";
    default:
      return null;
  }
}

export function defaultGoalTitle(
  kind: Goal["kind"],
  skill: GoalSkill,
  target: number,
  deadline: number | null,
): string {
  const skillBit = skill ? ` ${skill}` : "";
  const deadlineBit = deadline
    ? ` by ${new Date(deadline * 1000).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })}`
    : "";
  if (kind === "vocab") return `Learn ${target} words${deadlineBit}`;
  if (kind === "minutes")
    return `${target} minutes of${skillBit || " study"}${deadlineBit}`;
  return `${target} sessions${skillBit}${deadlineBit}`;
}
