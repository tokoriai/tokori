/**
 * Habits — repeating time-targeted goals scoped to a workspace.
 *
 * Each habit pairs an activity kind (one of the built-in session kinds, or
 * a user-defined string) with a target duration on a daily or weekly
 * cadence. Progress is computed by summing `study_sessions.duration_secs`
 * across the matching kind for the current period.
 *
 * Custom activity kinds get the same time-tracking pipeline as the
 * built-ins — `study_sessions.kind` is plain TEXT, so a habit pointed at
 * "shadowing" or "listening" works as soon as the user logs a session
 * with that kind. There's no per-kind enum to extend.
 */

import { isTauri } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { logSession } from "./db";

let dbPromise: Promise<Database> | null = null;
async function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:tokori.db");
  return dbPromise;
}

export type HabitFrequency = "daily" | "weekly";

export type Habit = {
  id: number;
  workspaceId: number;
  name: string;
  /** NULL = any session counts; otherwise filter sessions.kind. */
  activityKind: string | null;
  targetSecs: number;
  frequency: HabitFrequency;
  glyph: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type HabitRow = {
  id: number;
  workspace_id: number;
  name: string;
  activity_kind: string | null;
  target_secs: number;
  frequency: string;
  glyph: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

function rowToHabit(r: HabitRow): Habit {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    activityKind: r.activity_kind,
    targetSecs: r.target_secs,
    frequency: r.frequency === "weekly" ? "weekly" : "daily",
    glyph: r.glyph,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLS =
  "id, workspace_id, name, activity_kind, target_secs, frequency, glyph, archived_at, created_at, updated_at";

export async function listHabits(
  workspaceId: number,
  opts: { includeArchived?: boolean } = {},
): Promise<Habit[]> {
  if (!isTauri()) return [];
  const db = await getDb();
  const rows = await db.select<HabitRow[]>(
    opts.includeArchived
      ? `SELECT ${COLS} FROM habits WHERE workspace_id = $1 ORDER BY created_at ASC`
      : `SELECT ${COLS} FROM habits WHERE workspace_id = $1 AND archived_at IS NULL ORDER BY created_at ASC`,
    [workspaceId],
  );
  return rows.map(rowToHabit);
}

export async function createHabit(input: {
  workspaceId: number;
  name: string;
  activityKind: string | null;
  targetSecs: number;
  frequency: HabitFrequency;
  glyph?: string | null;
}): Promise<Habit> {
  if (!isTauri()) {
    throw new Error("Habits require Tauri storage.");
  }
  const db = await getDb();
  const r = await db.execute(
    `INSERT INTO habits (workspace_id, name, activity_kind, target_secs, frequency, glyph)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.workspaceId,
      input.name,
      input.activityKind ?? null,
      input.targetSecs,
      input.frequency,
      input.glyph ?? null,
    ],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<HabitRow[]>(
    `SELECT ${COLS} FROM habits WHERE id = $1`,
    [id],
  );
  return rowToHabit(rows[0]);
}

export async function updateHabit(input: {
  id: number;
  name?: string;
  activityKind?: string | null;
  targetSecs?: number;
  frequency?: HabitFrequency;
  glyph?: string | null;
  archivedAt?: number | null;
}): Promise<void> {
  if (!isTauri()) return;
  const db = await getDb();
  const fields: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) {
    fields.push(`name = $${fields.length + 1}`);
    params.push(input.name);
  }
  if (input.activityKind !== undefined) {
    fields.push(`activity_kind = $${fields.length + 1}`);
    params.push(input.activityKind);
  }
  if (input.targetSecs !== undefined) {
    fields.push(`target_secs = $${fields.length + 1}`);
    params.push(input.targetSecs);
  }
  if (input.frequency !== undefined) {
    fields.push(`frequency = $${fields.length + 1}`);
    params.push(input.frequency);
  }
  if (input.glyph !== undefined) {
    fields.push(`glyph = $${fields.length + 1}`);
    params.push(input.glyph);
  }
  if (input.archivedAt !== undefined) {
    fields.push(`archived_at = $${fields.length + 1}`);
    params.push(input.archivedAt);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = strftime('%s','now')`);
  params.push(input.id);
  await db.execute(
    `UPDATE habits SET ${fields.join(", ")} WHERE id = $${params.length}`,
    params,
  );
}

export async function deleteHabit(id: number): Promise<void> {
  if (!isTauri()) return;
  const db = await getDb();
  await db.execute("DELETE FROM habits WHERE id = $1", [id]);
}

// ─── Progress + custom activity kinds ─────────────────────────────────────

/** Start of the current period (today / this week, Monday-based) in
 *  unix seconds. The window the habit's progress is measured over. */
export function periodStartSec(freq: HabitFrequency, now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (freq === "weekly") {
    // Roll back to Monday. JS's getDay() is 0=Sun..6=Sat — Monday-based
    // weeks are what most habit apps use and what feels natural here.
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
  }
  return Math.floor(d.getTime() / 1000);
}

export type HabitProgress = {
  habit: Habit;
  /** Seconds logged in the current period that match the habit. */
  doneSecs: number;
  /** doneSecs / targetSecs, capped at 1. */
  ratio: number;
  /** Streak in completed periods. Walks back from the current period
   *  looking at previous days/weeks; stops at the first incomplete one. */
  streak: number;
};

/** Compute progress for a habit by summing matching session durations. */
export async function computeHabitProgress(habit: Habit): Promise<HabitProgress> {
  if (!isTauri()) {
    return { habit, doneSecs: 0, ratio: 0, streak: 0 };
  }
  const db = await getDb();
  const since = periodStartSec(habit.frequency);
  const where = habit.activityKind
    ? "workspace_id = $1 AND started_at >= $2 AND kind = $3"
    : "workspace_id = $1 AND started_at >= $2";
  const params: unknown[] = habit.activityKind
    ? [habit.workspaceId, since, habit.activityKind]
    : [habit.workspaceId, since];
  const rows = await db.select<{ total: number | null }[]>(
    `SELECT COALESCE(SUM(duration_secs), 0) AS total FROM study_sessions WHERE ${where}`,
    params,
  );
  const doneSecs = rows[0]?.total ?? 0;
  const ratio = habit.targetSecs > 0 ? Math.min(1, doneSecs / habit.targetSecs) : 0;

  // Streak — walk backwards period by period. Cap the depth so a habit
  // with months of history doesn't pay for an unbounded SELECT loop on
  // every render; users who care about long streaks tend to look at
  // them as graphs anyway.
  const MAX_LOOKBACK = 60;
  let streak = ratio >= 1 ? 1 : 0;
  if (streak > 0) {
    const periodSecs = habit.frequency === "weekly" ? 7 * 86400 : 86400;
    for (let i = 1; i < MAX_LOOKBACK; i++) {
      const periodEnd = since - (i - 1) * periodSecs;
      const periodStart = periodEnd - periodSecs;
      const r = await db.select<{ total: number | null }[]>(
        `SELECT COALESCE(SUM(duration_secs), 0) AS total FROM study_sessions
           WHERE workspace_id = $1
             AND started_at >= $2 AND started_at < $3
             ${habit.activityKind ? "AND kind = $4" : ""}`,
        habit.activityKind
          ? [habit.workspaceId, periodStart, periodEnd, habit.activityKind]
          : [habit.workspaceId, periodStart, periodEnd],
      );
      if ((r[0]?.total ?? 0) >= habit.targetSecs) {
        streak += 1;
      } else {
        break;
      }
    }
  }

  return { habit, doneSecs, ratio, streak };
}

/** Distinct activity kinds that have actually appeared in this workspace's
 *  sessions. Drives the "kind" dropdown when creating/editing a habit so
 *  the user can pick from kinds they're actively using without typing. */
export async function listSeenActivityKinds(workspaceId: number): Promise<string[]> {
  if (!isTauri()) return ["chat", "review", "reading", "writing", "speaking"];
  const db = await getDb();
  const rows = await db.select<{ kind: string }[]>(
    "SELECT DISTINCT kind FROM study_sessions WHERE workspace_id = $1 AND kind IS NOT NULL ORDER BY kind ASC",
    [workspaceId],
  );
  // Always include the canonical built-ins so the dropdown isn't empty
  // for fresh workspaces.
  const seen = new Set<string>([
    "chat",
    "review",
    "reading",
    "writing",
    "speaking",
  ]);
  for (const r of rows) seen.add(r.kind);
  return Array.from(seen).sort();
}

// ─── Goal → habit plan ───────────────────────────────────────────────────
//
// A goal carries a target ("1000 words by Jul 15", "300 min by Friday")
// while a habit carries a cadence ("30 min/day"). Bridging them is just
// arithmetic: divide the remaining target by the remaining time and the
// daily/weekly load falls out.
//
// We only handle the "with deadline" case — without a deadline there's no
// rate to derive. Callers should hide the "Generate plan" affordance for
// open-ended goals.

import type { Goal } from "./db";

/** Map a goal's `skill` into a session `kind`. The two enums don't quite
 *  line up — goals talk about "skills" (reading, writing, ...), sessions
 *  talk about "kinds" (chat, review, voice, ...). For the habit plan we
 *  pick the most relevant kind, falling back to null for "any". */
function skillToActivityKind(skill: Goal["skill"]): string | null {
  switch (skill) {
    case "reading":
      return "reading";
    case "writing":
      return "writing";
    case "speaking":
      return "speaking";
    case "listening":
      return "listening";
    default:
      return null;
  }
}

export type HabitPlan = {
  name: string;
  activityKind: string | null;
  targetSecs: number;
  frequency: HabitFrequency;
  /** Human-readable rationale for the picked numbers, shown in the
   *  confirmation dialog. */
  rationale: string;
};

/**
 * Translate a goal into a daily habit that, if followed, hits the goal
 * by its deadline. Returns null when the goal has no deadline (so we
 * have no rate to compute) or has already been hit.
 */
export function planHabitFromGoal(
  goal: Goal,
  now: number = Math.floor(Date.now() / 1000),
): HabitPlan | null {
  if (goal.deadline == null) return null;
  const daysLeft = Math.max(1, Math.ceil((goal.deadline - now) / 86400));

  if (goal.kind === "minutes") {
    const minPerDay = Math.max(5, Math.round(goal.target / daysLeft));
    return {
      name: `${minPerDay} min/day toward "${goal.title}"`,
      activityKind: skillToActivityKind(goal.skill),
      targetSecs: minPerDay * 60,
      frequency: "daily",
      rationale: `${goal.target} min ÷ ${daysLeft} days = ${minPerDay} min/day.`,
    };
  }

  if (goal.kind === "sessions") {
    // Treat one session ≈ 15 min for a realistic time-budget proxy. The
    // habit tracks time, not session count; this conversion lets goal
    // and habit progress reinforce each other.
    const sessionsPerDay = goal.target / daysLeft;
    const minPerDay = Math.max(10, Math.round(sessionsPerDay * 15));
    return {
      name: `${minPerDay} min/day toward "${goal.title}"`,
      activityKind: skillToActivityKind(goal.skill),
      targetSecs: minPerDay * 60,
      frequency: "daily",
      rationale: `${goal.target} sessions ÷ ${daysLeft} days ≈ ${sessionsPerDay.toFixed(
        1,
      )} per day, ~15 min each → ${minPerDay} min/day.`,
    };
  }

  // "vocab": review-driven. Rule of thumb is ~1.5 min per word landed
  // (mix of new + review). Builds a daily review habit on the "review"
  // session kind so flashcard sessions count toward the goal.
  if (goal.kind === "vocab") {
    const wordsPerDay = Math.max(5, Math.round(goal.target / daysLeft));
    const minPerDay = Math.max(10, Math.round(wordsPerDay * 1.5));
    return {
      name: `${minPerDay} min/day review for "${goal.title}"`,
      activityKind: "review",
      targetSecs: minPerDay * 60,
      frequency: "daily",
      rationale: `${goal.target} words ÷ ${daysLeft} days ≈ ${wordsPerDay} words/day at ~1.5 min each → ${minPerDay} min/day of reviews.`,
    };
  }

  return null;
}

/**
 * Manually log a session. Delegates to `db.logSession` so all manual
 * logs route through one path — the dashboard's quick-action button,
 * the habits view's "Log time" affordance, and the dedicated Activities
 * tab all converge on the same insert. That gives `listManualSessions`
 * a single discriminator (`notes IS NOT NULL`) to filter on, and
 * deletions in the Activities view show up everywhere immediately.
 *
 * Caller-side compat: this helper used to be its own INSERT. Existing
 * call sites pass the same `{ workspaceId, kind, durationSecs, notes }`
 * shape — `startedAt` becomes the `when` end-time argument (we keep it
 * named `startedAt` here for backwards compatibility but the semantic
 * meaning is "when the activity finished").
 */
export async function logManualSession(input: {
  workspaceId: number;
  kind: string;
  durationSecs: number;
  startedAt?: number;
  notes?: string | null;
}): Promise<void> {
  await logSession({
    workspaceId: input.workspaceId,
    kind: input.kind,
    durationSecs: input.durationSecs,
    // Existing callers pass `startedAt` meaning "when did the activity
    // begin"; logSession's `when` is the *end* time so we add duration.
    when: input.startedAt
      ? input.startedAt + input.durationSecs
      : undefined,
    // Keep notes nullable across the API but coerce undefined → empty
    // string here so the Activities-tab filter (`notes IS NOT NULL`)
    // picks up sessions logged via this path too.
    notes: input.notes ?? "",
  });
}
