/**
 * Stats-report module — pure aggregations for the interactive panels on
 * Progress → Statistics (weekly report, day-by-day activity explorer,
 * study-hour histogram).
 *
 * Same contract as `study-stats.ts`: every function is a deterministic
 * map over already-fetched rows (`listVocab` / `listSessions` /
 * `listWorkspaceReviews`) with an injectable `now`, so the math is
 * unit-testable without a workspace or a wall clock. Days are bucketed
 * by *local* calendar day and iterated via `Date.setDate` (not fixed
 * 86 400 s steps) so DST transitions don't drop or double a day.
 */

import type { StudySession, VocabEntry, VocabReview } from "@/lib/db";

const DAY_SECS = 86_400;

/** Locale-independent short weekday names, indexed by `Date.getDay()`.
 *  Hard-coded (not `toLocaleDateString`) so chart labels and tests don't
 *  shift with the runtime locale. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** Local midnight of the day containing `epochSecs`, as a Date. */
function localMidnight(epochSecs: number): Date {
  const d = new Date(epochSecs * 1000);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local `YYYY-MM-DD` key for a Date already snapped to a local day. */
function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function keyOfEpoch(epochSecs: number): string {
  return keyOf(new Date(epochSecs * 1000));
}

// ── per-day accumulator ─────────────────────────────────────────────

type DayAccum = {
  secs: number;
  sessions: number;
  reviews: number;
  recalled: number;
  wordsAdded: number;
};

const EMPTY_ACCUM: DayAccum = {
  secs: 0,
  sessions: 0,
  reviews: 0,
  recalled: 0,
  wordsAdded: 0,
};

/** One pass over the three row arrays → per-local-day totals. All the
 *  report builders below read from this map so the bucketing rules
 *  (what counts as "recalled", which timestamp keys a row to a day)
 *  live in exactly one place. */
function accumulateByDay(
  vocab: VocabEntry[],
  sessions: StudySession[],
  reviews: VocabReview[],
): Map<string, DayAccum> {
  const map = new Map<string, DayAccum>();
  const at = (k: string): DayAccum => {
    let a = map.get(k);
    if (!a) {
      a = { ...EMPTY_ACCUM };
      map.set(k, a);
    }
    return a;
  };
  for (const s of sessions) {
    const a = at(keyOfEpoch(s.startedAt));
    a.secs += s.durationSecs ?? 0;
    a.sessions += 1;
  }
  for (const r of reviews) {
    const a = at(keyOfEpoch(r.reviewedAt));
    a.reviews += 1;
    if (r.grade !== "again") a.recalled += 1;
  }
  for (const v of vocab) {
    at(keyOfEpoch(v.createdAt)).wordsAdded += 1;
  }
  return map;
}

// ── daily series ────────────────────────────────────────────────────

export type DayStat = {
  /** Local `YYYY-MM-DD`. */
  date: string;
  /** Short axis label, `M/D`. */
  label: string;
  /** Locale-independent short weekday name ("Mon" … "Sun"). */
  weekday: string;
  /** Local midnight, epoch seconds — for full-date formatting in UI. */
  epoch: number;
  minutes: number;
  reviews: number;
  /** Day recall rate (grade ≠ "again"), null when no reviews that day. */
  retention: number | null;
  wordsAdded: number;
  sessions: number;
};

/** The metrics the explorer can pivot on. */
export type Metric = "minutes" | "reviews" | "wordsAdded";

function statFor(d: Date, accum: Map<string, DayAccum>): DayStat {
  const a = accum.get(keyOf(d)) ?? EMPTY_ACCUM;
  return {
    date: keyOf(d),
    label: `${d.getMonth() + 1}/${d.getDate()}`,
    weekday: WEEKDAYS[d.getDay()],
    epoch: Math.floor(d.getTime() / 1000),
    minutes: Math.round(a.secs / 60),
    reviews: a.reviews,
    retention: a.reviews > 0 ? a.recalled / a.reviews : null,
    wordsAdded: a.wordsAdded,
    sessions: a.sessions,
  };
}

/** Per-day stats for the last `days` local days, oldest → newest, ending
 *  today. Zero-filled so charts show gaps. */
export function buildDailyStats(input: {
  vocab: VocabEntry[];
  sessions: StudySession[];
  reviews: VocabReview[];
  days: number;
  now?: number;
}): DayStat[] {
  const { vocab, sessions, reviews } = input;
  const now = input.now ?? nowSecs();
  const days = Math.max(1, Math.floor(input.days));
  const accum = accumulateByDay(vocab, sessions, reviews);
  const out: DayStat[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = localMidnight(now);
    d.setDate(d.getDate() - i);
    out.push(statFor(d, accum));
  }
  return out;
}

// ── day deltas ──────────────────────────────────────────────────────

export type DayDelta = {
  value: number;
  /** Metric value the day before — null at the start of the series. */
  prev: number | null;
  /** Metric value the day after — null for the last (most recent) day. */
  next: number | null;
  /** `value - prev`. */
  diffPrev: number | null;
  /** Relative change vs the day before; null when prev is 0 or missing. */
  pctPrev: number | null;
  /** `next - value` — how the following day moved. */
  diffNext: number | null;
  /** Mean over up to 7 days strictly *before* the focused day — the
   *  baseline "is this day above my recent normal?". Null when the
   *  focused day is the first of the series. */
  avg7: number | null;
  /** `value - avg7`. */
  diffAvg: number | null;
};

/** Compare one day of a series against its neighbours and its trailing
 *  7-day average. `index` is clamped into the series. */
export function dayDelta(
  series: DayStat[],
  index: number,
  metric: Metric,
): DayDelta {
  const i = Math.min(Math.max(index, 0), series.length - 1);
  const value = series[i][metric];
  const prev = i > 0 ? series[i - 1][metric] : null;
  const next = i < series.length - 1 ? series[i + 1][metric] : null;
  const window = series.slice(Math.max(0, i - 7), i);
  const avg7 =
    window.length > 0
      ? window.reduce((s, d) => s + d[metric], 0) / window.length
      : null;
  return {
    value,
    prev,
    next,
    diffPrev: prev == null ? null : value - prev,
    pctPrev: prev == null || prev === 0 ? null : (value - prev) / prev,
    diffNext: next == null ? null : next - value,
    avg7,
    diffAvg: avg7 == null ? null : value - avg7,
  };
}

// ── weekly report ───────────────────────────────────────────────────

export type WeekTotals = {
  minutes: number;
  reviews: number;
  wordsAdded: number;
  sessions: number;
  /** Days with study time or reviews logged. */
  activeDays: number;
  /** Week recall rate (grade ≠ "again"), null when no reviews. */
  retention: number | null;
};

export type WeeklyReport = {
  /** Local Monday 00:00 of the reported week, epoch seconds. */
  weekStart: number;
  /** Exactly 7 entries, Monday → Sunday. */
  days: DayStat[];
  totals: WeekTotals;
  /** Same totals for the week before — drives the delta column. */
  prevTotals: WeekTotals;
  /** Most-studied day (by minutes, reviews as tiebreak); null when the
   *  week has no activity at all. */
  bestDay: DayStat | null;
  /** 0 = the week containing `now`, 1 = last week, … */
  offset: number;
  isCurrentWeek: boolean;
};

/** Local Monday 00:00 of the week containing `now`, shifted back by
 *  `offset` weeks. */
function mondayOf(now: number, offset: number): Date {
  const d = localMidnight(now);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - offset * 7);
  return d;
}

function weekDays(monday: Date, accum: Map<string, DayAccum>): DayStat[] {
  const out: DayStat[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    out.push(statFor(d, accum));
  }
  return out;
}

function weekTotals(monday: Date, accum: Map<string, DayAccum>): WeekTotals {
  let secs = 0;
  let reviews = 0;
  let recalled = 0;
  let wordsAdded = 0;
  let sessions = 0;
  let activeDays = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const a = accum.get(keyOf(d)) ?? EMPTY_ACCUM;
    secs += a.secs;
    reviews += a.reviews;
    recalled += a.recalled;
    wordsAdded += a.wordsAdded;
    sessions += a.sessions;
    if (a.secs > 0 || a.reviews > 0) activeDays += 1;
  }
  return {
    minutes: Math.round(secs / 60),
    reviews,
    wordsAdded,
    sessions,
    activeDays,
    retention: reviews > 0 ? recalled / reviews : null,
  };
}

/** Build the report for the week `offset` weeks before the one
 *  containing `now`. Weeks run Monday → Sunday in local time. */
export function buildWeeklyReport(input: {
  vocab: VocabEntry[];
  sessions: StudySession[];
  reviews: VocabReview[];
  offset?: number;
  now?: number;
}): WeeklyReport {
  const { vocab, sessions, reviews } = input;
  const now = input.now ?? nowSecs();
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const accum = accumulateByDay(vocab, sessions, reviews);
  const monday = mondayOf(now, offset);
  const prevMonday = mondayOf(now, offset + 1);
  const days = weekDays(monday, accum);
  const totals = weekTotals(monday, accum);
  const prevTotals = weekTotals(prevMonday, accum);
  let bestDay: DayStat | null = null;
  for (const d of days) {
    if (d.minutes === 0 && d.reviews === 0) continue;
    if (
      bestDay == null ||
      d.minutes > bestDay.minutes ||
      (d.minutes === bestDay.minutes && d.reviews > bestDay.reviews)
    ) {
      bestDay = d;
    }
  }
  return {
    weekStart: Math.floor(monday.getTime() / 1000),
    days,
    totals,
    prevTotals,
    bestDay,
    offset,
    isCurrentWeek: offset === 0,
  };
}

/** "3h 20m across 5 active days · 320 reviews · 14 new words. Up 25% on
 *  the week before." — the one-line narrative under the weekly report.
 *  Zero-value parts are omitted; the comparison clause only renders
 *  when both weeks have study time (a 0 baseline makes percentages
 *  meaningless). */
export function weeklySummaryLine(report: WeeklyReport): string {
  const t = report.totals;
  const inactive = t.minutes === 0 && t.reviews === 0 && t.wordsAdded === 0;
  if (inactive) {
    return report.isCurrentWeek
      ? "Nothing logged yet this week — a ten-minute session gets it on the board."
      : "No activity that week.";
  }
  const parts: string[] = [];
  if (t.minutes > 0) {
    parts.push(
      `${fmtMins(t.minutes)} across ${t.activeDays} active day${t.activeDays === 1 ? "" : "s"}`,
    );
  } else {
    parts.push(`${t.activeDays} active day${t.activeDays === 1 ? "" : "s"}`);
  }
  if (t.reviews > 0) parts.push(`${t.reviews} review${t.reviews === 1 ? "" : "s"}`);
  if (t.wordsAdded > 0)
    parts.push(`${t.wordsAdded} new word${t.wordsAdded === 1 ? "" : "s"}`);
  let line = `${parts.join(" · ")}.`;
  if (t.minutes > 0 && report.prevTotals.minutes > 0) {
    const pct = (t.minutes - report.prevTotals.minutes) / report.prevTotals.minutes;
    if (Math.abs(pct) < 0.05) {
      line += " Level with the week before.";
    } else if (pct > 0) {
      line += ` Up ${Math.round(pct * 100)}% on the week before.`;
    } else {
      line += ` Down ${Math.round(-pct * 100)}% on the week before.`;
    }
  }
  return line;
}

/** Minutes → "45m" / "1h 20m" / "3h". Exported so the report panels
 *  format durations exactly like the summary line does. */
export function fmtMins(mins: number): string {
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

// ── study-hour histogram ────────────────────────────────────────────

export type HourStat = {
  /** 0–23, local. */
  hour: number;
  /** Zero-padded axis label ("08"). */
  label: string;
  minutes: number;
};

/** Minutes of study by local *starting* hour over the last `days`
 *  days (default 90). A session's whole duration is attributed to the
 *  hour it started in — fine at this granularity, where the question
 *  is "when do I tend to sit down", not exact time accounting. */
export function hourHistogram(
  sessions: StudySession[],
  opts?: { days?: number; now?: number },
): HourStat[] {
  const now = opts?.now ?? nowSecs();
  const days = opts?.days ?? 90;
  const since = now - days * DAY_SECS;
  const mins = new Array<number>(24).fill(0);
  for (const s of sessions) {
    if (s.startedAt < since) continue;
    const h = new Date(s.startedAt * 1000).getHours();
    mins[h] += (s.durationSecs ?? 0) / 60;
  }
  return mins.map((m, hour) => ({
    hour,
    label: String(hour).padStart(2, "0"),
    minutes: Math.round(m),
  }));
}

/** The histogram's busiest hour, null when nothing is logged. */
export function peakHour(hist: HourStat[]): HourStat | null {
  let best: HourStat | null = null;
  for (const h of hist) {
    if (h.minutes <= 0) continue;
    if (best == null || h.minutes > best.minutes) best = h;
  }
  return best;
}
