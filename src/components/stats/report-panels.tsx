/**
 * Interactive report panels for Progress → Statistics.
 *
 * Three panels over the same three row arrays the page already fetches
 * (vocab / sessions / reviews), all math delegated to the pure helpers
 * in `lib/stats-report.ts` so it stays unit-tested:
 *
 *   - WeeklyReportCard   — Monday→Sunday digest with ‹ › week paging,
 *     per-metric deltas vs the week before, and a one-line narrative.
 *   - ActivityExplorer   — day-by-day bar chart you can click (or step
 *     with arrows) to inspect one day: value, vs day before, the day
 *     after, and vs your trailing 7-day average. Metric + range pills.
 *   - StudyHoursCard     — when in the day you actually study (minutes
 *     by starting hour, last 90 days).
 */

import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Minus,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { StudySession, VocabEntry, VocabReview } from "@/lib/db";
import {
  buildDailyStats,
  buildWeeklyReport,
  dayDelta,
  fmtMins,
  hourHistogram,
  peakHour,
  weeklySummaryLine,
  type Metric,
  type WeeklyReport,
} from "@/lib/stats-report";
import { cn } from "@/lib/utils";

const PANEL = "rounded-2xl border border-border bg-card px-5 py-4";

type Rows = {
  vocab: VocabEntry[];
  sessions: StudySession[];
  reviews: VocabReview[];
};

// ── shared chrome ───────────────────────────────────────────────────

/** Segmented pill control — same look as the period toggle on the
 *  vocab-growth chart so every chart header reads the same. */
function PillGroup<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-full border border-border bg-card p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "cursor-pointer rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider transition-colors",
            value === o.value
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PagerButton({
  dir,
  onClick,
  disabled,
  label,
}: {
  dir: "prev" | "next";
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-6 cursor-pointer items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/** Signed comparison chip: "+12m (+34%)" tinted by direction. Pass
 *  `diff: null` for "no baseline" — renders a muted em-dash chip so
 *  the row doesn't jump around as data appears. The label is optional:
 *  the weekly rows omit it (the whole column compares vs last week,
 *  spelled out in the title tooltip), the day inspector spells it out. */
function DeltaChip({
  label,
  diff,
  pct,
  fmt,
  title,
}: {
  label?: string;
  diff: number | null;
  pct?: number | null;
  fmt: (n: number) => string;
  title?: string;
}) {
  const rounded = diff == null ? null : Math.round(diff * 10) / 10;
  const flat = rounded === 0;
  const up = rounded != null && rounded > 0;
  const Icon = rounded == null || flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium",
        rounded == null || flat
          ? "border-border bg-card text-muted-foreground"
          : up
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400",
      )}
    >
      <Icon className="size-3" />
      {label && <span className="text-muted-foreground">{label}</span>}
      <span className="tabular-nums">
        {rounded == null
          ? "—"
          : flat
            ? "±0"
            : `${up ? "+" : "−"}${fmt(Math.abs(rounded))}`}
        {rounded != null && !flat && pct != null && (
          <> ({up ? "+" : "−"}{Math.round(Math.abs(pct) * 100)}%)</>
        )}
      </span>
    </span>
  );
}

function EmptyPlot({ height, children }: { height: number; children: string }) {
  return (
    <div
      style={{ height }}
      className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-4 text-center text-[13px] text-muted-foreground"
    >
      {children}
    </div>
  );
}

// ── weekly report ───────────────────────────────────────────────────

const WEEK_CONFIG = {
  minutes: { label: "Minutes", color: "var(--color-brand)" },
} satisfies ChartConfig;

function fmtWeekRange(report: WeeklyReport): string {
  const start = new Date(report.weekStart * 1000);
  const end = new Date(report.days[6].epoch * 1000);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const sameYear = start.getFullYear() === new Date().getFullYear();
  const endOpts: Intl.DateTimeFormatOptions = sameYear
    ? opts
    : { ...opts, year: "numeric" };
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, endOpts)}`;
}

function weekTitle(offset: number): string {
  if (offset === 0) return "This week";
  if (offset === 1) return "Last week";
  return `${offset} weeks ago`;
}

const count = (n: number) => String(Math.round(n));

export function WeeklyReportCard({ vocab, sessions, reviews }: Rows) {
  const [offset, setOffset] = useState(0);
  const report = useMemo(
    () => buildWeeklyReport({ vocab, sessions, reviews, offset }),
    [vocab, sessions, reviews, offset],
  );
  const summary = useMemo(() => weeklySummaryLine(report), [report]);
  const { totals, prevTotals } = report;
  const hasBars = report.days.some((d) => d.minutes > 0);

  // Retention compares in percentage points, not relative percent —
  // "86% → 91%" reads as "+5pp", which is how recall rates are talked
  // about everywhere else in the app.
  const retentionDiff =
    totals.retention != null && prevTotals.retention != null
      ? (totals.retention - prevTotals.retention) * 100
      : null;

  const rows: {
    label: string;
    value: string;
    diff: number | null;
    pct?: number | null;
    fmt: (n: number) => string;
  }[] = [
    {
      label: "Study time",
      value: fmtMins(totals.minutes),
      diff: totals.minutes - prevTotals.minutes,
      pct:
        prevTotals.minutes > 0
          ? (totals.minutes - prevTotals.minutes) / prevTotals.minutes
          : null,
      fmt: fmtMins,
    },
    {
      label: "Reviews",
      value: count(totals.reviews),
      diff: totals.reviews - prevTotals.reviews,
      fmt: count,
    },
    {
      label: "Words added",
      value: count(totals.wordsAdded),
      diff: totals.wordsAdded - prevTotals.wordsAdded,
      fmt: count,
    },
    {
      label: "Active days",
      value: `${totals.activeDays}/7`,
      diff: totals.activeDays - prevTotals.activeDays,
      fmt: count,
    },
    {
      label: "Retention",
      value:
        totals.retention != null
          ? `${Math.round(totals.retention * 100)}%`
          : "—",
      diff: retentionDiff,
      fmt: (n) => `${Math.round(n)}pp`,
    },
  ];

  return (
    <div className={cn(PANEL, "flex flex-col")}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Weekly report</h3>
          <p className="text-[11.5px] text-muted-foreground">
            {weekTitle(report.offset)} · {fmtWeekRange(report)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <PagerButton
            dir="prev"
            onClick={() => setOffset((o) => o + 1)}
            label="Previous week"
          />
          <PagerButton
            dir="next"
            onClick={() => setOffset((o) => Math.max(0, o - 1))}
            disabled={report.isCurrentWeek}
            label="Next week"
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_15rem]">
        {hasBars ? (
          <ChartContainer config={WEEK_CONFIG} className="h-[150px] w-full">
            <BarChart
              data={report.days}
              margin={{ left: 8, right: 8, top: 4, bottom: 0 }}
            >
              <CartesianGrid
                vertical={false}
                strokeDasharray="3 3"
                stroke="var(--color-border)"
              />
              <XAxis
                dataKey="weekday"
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                fontSize={10}
              />
              <YAxis hide />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent indicator="dot" />}
              />
              <Bar
                dataKey="minutes"
                fill="var(--color-minutes)"
                radius={[3, 3, 0, 0]}
                isAnimationActive
                animationDuration={600}
                animationEasing="ease-out"
              >
                {report.days.map((d) => (
                  <Cell
                    key={d.date}
                    fillOpacity={
                      report.bestDay && d.date === report.bestDay.date ? 1 : 0.55
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        ) : (
          <EmptyPlot height={150}>
            {report.isCurrentWeek
              ? "No study time yet this week."
              : "No study time that week."}
          </EmptyPlot>
        )}

        <div className="flex flex-col justify-center gap-1.5">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between gap-2 text-[12px]"
            >
              <span className="text-muted-foreground">{r.label}</span>
              <span className="flex items-center gap-2">
                <span className="font-semibold tabular-nums">{r.value}</span>
                <DeltaChip
                  diff={r.diff}
                  pct={r.pct}
                  fmt={r.fmt}
                  title={`vs the week before (${weekTitle(report.offset + 1).toLowerCase()})`}
                />
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-3 border-t border-border/60 pt-2.5 text-[12px] leading-relaxed text-muted-foreground">
        {summary}
        {report.bestDay && (
          <>
            {" "}
            Best day:{" "}
            <span className="font-medium text-foreground">
              {report.bestDay.weekday}
            </span>{" "}
            with {fmtMins(report.bestDay.minutes)}
            {report.bestDay.reviews > 0 && <> · {report.bestDay.reviews} reviews</>}.
          </>
        )}
      </p>
    </div>
  );
}

// ── activity explorer ───────────────────────────────────────────────

const METRICS: readonly {
  value: Metric;
  label: string;
  noun: string;
  fmt: (n: number) => string;
}[] = [
  { value: "minutes", label: "Time", noun: "studied", fmt: fmtMins },
  { value: "reviews", label: "Reviews", noun: "reviews", fmt: count },
  { value: "wordsAdded", label: "Words", noun: "words added", fmt: count },
];

const RANGES = [
  { value: 14, label: "14D" },
  { value: 30, label: "30D" },
  { value: 90, label: "90D" },
] as const;

export function ActivityExplorer({ vocab, sessions, reviews }: Rows) {
  const [metric, setMetric] = useState<Metric>("minutes");
  const [days, setDays] = useState<(typeof RANGES)[number]["value"]>(30);
  // Selection is stored as a date string (not an index) so it survives
  // range switches; days that fall outside the new range fall back to
  // today via the derive below.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const series = useMemo(
    () => buildDailyStats({ vocab, sessions, reviews, days }),
    [vocab, sessions, reviews, days],
  );
  const meta = METRICS.find((m) => m.value === metric) ?? METRICS[0];

  const data = useMemo(
    () => series.map((d) => ({ ...d, value: d[metric] })),
    [series, metric],
  );
  const selIdx = useMemo(() => {
    const i = selectedDate ? series.findIndex((d) => d.date === selectedDate) : -1;
    return i >= 0 ? i : series.length - 1;
  }, [series, selectedDate]);
  const sel = series[selIdx];
  const delta = useMemo(
    () => dayDelta(series, selIdx, metric),
    [series, selIdx, metric],
  );

  const config = {
    value: { label: meta.label, color: "var(--color-brand)" },
  } satisfies ChartConfig;

  const isToday = selIdx === series.length - 1;
  const hasAny = series.some((d) => d[metric] > 0);

  function step(dir: -1 | 1) {
    const next = Math.min(Math.max(selIdx + dir, 0), series.length - 1);
    setSelectedDate(series[next].date);
  }

  return (
    <div className={cn(PANEL, "flex flex-col")}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">
            Activity explorer
          </h3>
          <p className="text-[11.5px] text-muted-foreground">
            Click a bar (or step with the arrows) to compare any day
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <PillGroup
            options={METRICS.map((m) => ({ value: m.value, label: m.label }))}
            value={metric}
            onChange={setMetric}
          />
          <PillGroup options={RANGES} value={days} onChange={setDays} />
        </div>
      </div>

      {hasAny ? (
        <ChartContainer config={config} className="h-[170px] w-full cursor-pointer">
          <BarChart
            data={data}
            margin={{ left: 8, right: 8, top: 4, bottom: 0 }}
            onClick={(state) => {
              const i = state?.activeTooltipIndex;
              const n = typeof i === "string" ? Number(i) : i;
              if (typeof n === "number" && Number.isFinite(n) && series[n]) {
                setSelectedDate(series[n].date);
              }
            }}
          >
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke="var(--color-border)"
            />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              minTickGap={16}
              fontSize={10}
            />
            <YAxis hide />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" />}
            />
            <Bar dataKey="value" fill="var(--color-value)" radius={[3, 3, 0, 0]}>
              {series.map((d, i) => (
                <Cell key={d.date} fillOpacity={i === selIdx ? 1 : 0.45} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      ) : (
        <EmptyPlot height={170}>
          {`No ${meta.label.toLowerCase()} data in this range yet — switch metric or study a little.`}
        </EmptyPlot>
      )}

      {/* Day inspector — the interactive heart of the panel. */}
      {sel && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-3.5 py-2.5">
          <div className="flex items-center gap-1">
            <PagerButton
              dir="prev"
              onClick={() => step(-1)}
              disabled={selIdx === 0}
              label="Day before"
            />
            <PagerButton
              dir="next"
              onClick={() => step(1)}
              disabled={isToday}
              label="Day after"
            />
          </div>
          <div className="min-w-[10rem]">
            <div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              {isToday
                ? "Today"
                : new Date(sel.epoch * 1000).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
            </div>
            <div className="text-xl font-semibold tabular-nums">
              {meta.fmt(sel[metric])}{" "}
              <span className="text-[11px] font-normal text-muted-foreground">
                {meta.noun}
              </span>
            </div>
            <div className="text-[10.5px] tabular-nums text-muted-foreground">
              {fmtMins(sel.minutes)} · {sel.reviews} reviews · {sel.wordsAdded}{" "}
              words
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <DeltaChip
              label="vs day before"
              diff={delta.diffPrev}
              pct={delta.pctPrev}
              fmt={meta.fmt}
              title={
                delta.prev != null
                  ? `Day before: ${meta.fmt(delta.prev)}`
                  : undefined
              }
            />
            {delta.next != null && (
              <DeltaChip
                label="day after"
                diff={delta.diffNext}
                fmt={meta.fmt}
                title={`Day after: ${meta.fmt(delta.next)}`}
              />
            )}
            <DeltaChip
              label="vs 7-day avg"
              diff={delta.diffAvg}
              fmt={meta.fmt}
              title={
                delta.avg7 != null
                  ? `Average over the 7 days before: ${meta.fmt(delta.avg7)}`
                  : undefined
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── study hours ─────────────────────────────────────────────────────

const HOURS_CONFIG = {
  minutes: { label: "Minutes", color: "var(--color-brand)" },
} satisfies ChartConfig;

export function StudyHoursCard({ sessions }: { sessions: StudySession[] }) {
  const hist = useMemo(() => hourHistogram(sessions), [sessions]);
  const peak = useMemo(() => peakHour(hist), [hist]);

  return (
    <div className={cn(PANEL, "flex flex-col")}>
      <div className="mb-3">
        <h3 className="text-sm font-semibold tracking-tight">When you study</h3>
        <p className="text-[11.5px] text-muted-foreground">
          {peak
            ? `Minutes by starting hour · most sessions start around ${peak.label}:00`
            : "Minutes by starting hour · last 90 days"}
        </p>
      </div>
      {peak ? (
        <ChartContainer config={HOURS_CONFIG} className="h-[160px] w-full">
          <BarChart data={hist} margin={{ left: 8, right: 8, top: 4, bottom: 0 }}>
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke="var(--color-border)"
            />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              minTickGap={14}
              fontSize={9}
            />
            <YAxis hide />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" />}
            />
            <Bar dataKey="minutes" fill="var(--color-minutes)" radius={[2, 2, 0, 0]}>
              {hist.map((h) => (
                <Cell
                  key={h.hour}
                  fillOpacity={peak && h.hour === peak.hour ? 1 : 0.55}
                />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      ) : (
        <EmptyPlot height={160}>
          No sessions in the last 90 days — your daily rhythm shows up here.
        </EmptyPlot>
      )}
    </div>
  );
}
