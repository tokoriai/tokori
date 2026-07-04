import { describe, expect, it } from "vitest";
import {
  buildDailyStats,
  buildWeeklyReport,
  dayDelta,
  fmtMins,
  hourHistogram,
  peakHour,
  weeklySummaryLine,
  type DayStat,
  type WeeklyReport,
  type WeekTotals,
} from "@/lib/stats-report";
import { startOfToday } from "@/lib/study-stats";
import type { StudySession, VocabEntry, VocabReview } from "@/lib/db";

// Fixed "now" + boundaries anchored to the module's own local-midnight
// math, so assertions are timezone-independent (timestamps are placed
// an hour inside a day, never near a midnight another TZ would bucket
// differently). Day-relative placement uses whole local days (n * DAY
// from a local-noon anchor stays inside the expected calendar day).
const NOW = 1_700_000_000;
const TODAY = startOfToday(NOW);
const DAY = 86_400;

/** 1am local, `daysAgo` days before today. */
function at(daysAgo: number, offsetSecs = 3_600): number {
  return TODAY - daysAgo * DAY + offsetSecs;
}

function mkVocab(over: Partial<VocabEntry>): VocabEntry {
  return {
    id: 1,
    workspaceId: 1,
    word: "x",
    reading: null,
    gloss: null,
    source: "manual",
    status: "new",
    kind: "vocab",
    stability: 0,
    difficulty: 0,
    learningStep: 0,
    dueAt: null,
    lastReview: null,
    reviewCount: 0,
    createdAt: at(0),
    imageData: null,
    hasImage: false,
    cardNotes: null,
    frontExtra: null,
    translation: null,
    layout: null,
    hasAudio: false,
    audioMime: null,
    isActive: true,
    ...over,
  };
}

function mkSession(over: Partial<StudySession>): StudySession {
  return {
    id: 1,
    workspaceId: 1,
    kind: "review",
    startedAt: at(0),
    endedAt: at(0) + 600,
    durationSecs: 600,
    wordsSeen: 0,
    wordsSaved: 0,
    notes: null,
    syncedFrom: null,
    ...over,
  } as StudySession;
}

function mkReview(over: Partial<VocabReview>): VocabReview {
  return {
    id: 1,
    vocabId: 1,
    grade: "good",
    prevStatus: null,
    newStatus: "learning",
    prevStability: null,
    newStability: 1,
    prevDueAt: null,
    newDueAt: null,
    reviewedAt: at(0),
    ...over,
  } as VocabReview;
}

// ── buildDailyStats ─────────────────────────────────────────────────

describe("buildDailyStats", () => {
  it("zero-fills the window, oldest → newest, ending today", () => {
    const series = buildDailyStats({
      vocab: [],
      sessions: [],
      reviews: [],
      days: 5,
      now: NOW,
    });
    expect(series).toHaveLength(5);
    expect(series.every((d) => d.minutes === 0 && d.reviews === 0)).toBe(true);
    // Strictly ascending dates; the last entry is today's bucket.
    for (let i = 1; i < series.length; i++) {
      expect(series[i].date > series[i - 1].date).toBe(true);
    }
    expect(series[4].epoch).toBe(TODAY);
  });

  it("aggregates minutes, reviews, retention, words, sessions per day", () => {
    const series = buildDailyStats({
      vocab: [mkVocab({ createdAt: at(1) }), mkVocab({ id: 2, createdAt: at(0) })],
      sessions: [
        mkSession({ startedAt: at(0), durationSecs: 600 }),
        mkSession({ id: 2, startedAt: at(0, 7_200), durationSecs: 300 }),
        mkSession({ id: 3, startedAt: at(1), durationSecs: 60 }),
      ],
      reviews: [
        mkReview({ reviewedAt: at(0), grade: "good" }),
        mkReview({ id: 2, reviewedAt: at(0, 7_200), grade: "again" }),
        mkReview({ id: 3, reviewedAt: at(2), grade: "easy" }),
      ],
      days: 3,
      now: NOW,
    });
    const [twoAgo, yesterday, today] = series;
    expect(today.minutes).toBe(15);
    expect(today.sessions).toBe(2);
    expect(today.reviews).toBe(2);
    expect(today.retention).toBeCloseTo(0.5);
    expect(today.wordsAdded).toBe(1);
    expect(yesterday.minutes).toBe(1);
    expect(yesterday.wordsAdded).toBe(1);
    expect(yesterday.retention).toBeNull();
    expect(twoAgo.reviews).toBe(1);
    expect(twoAgo.retention).toBe(1);
  });

  it("ignores activity outside the window and clamps days to ≥ 1", () => {
    const series = buildDailyStats({
      vocab: [],
      sessions: [mkSession({ startedAt: at(10), durationSecs: 600 })],
      reviews: [],
      days: 0,
      now: NOW,
    });
    expect(series).toHaveLength(1);
    expect(series[0].minutes).toBe(0);
  });
});

// ── dayDelta ────────────────────────────────────────────────────────

function mkDay(over: Partial<DayStat>): DayStat {
  return {
    date: "2026-01-01",
    label: "1/1",
    weekday: "Mon",
    epoch: 0,
    minutes: 0,
    reviews: 0,
    retention: null,
    wordsAdded: 0,
    sessions: 0,
    ...over,
  };
}

describe("dayDelta", () => {
  const series = [10, 20, 0, 40, 30].map((m, i) =>
    mkDay({ date: `2026-01-0${i + 1}`, minutes: m }),
  );

  it("compares against the day before and the day after", () => {
    const d = dayDelta(series, 3, "minutes");
    expect(d.value).toBe(40);
    expect(d.prev).toBe(0);
    expect(d.diffPrev).toBe(40);
    // Day before was 0 → a percentage is meaningless.
    expect(d.pctPrev).toBeNull();
    expect(d.next).toBe(30);
    expect(d.diffNext).toBe(-10);
  });

  it("computes the trailing 7-day average, excluding the focused day", () => {
    const d = dayDelta(series, 3, "minutes");
    expect(d.avg7).toBeCloseTo((10 + 20 + 0) / 3);
    expect(d.diffAvg).toBeCloseTo(40 - 10);
  });

  it("nulls the edges: no prev/avg on the first day, no next on the last", () => {
    const first = dayDelta(series, 0, "minutes");
    expect(first.prev).toBeNull();
    expect(first.diffPrev).toBeNull();
    expect(first.avg7).toBeNull();
    const last = dayDelta(series, 4, "minutes");
    expect(last.next).toBeNull();
    expect(last.diffNext).toBeNull();
    expect(last.pctPrev).toBeCloseTo((30 - 40) / 40);
  });

  it("clamps an out-of-range index", () => {
    expect(dayDelta(series, 99, "minutes").value).toBe(30);
    expect(dayDelta(series, -5, "minutes").value).toBe(10);
  });
});

// ── buildWeeklyReport ───────────────────────────────────────────────

describe("buildWeeklyReport", () => {
  // `at(7)` is exactly one week before `at(0)` — same weekday — so it
  // always lands in the previous Monday→Sunday week, whatever weekday
  // the fixed NOW happens to be.
  const sessions = [
    mkSession({ startedAt: at(0), durationSecs: 1_800 }),
    mkSession({ id: 2, startedAt: at(7), durationSecs: 3_600 }),
  ];
  const reviews = [
    mkReview({ reviewedAt: at(0), grade: "good" }),
    mkReview({ id: 2, reviewedAt: at(0, 7_200), grade: "again" }),
    mkReview({ id: 3, reviewedAt: at(7), grade: "good" }),
  ];
  const vocab = [mkVocab({ createdAt: at(7) })];

  it("covers Monday → Sunday and includes today when offset is 0", () => {
    const report = buildWeeklyReport({ vocab, sessions, reviews, now: NOW });
    expect(report.days).toHaveLength(7);
    expect(report.days[0].weekday).toBe("Mon");
    expect(report.days[6].weekday).toBe("Sun");
    expect(report.days.some((d) => d.epoch === TODAY)).toBe(true);
    expect(report.isCurrentWeek).toBe(true);
  });

  it("totals the week and the week before it", () => {
    const report = buildWeeklyReport({ vocab, sessions, reviews, now: NOW });
    expect(report.totals.minutes).toBe(30);
    expect(report.totals.reviews).toBe(2);
    expect(report.totals.retention).toBeCloseTo(0.5);
    expect(report.totals.activeDays).toBe(1);
    expect(report.totals.wordsAdded).toBe(0);
    expect(report.prevTotals.minutes).toBe(60);
    expect(report.prevTotals.reviews).toBe(1);
    expect(report.prevTotals.wordsAdded).toBe(1);
  });

  it("offset shifts the window back week by week", () => {
    const lastWeek = buildWeeklyReport({
      vocab,
      sessions,
      reviews,
      offset: 1,
      now: NOW,
    });
    expect(lastWeek.isCurrentWeek).toBe(false);
    expect(lastWeek.totals.minutes).toBe(60);
    expect(lastWeek.prevTotals.minutes).toBe(0);
    // Adjacent weeks tile exactly: 7 days apart.
    const thisWeek = buildWeeklyReport({ vocab, sessions, reviews, now: NOW });
    expect(thisWeek.weekStart - lastWeek.weekStart).toBe(7 * DAY);
  });

  it("picks the most-studied day as bestDay, null on an empty week", () => {
    const report = buildWeeklyReport({ vocab, sessions, reviews, now: NOW });
    expect(report.bestDay?.epoch).toBe(TODAY);
    const empty = buildWeeklyReport({
      vocab: [],
      sessions: [],
      reviews: [],
      now: NOW,
    });
    expect(empty.bestDay).toBeNull();
  });
});

// ── weeklySummaryLine ───────────────────────────────────────────────

function mkTotals(over: Partial<WeekTotals>): WeekTotals {
  return {
    minutes: 0,
    reviews: 0,
    wordsAdded: 0,
    sessions: 0,
    activeDays: 0,
    retention: null,
    ...over,
  };
}

function mkReport(over: Partial<WeeklyReport>): WeeklyReport {
  return {
    weekStart: TODAY,
    days: [],
    totals: mkTotals({}),
    prevTotals: mkTotals({}),
    bestDay: null,
    offset: 0,
    isCurrentWeek: true,
    ...over,
  };
}

describe("weeklySummaryLine", () => {
  it("encourages on an empty current week, stays neutral on past weeks", () => {
    expect(weeklySummaryLine(mkReport({}))).toMatch(/Nothing logged yet/);
    expect(
      weeklySummaryLine(mkReport({ offset: 2, isCurrentWeek: false })),
    ).toBe("No activity that week.");
  });

  it("joins the non-zero parts and compares vs the week before", () => {
    const line = weeklySummaryLine(
      mkReport({
        totals: mkTotals({
          minutes: 200,
          activeDays: 5,
          reviews: 320,
          wordsAdded: 14,
        }),
        prevTotals: mkTotals({ minutes: 160 }),
      }),
    );
    expect(line).toBe(
      "3h 20m across 5 active days · 320 reviews · 14 new words. Up 25% on the week before.",
    );
  });

  it("omits zero parts and skips the comparison on a zero baseline", () => {
    const line = weeklySummaryLine(
      mkReport({
        totals: mkTotals({ minutes: 45, activeDays: 1, reviews: 0, wordsAdded: 0 }),
      }),
    );
    expect(line).toBe("45m across 1 active day.");
  });

  it("treats small swings as level, big drops as down", () => {
    const level = weeklySummaryLine(
      mkReport({
        totals: mkTotals({ minutes: 102, activeDays: 3 }),
        prevTotals: mkTotals({ minutes: 100 }),
      }),
    );
    expect(level).toMatch(/Level with the week before\.$/);
    const down = weeklySummaryLine(
      mkReport({
        totals: mkTotals({ minutes: 50, activeDays: 2 }),
        prevTotals: mkTotals({ minutes: 100 }),
      }),
    );
    expect(down).toMatch(/Down 50% on the week before\.$/);
  });
});

// ── hourHistogram ───────────────────────────────────────────────────

describe("hourHistogram", () => {
  it("buckets minutes by local starting hour and windows by days", () => {
    const nineAm = new Date(NOW * 1000);
    nineAm.setHours(9, 0, 0, 0);
    const nine = Math.floor(nineAm.getTime() / 1000);
    const hist = hourHistogram(
      [
        mkSession({ startedAt: nine, durationSecs: 1_200 }),
        mkSession({ id: 2, startedAt: nine - DAY, durationSecs: 600 }),
        // Outside the 90-day window — must not count.
        mkSession({ id: 3, startedAt: nine - 200 * DAY, durationSecs: 6_000 }),
      ],
      { now: NOW },
    );
    expect(hist).toHaveLength(24);
    expect(hist[9].minutes).toBe(30);
    expect(hist[9].label).toBe("09");
    expect(hist.reduce((s, h) => s + h.minutes, 0)).toBe(30);
  });

  it("peakHour finds the busiest hour, null when empty", () => {
    const empty = hourHistogram([], { now: NOW });
    expect(peakHour(empty)).toBeNull();
    const one = new Date(NOW * 1000);
    one.setHours(21, 30, 0, 0);
    const hist = hourHistogram(
      [mkSession({ startedAt: Math.floor(one.getTime() / 1000), durationSecs: 900 })],
      { now: NOW + DAY },
    );
    expect(peakHour(hist)?.hour).toBe(21);
  });
});

// ── fmtMins ─────────────────────────────────────────────────────────

describe("fmtMins", () => {
  it("formats sub-hour, mixed, and whole-hour durations", () => {
    expect(fmtMins(0)).toBe("0m");
    expect(fmtMins(45)).toBe("45m");
    expect(fmtMins(80)).toBe("1h 20m");
    expect(fmtMins(120)).toBe("2h");
  });
});
