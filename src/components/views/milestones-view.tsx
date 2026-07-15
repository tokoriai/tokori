import { useEffect, useMemo, useState } from "react";
import { BookOpen, Clock, Flame, GraduationCap } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import {
  listSessions,
  listVocab,
  listWorkspaceReviews,
  type StudySession,
  type VocabEntry,
  type VocabReview,
} from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";
import { computeStreak } from "@/lib/streak";
import { currentGrowthBuckets } from "@/lib/vocab-growth";
import { cn } from "@/lib/utils";

const VOCAB_GOALS = [100, 1000, 5000, 10_000];
const HOUR_GOALS = [10, 100, 500, 1500];

export function MilestonesView() {
  const { active: workspace } = useWorkspace();
  const [vocab, setVocab] = useState<VocabEntry[]>([]);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [reviews, setReviews] = useState<VocabReview[]>([]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    Promise.all([
      listVocab(workspace.id),
      listSessions(workspace.id),
      listWorkspaceReviews(workspace.id),
    ]).then(([v, s, r]) => {
      if (!cancelled) {
        setVocab(v);
        setSessions(s);
        setReviews(r);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  const stats = useMemo(() => {
    // Same replay engine as the vocab-growth chart, so "Words known"
    // here matches the chart and the other KPI surfaces.
    const buckets = currentGrowthBuckets({ vocab, reviews });
    const wordsKnown = buckets.known;
    const wordsLearning = buckets.learning;
    const totalSeconds = sessions.reduce((sum, s) => sum + (s.durationSecs ?? 0), 0);
    const hours = totalSeconds / 3600;

    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const sessionsThisWeek = sessions.filter((s) => s.startedAt >= sevenDaysAgo).length;

    const streak = computeStreak(sessions);

    const last7 = computeDailyMinutes(sessions, 7);

    return {
      wordsKnown,
      wordsLearning,
      hours,
      sessionsThisWeek,
      streak,
      last7,
    };
  }, [vocab, reviews, sessions]);

  if (!workspace) return null;

  const vocabGoal = nextGoal(stats.wordsKnown, VOCAB_GOALS);
  const hourGoal = nextGoal(stats.hours, HOUR_GOALS);

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl space-y-8">
        {/* Hero */}
        <div className="rounded-2xl border border-border bg-card px-6 py-6 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="space-y-1">
              <p className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
                Day streak
              </p>
              <div className="flex items-baseline gap-2">
                <span className="font-serif text-6xl tracking-tight">
                  {stats.streak}
                </span>
                <span className="text-[13px] text-muted-foreground">
                  {stats.streak === 1 ? "day" : "days"}
                </span>
              </div>
              <p className="text-[13px] text-muted-foreground">
                {stats.streak > 0
                  ? "Keep showing up — even 5 minutes counts."
                  : "Start a chat to log your first session."}
              </p>
            </div>
            <Sparkline data={stats.last7} />
          </div>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Kpi
            icon={<GraduationCap className="size-4" />}
            label="Words known"
            value={String(stats.wordsKnown)}
            sub={`+${stats.wordsLearning} in progress`}
          />
          <Kpi
            icon={<Clock className="size-4" />}
            label="Immersion"
            value={`${stats.hours.toFixed(1)}h`}
            sub={`${sessions.length} sessions total`}
          />
          <Kpi
            icon={<BookOpen className="size-4" />}
            label="This week"
            value={String(stats.sessionsThisWeek)}
            sub="sessions logged"
          />
        </div>

        {/* Goals */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold tracking-tight">Goals</h2>
          <GoalBar
            label="Vocabulary"
            value={stats.wordsKnown}
            goal={vocabGoal}
            unit="words"
          />
          <GoalBar
            label="Immersion hours"
            value={Number(stats.hours.toFixed(1))}
            goal={hourGoal}
            unit="hours"
          />
        </div>

        {/* Recent sessions */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold tracking-tight">Recent sessions</h2>
          {sessions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border bg-card/50 px-4 py-8 text-center text-sm text-muted-foreground">
              No sessions yet — start a chat and one will be tracked automatically.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {sessions.slice(0, 8).map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-card px-3.5 py-2 text-[13px]"
                >
                  <div className="flex items-center gap-2">
                    <Flame className="size-3.5 text-muted-foreground" />
                    <span>{new Date(s.startedAt * 1000).toLocaleString()}</span>
                  </div>
                  <span className="text-muted-foreground">
                    {s.durationSecs
                      ? `${Math.round(s.durationSecs / 60)} min`
                      : "in progress"}
                    {" · "}
                    {s.wordsSaved} saved · {s.wordsSeen} seen
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-0.5 text-[11.5px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function GoalBar({
  label,
  value,
  goal,
  unit,
}: {
  label: string;
  value: number;
  goal: number;
  unit: string;
}) {
  const pct = Math.min(100, (value / goal) * 100);
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13.5px] font-medium">{label}</span>
        <span className="text-[12.5px] text-muted-foreground">
          {value.toLocaleString()} / {goal.toLocaleString()} {unit}
        </span>
      </div>
      <Progress className="mt-2 h-1.5" value={pct} />
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  return (
    <div className="flex items-end gap-1">
      {data.map((v, i) => {
        const height = Math.max(4, (v / max) * 36);
        return (
          <div key={i} className="flex flex-col items-center gap-1">
            <div
              className={cn(
                "w-3 rounded-sm transition-all",
                v > 0 ? "bg-foreground/85" : "bg-muted",
              )}
              style={{ height }}
            />
            <span className="text-[9px] uppercase text-muted-foreground">
              {dayLabel(i, data.length)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function dayLabel(idx: number, total: number) {
  const today = new Date();
  const d = new Date(today);
  d.setDate(d.getDate() - (total - 1 - idx));
  return d.toLocaleDateString(undefined, { weekday: "narrow" });
}

function nextGoal(value: number, goals: number[]): number {
  for (const g of goals) if (value < g) return g;
  return goals[goals.length - 1];
}

// Streak math lives in `lib/streak.ts` so the dashboard KPI and
// this page agree on which days count. See that file for the rule.

function computeDailyMinutes(sessions: StudySession[], days: number): number[] {
  const today = new Date();
  const buckets: number[] = new Array(days).fill(0);
  for (const s of sessions) {
    const d = new Date(s.startedAt * 1000);
    const offset =
      Math.floor((today.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
    if (offset < 0 || offset >= days) continue;
    const minutes = (s.durationSecs ?? 0) / 60;
    buckets[days - 1 - offset] += minutes;
  }
  return buckets;
}
