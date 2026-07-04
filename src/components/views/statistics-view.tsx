/**
 * Progress → Statistics.
 *
 * A read-only dashboard over the workspace's vocab, study sessions, and
 * review history. Everything is computed client-side from three list
 * queries via the pure helpers in `study-stats.ts` (so the math is tested)
 * and the existing dashboard chart components (so the visuals match Home).
 *
 * The live session timer (`useSession`) feeds the "Today" card: while a
 * session is running, today's studied time ticks up in real time and a
 * "Studying now" pill shows the live clock — so the Progress tab reflects
 * what you're doing this very minute, not just what's been saved.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  BookOpen,
  Clock,
  Flame,
  Loader2,
  Repeat2,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import {
  ConsistencyHeatmap,
  SkillsRadar,
  VocabGrowthChart,
} from "@/components/dashboard/charts";
import {
  ActivityExplorer,
  StudyHoursCard,
  WeeklyReportCard,
} from "@/components/stats/report-panels";
import { RecentSessionsCard } from "@/components/stats/recent-sessions";
import {
  listSessions,
  listVocab,
  listWorkspaceReviews,
  type StudySession,
  type VocabEntry,
  type VocabReview,
} from "@/lib/db";
import {
  startOfToday,
  studyTotals,
  summarizeReviews,
  vocabStatusCounts,
  wordsAddedSince,
  type ReviewSummary,
} from "@/lib/study-stats";
import { computeStreak, longestStreak } from "@/lib/streak";
import { computeLevel, type ComputedLevel } from "@/lib/level";
import { languageName } from "@/lib/languages";
import { useWorkspace } from "@/lib/workspace-context";
import { useProfile } from "@/lib/profile-context";
import { useSession } from "@/lib/session-context";
import { useCloudRefresh } from "@/lib/cloud-refresh";
import { cn } from "@/lib/utils";

// ── formatters ──────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Human study duration: "0m" / "45m" / "1h 20m" / "3h". */
function fmtStudy(secs: number): string {
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** Live clock for the running session: "m:ss" or "h:mm:ss". */
function fmtClock(secs: number): string {
  const s = secs % 60;
  const m = Math.floor(secs / 60) % 60;
  const h = Math.floor(secs / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ── small building blocks ───────────────────────────────────────────

const PANEL = "rounded-2xl border border-border bg-card px-5 py-4";

const ACCENT: Record<string, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  sky: "text-sky-600 dark:text-sky-400",
  amber: "text-amber-600 dark:text-amber-400",
  violet: "text-violet-600 dark:text-violet-400",
};

function KpiCard({
  icon: Icon,
  accent,
  label,
  value,
  sub,
}: {
  icon: typeof BookOpen;
  accent: keyof typeof ACCENT | string;
  label: string;
  value: string | number;
  sub: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className={cn("size-3.5", ACCENT[accent] ?? "")} />
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 text-[11.5px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function TodayCard({
  todaySecs,
  wordsToday,
  reviewsToday,
  sessionsToday,
  active,
  paused,
  activeSecs,
}: {
  todaySecs: number;
  wordsToday: number;
  reviewsToday: number;
  sessionsToday: number;
  active: StudySession | null;
  paused: boolean;
  activeSecs: number;
}) {
  return (
    <div className={cn(PANEL, "flex flex-wrap items-end justify-between gap-4")}>
      <div>
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Today
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="font-serif text-4xl tracking-tight tabular-nums">
            {fmtStudy(todaySecs)}
          </span>
          <span className="text-[12.5px] text-muted-foreground">studied</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          <span>
            <span className="font-medium text-foreground tabular-nums">
              {wordsToday}
            </span>{" "}
            words added
          </span>
          <span>
            <span className="font-medium text-foreground tabular-nums">
              {reviewsToday}
            </span>{" "}
            reviews
          </span>
          <span>
            <span className="font-medium text-foreground tabular-nums">
              {sessionsToday}
            </span>{" "}
            sessions
          </span>
        </div>
      </div>

      {/* The session timer, surfaced in the journey. While a session runs,
          the clock here ticks and the Today total above climbs with it. */}
      {active ? (
        <div
          className={cn(
            "flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px]",
            paused
              ? "border-border bg-muted/40 text-muted-foreground"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          )}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              paused ? "bg-muted-foreground" : "animate-pulse bg-emerald-500",
            )}
          />
          {paused ? "Paused" : "Studying now"}
          <span className="font-medium capitalize">· {active.kind}</span>
          <span className="font-semibold tabular-nums">{fmtClock(activeSecs)}</span>
        </div>
      ) : (
        <p className="max-w-[16rem] text-[11.5px] text-muted-foreground">
          Start a session from the sidebar timer to track your study time live.
        </p>
      )}
    </div>
  );
}

function LevelCard({ level }: { level: ComputedLevel }) {
  const maxed = level.next.id === level.current.id;
  const pct = maxed ? 100 : Math.round(level.progress * 100);
  return (
    <div className={PANEL}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Current level
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="font-serif text-2xl tracking-tight">
              {level.current.id}
            </span>
            <span className="text-[12.5px] text-muted-foreground">
              {level.current.label}
            </span>
          </div>
        </div>
        {!maxed && (
          <div className="text-right text-[12px] text-muted-foreground">
            next{" "}
            <span className="font-medium text-foreground">{level.next.id}</span>
          </div>
        )}
      </div>
      <Progress value={pct} className="mt-3 h-2" />
      <div className="mt-1.5 flex justify-between text-[11.5px] text-muted-foreground">
        <span>
          {maxed ? "Top of the scale 🎉" : `${pct}% to ${level.next.id}`}
        </span>
        {!maxed && (
          <span className="tabular-nums">{Math.ceil(level.toNext)} to go</span>
        )}
      </div>
    </div>
  );
}

const GRADE_META = [
  { key: "again", label: "Again", bar: "bg-rose-500" },
  { key: "hard", label: "Hard", bar: "bg-amber-500" },
  { key: "good", label: "Good", bar: "bg-emerald-500" },
  { key: "easy", label: "Easy", bar: "bg-sky-500" },
] as const;

function ReviewBreakdown({ summary }: { summary: ReviewSummary }) {
  const max = Math.max(1, ...GRADE_META.map((g) => summary.byGrade[g.key]));
  return (
    <div className={cn(PANEL, "flex flex-col")}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">
            Review breakdown
          </h3>
          <p className="text-[11.5px] text-muted-foreground">
            {summary.total.toLocaleString()} reviews graded
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">
            {Math.round(summary.retention * 100)}%
          </div>
          <div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            retention
          </div>
        </div>
      </div>
      {summary.total === 0 ? (
        <p className="mt-4 text-[12.5px] text-muted-foreground">
          No reviews yet — grade some cards and your recall split shows up here.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {GRADE_META.map((g) => {
            const n = summary.byGrade[g.key];
            return (
              <div key={g.key} className="flex items-center gap-2 text-[12px]">
                <span className="w-12 text-muted-foreground">{g.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", g.bar)}
                    style={{ width: `${(n / max) * 100}%` }}
                  />
                </div>
                <span className="w-10 text-right tabular-nums text-muted-foreground">
                  {n}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── the page ────────────────────────────────────────────────────────

export function StatisticsPanel() {
  const { active: workspace } = useWorkspace();
  const { profile } = useProfile();
  const { active: activeSession, activeSecs, paused } = useSession();

  const [vocab, setVocab] = useState<VocabEntry[]>([]);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [reviews, setReviews] = useState<VocabReview[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!workspace) return;
    const [v, s, r] = await Promise.all([
      listVocab(workspace.id),
      listSessions(workspace.id),
      listWorkspaceReviews(workspace.id),
    ]);
    setVocab(v);
    setSessions(s);
    setReviews(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    setLoading(true);
    void refresh().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace?.id, refresh]);

  useCloudRefresh(() => {
    void refresh();
  });

  const counts = useMemo(() => vocabStatusCounts(vocab), [vocab]);
  const totals = useMemo(() => studyTotals(sessions), [sessions]);
  const reviewSummary = useMemo(() => summarizeReviews(reviews), [reviews]);
  const streak = useMemo(() => computeStreak(sessions), [sessions]);
  const best = useMemo(() => longestStreak(sessions), [sessions]);
  const wordsToday = useMemo(
    () => wordsAddedSince(vocab, startOfToday()),
    [vocab],
  );
  const sessionsToday = useMemo(() => {
    const start = startOfToday();
    return sessions.filter((s) => s.startedAt >= start).length;
  }, [sessions]);

  const level = useMemo(
    () =>
      computeLevel(
        workspace?.targetLang ?? "en",
        counts.mastered,
        totals.totalSecs / 3600,
        profile.goalLevel,
        {
          manualLevelId: profile.manualLevelId,
          manualScore: profile.manualScore,
          scale: profile.levelScale === "auto" ? null : profile.levelScale,
          customLevels: profile.customScale,
        },
      ),
    [
      workspace?.targetLang,
      counts.mastered,
      totals.totalSecs,
      profile.goalLevel,
      profile.manualLevelId,
      profile.manualScore,
      profile.levelScale,
      profile.customScale,
    ],
  );

  if (!workspace) return null;

  // Today's studied time = completed sessions today + the live running
  // session (which contributes 0 to `studyTotals` until it ends).
  const todaySecs =
    totals.todaySecs + (activeSession ? activeSecs : 0);
  const weekHours = totals.weekSecs / 3600;
  const firstLoad = loading && vocab.length === 0 && sessions.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 px-8 py-8 2xl:max-w-6xl">
        <header className="space-y-1">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <BarChart3 className="size-3" />
            Statistics
          </div>
          <h1 className="font-serif text-3xl tracking-tight">Your numbers</h1>
          <p className="text-[13px] text-muted-foreground">
            Words, time, retention, and consistency — the whole picture of your{" "}
            {languageName(workspace.targetLang)} progress.
          </p>
        </header>

        {firstLoad ? (
          <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Crunching your stats…
          </div>
        ) : (
          <>
            <TodayCard
              todaySecs={todaySecs}
              wordsToday={wordsToday}
              reviewsToday={reviewSummary.reviewsToday}
              sessionsToday={sessionsToday}
              active={activeSession}
              paused={paused}
              activeSecs={activeSecs}
            />

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard
                icon={BookOpen}
                accent="emerald"
                label="Words known"
                value={counts.mastered.toLocaleString()}
                sub={`${counts.learning} learning · ${counts.review} reviewing`}
              />
              <KpiCard
                icon={Clock}
                accent="sky"
                label="Study time"
                value={fmtStudy(totals.totalSecs)}
                sub={`${weekHours < 1 ? `${Math.round(totals.weekSecs / 60)}m` : `${weekHours.toFixed(1)}h`} this week`}
              />
              <KpiCard
                icon={Flame}
                accent="amber"
                label="Streak"
                value={`${streak}d`}
                sub={best > 0 ? `best ${best}d` : "start today"}
              />
              <KpiCard
                icon={Repeat2}
                accent="violet"
                label="Reviews"
                value={reviewSummary.total.toLocaleString()}
                sub={
                  reviewSummary.total
                    ? `${Math.round(reviewSummary.retention * 100)}% retention`
                    : "no reviews yet"
                }
              />
            </div>

            {/* The interactive report module: week-over-week digest +
                the clickable day explorer. Both read the same three row
                arrays this page already fetched — no extra queries. */}
            <WeeklyReportCard vocab={vocab} sessions={sessions} reviews={reviews} />
            <ActivityExplorer vocab={vocab} sessions={sessions} reviews={reviews} />

            <LevelCard level={level} />

            <VocabGrowthChart vocab={vocab} reviews={reviews} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ReviewBreakdown summary={reviewSummary} />
              <StudyHoursCard sessions={sessions} />
            </div>

            {/* Editable session log — fix a mis-timed session (or one the
                auto-pause shortened/lengthened unexpectedly) and every
                stat above refetches. */}
            <RecentSessionsCard
              sessions={sessions}
              onChanged={() => void refresh()}
            />

            <ConsistencyHeatmap sessions={sessions} />
            <SkillsRadar sessions={sessions} />
          </>
        )}
      </div>
    </div>
  );
}
