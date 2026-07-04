/**
 * Vocab-growth replay engine.
 *
 * Pure function. Replays a workspace's review log forward day-by-day
 * and emits per-day bucket counts the chart can plot. Lives outside
 * the chart component so it's unit-testable in isolation and so the
 * mobile app can use the same logic without pulling React in.
 *
 * Bucket semantics:
 *   • known    — Studied + not currently lapsing. Anything with
 *                FSRS status `review` or `mastered` and lapses below
 *                threshold. This is the inclusive "how many words
 *                have I acquired" count — it does NOT drop when a
 *                card becomes overdue, because the user still knows
 *                the word; they just owe the scheduler a check-in.
 *   • due      — **Subset of known** that's currently overdue
 *                (`dueAt ≤ dayEnd`). Rendered as an overlay on the
 *                Known curve so the user sees both "I know 412
 *                words" and "38 of them need review today" without
 *                them visually subtracting from each other.
 *   • learning — In the FSRS learning/relearning ladder (status
 *                `new` or `learning`) and below the leech threshold.
 *                Words actively being acquired but not yet
 *                consolidated.
 *   • leeches  — Lapses ≥ `leechThreshold`. Cards the user keeps
 *                forgetting; surfaced as a distinct concern.
 *
 * Disjoint invariant: known + learning + leeches = total active
 * cards. Due is independent and satisfies `0 ≤ due ≤ known`.
 *
 * Why inclusive Known: the previous definition (Known = review &
 * not-due) made the headline number plunge every time the user
 * skipped a few days — even though they hadn't actually forgotten
 * anything. Users said this felt wrong: "I studied those words, I
 * remember them, the chart shouldn't say I unlearned them." Now
 * Known only drops when a card actually lapses (drops back to
 * learning) or crosses the leech threshold — both real signals.
 */

import type { VocabEntry, VocabReview, VocabStatus } from "./db";
import type { Grade } from "./fsrs";

export type GrowthBucketKey = "known" | "due" | "learning" | "leeches";

export type GrowthRow = {
  date: string;
  known: number;
  due: number;
  learning: number;
  leeches: number;
};

export type GrowthVocab = Pick<
  VocabEntry,
  "id" | "createdAt" | "lastReview" | "stability" | "dueAt" | "status"
>;

export type GrowthReview = Pick<
  VocabReview,
  "vocabId" | "grade" | "newDueAt" | "newStatus" | "reviewedAt"
>;

export type GrowthInput = {
  vocab: GrowthVocab[];
  /** Workspace-wide review history, any order. Replayed ascending. */
  reviews: GrowthReview[];
  /** How many days of history to render, ending today. */
  days: number;
  /** Lapses at which a card flips into the Leeches bucket. Defaults
   *  to FSRS's standard 8. Pass the user's actual workspace value
   *  for an exact match with the scheduler. */
  leechThreshold?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now()`. */
  now?: number;
};

type ReplayState = {
  status: VocabStatus;
  dueAt: number;
  lapses: number;
};

const DAY_MS = 86_400_000;
const DEFAULT_LEECH_THRESHOLD = 8;

export function computeVocabGrowth(input: GrowthInput): GrowthRow[] {
  const { vocab, reviews, days } = input;
  if (vocab.length === 0 || days <= 0) return [];
  const leechThreshold = input.leechThreshold ?? DEFAULT_LEECH_THRESHOLD;
  const now = input.now ?? Date.now();

  const dayEnds: number[] = [];
  const labels: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const end = new Date(now - i * DAY_MS);
    end.setHours(23, 59, 59, 999);
    dayEnds.push(Math.floor(end.getTime() / 1000));
    labels.push(
      end.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  }

  // Some installs (legacy desktop pre-review-log; hosted lag right
  // after a grade) have vocab rows without matching review entries.
  // Synthesise one event per such row so the curve isn't blank — the
  // event lands at the best-effort timestamp we have (lastReview, or
  // createdAt for rows imported as "already-known").
  const reviewedIds = new Set<number>();
  for (const r of reviews) reviewedIds.add(r.vocabId);
  const synthetic: GrowthReview[] = [];
  for (const v of vocab) {
    if (reviewedIds.has(v.id)) continue;
    const anchor =
      v.lastReview && v.lastReview > 0
        ? v.lastReview
        : v.stability > 0 && v.createdAt > 0
          ? v.createdAt
          : null;
    if (anchor == null) continue;
    // The card's current status is the best guess we have for what
    // the missing review event "wanted" to set it to. Same grade
    // either way — we never want to synthesise a lapse without proof.
    const grade: Grade = "good";
    synthetic.push({
      vocabId: v.id,
      grade,
      newStatus: v.status,
      newDueAt: v.dueAt,
      reviewedAt: anchor,
    });
  }
  const sorted = reviews
    .concat(synthetic)
    .sort((a, b) => a.reviewedAt - b.reviewedAt);

  const state = new Map<number, ReplayState>();
  let reviewIdx = 0;

  const out: GrowthRow[] = [];
  for (let di = 0; di < dayEnds.length; di++) {
    const dayEnd = dayEnds[di];

    // Apply every review on or before this day-end.
    while (
      reviewIdx < sorted.length &&
      sorted[reviewIdx].reviewedAt <= dayEnd
    ) {
      const r = sorted[reviewIdx++];
      const prev =
        state.get(r.vocabId) ??
        ({
          status: "new" as VocabStatus,
          dueAt: r.newDueAt ?? r.reviewedAt,
          lapses: 0,
        } satisfies ReplayState);
      // newStatus is authoritative — it's what FSRS wrote after the
      // grade. newDueAt may be null on very old rows; keep the prior
      // value rather than zeroing it (would falsely flip Known → Due).
      const next: ReplayState = {
        status: r.newStatus,
        dueAt: r.newDueAt ?? prev.dueAt,
        lapses: r.grade === "again" ? prev.lapses + 1 : prev.lapses,
      };
      state.set(r.vocabId, next);
    }

    let known = 0;
    let due = 0;
    let learning = 0;
    let leeches = 0;
    for (const v of vocab) {
      if (v.createdAt > dayEnd) continue;
      // Skip imported-but-never-activated cards. They're library
      // content, not part of the SRS process, and including them
      // would make the chart's "learning" bar spike every time the
      // user installs a textbook pack.
      if (v.status === "unseen" && !state.has(v.id)) continue;
      const s = state.get(v.id);
      if (!s) {
        // Created but no review yet — actively learning.
        learning += 1;
        continue;
      }
      if (s.lapses >= leechThreshold) {
        leeches += 1;
        continue;
      }
      if (s.status === "review" || s.status === "mastered") {
        // Inclusive Known: the user has studied this word and the
        // scheduler hasn't lost confidence in it yet (lapses below
        // threshold). Overdue cards still count — Due is reported
        // as an overlay subset, not a debit.
        known += 1;
        if (s.dueAt <= dayEnd) due += 1;
      } else {
        learning += 1;
      }
    }
    out.push({ date: labels[di], known, due, learning, leeches });
  }
  return out;
}
