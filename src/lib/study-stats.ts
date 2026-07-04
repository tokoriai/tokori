/**
 * Pure aggregations for the Progress → Statistics page.
 *
 * Everything here is a deterministic function of already-fetched rows
 * (`listVocab` / `listSessions` / `listWorkspaceReviews`) — no DB or network.
 * That keeps the stats page a thin render layer over these helpers and lets
 * the math be unit-tested without a workspace. `now` is injectable so tests
 * don't depend on the wall clock.
 */

import type { Grade } from "@/lib/fsrs";
import type {
  StudySession,
  VocabEntry,
  VocabReview,
  VocabStatus,
} from "@/lib/db";

const DAY_SECS = 86_400;

export const VOCAB_STATUSES: VocabStatus[] = [
  "unseen",
  "new",
  "learning",
  "review",
  "mastered",
];

const GRADES: Grade[] = ["again", "hard", "good", "easy"];

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** Start of the local day containing `epochSecs`, as epoch seconds. */
function startOfLocalDay(epochSecs: number): number {
  const d = new Date(epochSecs * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export type VocabCounts = Record<VocabStatus, number> & {
  total: number;
  /** Words in the active SRS queue (is_active = 1), vs library-only imports. */
  active: number;
};

/** Count vocab by status (+ total + active). Mastered is "words known". */
export function vocabStatusCounts(vocab: VocabEntry[]): VocabCounts {
  const counts: VocabCounts = {
    unseen: 0,
    new: 0,
    learning: 0,
    review: 0,
    mastered: 0,
    total: 0,
    active: 0,
  };
  for (const v of vocab) {
    counts[v.status] += 1;
    counts.total += 1;
    if (v.isActive) counts.active += 1;
  }
  return counts;
}

export type ReviewSummary = {
  total: number;
  byGrade: Record<Grade, number>;
  /** Recall rate: share of reviews the learner remembered (grade ≠ "again").
   *  This is the standard FSRS "retention" — "hard" still counts as recalled.
   *  0 when there are no reviews yet. */
  retention: number;
  reviewsToday: number;
};

export function summarizeReviews(
  reviews: VocabReview[],
  now: number = nowSecs(),
): ReviewSummary {
  const byGrade: Record<Grade, number> = { again: 0, hard: 0, good: 0, easy: 0 };
  const todayStart = startOfLocalDay(now);
  let reviewsToday = 0;
  for (const r of reviews) {
    if (GRADES.includes(r.grade)) byGrade[r.grade] += 1;
    if (r.reviewedAt >= todayStart) reviewsToday += 1;
  }
  const total = reviews.length;
  const recalled = total - byGrade.again;
  return {
    total,
    byGrade,
    retention: total > 0 ? recalled / total : 0,
    reviewsToday,
  };
}

export type StudyTotals = {
  totalSecs: number;
  todaySecs: number;
  weekSecs: number;
  monthSecs: number;
  sessions: number;
  longestSecs: number;
};

/** Roll up session durations into total / today / 7-day / 30-day windows.
 *  `todaySecs` covers only *completed* time (the running session contributes
 *  0 until it ends); the stats page adds the live `activeSecs` on top so the
 *  Today figure ticks up while a session is running. */
export function studyTotals(
  sessions: StudySession[],
  now: number = nowSecs(),
): StudyTotals {
  const todayStart = startOfLocalDay(now);
  const weekStart = now - 7 * DAY_SECS;
  const monthStart = now - 30 * DAY_SECS;
  let totalSecs = 0;
  let todaySecs = 0;
  let weekSecs = 0;
  let monthSecs = 0;
  let longestSecs = 0;
  for (const s of sessions) {
    const secs = s.durationSecs ?? 0;
    totalSecs += secs;
    if (secs > longestSecs) longestSecs = secs;
    if (s.startedAt >= todayStart) todaySecs += secs;
    if (s.startedAt >= weekStart) weekSecs += secs;
    if (s.startedAt >= monthStart) monthSecs += secs;
  }
  return {
    totalSecs,
    todaySecs,
    weekSecs,
    monthSecs,
    sessions: sessions.length,
    longestSecs,
  };
}

/** Count of vocab rows created on/after `sinceEpoch` — e.g. "words added today". */
export function wordsAddedSince(
  vocab: VocabEntry[],
  sinceEpoch: number,
): number {
  return vocab.reduce((n, v) => (v.createdAt >= sinceEpoch ? n + 1 : n), 0);
}

/** Start of today, exported so the view can compute "added today" without
 *  re-deriving the local-midnight math. */
export function startOfToday(now: number = nowSecs()): number {
  return startOfLocalDay(now);
}
