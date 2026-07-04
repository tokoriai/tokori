/**
 * Shared "edit session" dialog — adjust a logged session's activity
 * label, duration (minutes), and notes after the fact. Used by the
 * Activities log and the Statistics page's recent-sessions panel, so
 * both manually-logged and in-app (timer-tracked) sessions can be
 * corrected from one consistent surface. Persists via `updateSession`,
 * which re-derives `ended_at` from the new duration.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { updateSession, type StudySession } from "@/lib/db";

export function EditSessionDialog({
  session,
  onClose,
  onSaved,
}: {
  session: StudySession | null;
  onClose: () => void;
  onSaved: (updated: StudySession) => void;
}) {
  const [kind, setKind] = useState("");
  const [minutes, setMinutes] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!session) return;
    setKind(session.kind);
    setMinutes(String(Math.max(1, Math.round((session.durationSecs ?? 0) / 60))));
    setNotes(session.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  if (!session) return null;

  async function save() {
    if (!session) return;
    const n = Number(minutes);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Minutes must be a positive number.");
      return;
    }
    const duration = Math.round(n * 60);
    setSaving(true);
    try {
      await updateSession({
        id: session.id,
        kind: kind.trim() || session.kind,
        durationSecs: duration,
        notes: notes.trim() || null,
      });
      // Optimistically apply the patch — same shape the row reads.
      onSaved({
        ...session,
        kind: kind.trim() || session.kind,
        durationSecs: duration,
        endedAt:
          session.startedAt != null
            ? session.startedAt + duration
            : session.endedAt,
        notes: notes.trim() || null,
      });
      toast.success("Session updated");
      onClose();
    } catch (err) {
      toast.error("Couldn't update", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!session} onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit session</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="es-kind">Activity</Label>
            <Input
              id="es-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              placeholder="e.g. reading, tutor, podcast"
            />
            <p className="text-[11px] text-muted-foreground">
              Any short name — habits + goals match on this label.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="es-min">Minutes</Label>
            <Input
              id="es-min"
              type="number"
              min={1}
              step={1}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="es-notes">Notes (optional)</Label>
            <Textarea
              id="es-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="What did you work on?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
