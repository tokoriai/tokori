/**
 * Recent sessions — the editable session log on Progress → Statistics.
 *
 * Lists every finished session (in-app timer sessions AND manually
 * logged activities, newest first) so a mis-timed entry can be fixed
 * after the fact: click a row → the shared EditSessionDialog (activity
 * / minutes / notes), hover → delete. The parent refetches on change so
 * the Today card, weekly report, and charts pick the correction up
 * immediately.
 */

import { useMemo, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
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
import { EditSessionDialog } from "@/components/session-edit-dialog";
import { deleteSession, type StudySession } from "@/lib/db";
import { fmtMins } from "@/lib/stats-report";
import { cn } from "@/lib/utils";

const PANEL = "rounded-2xl border border-border bg-card px-5 py-4";

const COLLAPSED_COUNT = 8;
const MAX_COUNT = 60;

function whenLabel(s: StudySession): string {
  const d = new Date((s.endedAt ?? s.startedAt) * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function RecentSessionsCard({
  sessions,
  onChanged,
}: {
  sessions: StudySession[];
  /** Fired after an edit or delete persisted — parent refetches so
   *  every stat on the page reflects the correction. */
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<StudySession | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StudySession | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Finished sessions only — the live one is still accumulating and is
  // ended/patched by the timer itself.
  const rows = useMemo(
    () =>
      sessions
        .filter((s) => (s.durationSecs ?? 0) > 0)
        .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
        .slice(0, MAX_COUNT),
    [sessions],
  );
  const visible = showAll ? rows : rows.slice(0, COLLAPSED_COUNT);

  return (
    <div className={cn(PANEL, "flex flex-col")}>
      <div className="mb-3">
        <h3 className="text-sm font-semibold tracking-tight">Recent sessions</h3>
        <p className="text-[11.5px] text-muted-foreground">
          Click a session to adjust its time after the fact
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="py-4 text-center text-[12.5px] text-muted-foreground">
          No finished sessions yet — study a little or log an activity.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {visible.map((s) => {
            const customName = s.notes?.trim() || null;
            const kindLabel = s.kind.charAt(0).toUpperCase() + s.kind.slice(1);
            return (
              <li
                key={s.id}
                className="group/row flex items-center gap-2 rounded-lg border border-border/60 transition-colors hover:bg-accent/30"
              >
                <button
                  type="button"
                  onClick={() => setEditing(s)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-3 py-2 text-left"
                  title="Edit this session"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium">
                      {customName ?? kindLabel}
                      {customName && (
                        <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                          · {kindLabel}
                        </span>
                      )}
                    </div>
                    <p className="text-[10.5px] text-muted-foreground">
                      {whenLabel(s)}
                    </p>
                  </div>
                  <span className="shrink-0 tabular-nums text-[12px] text-muted-foreground">
                    {fmtMins(Math.round((s.durationSecs ?? 0) / 60))}
                  </span>
                  <Pencil className="size-3 shrink-0 text-muted-foreground/0 transition-colors group-hover/row:text-muted-foreground" />
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDelete(s)}
                  className="mr-2 shrink-0 cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/row:opacity-100"
                  aria-label="Delete session"
                  title="Delete session"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length > COLLAPSED_COUNT && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 cursor-pointer text-center text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {showAll
            ? "Show fewer"
            : `Show all ${rows.length}${rows.length === MAX_COUNT ? "+" : ""}`}
        </button>
      )}

      <EditSessionDialog
        session={editing}
        onClose={() => setEditing(null)}
        onSaved={() => onChanged()}
      />

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this session?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes{" "}
              {pendingDelete
                ? `the ${fmtMins(Math.round((pendingDelete.durationSecs ?? 0) / 60))} "${
                    pendingDelete.notes?.trim() || pendingDelete.kind
                  }" session`
                : "the session"}{" "}
              from your history. Study-time totals and the heatmap update
              immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = pendingDelete;
                if (!target) return;
                void deleteSession(target.id)
                  .then(() => {
                    toast("Session removed");
                    onChanged();
                  })
                  .catch((err) => {
                    toast.error("Couldn't delete", {
                      description:
                        err instanceof Error ? err.message : String(err),
                    });
                  });
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
