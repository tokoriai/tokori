/**
 * Watch/listen time rollups for the Immersion view's stat strip.
 *
 * Time comes from `study_sessions` (the same rows the dashboard's
 * immersion KPIs read), narrowed to the audio-visual kinds — the
 * in-app timer's "listening", the Companion extension's live "video"
 * sessions, and the activity logger's video/podcast/immersion presets.
 * Reading/writing/review time stays on the dashboard where it belongs.
 */

import type { StudySession } from "@/lib/db";

const WATCH_KINDS = new Set(["video", "podcast", "listening", "immersion"]);

export type WatchTimeTotals = {
  todaySecs: number;
  weekSecs: number;
  totalSecs: number;
};

/** Sum media-kind session time. `nowMs` is injected so the day/week
 *  boundaries are testable; "today" starts at local midnight, "week"
 *  is a rolling 7 days. */
export function watchTimeTotals(
  sessions: readonly Pick<StudySession, "kind" | "startedAt" | "durationSecs">[],
  nowMs: number,
): WatchTimeTotals {
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const todayStart = Math.floor(midnight.getTime() / 1000);
  const weekStart = Math.floor(nowMs / 1000) - 7 * 86_400;

  const out: WatchTimeTotals = { todaySecs: 0, weekSecs: 0, totalSecs: 0 };
  for (const s of sessions) {
    if (!WATCH_KINDS.has(s.kind)) continue;
    const secs = s.durationSecs ?? 0;
    if (secs <= 0) continue;
    out.totalSecs += secs;
    if (s.startedAt >= weekStart) out.weekSecs += secs;
    if (s.startedAt >= todayStart) out.todaySecs += secs;
  }
  return out;
}

/** "1h 24m" / "37m" / "0m" — the stat-tile display format. */
export function formatWatchTime(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
