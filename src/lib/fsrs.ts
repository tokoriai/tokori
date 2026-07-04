/**
 * FSRS-5 spaced-repetition scheduler.
 *
 * FSRS-5 (Free Spaced Repetition Scheduler v5) is the modern algorithm
 * that replaced SM-2 in Anki and most serious SRS apps. It models a
 * card with two latent variables — Stability (S) and Difficulty (D) —
 * and updates them after each review based on the user's rating and
 * the elapsed time since the last review (which gives Retrievability
 * R, "how likely was this remembered just now").
 *
 * Reference:
 *   • Algorithm spec: https://github.com/open-spaced-repetition/fsrs5
 *   • The 19 default weights below come from the optimised average
 *     across the open-spaced-repetition reference dataset; users
 *     can tune them per-deck for better personal calibration.
 *
 * Around the FSRS core we keep a single short step for "Again": a card
 * the user fails (new or lapsed) comes back almost immediately. Every
 * passing grade — Hard / Good / Easy — graduates straight into the
 * FSRS-managed review queue, seeded from the algorithm's initial-
 * stability weights, so a recalled card gets a day-scale interval
 * instead of bouncing through minute-long steps in the same session.
 */

import type { VocabEntry, VocabStatus } from "./db";

export type Grade = "again" | "hard" | "good" | "easy";

const RATING_NUMBER: Record<Grade, number> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};

/** Canonical grade order, worst → best. */
const GRADES: readonly Grade[] = ["again", "hard", "good", "easy"];

/** FSRS-5 default weights. 19 floats — index meaning is fixed by the
 *  algorithm. Users can override via the SRS settings panel ("Advanced
 *  weights") for personal tuning. */
export const DEFAULT_FSRS_WEIGHTS: readonly number[] = [
  0.40255, 1.18385, 3.173, 15.69105,
  7.1949, 0.5345, 1.4604, 0.0046,
  1.54575, 0.1192, 1.01925, 1.9395,
  0.11, 0.29605, 2.2698, 0.2315,
  2.9898, 0.51655, 0.6621,
];

export type SRSConfig = {
  /** Learning ladder for new cards, in MINUTES. After "Good", advance
   *  one step; after the last step, graduate to review with
   *  `graduatingInterval`. "Again" resets to step 0 — for new AND
   *  lapsed review cards alike, so failing a card always brings it
   *  back within the first step (default 1 minute). */
  learningSteps: number[];
  /** Days for the first review after graduating from learning. */
  graduatingInterval: number;
  /** Days for the first review when "Easy" is pressed on a learning card. */
  easyInterval: number;
  /** Target retention probability (0.7–0.97). Higher = more reviews,
   *  shorter intervals. 0.9 is the FSRS default. */
  desiredRetention: number;
  /** Hard cap on a single interval, in days. */
  maximumInterval: number;
  /** Stability threshold (days) at which a review card is considered
   *  mastered and dropped from the active queue. */
  masteredThreshold: number;
  /** After this many lapses the card is flagged a leech. UI surfaces
   *  this as a tag on the card; the scheduler itself doesn't change
   *  behaviour for leeches. */
  leechThreshold: number;
  /** What to do when a card hits the leech threshold. */
  leechAction: "tag" | "suspend";
  /** 19 FSRS weights. Override the defaults to personally tune the
   *  forgetting curve. */
  weights: number[];
};

export const DEFAULT_SRS_CONFIG: SRSConfig = {
  learningSteps: [1, 10],
  graduatingInterval: 1,
  easyInterval: 4,
  desiredRetention: 0.9,
  maximumInterval: 36500,
  masteredThreshold: 365,
  leechThreshold: 8,
  leechAction: "tag",
  weights: [...DEFAULT_FSRS_WEIGHTS],
};

export type Schedule = {
  status: VocabStatus;
  stability: number; // days
  difficulty: number; // 1..10
  learningStep: number; // index into learningSteps
  dueAt: number; // unix seconds
};

const DAY_S = 86400;
const MIN_S = 60;

// FSRS-5 forgetting-curve constant. With factor = 19/81 the curve
// hits exactly R=0.9 at t=S (so stability is "the interval at which
// recall probability drops to 90%"). Re-derived for any retention
// target via the next_interval helper below.
const FACTOR = 19 / 81;
const DECAY = -0.5;

/** Probability of recall at elapsed time `t` days given stability `S`. */
function retrievability(t: number, S: number): number {
  if (S <= 0) return 0;
  return Math.pow(1 + (FACTOR * t) / S, DECAY);
}

/** Convert a stability into a next-interval (days) given the user's
 *  desired retention target. Smaller retention → longer interval. */
function nextInterval(S: number, retention: number, maxDays: number): number {
  const days = (S / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return Math.max(1, Math.min(maxDays, Math.round(days)));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── FSRS-5 stability / difficulty updates ────────────────────────────────

function initialDifficulty(rating: number, w: number[]): number {
  // D0(rating) = w[4] - exp(w[5] * (rating - 1)) + 1, clamped 1..10.
  return clamp(w[4] - Math.exp(w[5] * (rating - 1)) + 1, 1, 10);
}

function meanReversion(w: number[], D: number): number {
  // Drift difficulty toward the mean (w[7] is the rate).
  return w[7] * (initialDifficulty(4, w)) + (1 - w[7]) * D;
}

function nextDifficulty(D: number, rating: number, w: number[]): number {
  // Linear update around rating "good".
  const newD = D - w[6] * (rating - 3);
  return clamp(meanReversion(w, newD), 1, 10);
}

function nextStabilityRecall(
  D: number,
  S: number,
  R: number,
  rating: number,
  w: number[],
): number {
  // From the FSRS-5 spec — short-term + Hard/Easy modifiers built in.
  const hardPenalty = rating === 2 ? w[15] : 1;
  const easyBonus = rating === 4 ? w[16] : 1;
  return (
    S *
    (1 +
      Math.exp(w[8]) *
        (11 - D) *
        Math.pow(S, -w[9]) *
        (Math.exp((1 - R) * w[10]) - 1) *
        hardPenalty *
        easyBonus)
  );
}

function nextStabilityForget(
  D: number,
  S: number,
  R: number,
  w: number[],
): number {
  return (
    w[11] *
    Math.pow(D, -w[12]) *
    (Math.pow(S + 1, w[13]) - 1) *
    Math.exp((1 - R) * w[14])
  );
}

/**
 * Schedule the next review for a card.
 *
 * Splits along three axes:
 *   1. Learning / Review state (drives whether we walk the learning
 *      ladder or call into FSRS).
 *   2. Rating (Again, Hard, Good, Easy) — per-state semantics.
 *   3. Elapsed days since last review (only used for FSRS retrieval).
 *
 * Returns the new SRS columns + dueAt. The DB write happens at the
 * call-site (via `reviewVocab`), so this function is pure and easy
 * to unit-test against fixtures.
 */
export function schedule(
  entry: VocabEntry,
  grade: Grade,
  config: SRSConfig = DEFAULT_SRS_CONFIG,
  now = Math.floor(Date.now() / 1000),
): Schedule {
  const rating = RATING_NUMBER[grade];
  const w = config.weights;

  // ── Learning phase (new + learning, including relearning) ────────────
  // "unseen" only reaches the scheduler if someone grades a card
  // that was never activated through normal channels — treat it as
  // "new" so it enters the learning ladder from scratch.
  const inLearning =
    entry.status === "unseen" ||
    entry.status === "new" ||
    entry.status === "learning";
  if (inLearning) {
    // Every passing grade graduates straight into FSRS review
    // scheduling — no minute-scale ladder for Hard / Good / Easy. This
    // is the science-based FSRS-5 behaviour (and matches Anki run with
    // minimal learning steps): a card the user recalled, even with
    // effort, gets a day-scale interval seeded from the initial-
    // stability weights instead of resurfacing minutes later the same
    // sitting.
    if (grade !== "again") {
      return graduateFromLearning(entry, grade, config, now);
    }
    // "Again" always resets to the first learning step, so the card
    // comes back within ~a minute exactly like a brand-new card (the
    // recall plugin also re-queues it a few cards later for an
    // in-session retry). No separate relearning ladder — a fail is a
    // fail, whatever the card's history.
    const minutes = config.learningSteps[0] ?? 1;
    // Nudge difficulty up so subsequent reviews respect that this lapsed.
    const D = entry.difficulty
      ? clamp(entry.difficulty + 0.2, 1, 10)
      : initialDifficulty(rating, w);
    return {
      status: "learning",
      stability: minutes / 1440,
      difficulty: D,
      learningStep: 0,
      dueAt: now + minutes * MIN_S,
    };
  }

  // ── Review / mastered phase — FSRS proper ────────────────────────────
  const D = entry.difficulty || initialDifficulty(rating, w);
  const S = Math.max(0.1, entry.stability);
  const elapsedDays = entry.lastReview
    ? Math.max(0, (now - entry.lastReview) / DAY_S)
    : 0;
  const R = retrievability(elapsedDays, S);

  if (grade === "again") {
    // Lapse — partial reset via FSRS forget formula, then straight back
    // to the first learning step: "Again" always means "show me again
    // in a minute", the same as the first time the card was seen.
    const newS = nextStabilityForget(D, S, R, w);
    const newD = nextDifficulty(D, 1, w);
    const minutes = config.learningSteps[0] ?? 1;
    return {
      status: "learning",
      stability: Math.max(newS, minutes / 1440),
      difficulty: newD,
      learningStep: 0,
      dueAt: now + minutes * MIN_S,
    };
  }

  // Hard / Good / Easy
  const newS = nextStabilityRecall(D, S, R, rating, w);
  const newD = nextDifficulty(D, rating, w);
  const interval = nextInterval(
    newS,
    config.desiredRetention,
    config.maximumInterval,
  );
  const status: VocabStatus =
    newS >= config.masteredThreshold ? "mastered" : "review";
  return {
    status,
    stability: newS,
    difficulty: newD,
    learningStep: 0,
    dueAt: now + interval * DAY_S,
  };
}

/**
 * Graduate a learning / relearning card into FSRS review scheduling.
 *
 * Stability is seeded from the FSRS-5 initial-stability weights —
 * S0(rating) = w[rating-1], in days — which at the default 90 %
 * retention yield first intervals of roughly Hard ≈ 1d, Good ≈ 3d,
 * Easy ≈ 2w (and that's exactly what the answer-button labels show).
 * The `graduatingInterval` / `easyInterval` settings act as floors, so
 * a user can force longer first intervals without overriding the
 * science-based defaults. A first-ever review takes FSRS's initial
 * difficulty; a relearned lapse keeps and nudges its existing one.
 */
function graduateFromLearning(
  entry: VocabEntry,
  grade: Grade,
  config: SRSConfig,
  now: number,
): Schedule {
  const rating = RATING_NUMBER[grade];
  const w = config.weights;
  let seedStability = clamp(w[rating - 1], 0.1, config.maximumInterval);
  if (grade === "good") {
    seedStability = Math.max(seedStability, config.graduatingInterval);
  } else if (grade === "easy") {
    seedStability = Math.max(seedStability, config.easyInterval);
  }
  const D =
    entry.lastReview == null
      ? initialDifficulty(rating, w)
      : nextDifficulty(entry.difficulty || initialDifficulty(rating, w), rating, w);
  const interval = nextInterval(
    seedStability,
    config.desiredRetention,
    config.maximumInterval,
  );
  return {
    status: seedStability >= config.masteredThreshold ? "mastered" : "review",
    stability: seedStability,
    difficulty: D,
    learningStep: 0,
    dueAt: now + interval * DAY_S,
  };
}

// ── Interval labels (Anki-style answer-button hints) ───────────────────────

/** Format a forward interval (in seconds) as a compact Anki-style label:
 *  "<1m", "6m", "2h", "1d", "12d", "2mo", "1.1y". Shown under each grade
 *  button so the learner sees the real next interval, not a static guess. */
export function formatInterval(seconds: number): string {
  if (seconds < 45) return "<1m";
  const mins = seconds / 60;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 31) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  const years = days / 365;
  return `${years < 10 ? years.toFixed(1) : Math.round(years)}y`;
}

/** The next-interval label for each grade given a card's *current* SRS
 *  state — exactly what pressing that button would schedule right now.
 *  The honest, per-card replacement for a static hint table: it runs the
 *  scheduler once per grade and formats each result. Keep this in sync
 *  with `schedule()` by construction (it calls straight into it). */
export function gradeIntervalHints(
  entry: VocabEntry,
  config: SRSConfig = DEFAULT_SRS_CONFIG,
  now = Math.floor(Date.now() / 1000),
): Record<Grade, string> {
  const out = {} as Record<Grade, string>;
  for (const g of GRADES) {
    const next = schedule(entry, g, config, now);
    out[g] = formatInterval(Math.max(0, next.dueAt - now));
  }
  return out;
}

// ── Presets ──────────────────────────────────────────────────────────────

export type PresetId = "default" | "aggressive" | "cautious";

export const SRS_PRESETS: Record<PresetId, SRSConfig> = {
  default: DEFAULT_SRS_CONFIG,
  aggressive: {
    ...DEFAULT_SRS_CONFIG,
    learningSteps: [1, 5],
    desiredRetention: 0.85,
    masteredThreshold: 180,
  },
  cautious: {
    ...DEFAULT_SRS_CONFIG,
    learningSteps: [1, 10, 60 * 24],
    desiredRetention: 0.95,
    masteredThreshold: 730,
  },
};

export const PRESET_LABEL: Record<PresetId, string> = {
  default: "Default — FSRS-5 standard (90% retention)",
  aggressive: "Aggressive — fewer reviews, 85% retention",
  cautious: "Cautious — more reviews, 95% retention",
};
