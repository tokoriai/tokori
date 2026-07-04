/**
 * Streak math. Lives in lib/ rather than inside a view so the
 * dashboard KPI tile and the Milestones page agree on which days
 * "count" — duplicating the rule across two `computeStreak` copies
 * is how a streak inflation bug shipped originally.
 */

import type { StudySession } from "@/lib/db";

/**
 * Whether a session should bump the streak. The rule is "actual
 * learning, not just opening the app":
 *
 *  - Reviews (`kind === "review"`): always — you graded cards.
 *  - Reading (`kind === "reading"`): always — you opened a doc.
 *  - Speaking (`kind === "speaking"`): always — live-voice session.
 *  - Manually logged activities (`notes != null`): always — the
 *    user explicitly says they did something.
 *  - Chat / writing (`kind === "writing"` / `"chat"`): only if the
 *    session has any words-seen or words-saved on it. Without that
 *    it's just the chat tab being open — the desktop fires
 *    `ensureStarted("writing")` on chat-tab mount, so before this
 *    filter every page load was inflating the streak.
 */
export function sessionCountsForStreak(s: StudySession): boolean {
  if (s.notes != null && s.notes.length > 0) return true;
  if (s.kind === "review" || s.kind === "reading" || s.kind === "speaking") {
    return true;
  }
  return s.wordsSeen > 0 || s.wordsSaved > 0;
}

/**
 * Count consecutive days ending today that have at least one
 * streak-qualifying session. Walks backward from today; the first
 * gap (other than today itself, which is allowed to be empty so the
 * UI doesn't show 0 on Monday morning before you've studied) breaks
 * the count.
 *
 * `sessions` is the unfiltered set — we apply
 * `sessionCountsForStreak` inside.
 */
export function computeStreak(sessions: StudySession[]): number {
  if (sessions.length === 0) return 0;
  const days = new Set<string>();
  for (const s of sessions) {
    if (!sessionCountsForStreak(s)) continue;
    const d = new Date(s.startedAt * 1000);
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  let streak = 0;
  const today = new Date();
  for (let offset = 0; offset < 365; offset++) {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (days.has(key)) streak += 1;
    else if (offset === 0) continue;
    else break;
  }
  return streak;
}

/**
 * The longest run of consecutive streak-qualifying days anywhere in the
 * history — the "personal best" shown on the stats page. Same day-bucketing
 * and `sessionCountsForStreak` rule as `computeStreak`, so the two never
 * disagree on which days count.
 */
export function longestStreak(sessions: StudySession[]): number {
  const days = new Set<string>();
  for (const s of sessions) {
    if (!sessionCountsForStreak(s)) continue;
    const d = new Date(s.startedAt * 1000);
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  if (days.size === 0) return 0;
  // Map each "Y-M-D" key to a calendar day number (via UTC of those exact
  // components, so DST never makes two adjacent days differ by ≠ 1), sort,
  // then find the longest +1 run.
  const dayNums = Array.from(days)
    .map((k) => {
      const [y, m, d] = k.split("-").map(Number);
      return Math.floor(Date.UTC(y, m, d) / 86_400_000);
    })
    .sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  for (let i = 1; i < dayNums.length; i++) {
    if (dayNums[i] === dayNums[i - 1] + 1) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
}
