import { memo, useMemo, useState } from "react";
import { Package, Search, Upload } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import type { StudySession, VocabEntry, VocabReview } from "@/lib/db";
import { DEFAULT_SRS_CONFIG } from "@/lib/fsrs";
import { computeVocabGrowth, type GrowthBucketKey } from "@/lib/vocab-growth";
import { cn } from "@/lib/utils";

// ───────── Vocab growth ─────────

const PERIODS = [
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "1Y", days: 365 },
] as const;

type SeriesId = GrowthBucketKey;

/** Per-series visual config. Each series has:
 *  - `dotClass`: Tailwind bg utility for the chip's leading dot.
 *    Always rendered in the series' true color so the user can spot
 *    which line is which even when the chip is OFF.
 *  - `activeChipClass`: applied to the chip when its series is on —
 *    border + soft tinted bg + matching text color, so the active
 *    chip reads as "this colored line is currently shown" without
 *    needing a separate legend.
 *  Tailwind classes (rather than the in-chart `var(--color-…)`)
 *  because those CSS vars are scoped to the ChartContainer and
 *  don't resolve in chips rendered outside it. */
const SERIES_META: Record<
  SeriesId,
  {
    label: string;
    description: string;
    fillStop: number;
    strokeWidth: number;
    dotClass: string;
    activeChipClass: string;
  }
> = {
  known: {
    label: "Known",
    description: "Words you've studied and aren't lapsing on",
    fillStop: 0.45,
    strokeWidth: 2.5,
    dotClass: "bg-emerald-500",
    activeChipClass:
      "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  due: {
    label: "Due",
    description: "Known words the scheduler wants you to review now",
    fillStop: 0.28,
    strokeWidth: 2,
    dotClass: "bg-amber-500",
    activeChipClass:
      "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  learning: {
    label: "Learning",
    description: "Walking the FSRS ladder",
    fillStop: 0.22,
    strokeWidth: 2,
    dotClass: "bg-sky-500",
    activeChipClass:
      "border-sky-500/60 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  leeches: {
    label: "Leeches",
    description: "Repeatedly forgotten — needs attention",
    fillStop: 0.18,
    strokeWidth: 1.75,
    dotClass: "bg-rose-500",
    activeChipClass:
      "border-rose-500/60 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
};

export function VocabGrowthChart({
  vocab,
  reviews,
  onImportVocab,
  onRedeemPack,
  onSearchDictionary,
  importerNames,
}: {
  vocab: VocabEntry[];
  /** Workspace-wide review history, ascending by `reviewedAt`. The
   *  chart replays this forward day-by-day to drive the SRS-aware
   *  per-day buckets. Falls back to a flat "saved word" curve if
   *  empty (no reviews yet). */
  reviews: VocabReview[];
  /** Open the Vocab CSV importer. When provided, the "no vocab at
   *  all" empty state surfaces it as a primary CTA — the fastest way
   *  to fill the chart with words a new user already knows. */
  onImportVocab?: () => void;
  /** Open the pack-import dialog (free packs + cloud store). Surfaced
   *  alongside the CSV importer in the "no vocab yet" state so a
   *  brand-new workspace can seed from a textbook pack in one click. */
  onRedeemPack?: () => void;
  /** Jump to the dictionary tab so the user can look up + save words
   *  one at a time. Caller should ONLY pass this when a dictionary is
   *  installed for the active workspace's language — otherwise the
   *  link would route to a dead surface. The MissingDictionaryBanner
   *  handles the "no dict installed" case at the shell level, so we
   *  don't double up here. */
  onSearchDictionary?: () => void;
  /** Comma-joined importer names the empty-state copy can drop into
   *  prose ("Anki, Duolingo, …"). Workspace-aware so a Japanese
   *  workspace doesn't suggest HackChinese. Empty string falls back
   *  to a generic "another app" mention. */
  importerNames?: string;
}) {
  const [days, setDays] = useState<(typeof PERIODS)[number]["days"]>(30);
  // The chart focuses on **Known + Leeches** — the two signals that
  // tell the user "how much do I know" and "what's slipping".
  // Due (today's review workload) and Learning (the ladder funnel)
  // are still computed by the engine for tooltips / future use,
  // but intentionally not exposed as chips here: this widget is
  // about the long-arc knowledge curve, not the daily queue.
  const [visible, setVisible] = useState<Record<SeriesId, boolean>>({
    known: true,
    due: false,
    learning: false,
    leeches: true,
  });
  function toggle(id: SeriesId) {
    setVisible((v) => ({ ...v, [id]: !v[id] }));
  }

  const data = useMemo(
    () =>
      computeVocabGrowth({
        vocab,
        reviews,
        days,
        // Match the scheduler's leech threshold so a card flagged as
        // a leech in Flashcards is also a leech here. Default is 8;
        // when we plumb the per-workspace SRS config into this widget
        // we'll pass `study.srs.leechThreshold` instead.
        leechThreshold: DEFAULT_SRS_CONFIG.leechThreshold,
      }),
    [vocab, reviews, days],
  );

  const config = {
    known: { label: "Known", color: "var(--color-emerald-500, oklch(0.74 0.15 162))" },
    due: { label: "Due", color: "var(--color-amber-500, oklch(0.79 0.16 80))" },
    learning: { label: "Learning", color: "var(--color-sky-500, oklch(0.68 0.16 230))" },
    leeches: { label: "Leeches", color: "var(--color-rose-500, oklch(0.69 0.21 16))" },
  } satisfies ChartConfig;

  // Two distinct empty states:
  //   - noVocab:    workspace has zero saved words. The chart can't
  //                 plot anything because there's nothing to plot.
  //                 CTA: import vocab (Duolingo / HackChinese / CSV).
  //   - noReviews:  vocab exists but no reviews have happened yet, so
  //                 every bucket sits at zero. CTA: review some cards.
  // Both still render the chrome (title, period toggle, chips) so the
  // panel doesn't visually collapse — only the plot area swaps.
  const noVocab = vocab.length === 0;
  const last = data.length > 0 ? data[data.length - 1] : null;
  const isEmpty =
    noVocab ||
    last == null ||
    (last.known === 0 &&
      last.due === 0 &&
      last.learning === 0 &&
      last.leeches === 0);
  // Only Known + Leeches are user-facing here. Leeches paints first
  // so Known reads on top when both are on. The other engine
  // buckets (due, learning) are intentionally not surfaced.
  const seriesOrder: SeriesId[] = ["leeches", "known"];
  const SERIES_IDS: SeriesId[] = ["known", "leeches"];

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-5 py-4">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Vocabulary growth</h3>
          <p className="text-[11.5px] text-muted-foreground">
            Words you know · leeches the SRS is losing
          </p>
        </div>
        <div className="flex gap-0.5 rounded-full border border-border bg-card p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              onClick={() => setDays(p.days)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider transition-colors",
                days === p.days
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Series toggles — chips that match the line color so the
          legend doubles as the on/off switch. The leading dot is
          always rendered in the series' true color (just dimmed
          when off) so the user can spot which line is which even
          on a chip they haven't enabled. Active chips paint their
          border + background in the matching tint, which makes
          "Known is on right now" read at a glance. */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {SERIES_IDS.map((id) => {
          const meta = SERIES_META[id];
          const on = visible[id];
          // Show the current count on each chip so the user reads
          // "Known 412 · Due 38 · Leeches 4" without hovering the
          // chart. Falls back to "—" while data is still loading.
          const count = last ? (last[id] as number) : null;
          return (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              aria-pressed={on}
              title={meta.description}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors",
                on
                  ? meta.activeChipClass
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "size-2 rounded-full",
                  meta.dotClass,
                  !on && "opacity-50",
                )}
              />
              {meta.label}
              {count != null && (
                <span className={cn("tabular-nums", !on && "opacity-60")}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {isEmpty ? (
        noVocab ? (
          <div className="flex h-[180px] flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-border bg-muted/30 px-4 text-center">
            <p className="text-[13px] font-medium">No vocabulary yet</p>
            <p className="max-w-sm text-[11.5px] leading-relaxed text-muted-foreground">
              This chart draws your retention curve from words you've saved.
              Import vocab you already know from{" "}
              {importerNames || "another app"}
              {importerNames ? ", or any CSV" : ""} to get a head start
              {onSearchDictionary
                ? " — or look up + save words from the dictionary one at a time."
                : " — or save words from chat as you go."}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
              {onImportVocab && (
                <Button size="sm" variant="outline" onClick={onImportVocab}>
                  <Upload className="size-3.5" />
                  Import vocab
                </Button>
              )}
              {/* Pack redeem is the fastest path to a populated
                  workspace — one click installs a whole textbook with
                  optional SRS seeding via the activation prefs. */}
              {onRedeemPack && (
                <Button size="sm" variant="outline" onClick={onRedeemPack}>
                  <Package className="size-3.5" />
                  Redeem a pack
                </Button>
              )}
              {/* Only rendered when the caller has confirmed a real
                  dictionary is installed for this workspace — search
                  would be a dead-end otherwise. */}
              {onSearchDictionary && (
                <Button size="sm" variant="ghost" onClick={onSearchDictionary}>
                  <Search className="size-3.5" />
                  Search dictionary
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-[180px] items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 text-[13px] text-muted-foreground">
            Review some cards — once you grade your first word, this chart
            starts tracking your retention curve.
          </div>
        )
      ) : (
        <ChartContainer config={config} className="h-[180px] w-full">
          <AreaChart data={data} margin={{ left: 8, right: 8, top: 4, bottom: 0 }}>
            <defs>
              {SERIES_IDS.map((id) => (
                <linearGradient
                  key={id}
                  id={`fill-${id}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="5%"
                    stopColor={`var(--color-${id})`}
                    stopOpacity={SERIES_META[id].fillStop}
                  />
                  <stop
                    offset="95%"
                    stopColor={`var(--color-${id})`}
                    stopOpacity={0}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              minTickGap={32}
              fontSize={10}
            />
            <YAxis hide />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            {/* Render order: faintest first, sharpest last so the
                "known" line always reads on top of learning /
                leeches when multiple are visible. */}
            {seriesOrder.map((id) =>
              visible[id] ? (
                <Area
                  key={id}
                  dataKey={id}
                  type="monotone"
                  stroke={`var(--color-${id})`}
                  fill={`url(#fill-${id})`}
                  strokeWidth={SERIES_META[id].strokeWidth}
                  // Animate the area fill on first paint — a smooth
                  // left-to-right reveal so the curve "draws itself"
                  // when the user lands on Home. Recharts re-fires
                  // this animation on data changes (period switch),
                  // which gives the period toggle nice polish too.
                  // Slightly longer for the upper "known" series so
                  // it lands last on top of learning/leeches.
                  isAnimationActive
                  animationDuration={id === "known" ? 1100 : 850}
                  animationEasing="ease-out"
                />
              ) : null,
            )}
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  );
}

// ───────── Consistency heatmap ─────────

function dk(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// memo'd: the only prop is the stable `sessions` ref, so this skips re-render
// when the dashboard re-renders for unrelated reasons (dialog open, edit mode) —
// it mounts ~365 tooltip cells, so a needless re-render is the dashboard's
// biggest avoidable hitch.
export const ConsistencyHeatmap = memo(function ConsistencyHeatmap({
  sessions,
}: {
  sessions: StudySession[];
}) {
  // Aggregate sessions per day → minutes.
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      const d = new Date(s.startedAt * 1000);
      const key = dk(d);
      m.set(key, (m.get(key) ?? 0) + (s.durationSecs ?? 0) / 60);
    }
    return m;
  }, [sessions]);

  const cells = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(today.getDate() - 364);
    // Snap to the previous Sunday so weeks line up vertically.
    start.setDate(start.getDate() - start.getDay());
    const out: { key: string; minutes: number; isToday: boolean; isFuture: boolean; date: Date }[] = [];
    const d = new Date(start);
    while (d <= today || out.length % 7 !== 0) {
      const key = dk(d);
      out.push({
        key,
        minutes: byDay.get(key) ?? 0,
        isToday: key === dk(today),
        isFuture: d > today,
        date: new Date(d),
      });
      d.setDate(d.getDate() + 1);
      if (out.length > 380) break;
    }
    return out;
  }, [byDay]);

  const maxMinutes = useMemo(
    () => Math.max(...cells.map((c) => c.minutes), 1),
    [cells],
  );

  function level(minutes: number): number {
    if (minutes === 0) return 0;
    if (minutes <= maxMinutes * 0.25) return 1;
    if (minutes <= maxMinutes * 0.5) return 2;
    if (minutes <= maxMinutes * 0.75) return 3;
    return 4;
  }

  const totalMinutes = useMemo(
    () => cells.reduce((sum, c) => sum + c.minutes, 0),
    [cells],
  );
  const activeDays = useMemo(() => cells.filter((c) => c.minutes > 0).length, [cells]);

  return (
    <TooltipProvider delayDuration={80}>
      <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-5 py-4">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Consistency</h3>
            <p className="text-[11.5px] text-muted-foreground">
              {activeDays} active day{activeDays === 1 ? "" : "s"} ·{" "}
              {totalMinutes >= 60
                ? `${(totalMinutes / 60).toFixed(1)}h total`
                : `${Math.round(totalMinutes)} min total`}
            </p>
          </div>
          <Legend />
        </div>

        <div className="overflow-x-auto pb-1">
          <div className="grid grid-flow-col grid-rows-7 gap-[3px]" style={{ width: "max-content" }}>
            {cells.map((cell, i) => (
              <Tooltip key={i}>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      "size-[12px] rounded-[3px] transition-opacity hover:opacity-75",
                      cell.isFuture
                        ? "bg-transparent"
                        : LEVEL_BG[level(cell.minutes)],
                      cell.isToday && "ring-1 ring-foreground/40 ring-offset-1 ring-offset-card",
                    )}
                  />
                </TooltipTrigger>
                {!cell.isFuture && (
                  <TooltipContent side="top" sideOffset={4} className="text-[11px]">
                    {cell.date.toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                    {" · "}
                    {cell.minutes > 0
                      ? `${Math.round(cell.minutes)} min`
                      : "no activity"}
                  </TooltipContent>
                )}
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
});

const LEVEL_BG = [
  "bg-muted",
  "bg-violet-500/20",
  "bg-violet-500/40",
  "bg-violet-500/65",
  "bg-violet-500/90",
];

function Legend() {
  return (
    <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
      <span>less</span>
      {LEVEL_BG.map((c, i) => (
        <span key={i} className={cn("size-2.5 rounded-[2px]", c)} />
      ))}
      <span>more</span>
    </div>
  );
}

// ───────── Skills radar ─────────

/** Skill bucket lookup. The session.kind string is matched here to one
 *  of five axes. Built-in kinds (chat, review, voice, etc.) live next
 *  to user-loggable activities (italki, class, tutor, …) so the radar
 *  treats real-world practice the same way as in-app practice. Falls
 *  back to "review" when a kind isn't recognised — review is the most
 *  conservative bucket since it implies generic reinforcement; the
 *  previous default of "writing" was misleading because it inflated
 *  writing time with every flashcard session. */
type SkillBucket = "reading" | "writing" | "speaking" | "listening" | "review";

export const SKILL_BUCKETS: Record<string, SkillBucket> = {
  // ── In-app session kinds ─────────────────────────────────────────────
  reading: "reading",
  read: "reading",
  writing: "writing",
  chat: "writing", // chat = typed conversation = writing practice
  speaking: "speaking",
  voice: "speaking",
  listening: "listening",
  // Flashcard study finally has its own bucket. Older sessions written
  // with kind="review" used to silently roll into writing.
  review: "review",

  // ── Loggable real-world activities ───────────────────────────────────
  italki: "speaking",
  class: "speaking",
  tutor: "speaking",
  conversation: "speaking",
  immersion: "listening",
  podcast: "listening",
  video: "listening",
  book: "reading",
};

const SKILL_AXES: { key: SkillBucket; label: string }[] = [
  { key: "reading", label: "Reading" },
  { key: "listening", label: "Listening" },
  { key: "speaking", label: "Speaking" },
  { key: "writing", label: "Writing" },
  { key: "review", label: "Review" },
];

// memo'd alongside ConsistencyHeatmap — same single stable `sessions` prop, so
// it stays put across unrelated dashboard re-renders.
export const SkillsRadar = memo(function SkillsRadar({
  sessions,
}: {
  sessions: StudySession[];
}) {
  const data = useMemo(() => {
    const yearAgoSec = Math.floor(Date.now() / 1000) - 365 * 86400;
    const totals: Record<SkillBucket, number> = {
      reading: 0,
      writing: 0,
      speaking: 0,
      listening: 0,
      review: 0,
    };
    for (const s of sessions) {
      if (s.startedAt < yearAgoSec) continue;
      const bucket = SKILL_BUCKETS[s.kind] ?? "review";
      totals[bucket] += (s.durationSecs ?? 0) / 3600;
    }
    return SKILL_AXES.map((axis) => ({
      skill: axis.label,
      hours: Number(totals[axis.key].toFixed(1)),
    }));
  }, [sessions]);

  const max = Math.max(...data.map((d) => d.hours), 1);
  const isEmpty = data.every((d) => d.hours === 0);

  const config = {
    hours: { label: "Hours", color: "var(--color-brand)" },
  } satisfies ChartConfig;

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-5 py-4">
      <div className="mb-1 flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Skill balance</h3>
          <p className="text-[11.5px] text-muted-foreground">
            Hours by skill, last 365 days
          </p>
        </div>
      </div>
      {isEmpty ? (
        <div className="flex h-[200px] items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 text-[13px] text-muted-foreground">
          Track sessions to see your balance.
        </div>
      ) : (
        <ChartContainer config={config} className="mx-auto h-[220px] w-full">
          <RadarChart data={data} outerRadius="72%">
            <PolarGrid stroke="var(--color-border)" />
            <PolarAngleAxis dataKey="skill" tick={{ fontSize: 11 }} />
            <PolarRadiusAxis
              domain={[0, max]}
              tick={{ fontSize: 9 }}
              axisLine={false}
              tickCount={4}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <Radar
              dataKey="hours"
              stroke="var(--color-hours)"
              fill="var(--color-hours)"
              fillOpacity={0.32}
              strokeWidth={2}
            />
          </RadarChart>
        </ChartContainer>
      )}
    </div>
  );
});

// ───────── Lingotrack-style stats strip ─────────

export function StatsStrip({ sessions }: { sessions: StudySession[] }) {
  const stats = useMemo(() => {
    const now = Date.now();
    const day = 86_400_000;
    const totalSecs = sessions.reduce((s, x) => s + (x.durationSecs ?? 0), 0);
    const weekSecs = sessions
      .filter((x) => x.startedAt * 1000 >= now - 7 * day)
      .reduce((s, x) => s + (x.durationSecs ?? 0), 0);
    const monthSecs = sessions
      .filter((x) => x.startedAt * 1000 >= now - 30 * day)
      .reduce((s, x) => s + (x.durationSecs ?? 0), 0);
    const dailyAvgMin = monthSecs / 30 / 60;
    const longestMin = sessions.reduce(
      (m, x) => Math.max(m, (x.durationSecs ?? 0) / 60),
      0,
    );
    return {
      totalH: totalSecs / 3600,
      weekH: weekSecs / 3600,
      dailyAvgMin,
      longestMin,
      sessionsCount: sessions.length,
    };
  }, [sessions]);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Total" value={stats.totalH < 1 ? `${Math.round(stats.totalH * 60)}m` : `${stats.totalH.toFixed(1)}h`} sub={`${stats.sessionsCount} sessions`} />
      <Stat label="This week" value={stats.weekH < 1 ? `${Math.round(stats.weekH * 60)}m` : `${stats.weekH.toFixed(1)}h`} sub="last 7 days" />
      <Stat label="Daily avg" value={`${Math.round(stats.dailyAvgMin)}m`} sub="last 30 days" />
      <Stat label="Longest" value={`${Math.round(stats.longestMin)}m`} sub="single session" />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card px-3.5 py-2.5">
      <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-xl font-semibold tracking-tight">{value}</div>
      <div className="text-[10.5px] text-muted-foreground">{sub}</div>
    </div>
  );
}
