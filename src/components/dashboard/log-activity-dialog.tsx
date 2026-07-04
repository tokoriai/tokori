/**
 * Log Activity dialog.
 *
 * Captures a real-world language-learning activity (tutor session, class,
 * immersion, podcast, etc.) and writes it as a one-shot session row via
 * `logSession`. Sessions written here count toward the same SkillsRadar /
 * StatsStrip / heatmap / streak as in-app sessions — users get credit for
 * time they spent practising outside the app.
 *
 * The picker exposes a small set of presets, each pre-mapped to a skill
 * bucket via `SKILL_BUCKETS` (see charts.tsx). Every entry — preset or
 * Other — accepts an optional name so a generic "Tutor" log can become
 * "Tutor · Yuki" in the recent list. For "Other" the name is required
 * and the user also picks the skill bucket themselves; we store the
 * bucket as `kind` and the name in `notes`.
 */

import { useEffect, useState } from "react";
import {
  BookOpen,
  Briefcase,
  GraduationCap,
  Headphones,
  Loader2,
  MessageCircle,
  Mic,
  Plus,
  Trash2,
  Tv2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  deleteSession,
  listManualSessions,
  logSession,
  type StudySession,
} from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";

type Preset = {
  /** What we write to `study_sessions.kind`. The SKILL_BUCKETS map in
   *  charts.tsx routes this to the correct radar axis. */
  kind: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
};

const PRESETS: Preset[] = [
  {
    kind: "tutor",
    label: "Tutor",
    description: "1-on-1 tutoring session",
    icon: UserRound,
  },
  {
    kind: "class",
    label: "Class",
    description: "Group class or course",
    icon: GraduationCap,
  },
  {
    kind: "conversation",
    label: "Conversation",
    description: "Chat partner / language exchange",
    icon: MessageCircle,
  },
  {
    kind: "immersion",
    label: "Immersion",
    description: "Travel, daily-life conversation",
    icon: Briefcase,
  },
  {
    kind: "podcast",
    label: "Podcast",
    description: "Listening practice",
    icon: Mic,
  },
  {
    kind: "video",
    label: "Video / TV",
    description: "Films, shows, videos",
    icon: Tv2,
  },
  {
    kind: "book",
    label: "Reading",
    description: "Books, articles, manga",
    icon: BookOpen,
  },
];

const OTHER_KIND_KEY = "__other__";

const SKILL_OPTIONS: { value: string; label: string }[] = [
  { value: "speaking", label: "Speaking" },
  { value: "listening", label: "Listening" },
  { value: "reading", label: "Reading" },
  { value: "writing", label: "Writing" },
  { value: "review", label: "Review" },
];

function todayLocalISO(): string {
  // YYYY-MM-DD in the user's local timezone for the date input.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function LogActivityDialog({
  open,
  onClose,
  onLogged,
}: {
  open: boolean;
  onClose: () => void;
  onLogged: () => void | Promise<void>;
}) {
  const { active: workspace } = useWorkspace();
  const [pickedKey, setPickedKey] = useState<string>("tutor");
  // Optional label for any preset, required for "Other". Lets a generic
  // "Tutor" log become "Tutor · Yuki" or a "Class" log become "Mandarin
  // 101" in the recent list.
  const [customName, setCustomName] = useState("");
  const [otherSkill, setOtherSkill] = useState<string>("speaking");
  const [minutes, setMinutes] = useState<string>("60");
  const [date, setDate] = useState<string>(todayLocalISO());
  const [busy, setBusy] = useState(false);
  // Recent activity log — everything the user has logged via this dialog.
  // Reloaded each open so it reflects external edits (e.g. logged from
  // another device once cloud sync ships, or via direct DB poke).
  const [recent, setRecent] = useState<StudySession[]>([]);

  async function refreshRecent() {
    if (!workspace) return;
    try {
      const rows = await listManualSessions(workspace.id, 25);
      setRecent(rows);
    } catch {
      setRecent([]);
    }
  }

  // Reset on each open so the dialog feels fresh — last-used kind would
  // be a tiny QoL win but starting at "Tutor" is the most common case.
  useEffect(() => {
    if (!open) return;
    setPickedKey("tutor");
    setCustomName("");
    setOtherSkill("speaking");
    setMinutes("60");
    setDate(todayLocalISO());
    void refreshRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspace?.id]);

  const isOther = pickedKey === OTHER_KIND_KEY;
  const minutesNum = Number(minutes);
  const validMinutes = Number.isFinite(minutesNum) && minutesNum > 0;
  // Other requires a name so the radar has something better than the
  // bare skill bucket to display. Presets fall back to their built-in
  // label, so the name there is purely optional.
  const validName = !isOther || customName.trim().length > 0;

  async function save() {
    if (!workspace) return;
    if (!validMinutes || !validName) return;
    setBusy(true);
    try {
      // For Other we use the picked skill bucket as the kind so the
      // radar groups it correctly. For preset entries the kind is the
      // preset itself. The optional name (customName) goes into notes
      // for both, so the recent list and history can show it.
      // We always write notes as a string (never null) so the
      // listManualSessions filter `notes IS NOT NULL` matches preset
      // entries with no name too.
      const kind = isOther ? otherSkill : pickedKey;
      const notes = customName.trim();
      // Date input gives us a local YYYY-MM-DD; build a Date at noon
      // local time so we land squarely inside the day regardless of
      // DST jumps. The session ends at this time and starts duration
      // seconds before — see logSession.
      const localEnd = new Date(`${date}T12:00:00`);
      const whenSec = Math.floor(localEnd.getTime() / 1000);
      const durationSecs = Math.round(minutesNum * 60);
      await logSession({
        workspaceId: workspace.id,
        kind,
        durationSecs,
        when: whenSec,
        notes,
      });
      const presetLabel =
        PRESETS.find((p) => p.kind === pickedKey)?.label || kind;
      const label = notes
        ? `${isOther ? notes : `${presetLabel} · ${notes}`}`
        : presetLabel;
      toast.success(`Logged ${minutesNum}m of ${label}`);
      await onLogged();
      // Refresh in-place rather than closing the dialog — the user can
      // see their entry land in the Recent list and log another in the
      // same flow.
      await refreshRecent();
      // Reset just the duration / date / name back to defaults so the
      // next log doesn't carry forward the previous one's specifics.
      setMinutes("60");
      setCustomName("");
    } finally {
      setBusy(false);
    }
  }

  async function removeEntry(s: StudySession) {
    await deleteSession(s.id);
    setRecent((prev) => prev.filter((r) => r.id !== s.id));
    // Tell the host so the radar / heatmap reflect the removal.
    await onLogged();
  }

  if (!workspace) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Log an activity</DialogTitle>
          <DialogDescription>
            Record time spent practising outside the app. Counts toward
            your skill balance, immersion hours, and streak.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Preset chips. Two-column on desktop, full-width on mobile so
              wide labels like "Conversation" don't truncate. */}
          <div className="grid gap-2">
            <Label>Activity</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {PRESETS.map((p) => {
                const Icon = p.icon;
                const active = pickedKey === p.kind;
                return (
                  <button
                    key={p.kind}
                    type="button"
                    onClick={() => setPickedKey(p.kind)}
                    className={cn(
                      "flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-foreground/40 bg-accent text-foreground"
                        : "border-border bg-card text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium">{p.label}</div>
                      <div className="truncate text-[10.5px] opacity-80">
                        {p.description}
                      </div>
                    </div>
                  </button>
                );
              })}
              {/* Other — opens the custom-name + custom-skill inputs below. */}
              <button
                type="button"
                onClick={() => setPickedKey(OTHER_KIND_KEY)}
                className={cn(
                  "flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors col-span-2",
                  isOther
                    ? "border-foreground/40 bg-accent text-foreground"
                    : "border-dashed border-border bg-card text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                )}
              >
                <Plus className="size-4 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium">Other</div>
                  <div className="text-[10.5px] opacity-80">
                    Custom activity — name it and pick a skill bucket
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Name — optional for presets, required for Other. Lets you
              tag an entry with a specific label ("Tutor · Yuki",
              "Class · Mandarin 101") that surfaces in the recent log. */}
          <div
            className={cn(
              "grid gap-3",
              isOther && "sm:grid-cols-2",
            )}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="activity-name">
                Name {isOther ? "" : <span className="text-muted-foreground">(optional)</span>}
              </Label>
              <Input
                id="activity-name"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={
                  isOther
                    ? "e.g. Tandem with Yuki"
                    : "e.g. Yuki, Mandarin 101 — optional"
                }
              />
            </div>
            {isOther && (
              <div className="grid gap-1.5">
                <Label htmlFor="other-skill">Counts as</Label>
                <Select
                  value={otherSkill}
                  onValueChange={setOtherSkill}
                >
                  <SelectTrigger id="other-skill">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SKILL_OPTIONS.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="duration">Duration (minutes)</Label>
              <Input
                id="duration"
                type="number"
                min="1"
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="date">Date</Label>
              <Input
                id="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          </div>

          {!validMinutes && (
            <p className="text-[11px] text-destructive">
              Enter a positive number of minutes.
            </p>
          )}
        </div>

        {/* Recent activities log — everything the user has logged here.
            Compact list with delete-on-hover. Capped at 25 entries; if
            we ever need pagination this is where the "view all" link
            would go. The empty state nudges the user to log their
            first activity rather than feeling like a broken empty box. */}
        <div className="border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              Recent
            </p>
            {recent.length > 0 && (
              <p className="text-[10.5px] text-muted-foreground">
                {recent.length} entr{recent.length === 1 ? "y" : "ies"}
              </p>
            )}
          </div>
          {recent.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-3 text-center text-[12px] text-muted-foreground">
              Nothing logged yet — your activities will show up here.
            </p>
          ) : (
            <ScrollArea className="max-h-[200px] rounded-md border border-border">
              <ul className="divide-y divide-border">
                {recent.map((s) => (
                  <RecentRow
                    key={s.id}
                    session={s}
                    onDelete={() => void removeEntry(s)}
                  />
                ))}
              </ul>
            </ScrollArea>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            onClick={save}
            disabled={busy || !validMinutes || !validName}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Headphones className="size-3.5" />}
            Log {validMinutes ? `${minutesNum}m` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Recent activity row ─────────────────────────────────────────────────
//
// One row in the Recent log. Left side shows the kind label + optional
// custom name (Other entries) + a relative date. Right side shows the
// duration and a delete-on-hover trash icon. Compact on purpose — the
// dialog has limited vertical space and we'd rather show 8 entries than
// 4 prettier ones.

function RecentRow({
  session,
  onDelete,
}: {
  session: StudySession;
  onDelete: () => void;
}) {
  // Resolve a friendly label for the kind. PRESET kinds have their own
  // label; "Other" entries store the picked skill bucket as kind, so
  // fall back to titlecasing the kind itself.
  const preset = PRESETS.find((p) => p.kind === session.kind);
  const Icon = preset?.icon ?? Headphones;
  const kindLabel =
    preset?.label ??
    session.kind.charAt(0).toUpperCase() + session.kind.slice(1);
  const customName = session.notes?.trim() || null;
  const duration = session.durationSecs ?? 0;
  const minutes = Math.max(1, Math.round(duration / 60));
  const when = session.endedAt ?? session.startedAt;
  const dateLabel = formatRelativeDate(when);

  return (
    <li className="group/row flex items-center gap-2.5 px-3 py-1.5 text-[12.5px] hover:bg-accent/40">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 truncate">
          <span className="font-medium">
            {customName ?? kindLabel}
          </span>
          {customName && (
            <span className="text-[10.5px] text-muted-foreground">
              · {kindLabel}
            </span>
          )}
        </div>
        <p className="text-[10.5px] text-muted-foreground">{dateLabel}</p>
      </div>
      <span className="shrink-0 tabular-nums text-[11.5px] text-muted-foreground">
        {minutes}m
      </span>
      <button
        type="button"
        onClick={onDelete}
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-destructive/10 hover:text-destructive"
        aria-label="Delete"
        title="Delete"
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  );
}

/** Compact relative date — "today", "yesterday", "Mon", or "Mar 12".
 *  Falls back to ISO date if the session is null/invalid. */
function formatRelativeDate(unixSec: number | null): string {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  const today = new Date();
  // Normalise both to local midnight so a session at 23:59 still
  // counts as "today" relative to a current time of 00:30.
  const dateMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const dayDiff = Math.round((todayMidnight - dateMidnight) / 86_400_000);
  if (dayDiff === 0) return "today";
  if (dayDiff === 1) return "yesterday";
  if (dayDiff > 1 && dayDiff < 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
