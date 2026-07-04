/**
 * Habits view — repeating goals + custom activity tracking.
 *
 * Three things in one screen:
 *   1. The user's habits (e.g. "Study 30 min/day"), each with a progress
 *      bar showing today's / this week's progress and a current streak.
 *   2. A small "Log time" form for manually recording activity that
 *      happened off-app (paper-book reading, podcast on the bus). Drives
 *      a `study_sessions` row with the right kind so habits that filter
 *      by kind pick it up.
 *   3. A list of recent sessions for visibility / debugging.
 *
 * Activity kinds are free-text strings the same column `study_sessions.kind`
 * already stores, so a habit on `"shadowing"` works the moment a user
 * logs a session with `kind: "shadowing"`. No schema change to add a kind.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ActivitySquare,
  AlarmClock,
  Calendar,
  CheckCircle2,
  Flame,
  Loader2,
  Plus,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  computeHabitProgress,
  createHabit,
  deleteHabit,
  listHabits,
  listSeenActivityKinds,
  planHabitFromGoal,
  type Habit,
  type HabitFrequency,
  type HabitProgress,
  type HabitPlan,
} from "@/lib/habits";
import {
  createGoal,
  deleteGoal,
  listGoals,
  listSessions,
  listVocab,
  type Goal,
  type GoalKind,
  type GoalSkill,
  type StudySession,
  type VocabEntry,
} from "@/lib/db";
import {
  computeGoalProgress,
  defaultGoalTitle,
  type GoalProgress,
  type SuggestedGoal,
} from "@/lib/goals";
import { LogActivityDialog } from "@/components/dashboard/log-activity-dialog";
import { useWorkspace } from "@/lib/workspace-context";
import { useProfile } from "@/lib/profile-context";
import { useProviderConfigs } from "@/lib/provider-context";
import { useJourneySettings } from "@/lib/use-journey-settings";
import {
  computeLearningJourney,
  type LearningJourney,
} from "@/lib/learning-journey";
import { suggestGoalsWithCoach } from "@/lib/journey-coach";
import { levelsForScale, scaleFor, type LevelInfo } from "@/lib/level";
import { cn } from "@/lib/utils";

const BUILTIN_KINDS = ["chat", "review", "reading", "writing", "speaking"];

type GoalRow = { goal: Goal; progress: GoalProgress; plan: HabitPlan | null };

export function HabitsView({
  section = "both",
}: {
  /** Which sub-tab to render when embedded in the Journey shell.
   *  "both" keeps the original combined screen for any legacy mount. */
  section?: "goals" | "habits" | "both";
} = {}) {
  const { active: workspace } = useWorkspace();
  const { profile } = useProfile();
  const { sendChat } = useProviderConfigs();
  const { settings, ready } = useJourneySettings(workspace?.id ?? 0);
  const [habits, setHabits] = useState<HabitProgress[]>([]);
  // Goals merged into the same view — each carries its computed progress
  // and (where the goal has a deadline) a derived "habit plan" we can
  // one-click materialise into an actual habit row.
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [recent, setRecent] = useState<StudySession[]>([]);
  // Full vocab + sessions kept so the AI "Suggest goals" action can
  // recompute the journey snapshot it reasons over — the same pure
  // function the Journey overview + dashboard widget use.
  const [allVocab, setAllVocab] = useState<VocabEntry[]>([]);
  const [allSessions, setAllSessions] = useState<StudySession[]>([]);
  const [knownKinds, setKnownKinds] = useState<string[]>(BUILTIN_KINDS);
  const [loading, setLoading] = useState(true);
  const [showNewHabit, setShowNewHabit] = useState(false);
  const [showNewGoal, setShowNewGoal] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<{ goal: Goal; plan: HabitPlan } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Habit | null>(null);
  const [pendingGoalDelete, setPendingGoalDelete] = useState<Goal | null>(null);
  // AI goal suggestions (Goals sub-tab). Empty until the user asks.
  const [suggested, setSuggested] = useState<SuggestedGoal[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const showGoals = section === "goals" || section === "both";
  const showHabits = section === "habits" || section === "both";

  async function refresh() {
    if (!workspace) return;
    setLoading(true);
    try {
      const [habitsList, goalList, sessions, vocab, kinds] = await Promise.all([
        listHabits(workspace.id),
        listGoals(workspace.id),
        listSessions(workspace.id),
        listVocab(workspace.id),
        listSeenActivityKinds(workspace.id),
      ]);
      const progresses = await Promise.all(habitsList.map(computeHabitProgress));
      setHabits(progresses);
      setGoals(
        goalList.map((g) => ({
          goal: g,
          progress: computeGoalProgress(g, vocab as VocabEntry[], sessions),
          plan: planHabitFromGoal(g),
        })),
      );
      setAllVocab(vocab as VocabEntry[]);
      setAllSessions(sessions);
      // Most-recent first, capped — full session log is the dashboard's job.
      setRecent(sessions.slice(0, 12));
      setKnownKinds(kinds);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Aggregate stats for the hero band.
  const stats = useMemo(() => {
    const completedToday = habits.filter(
      (h) => h.habit.frequency === "daily" && h.ratio >= 1,
    ).length;
    const completedThisWeek = habits.filter(
      (h) => h.habit.frequency === "weekly" && h.ratio >= 1,
    ).length;
    const longestStreak = habits.reduce((m, h) => Math.max(m, h.streak), 0);
    const totalSecondsToday = recent.reduce((s, r) => {
      const start = r.startedAt;
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      if (start * 1000 < startOfToday.getTime()) return s;
      return s + (r.durationSecs ?? 0);
    }, 0);
    return {
      total: habits.length,
      completedToday,
      completedThisWeek,
      longestStreak,
      totalSecondsToday,
    };
  }, [habits, recent]);

  // Journey snapshot for the AI "Suggest goals" action. Pure + cheap —
  // recomputed from the same inputs the overview + dashboard widget use.
  const scale = useMemo(() => {
    if (!workspace) return "cefr" as const;
    if (profile.levelScale === "auto") return scaleFor(workspace.targetLang);
    if (profile.levelScale === "custom") return "custom" as const;
    return profile.levelScale;
  }, [profile.levelScale, workspace?.targetLang]);

  const journey: LearningJourney | null = useMemo(() => {
    if (!workspace || !ready) return null;
    const availableLevels: LevelInfo[] =
      scale === "custom" && profile.customScale?.length
        ? [...profile.customScale].sort((a, b) => a.minVocab - b.minVocab)
        : levelsForScale(scale);
    const targetLevelId =
      settings.targetLevelId ??
      profile.goalLevel ??
      availableLevels[1]?.id ??
      availableLevels[0]?.id ??
      "";
    if (!targetLevelId) return null;
    return computeLearningJourney({
      workspace,
      vocab: allVocab,
      sessions: allSessions,
      scale,
      targetLevelId,
      deadline: settings.deadline,
      weeklyMinutesTarget: settings.weeklyMinutesTarget,
      manualOverrides: settings.manualOverrides,
      customLevels: profile.customScale ?? undefined,
    });
  }, [
    workspace,
    ready,
    settings,
    profile.goalLevel,
    profile.customScale,
    scale,
    allVocab,
    allSessions,
  ]);

  async function suggestGoals() {
    if (!workspace || suggesting) return;
    if (!journey) {
      toast.error("Set a target level in the Overview tab first.");
      return;
    }
    if (!sendChat) {
      toast.error("Add an AI provider in Settings → Providers to get suggestions.");
      return;
    }
    setSuggesting(true);
    try {
      const out = await suggestGoalsWithCoach({
        journey,
        sessions: allSessions,
        targetLang: workspace.targetLang,
        nativeLang: workspace.nativeLang,
        sendChat,
      });
      setSuggested(out);
      if (out.length === 0) {
        toast.info("No new goals to suggest right now — you're on track.");
      }
    } catch (err) {
      toast.error("Couldn't suggest goals", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSuggesting(false);
    }
  }

  async function adoptSuggested(g: SuggestedGoal) {
    if (!workspace) return;
    try {
      await createGoal({
        workspaceId: workspace.id,
        title: g.title,
        kind: g.kind,
        skill: g.skill,
        target: g.target,
        deadline: g.deadline,
      });
      setSuggested((prev) => prev.filter((s) => s !== g));
      toast.success(`Goal added: ${g.title}`);
      await refresh();
    } catch (err) {
      toast.error("Couldn't add goal", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!workspace) return null;

  return (
    <div className="flex h-full flex-col">
      {/* Hero band */}
      <div className="border-b border-border px-8 pt-8 pb-6">
        <div className="mx-auto max-w-5xl 2xl:max-w-6xl">
          <div className="flex items-end justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="mt-1 flex size-9 items-center justify-center rounded-lg bg-muted">
                {showHabits && !showGoals ? (
                  <ActivitySquare className="size-4 text-muted-foreground" />
                ) : (
                  <Target className="size-4 text-muted-foreground" />
                )}
              </div>
              <div>
                <h1 className="font-serif text-3xl tracking-tight">
                  {section === "goals"
                    ? "Goals"
                    : section === "habits"
                      ? "Habits"
                      : "Goals & habits"}
                </h1>
                <p className="mt-1 max-w-2xl text-[13.5px] text-muted-foreground">
                  {showGoals && !showHabits
                    ? "A goal sets a destination (“learn 1000 words by July”). Set one yourself, or let the coach suggest goals from your journey — then hit Generate plan to turn it into a daily habit."
                    : showHabits && !showGoals
                      ? "A habit sets the cadence (“30 min/day”). Sessions across the app log against it automatically; record off-app time with Log time."
                      : "A goal sets a destination; a habit sets the cadence. Define a goal, hit Generate plan, and a daily habit gets built that paces you to it."}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {showGoals && (
                <Button
                  variant="outline"
                  onClick={() => void suggestGoals()}
                  disabled={suggesting}
                  title="Let the coach propose goals from your journey"
                >
                  {suggesting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                  Suggest goals
                </Button>
              )}
              {showHabits && (
                <Button variant="outline" onClick={() => setShowLog(true)}>
                  <AlarmClock className="size-3.5" />
                  Log time
                </Button>
              )}
              {showGoals && (
                <Button
                  variant={showHabits ? "outline" : "default"}
                  onClick={() => setShowNewGoal(true)}
                >
                  <Target className="size-3.5" />
                  New goal
                </Button>
              )}
              {showHabits && (
                <Button onClick={() => setShowNewHabit(true)}>
                  <Plus className="size-3.5" />
                  New habit
                </Button>
              )}
            </div>
          </div>

          {showHabits && (
            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <BigStat label="Habits tracked" value={stats.total} />
              <BigStat
                label="Completed today"
                value={stats.completedToday}
                accent={stats.completedToday > 0 ? "text-emerald-700 dark:text-emerald-300" : undefined}
              />
              <BigStat label="Weekly habits done" value={stats.completedThisWeek} />
              <BigStat
                label="Longest streak"
                value={stats.longestStreak}
                hint={stats.longestStreak === 1 ? "period" : "periods"}
                accent="text-amber-700 dark:text-amber-300"
              />
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-5xl 2xl:max-w-6xl space-y-8">
          {/* Goals — destinations. A daily/weekly habit is the pacing
              mechanism that gets you there; the per-goal "Generate plan"
              button proposes one and creates it on confirm. */}
          {showGoals && (
            <section>
              <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Goals
              </h2>

              {/* Coach-suggested goals — adopt to drop straight into the list. */}
              {suggested.length > 0 && (
                <div className="mb-3 space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    <Sparkles className="size-3" />
                    Suggested by the coach
                  </div>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {suggested.map((g, i) => (
                      <SuggestedGoalCard
                        key={i}
                        goal={g}
                        onAdopt={() => void adoptSuggested(g)}
                        onDismiss={() =>
                          setSuggested((prev) => prev.filter((s) => s !== g))
                        }
                      />
                    ))}
                  </ul>
                </div>
              )}

              {loading ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  <Loader2 className="mr-1.5 inline size-4 animate-spin" />
                  Loading…
                </p>
              ) : goals.length === 0 ? (
                <p className="rounded-md border border-dashed border-border bg-card/30 px-3 py-4 text-center text-[12.5px] text-muted-foreground">
                  No goals yet. Set one yourself, or hit{" "}
                  <span className="font-medium">Suggest goals</span> and let the
                  coach propose a few from your journey.
                </p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {goals.map(({ goal, progress, plan }) => (
                    <GoalCard
                      key={goal.id}
                      goal={goal}
                      progress={progress}
                      plan={plan}
                      onPlan={() => plan && setPendingPlan({ goal, plan })}
                      onDelete={() => setPendingGoalDelete(goal)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {showHabits && (
            <>
              {/* Habit list */}
              <section>
                <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Habits — daily / weekly cadence
                </h2>
                {loading ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="mr-1.5 inline size-4 animate-spin" />
                    Loading…
                  </p>
                ) : habits.length === 0 ? (
                  <EmptyState onAdd={() => setShowNewHabit(true)} />
                ) : (
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {habits.map((h) => (
                      <HabitCard
                        key={h.habit.id}
                        progress={h}
                        onDelete={() => setPendingDelete(h.habit)}
                      />
                    ))}
                  </ul>
                )}
              </section>

              {/* Recent sessions */}
              <section>
                <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Recent sessions
                </h2>
                {recent.length === 0 ? (
                  <p className="py-3 text-[12.5px] text-muted-foreground">
                    No sessions logged yet. Use Log time to record one
                    manually, or open Conversation / Reader / Flashcards — each
                    tracked automatically.
                  </p>
                ) : (
                  <ul className="grid gap-1.5 sm:grid-cols-2">
                    {recent.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-baseline gap-3 rounded-md border border-border bg-card/40 px-3 py-1.5 text-[12.5px]"
                      >
                        <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                          {s.kind}
                        </span>
                        <span className="text-foreground">
                          {formatDuration(s.durationSecs ?? 0)}
                        </span>
                        <span className="ml-auto text-[11px] text-muted-foreground">
                          {timeAgo(s.startedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {showNewHabit && (
        <HabitDialog
          workspaceId={workspace.id}
          knownKinds={knownKinds}
          onClose={() => setShowNewHabit(false)}
          onSaved={async () => {
            setShowNewHabit(false);
            await refresh();
          }}
        />
      )}

      {/* Logger is now the canonical LogActivityDialog used by the
          dashboard quick-action and the Activities tab. Same picker,
          same Recent list, same backing path — habits and activities
          stay in sync. The local LogTimeDialog used to live here; it
          was a near-duplicate and has been removed. */}
      <LogActivityDialog
        open={showLog}
        onClose={() => setShowLog(false)}
        onLogged={() => refresh()}
      />

      {showNewGoal && (
        <NewGoalDialog
          workspaceId={workspace.id}
          onClose={() => setShowNewGoal(false)}
          onSaved={async () => {
            setShowNewGoal(false);
            await refresh();
          }}
        />
      )}

      {pendingPlan && (
        <ConfirmPlanDialog
          workspaceId={workspace.id}
          goal={pendingPlan.goal}
          plan={pendingPlan.plan}
          onClose={() => setPendingPlan(null)}
          onCreated={async () => {
            setPendingPlan(null);
            await refresh();
          }}
        />
      )}

      <AlertDialog
        open={pendingGoalDelete != null}
        onOpenChange={(v) => !v && setPendingGoalDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete goal "{pendingGoalDelete?.title}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The goal target and deadline are removed. Sessions you logged
              against it stay intact — only the goal row goes away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const target = pendingGoalDelete;
                setPendingGoalDelete(null);
                if (target) {
                  await deleteGoal(target.id);
                  await refresh();
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(v) => !v && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete habit "{pendingDelete?.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The habit and its target are removed. Sessions you logged
              against this habit's activity stay intact — only the goal
              + streak counter go away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) {
                  await deleteHabit(target.id);
                  await refresh();
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Cards & dialogs ────────────────────────────────────────────────────

function HabitCard({
  progress,
  onDelete,
}: {
  progress: HabitProgress;
  onDelete: () => void;
}) {
  const { habit, doneSecs, ratio, streak } = progress;
  const pct = Math.round(ratio * 100);
  const complete = ratio >= 1;
  return (
    <li className="group rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          {habit.glyph && (
            <span className="font-serif text-[18px] text-foreground/80">
              {habit.glyph}
            </span>
          )}
          <span className="truncate text-[14.5px] font-medium">{habit.name}</span>
          <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
            {habit.frequency}
          </span>
          {habit.activityKind && (
            <span className="rounded-full bg-muted/30 px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
              {habit.activityKind}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
          title="Delete"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full transition-all",
            complete ? "bg-emerald-500" : "bg-foreground/60",
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between text-[11.5px] text-muted-foreground">
        <span>
          {formatDuration(doneSecs)} of {formatDuration(habit.targetSecs)}
          <span className={cn("ml-1.5", complete && "text-emerald-600 dark:text-emerald-400")}>
            ({pct}%)
          </span>
        </span>
        {streak > 0 && (
          <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
            <Flame className="size-3" />
            {streak} {habit.frequency === "weekly" ? "wk" : "d"} streak
          </span>
        )}
      </div>
    </li>
  );
}

function HabitDialog({
  workspaceId,
  knownKinds,
  onClose,
  onSaved,
}: {
  workspaceId: number;
  knownKinds: string[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [targetMinutes, setTargetMinutes] = useState(30);
  const [frequency, setFrequency] = useState<HabitFrequency>("daily");
  const [activityKind, setActivityKind] = useState<string>("__any__");
  const [customKind, setCustomKind] = useState("");
  const [glyph, setGlyph] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) {
      toast.error("Name your habit.");
      return;
    }
    if (targetMinutes <= 0) {
      toast.error("Target must be at least one minute.");
      return;
    }
    setSaving(true);
    try {
      const resolvedKind: string | null =
        activityKind === "__any__"
          ? null
          : activityKind === "__custom__"
            ? customKind.trim() || null
            : activityKind;
      await createHabit({
        workspaceId,
        name: name.trim(),
        activityKind: resolvedKind,
        targetSecs: targetMinutes * 60,
        frequency,
        glyph: glyph.trim() || null,
      });
      await onSaved();
    } catch (err) {
      toast.error("Couldn't save habit", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="size-4" />
            New habit
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="h-name">Name</Label>
            <Input
              id="h-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Study 30 minutes a day"
            />
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 sm:gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="h-target">Target (minutes)</Label>
              <Input
                id="h-target"
                type="number"
                min={1}
                max={600}
                value={targetMinutes}
                onChange={(e) =>
                  setTargetMinutes(Math.max(1, Number(e.target.value) || 1))
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Frequency</Label>
              <Select
                value={frequency}
                onValueChange={(v) => setFrequency(v as HabitFrequency)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily — resets at midnight</SelectItem>
                  <SelectItem value="weekly">Weekly — resets Monday</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Activity</Label>
            <Select value={activityKind} onValueChange={setActivityKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__any__">Any activity</SelectItem>
                {knownKinds.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">+ Custom kind…</SelectItem>
              </SelectContent>
            </Select>
            {activityKind === "__custom__" && (
              <Input
                value={customKind}
                onChange={(e) => setCustomKind(e.target.value)}
                placeholder="e.g. shadowing, dictation, listening"
                className="text-[13px]"
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              Pick "Any activity" if you want every kind of session to count.
              Custom kinds let you track stuff like shadowing or listening
              sessions you log manually.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="h-glyph">Glyph (optional)</Label>
            <Input
              id="h-glyph"
              value={glyph}
              onChange={(e) => setGlyph(e.target.value.slice(0, 4))}
              placeholder="e.g. 📚 or 你"
              className="font-serif"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// LogTimeDialog removed — habits-view now uses the canonical
// LogActivityDialog from `@/components/dashboard/log-activity-dialog`.
// See the comment near the dialog mount in HabitsView for context.

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/50 px-8 py-12 text-center">
      <Calendar className="mx-auto mb-3 size-7 text-muted-foreground" />
      <h3 className="font-serif text-2xl tracking-tight">Build a habit</h3>
      <p className="mx-auto mt-2 max-w-md text-[13.5px] text-muted-foreground">
        Pick a target and a cadence. Reading 30 minutes a day, an hour of
        shadowing per week, ten flashcard reviews each morning — anything
        with a number and a clock.
      </p>
      <Button onClick={onAdd} className="mt-4">
        <Plus className="size-3.5" />
        New habit
      </Button>
    </div>
  );
}

function BigStat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number | string;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 text-xl font-semibold tracking-tight", accent)}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {hint && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const minutes = Math.round(secs / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
}

function timeAgo(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

// ─── Goals ────────────────────────────────────────────────────────────────

function GoalCard({
  goal,
  progress,
  plan,
  onPlan,
  onDelete,
}: {
  goal: Goal;
  progress: GoalProgress;
  plan: HabitPlan | null;
  onPlan: () => void;
  onDelete: () => void;
}) {
  const pct = Math.round(progress.pct * 100);
  const complete = progress.isComplete;
  return (
    <li className="group rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[14.5px] font-medium">{goal.title}</span>
          {progress.pace && (
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10.5px] uppercase tracking-wider",
                progress.pace === "ahead" &&
                  "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                progress.pace === "on" &&
                  "bg-sky-500/10 text-sky-700 dark:text-sky-300",
                progress.pace === "behind" &&
                  "bg-amber-500/10 text-amber-700 dark:text-amber-300",
              )}
            >
              {progress.pace}
            </span>
          )}
          {progress.isExpired && (
            <span className="rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wider text-rose-700 dark:text-rose-300">
              expired
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
          title="Delete goal"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full transition-all",
            complete ? "bg-emerald-500" : "bg-foreground/60",
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11.5px] text-muted-foreground">
        <span>
          {progress.current.toLocaleString()} / {progress.target.toLocaleString()}{" "}
          {progress.unit}
          <span className={cn("ml-1.5", complete && "text-emerald-600 dark:text-emerald-400")}>
            ({pct}%)
          </span>
        </span>
        {progress.daysLeft != null && (
          <span>
            {progress.daysLeft >= 0
              ? `${progress.daysLeft} day${progress.daysLeft === 1 ? "" : "s"} left`
              : "past deadline"}
          </span>
        )}
      </div>
      {/* Plan-from-goal action — only meaningful when there's a deadline
          to derive a rate from. Open-ended goals show a hint instead. */}
      <div className="mt-2 flex items-center gap-2 border-t border-border/50 pt-2">
        {complete ? (
          <span className="flex items-center gap-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            Goal hit
          </span>
        ) : plan ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onPlan}
            className="h-7"
            title={plan.rationale}
          >
            <Sparkles className="size-3.5" />
            Generate plan ({Math.round(plan.targetSecs / 60)} min/day)
          </Button>
        ) : (
          <span className="text-[11.5px] text-muted-foreground">
            Add a deadline to auto-generate a daily habit.
          </span>
        )}
      </div>
    </li>
  );
}

/** A coach-proposed goal the user hasn't committed to yet. Adopt → it
 *  becomes a real Goal row (createGoal) and joins the list below. */
function SuggestedGoalCard({
  goal,
  onAdopt,
  onDismiss,
}: {
  goal: SuggestedGoal;
  onAdopt: () => void;
  onDismiss: () => void;
}) {
  const unit =
    goal.kind === "vocab" ? "words" : goal.kind === "minutes" ? "min" : "sessions";
  const deadlineBit = goal.deadline
    ? ` · by ${new Date(goal.deadline * 1000).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })}`
    : "";
  return (
    <li className="rounded-xl border border-dashed border-border bg-card px-4 py-3">
      <p className="text-[14px] font-medium">{goal.title}</p>
      <p className="mt-0.5 text-[11.5px] text-muted-foreground">
        {goal.target.toLocaleString()} {unit}
        {goal.skill ? ` · ${goal.skill}` : ""}
        {deadlineBit}
      </p>
      {goal.rationale && (
        <p className="mt-1 text-[11.5px] italic text-muted-foreground">
          {goal.rationale}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2 border-t border-border/50 pt-2">
        <Button size="sm" onClick={onAdopt} className="h-7">
          <Plus className="size-3.5" />
          Adopt
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} className="h-7">
          Dismiss
        </Button>
      </div>
    </li>
  );
}

function NewGoalDialog({
  workspaceId,
  onClose,
  onSaved,
}: {
  workspaceId: number;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [kind, setKind] = useState<GoalKind>("minutes");
  const [skill, setSkill] = useState<GoalSkill>(null);
  const [target, setTarget] = useState(300);
  const [deadlineStr, setDeadlineStr] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const deadlineSec = useMemo(() => {
    if (!deadlineStr) return null;
    const d = new Date(deadlineStr);
    if (isNaN(d.getTime())) return null;
    d.setHours(23, 59, 59, 999);
    return Math.floor(d.getTime() / 1000);
  }, [deadlineStr]);

  async function save() {
    if (target <= 0) {
      toast.error("Pick a target.");
      return;
    }
    setSaving(true);
    try {
      const finalTitle = title.trim() || defaultGoalTitle(kind, skill, target, deadlineSec);
      await createGoal({
        workspaceId,
        title: finalTitle,
        kind,
        skill,
        target,
        deadline: deadlineSec,
      });
      toast.success(
        deadlineSec
          ? "Goal created — hit Generate plan to auto-build a daily habit."
          : "Goal created.",
      );
      await onSaved();
    } catch (err) {
      toast.error("Couldn't save goal", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="size-4" />
            New goal
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="g-title">Title (optional)</Label>
            <Input
              id="g-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={defaultGoalTitle(kind, skill, target, deadlineSec)}
            />
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 sm:gap-3">
            <div className="grid gap-1.5">
              <Label>Track</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as GoalKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vocab">Words mastered</SelectItem>
                  <SelectItem value="minutes">Minutes practiced</SelectItem>
                  <SelectItem value="sessions">Sessions completed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Skill</Label>
              <Select
                value={skill ?? "__any__"}
                onValueChange={(v) =>
                  setSkill(v === "__any__" ? null : (v as GoalSkill))
                }
                disabled={kind === "vocab"}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Any</SelectItem>
                  <SelectItem value="reading">Reading</SelectItem>
                  <SelectItem value="writing">Writing</SelectItem>
                  <SelectItem value="speaking">Speaking</SelectItem>
                  <SelectItem value="listening">Listening</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 sm:gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="g-target">
                Target {kind === "vocab" ? "(words)" : kind === "minutes" ? "(minutes)" : "(sessions)"}
              </Label>
              <Input
                id="g-target"
                type="number"
                min={1}
                value={target}
                onChange={(e) => setTarget(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="g-deadline">Deadline (optional)</Label>
              <Input
                id="g-deadline"
                type="date"
                value={deadlineStr}
                onChange={(e) => setDeadlineStr(e.target.value)}
              />
            </div>
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            Add a deadline to unlock automatic habit-plan generation —
            we'll divide the remaining target by the days left and propose
            a daily habit that paces you to it.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm a derived habit plan before creating the habit row. The user
 *  can tweak the duration or kind before accepting — the rationale line
 *  shows them exactly how we got there. */
function ConfirmPlanDialog({
  workspaceId,
  goal,
  plan,
  onClose,
  onCreated,
}: {
  workspaceId: number;
  goal: Goal;
  plan: HabitPlan;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [minutes, setMinutes] = useState(Math.round(plan.targetSecs / 60));
  const [kind, setKind] = useState<string>(plan.activityKind ?? "__any__");
  const [saving, setSaving] = useState(false);

  async function create() {
    setSaving(true);
    try {
      await createHabit({
        workspaceId,
        name: plan.name,
        activityKind: kind === "__any__" ? null : kind,
        targetSecs: minutes * 60,
        frequency: plan.frequency,
        glyph: null,
      });
      toast.success(`Habit created — ${minutes} min/day toward your goal`);
      await onCreated();
    } catch (err) {
      toast.error("Couldn't create habit", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            Generate habit plan
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-[12.5px] text-muted-foreground">
            For <strong className="text-foreground">{goal.title}</strong>:
          </p>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[12.5px]">
            <p className="font-medium text-foreground">{plan.rationale}</p>
            <p className="mt-1 text-muted-foreground">
              Tweak the numbers below before saving if you want a softer or
              harder target.
            </p>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 sm:gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="cp-mins">Minutes per day</Label>
              <Input
                id="cp-mins"
                type="number"
                min={1}
                max={600}
                value={minutes}
                onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Activity</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Any activity</SelectItem>
                  {BUILTIN_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={create} disabled={saving}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Create habit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
