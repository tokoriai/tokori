import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Headphones,
  Mic,
  Pencil,
  PenLine,
  Plus,
  Target,
  Trash2,
  Trophy,
} from "lucide-react";
import { toast } from "sonner";
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
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  completeGoal,
  createGoal,
  deleteGoal,
  listGoals,
  type Goal,
  type GoalKind,
  type GoalSkill,
  type StudySession,
  type VocabEntry,
} from "@/lib/db";
import { computeGoalProgress, defaultGoalTitle } from "@/lib/goals";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";

const SKILL_ICONS: Record<NonNullable<GoalSkill>, React.ComponentType<{ className?: string }>> = {
  reading: PenLine,
  writing: Pencil,
  speaking: Mic,
  listening: Headphones,
};

export function GoalsCard({
  vocab,
  sessions,
}: {
  vocab: VocabEntry[];
  sessions: StudySession[];
}) {
  const { active: workspace } = useWorkspace();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [showNew, setShowNew] = useState(false);

  async function refresh() {
    if (!workspace) return;
    setGoals(await listGoals(workspace.id));
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  const enriched = useMemo(
    () =>
      goals.map((g) => ({ goal: g, progress: computeGoalProgress(g, vocab, sessions) })),
    [goals, vocab, sessions],
  );

  if (!workspace) return null;

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Goals</h3>
          <p className="text-[11.5px] text-muted-foreground">
            Concrete checkpoints with optional deadlines
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowNew(true)}>
          <Plus className="size-3.5" />
          New
        </Button>
      </div>

      {enriched.length === 0 ? (
        <button
          onClick={() => setShowNew(true)}
          className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-4 py-5 text-left transition-colors hover:border-foreground/20"
        >
          <div className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Target className="size-4" />
          </div>
          <div className="flex-1">
            <p className="text-[13.5px] font-medium">Set your first goal</p>
            <p className="text-[12px] text-muted-foreground">
              e.g. "Learn 100 words by Aug 1" — track progress against an actual checkpoint.
            </p>
          </div>
          <Plus className="size-4 text-muted-foreground" />
        </button>
      ) : (
        <ul className="space-y-2">
          {enriched.map(({ goal, progress }) => (
            <GoalItem
              key={goal.id}
              goal={goal}
              progress={progress}
              onComplete={async () => {
                await completeGoal(goal.id, !goal.completedAt);
                await refresh();
              }}
              onDelete={async () => {
                await deleteGoal(goal.id);
                await refresh();
                toast(`Removed "${goal.title}"`);
              }}
            />
          ))}
        </ul>
      )}

      <NewGoalDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={async () => {
          setShowNew(false);
          await refresh();
        }}
      />
    </div>
  );
}

function GoalItem({
  goal,
  progress,
  onComplete,
  onDelete,
}: {
  goal: Goal;
  progress: ReturnType<typeof computeGoalProgress>;
  onComplete: () => void;
  onDelete: () => void;
}) {
  const SkillIcon = goal.skill ? SKILL_ICONS[goal.skill] : Target;
  const isDone = !!goal.completedAt || progress.isComplete;

  const paceColor =
    progress.pace === "behind"
      ? "text-amber-700 dark:text-amber-400"
      : progress.pace === "ahead"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-muted-foreground";

  return (
    <li
      className={cn(
        "group rounded-xl border bg-card px-3.5 py-3 transition-colors",
        isDone ? "border-emerald-500/30 opacity-80" : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <button
          onClick={onComplete}
          className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          title={isDone ? "Mark active" : "Mark done"}
        >
          {isDone ? (
            <CheckCircle2 className="size-5 text-emerald-500" />
          ) : (
            <Circle className="size-5" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px]">
            <SkillIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={cn("font-medium truncate", isDone && "line-through")}>
              {goal.title}
            </span>
            {isDone && <Trophy className="size-3.5 shrink-0 text-emerald-500" />}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11.5px]">
            <span className="font-medium tabular-nums">
              {progress.current.toLocaleString()} / {progress.target.toLocaleString()} {progress.unit}
            </span>
            {progress.daysLeft != null && !isDone && (
              <span
                className={cn(
                  "tabular-nums",
                  progress.isExpired ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {progress.isExpired
                  ? `${Math.abs(progress.daysLeft)}d overdue`
                  : progress.daysLeft <= 0
                    ? "due today"
                    : `${progress.daysLeft}d left`}
              </span>
            )}
            {progress.pace && !isDone && (
              <span className={cn("capitalize", paceColor)}>{progress.pace} pace</span>
            )}
          </div>
          <Progress
            className={cn("mt-1.5 h-1", isDone && "[&>div]:bg-emerald-500")}
            value={progress.pct * 100}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          className="opacity-0 transition-opacity group-hover:opacity-100"
          title="Delete"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

function NewGoalDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const { active: workspace } = useWorkspace();
  const [kind, setKind] = useState<GoalKind>("vocab");
  const [skill, setSkill] = useState<GoalSkill>(null);
  const [target, setTarget] = useState<string>("100");
  const [deadlineStr, setDeadlineStr] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setKind("vocab");
      setSkill(null);
      setTarget("100");
      setDeadlineStr("");
      setTitle("");
    }
  }, [open]);

  const targetNum = Number(target) || 0;
  const deadlineSec = useMemo(() => {
    if (!deadlineStr) return null;
    const d = new Date(deadlineStr);
    if (isNaN(d.getTime())) return null;
    d.setHours(23, 59, 59, 999);
    return Math.floor(d.getTime() / 1000);
  }, [deadlineStr]);

  async function submit() {
    if (!workspace || targetNum <= 0) return;
    setBusy(true);
    try {
      const finalTitle =
        title.trim() || defaultGoalTitle(kind, skill, targetNum, deadlineSec);
      await createGoal({
        workspaceId: workspace.id,
        title: finalTitle,
        kind,
        skill,
        target: targetNum,
        deadline: deadlineSec,
      });
      toast.success("Goal created", { description: finalTitle });
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New goal</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
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
            <div className="grid gap-2">
              <Label>Linked skill {kind === "vocab" && "(N/A)"}</Label>
              <Select
                value={skill ?? "__any__"}
                onValueChange={(v) => setSkill(v === "__any__" ? null : (v as GoalSkill))}
                disabled={kind === "vocab"}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Any skill</SelectItem>
                  <SelectItem value="reading">Reading</SelectItem>
                  <SelectItem value="writing">Writing</SelectItem>
                  <SelectItem value="speaking">Speaking</SelectItem>
                  <SelectItem value="listening">Listening</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Target</Label>
              <div className="flex items-center gap-2">
                <Input
                  inputMode="numeric"
                  value={target}
                  onChange={(e) => setTarget(e.target.value.replace(/[^0-9]/g, ""))}
                  className="font-mono"
                />
                <span className="text-[12.5px] text-muted-foreground">
                  {kind === "vocab" ? "words" : kind === "minutes" ? "min" : "sessions"}
                </span>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Deadline (optional)</Label>
              <Input
                type="date"
                value={deadlineStr}
                onChange={(e) => setDeadlineStr(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Title (optional)</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={defaultGoalTitle(kind, skill, targetNum, deadlineSec)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || targetNum <= 0}>
            <Target className="size-3.5" />
            Create goal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
