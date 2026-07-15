/**
 * Journey view — the dedicated "where am I, where am I going" tab.
 *
 * Layout (single column, max-w-5xl — matches the sub-tab bar and the
 * sibling Goals/Habits + Statistics tabs so the Progress screens share
 * one page width):
 *   1. Header — target level picker + deadline/weekly-minutes picker
 *   2. Progress strip — gradient bar current → target
 *   3. Milestones — one row per JourneyMilestone with vocab/hours
 *      progress, status pill, manual override, expand to see
 *      recommended habits
 *   4. Coach panel — proactive nudge + free-form "Ask the coach"
 *      input. Conversation memory is per-session (in-state); the
 *      proactive nudge caches across sessions via the same key the
 *      dashboard widget uses.
 *   5. Footer — "Read the study guide" link
 */

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  Lock,
  RefreshCcw,
  Send,
  Sparkles,
  Target,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createHabit,
  listHabits,
  type Habit,
} from "@/lib/habits";
import {
  listSessions,
  listVocab,
  listWorkspaceReviews,
  type StudySession,
  type VocabEntry,
  type VocabReview,
} from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";
import { useProfile } from "@/lib/profile-context";
import { useProviderConfigs } from "@/lib/provider-context";
import { useJourneySettings } from "@/lib/use-journey-settings";
import {
  computeLearningJourney,
  type JourneyMilestone,
  type LearningJourney,
  type SuggestedHabit,
} from "@/lib/learning-journey";
import { askCoach, type CoachReply } from "@/lib/journey-coach";
import { levelsForScale, scaleFor, type LevelInfo } from "@/lib/level";
import { HabitsView } from "@/components/views/habits-view";
import { cn } from "@/lib/utils";

type CoachTurn = {
  role: "coach" | "user";
  text: string;
  actions?: CoachReply["suggestedActions"];
};

// "statistics" used to be a fourth sub-tab here; it's now its own
// sidebar page (Progress → Statistics). A stale persisted value falls
// through readSubtab's validation to the Overview default.
type JourneySubtab = "overview" | "goals" | "habits";

const SUBTABS: { id: JourneySubtab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "goals", label: "Goals" },
  { id: "habits", label: "Habits" },
];

const subtabKey = (wsId: number) => `journey.subtab.${wsId}`;

function readSubtab(wsId: number | undefined): JourneySubtab | null {
  if (wsId == null || typeof window === "undefined") return null;
  const v = window.localStorage.getItem(subtabKey(wsId));
  return v === "overview" || v === "goals" || v === "habits" ? v : null;
}

/**
 * Journey shell — one home for the whole learning loop, split into three
 * sub-tabs:
 *   • Overview — the level ladder, pace, and the AI coach.
 *   • Goals    — manual + coach-suggested goals (auto-tracked).
 *   • Habits   — daily / weekly cadences + activity logging.
 *
 * The active sub-tab is remembered per workspace; `initialSubtab` lets a
 * deep-link (e.g. the legacy /habits route) open straight to one.
 */
export function JourneyView({
  initialSubtab,
}: {
  initialSubtab?: JourneySubtab;
} = {}) {
  const { active: workspace } = useWorkspace();
  const [subtab, setSubtab] = useState<JourneySubtab>(
    () => initialSubtab ?? readSubtab(workspace?.id) ?? "overview",
  );

  // Honour a deep-link change (route → initialSubtab) after mount.
  useEffect(() => {
    if (initialSubtab) setSubtab(initialSubtab);
  }, [initialSubtab]);

  // Re-read the saved sub-tab when the workspace switches.
  useEffect(() => {
    if (!initialSubtab) setSubtab(readSubtab(workspace?.id) ?? "overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Persist the choice.
  useEffect(() => {
    if (workspace?.id != null && typeof window !== "undefined") {
      window.localStorage.setItem(subtabKey(workspace.id), subtab);
    }
  }, [subtab, workspace?.id]);

  if (!workspace) return null;

  return (
    <div className="flex h-full flex-col">
      {/* Sub-tab bar */}
      <div className="border-b border-border px-8 pt-4">
        <div className="mx-auto flex max-w-5xl gap-1 2xl:max-w-6xl">
          {SUBTABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubtab(t.id)}
              className={cn(
                "relative px-3 py-2 text-[13px] font-medium transition-colors",
                subtab === t.id
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {subtab === t.id && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Active sub-tab */}
      <div className="min-h-0 flex-1">
        {subtab === "overview" ? (
          <JourneyOverview onGoToGoals={() => setSubtab("goals")} />
        ) : subtab === "goals" ? (
          <HabitsView section="goals" />
        ) : (
          <HabitsView section="habits" />
        )}
      </div>
    </div>
  );
}

function JourneyOverview({ onGoToGoals }: { onGoToGoals: () => void }) {
  const { active: workspace } = useWorkspace();
  const { profile } = useProfile();
  const { sendChat } = useProviderConfigs();
  const {
    settings,
    ready,
    setTargetLevelId,
    setDeadline,
    setWeeklyMinutesTarget,
    setMilestoneOverride,
  } = useJourneySettings(workspace?.id ?? 0);

  const [vocab, setVocab] = useState<VocabEntry[]>([]);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [reviews, setReviews] = useState<VocabReview[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Coach state — conversation lives in-memory per mount. We also
  // hand the first turn to the user as the cached proactive nudge.
  const [turns, setTurns] = useState<CoachTurn[]>([]);
  const [asking, setAsking] = useState(false);
  const [userInput, setUserInput] = useState("");

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listVocab(workspace.id),
      listSessions(workspace.id),
      listWorkspaceReviews(workspace.id),
      listHabits(workspace.id),
    ])
      .then(([v, s, r, h]) => {
        if (cancelled) return;
        setVocab(v);
        setSessions(s);
        setReviews(r);
        setHabits(h);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  const scale = useMemo(() => {
    if (!workspace) return "cefr" as const;
    if (profile.levelScale === "auto") return scaleFor(workspace.targetLang);
    if (profile.levelScale === "custom") return "custom" as const;
    return profile.levelScale;
  }, [profile.levelScale, workspace?.targetLang]);

  const availableLevels: LevelInfo[] = useMemo(() => {
    if (scale === "custom" && profile.customScale?.length) {
      return [...profile.customScale].sort((a, b) => a.minVocab - b.minVocab);
    }
    return levelsForScale(scale);
  }, [scale, profile.customScale]);

  const journey: LearningJourney | null = useMemo(() => {
    if (!workspace || !ready) return null;
    const targetLevelId =
      settings.targetLevelId ?? profile.goalLevel ?? availableLevels[1]?.id ?? availableLevels[0]?.id ?? "";
    if (!targetLevelId) return null;
    return computeLearningJourney({
      workspace,
      vocab,
      reviews,
      sessions,
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
    availableLevels,
    vocab,
    reviews,
    sessions,
  ]);

  if (!workspace) return null;

  async function ask(userPrompt?: string) {
    if (!journey || !sendChat || asking) return;
    setAsking(true);
    if (userPrompt) {
      setTurns((prev) => [...prev, { role: "user", text: userPrompt }]);
    }
    try {
      const reply = await askCoach({
        journey,
        todayStats: todayStats(sessions, vocab),
        weekStats: weekStats(sessions),
        streakDays: 0,                          // a future pass can pipe in computeStreak()
        activeHabits: habits.filter((h) => !h.archivedAt),
        habitsHit: {},
        recentSessions: sessions.slice(-5),
        targetLang: workspace!.targetLang,
        nativeLang: workspace!.nativeLang,
        userPrompt,
        sendChat,
      });
      setTurns((prev) => [
        ...prev,
        { role: "coach", text: reply.message, actions: reply.suggestedActions },
      ]);
    } catch (err) {
      toast.error("Coach didn't respond", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAsking(false);
    }
  }

  function toggleExpand(levelId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(levelId)) next.delete(levelId);
      else next.add(levelId);
      return next;
    });
  }

  async function adoptHabit(suggestion: SuggestedHabit) {
    if (!workspace) return;
    try {
      const created = await createHabit({
        workspaceId: workspace.id,
        name: suggestion.name,
        activityKind: suggestion.activityKind,
        targetSecs: suggestion.targetSecs,
        frequency: suggestion.frequency,
      });
      setHabits((prev) => [...prev, created]);
      toast.success(`Habit added: ${created.name}`);
    } catch (err) {
      toast.error("Couldn't add habit", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-8 py-8 2xl:max-w-6xl">
        {/* ─── Header ─── */}
        <header className="space-y-1">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Target className="size-3" />
            Your journey
          </div>
          <h1 className="font-serif text-3xl tracking-tight">
            {workspace.name}
          </h1>
          <p className="text-[13px] text-muted-foreground">
            Pick a target level and let the coach guide you there. Manual
            overrides at every step.
          </p>
        </header>

        {!journey ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/30 px-5 py-8 text-center">
            <p className="text-[13px] text-muted-foreground">
              {loading ? "Loading your journey…" : "Pick a target level below to start."}
            </p>
          </div>
        ) : (
          <>
            {/* ─── Target picker + pace controls ─── */}
            <section className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card px-5 py-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Target level
                </Label>
                <Select
                  value={journey.targetLevelId}
                  onValueChange={(v) => void setTargetLevelId(v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableLevels.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.id} · {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Deadline (optional)
                </Label>
                <Input
                  type="date"
                  value={settings.deadline ? toDateInput(settings.deadline) : ""}
                  onChange={(e) =>
                    void setDeadline(
                      e.target.value
                        ? Math.floor(new Date(e.target.value).getTime() / 1000)
                        : null,
                    )
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Weekly minutes target (optional)
                </Label>
                <Input
                  type="number"
                  min={0}
                  step={15}
                  value={settings.weeklyMinutesTarget ?? ""}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    void setWeeklyMinutesTarget(Number.isFinite(n) && n > 0 ? n : null);
                  }}
                  placeholder="e.g. 210"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Pace
                </Label>
                <div className="flex h-9 items-center px-1 text-[13px]">
                  {paceLabel(journey)}
                </div>
              </div>
            </section>

            {/* ─── Progress strip ─── */}
            <ProgressStrip journey={journey} />

            {/* ─── Milestones ─── */}
            <section className="space-y-2">
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Milestones
              </h2>
              <ul className="space-y-2">
                {journey.milestones.map((m) => (
                  <MilestoneRow
                    key={m.levelId}
                    milestone={m}
                    journey={journey}
                    expanded={expanded.has(m.levelId)}
                    onToggle={() => toggleExpand(m.levelId)}
                    onMarkComplete={() =>
                      void setMilestoneOverride(m.levelId, Math.floor(Date.now() / 1000))
                    }
                    onReopen={() => void setMilestoneOverride(m.levelId, null)}
                    suggestedHabits={journey.suggestedHabits}
                    onAdoptHabit={(h) => void adoptHabit(h)}
                    isCurrent={m.levelId === journey.currentLevelId}
                    isTarget={m.levelId === journey.targetLevelId}
                  />
                ))}
              </ul>
            </section>

            {/* ─── Coach panel ─── */}
            <section className="space-y-3 rounded-lg border border-border bg-muted/20 px-5 py-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  <Sparkles className="size-3" />
                  Coach
                </h2>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11.5px]"
                    onClick={onGoToGoals}
                    title="Set goals — manually or coach-suggested"
                  >
                    <Target className="size-3" />
                    Plan my goals
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11.5px]"
                    onClick={() => void ask()}
                    disabled={!sendChat || asking}
                  >
                    {asking ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RefreshCcw className="size-3" />
                    )}
                    Fresh nudge
                  </Button>
                </div>
              </div>
              <div className="space-y-3">
                {turns.length === 0 && !asking && (
                  <p className="text-[12.5px] italic text-muted-foreground">
                    Click <span className="font-medium">Fresh nudge</span> for a
                    suggestion based on your current state, or type a question
                    below.
                  </p>
                )}
                {turns.map((t, i) => (
                  <CoachBubble
                    key={i}
                    turn={t}
                  />
                ))}
                {asking && (
                  <div className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    The coach is thinking…
                  </div>
                )}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const q = userInput.trim();
                  if (!q) return;
                  setUserInput("");
                  void ask(q);
                }}
                className="flex items-start gap-2"
              >
                <Textarea
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder="Ask anything — &lsquo;How am I doing?&rsquo;, &lsquo;What should I focus on this week?&rsquo;, &lsquo;I&rsquo;m falling behind&rsquo;…"
                  rows={2}
                  className="resize-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      const q = userInput.trim();
                      if (!q) return;
                      setUserInput("");
                      void ask(q);
                    }
                  }}
                />
                <Button
                  type="submit"
                  size="icon-sm"
                  disabled={!userInput.trim() || asking}
                  className="h-9 w-9"
                  title="Send (⌘/Ctrl+Enter)"
                >
                  <Send className="size-3.5" />
                </Button>
              </form>
            </section>

            <footer className="text-center text-[11.5px] text-muted-foreground">
              <a
                href="https://tokori.ai/docs/guides/study-guide"
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-2 hover:underline"
              >
                Read the study guide →
              </a>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function ProgressStrip({ journey }: { journey: LearningJourney }) {
  const start = journey.milestones[0]?.vocabTarget ?? 0;
  const end =
    journey.milestones[journey.milestones.length - 1]?.vocabTarget ?? 1;
  const span = Math.max(1, end - start);
  const pct = Math.min(1, Math.max(0, (journey.currentVocab - start) / span));
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="font-serif text-xl tracking-tight">
          {journey.currentLevelId}
        </span>
        <span className="text-[12.5px] text-muted-foreground">
          target {journey.targetLevelId}
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-sky-500 to-violet-500 transition-all"
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      </div>
      <p className="text-[12px] text-muted-foreground">
        {journey.currentVocab} words known ·{" "}
        {journey.currentHours.toFixed(1)}h immersion
      </p>
    </section>
  );
}

function MilestoneRow({
  milestone,
  journey,
  expanded,
  onToggle,
  onMarkComplete,
  onReopen,
  suggestedHabits,
  onAdoptHabit,
  isCurrent,
  isTarget,
}: {
  milestone: JourneyMilestone;
  journey: LearningJourney;
  expanded: boolean;
  onToggle: () => void;
  onMarkComplete: () => void;
  onReopen: () => void;
  suggestedHabits: SuggestedHabit[];
  onAdoptHabit: (h: SuggestedHabit) => void;
  isCurrent: boolean;
  isTarget: boolean;
}) {
  const vocabPct = Math.min(
    1,
    journey.currentVocab / Math.max(1, milestone.vocabTarget),
  );
  const hoursPct = Math.min(
    1,
    journey.currentHours / Math.max(1, milestone.hoursTarget),
  );
  const StatusIcon =
    milestone.status === "completed"
      ? CheckCircle2
      : milestone.status === "in-progress"
        ? Circle
        : Lock;
  const statusColor =
    milestone.status === "completed"
      ? "text-emerald-600 dark:text-emerald-400"
      : milestone.status === "in-progress"
        ? "text-sky-600 dark:text-sky-400"
        : "text-muted-foreground";

  return (
    <li>
      <div className="rounded-lg border border-border bg-card">
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
        >
          <StatusIcon className={cn("size-4 shrink-0", statusColor)} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-serif text-[15px] font-medium">
                {milestone.label}
              </span>
              <span className="text-[11.5px] text-muted-foreground">
                {milestone.description}
              </span>
              {isCurrent && (
                <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300">
                  current
                </span>
              )}
              {isTarget && !isCurrent && (
                <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">
                  target
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span>
                {journey.currentVocab} / {milestone.vocabTarget} words
              </span>
              <span>
                {journey.currentHours.toFixed(1)} / {milestone.hoursTarget}h
              </span>
            </div>
          </div>
          {expanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
        </button>
        {expanded && (
          <div className="border-t border-border bg-muted/20 px-4 py-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  Vocab
                </Label>
                <Progress value={vocabPct * 100} className="h-1.5" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  Hours
                </Label>
                <Progress value={hoursPct * 100} className="h-1.5" />
              </div>
            </div>

            {isCurrent && suggestedHabits.length > 0 && (
              <div className="mt-4 space-y-2">
                <Label className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  Suggested habits for this phase
                </Label>
                {suggestedHabits.map((h, i) => (
                  <div
                    key={i}
                    className="flex items-start justify-between gap-3 rounded-md border border-border bg-card px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] font-medium">{h.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {Math.round(h.targetSecs / 60)} min · {h.frequency} ·{" "}
                        {h.rationale}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onAdoptHabit(h)}
                    >
                      Adopt
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex justify-end">
              {milestone.status === "completed" && milestone.completedAt ? (
                <Button size="sm" variant="ghost" onClick={onReopen}>
                  Reopen milestone
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={onMarkComplete}>
                  Mark complete
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

function CoachBubble({ turn }: { turn: CoachTurn }) {
  if (turn.role === "user") {
    return (
      <div className="ml-8 rounded-lg bg-muted px-3 py-2 text-[13px]">
        {turn.text}
      </div>
    );
  }
  return (
    <div className="mr-8 space-y-2 rounded-lg border border-border bg-card px-3 py-2 text-[13px]">
      <p className="leading-relaxed">{turn.text}</p>
      {turn.actions && turn.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {turn.actions.map((a, i) => (
            <span
              key={i}
              className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {a.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function todayStats(sessions: StudySession[], vocab: VocabEntry[]) {
  const now = Math.floor(Date.now() / 1000);
  const d = new Date(now * 1000);
  d.setHours(0, 0, 0, 0);
  const start = Math.floor(d.getTime() / 1000);
  const today = sessions.filter((s) => s.startedAt >= start);
  const minutes = today.reduce((acc, s) => acc + (s.durationSecs ?? 0), 0) / 60;
  return {
    sessionsCount: today.length,
    minutesPracticed: Math.round(minutes),
    wordsReviewed: 0,
    wordsAdded: vocab.filter((v) => v.createdAt >= start).length,
  };
}

function weekStats(sessions: StudySession[]) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 7 * 86_400;
  const week = sessions.filter((s) => s.startedAt >= start);
  const minutes = week.reduce((acc, s) => acc + (s.durationSecs ?? 0), 0) / 60;
  const perKind: Record<string, number> = {};
  for (const s of week) {
    perKind[s.kind] = (perKind[s.kind] ?? 0) + (s.durationSecs ?? 0) / 60;
  }
  return {
    sessionsCount: week.length,
    minutesPracticed: Math.round(minutes),
    perKindMinutes: perKind,
  };
}

function paceLabel(j: LearningJourney): string {
  if (!j.pace) return "—";
  if (j.pace === "ahead") return "Ahead of pace";
  if (j.pace === "on") return "On pace";
  if (j.pace === "behind") return "Behind pace";
  return "—";
}

function toDateInput(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
