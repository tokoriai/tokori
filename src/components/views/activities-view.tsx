/**
 * Activities — full-page log of every manually-logged session.
 *
 * Shares its logging dialog with the dashboard quick-action button and
 * the habits view's "Log time" affordance, so an activity logged from
 * any of the three places shows up here. Sessions are grouped by day
 * with a per-day total for quick eyeballing.
 *
 * Each row is clickable → opens the edit dialog (adjust kind /
 * duration / notes). Hover reveals a delete affordance.
 */

import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Briefcase,
  GraduationCap,
  Headphones,
  Loader2,
  MessageCircle,
  Mic,
  Phone,
  Plus,
  Trash2,
  Tv2,
  UserRound,
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
import { LogActivityDialog } from "@/components/dashboard/log-activity-dialog";
import { EditSessionDialog } from "@/components/session-edit-dialog";
import {
  deleteSession,
  listManualSessions,
  type StudySession,
} from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";

// Mirror of the preset label/icon map in log-activity-dialog.tsx. Keeping
// it duplicated here (rather than exported from there) avoids a circular
// import — and the list is short enough that drift is easy to spot.
const PRESET_LABELS: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  italki: { label: "italki", icon: Phone },
  class: { label: "Class", icon: GraduationCap },
  tutor: { label: "Tutor", icon: UserRound },
  conversation: { label: "Conversation", icon: MessageCircle },
  immersion: { label: "Immersion", icon: Briefcase },
  podcast: { label: "Podcast", icon: Mic },
  video: { label: "Video / TV", icon: Tv2 },
  book: { label: "Reading", icon: BookOpen },
};

function labelFor(kind: string): { label: string; icon: React.ComponentType<{ className?: string }> } {
  const preset = PRESET_LABELS[kind];
  if (preset) return preset;
  // Fallback for "Other" entries (kind = skill bucket name) and any
  // user-defined custom kinds.
  return {
    label: kind.charAt(0).toUpperCase() + kind.slice(1),
    icon: Headphones,
  };
}

export function ActivitiesView() {
  const { active: workspace } = useWorkspace();
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<StudySession | null>(null);
  const [editing, setEditing] = useState<StudySession | null>(null);

  async function refresh() {
    if (!workspace) return;
    setLoading(true);
    try {
      // Big cap — the activities view is the "all of them" page. If a
      // user has 5k+ logged we can paginate later; for now load it all.
      const rows = await listManualSessions(workspace.id, 1000);
      setSessions(rows);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Group by local-date YYYY-MM-DD so we can render a header per day
  // with the day's total minutes. Order within a day is most-recent
  // first, which matches the listManualSessions order.
  const grouped = useMemo(() => {
    const byDay = new Map<
      string,
      { dateLabel: string; sessions: StudySession[]; totalMinutes: number }
    >();
    for (const s of sessions) {
      const ts = (s.endedAt ?? s.startedAt) * 1000;
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const slot = byDay.get(key);
      const minutes = Math.round((s.durationSecs ?? 0) / 60);
      if (slot) {
        slot.sessions.push(s);
        slot.totalMinutes += minutes;
      } else {
        byDay.set(key, {
          dateLabel: formatDayHeading(d),
          sessions: [s],
          totalMinutes: minutes,
        });
      }
    }
    return Array.from(byDay.entries()).map(([key, v]) => ({ key, ...v }));
  }, [sessions]);

  const totalMinutes = useMemo(
    () => sessions.reduce((s, x) => s + Math.round((x.durationSecs ?? 0) / 60), 0),
    [sessions],
  );

  if (!workspace) return null;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-8 pt-8 pb-5">
        <div className="mx-auto flex max-w-4xl xl:max-w-6xl items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl tracking-tight">Activities</h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              Off-app practice — tutors, classes, podcasts, books. Counts toward your
              skill balance, immersion hours, and streak.
            </p>
          </div>
          <Button onClick={() => setShowLog(true)}>
            <Plus className="size-4" />
            Log activity
          </Button>
        </div>
        {!loading && sessions.length > 0 && (
          <div className="mx-auto mt-4 flex max-w-4xl xl:max-w-6xl gap-3 text-[12px] text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">{sessions.length}</span> entr
              {sessions.length === 1 ? "y" : "ies"}
            </span>
            <span>·</span>
            <span>
              <span className="font-medium text-foreground">
                {Math.round((totalMinutes / 60) * 10) / 10}h
              </span>{" "}
              total
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-4xl xl:max-w-6xl">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
              <Headphones className="mx-auto mb-3 size-7 text-muted-foreground" />
              <h3 className="font-serif text-2xl tracking-tight">No activities logged.</h3>
              <p className="mx-auto mt-2 max-w-md text-[13.5px] text-muted-foreground">
                Track time you spent practising outside the app — tutors, classes,
                immersion, podcasts. Anything with a duration.
              </p>
              <Button onClick={() => setShowLog(true)} className="mt-5">
                <Plus className="size-4" />
                Log your first
              </Button>
            </div>
          ) : (
            <ul className="space-y-6">
              {grouped.map((day) => (
                <li key={day.key}>
                  <div className="mb-2 flex items-baseline justify-between border-b border-border/60 pb-1.5">
                    <h3 className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
                      {day.dateLabel}
                    </h3>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {day.totalMinutes} min
                    </span>
                  </div>
                  <ul className="space-y-1.5">
                    {day.sessions.map((s) => (
                      <ActivityRow
                        key={s.id}
                        session={s}
                        onEdit={() => setEditing(s)}
                        onDelete={() => setPendingDelete(s)}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <LogActivityDialog
        open={showLog}
        onClose={() => setShowLog(false)}
        onLogged={() => refresh()}
      />

      <EditSessionDialog
        session={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          setSessions((prev) =>
            prev.map((r) => (r.id === updated.id ? updated : r)),
          );
        }}
      />

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(v) => {
          if (!v) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this activity?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the entry permanently. Your skill balance,
              immersion hours, and streak will recompute without it.
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
                  await deleteSession(target.id);
                  setSessions((prev) => prev.filter((r) => r.id !== target.id));
                  toast(`Removed activity`);
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

function ActivityRow({
  session,
  onEdit,
  onDelete,
}: {
  session: StudySession;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { label, icon: Icon } = labelFor(session.kind);
  const customName = session.notes?.trim() || null;
  const minutes = Math.max(1, Math.round((session.durationSecs ?? 0) / 60));
  const time = new Date((session.endedAt ?? session.startedAt) * 1000);
  const timeLabel = time.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <li className="group/row flex items-center gap-3 rounded-lg border border-border bg-card transition-colors hover:bg-accent/30">
      <button
        type="button"
        onClick={onEdit}
        className="flex flex-1 items-center gap-3 px-4 py-2.5 text-left"
        title="Edit session"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 truncate">
            <span className="text-[13.5px] font-medium">
              {customName ?? label}
            </span>
            {customName && (
              <span className="text-[11px] text-muted-foreground">· {label}</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">{timeLabel}</p>
        </div>
        <span className="shrink-0 tabular-nums text-[12.5px] text-muted-foreground">
          {minutes} min
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="mr-2 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-destructive/10 hover:text-destructive"
        aria-label="Delete activity"
        title="Delete activity"
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  );
}

/** Friendly per-day heading: "Today", "Yesterday", weekday name within
 *  the past week, otherwise localized "Mon, Mar 12" / "Mon, Mar 12, 2025"
 *  if the year differs from now. */
function formatDayHeading(d: Date): string {
  const today = new Date();
  const dateMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const dayDiff = Math.round((todayMidnight - dateMidnight) / 86_400_000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff > 1 && dayDiff < 7) {
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}
