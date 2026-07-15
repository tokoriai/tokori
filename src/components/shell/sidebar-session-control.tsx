/**
 * Session control embedded in the sidebar bottom (between the
 * recents list and the profile row). Replaces the older floating
 * `SessionTimer` chip per user preference.
 *
 * Reads + writes go through the same `SessionContext` the rest of
 * the app uses — `ensureStarted` / `pause` / `resume` / `end` — so
 * the row written to `study_sessions` flows into dashboard hours,
 * the journey, goals, and habits exactly like any other session.
 *
 * Three states:
 *   - Idle:    "Start session" → kind picker (built-ins + custom).
 *   - Running: elapsed clock + Pause + ⋯ menu (switch / end / discard).
 *   - Paused:  frozen elapsed + Resume + Stop.
 *
 * Custom kinds (free-text) are stored verbatim in `session.kind`,
 * so habits and goals match on them by string equality. Pause
 * suspends the auto-idle timer — a paused session won't silently
 * end after 5 minutes.
 *
 * On End, a toast shows the user what they logged + which milestone
 * it counts toward (or "free-form" if no journey target is set).
 * Saves them having to switch to the dashboard to see the impact.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Clock,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Square,
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
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useExternalLiveSession } from "@/lib/external-session";
import { useSession, type SessionKind } from "@/lib/session-context";
import { useWorkspace } from "@/lib/workspace-context";
import { useProfile } from "@/lib/profile-context";
import {
  deleteSession,
  listSessions,
  listVocab,
  listWorkspaceReviews,
} from "@/lib/db";
import { useJourneySettings } from "@/lib/use-journey-settings";
import { computeLearningJourney } from "@/lib/learning-journey";
import { scaleFor } from "@/lib/level";
import { cn } from "@/lib/utils";

/** Emerald live-pulse marking the Companion-mirrored session. */
function PulseDot() {
  return (
    <span className="relative flex size-2 shrink-0">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
    </span>
  );
}

const KIND_OPTIONS: { kind: SessionKind; label: string; glyph: string }[] = [
  { kind: "review", label: "Review", glyph: "🔁" },
  { kind: "reading", label: "Reading", glyph: "📖" },
  { kind: "listening", label: "Listening", glyph: "🎧" },
  { kind: "chat", label: "Tutor chat", glyph: "💬" },
  { kind: "writing", label: "Writing", glyph: "✍" },
  { kind: "speaking", label: "Speaking", glyph: "🎙" },
];

export function SidebarSessionControl({ collapsed }: { collapsed: boolean }) {
  const { active: workspace } = useWorkspace();
  const { profile } = useProfile();
  const {
    active: session,
    paused,
    activeSecs,
    ensureStarted,
    pause,
    resume,
    end,
    discard,
  } = useSession();
  const { settings: jSettings } = useJourneySettings(workspace?.id ?? 0);
  // Companion-extension immersion sessions, mirrored via the local
  // api_server's tokori:live-session events. Display-only — the
  // extension owns start/stop; a locally started session outranks it.
  const external = useExternalLiveSession();

  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  /** Session queued for the discard confirm dialog. Snapshotted (id +
   *  kind) rather than read live so the dialog still knows what to
   *  delete if the session idle-ends while the confirm sits open. */
  const [pendingDiscard, setPendingDiscard] = useState<{
    id: number;
    kind: string;
  } | null>(null);
  /** When true, the picker swaps the chip grid for an inline text
   *  input so the user can type a custom kind name. Reset on close
   *  so the next open lands on the grid by default. */
  const [customMode, setCustomMode] = useState(false);
  const [customDraft, setCustomDraft] = useState("");

  // Resolve the scale once per profile/workspace change so the
  // end-of-session journey snapshot uses the right ladder.
  const scale = useMemo(() => {
    if (!workspace) return "cefr" as const;
    if (profile.levelScale === "auto") return scaleFor(workspace.targetLang);
    if (profile.levelScale === "custom") return "custom" as const;
    return profile.levelScale;
  }, [profile.levelScale, workspace?.targetLang]);

  // Reset the picker's custom-mode draft when the popover closes.
  useEffect(() => {
    if (!picker) {
      setCustomMode(false);
      setCustomDraft("");
    }
  }, [picker]);

  if (!workspace) return null;

  async function startCustom() {
    const trimmed = customDraft.trim().toLowerCase();
    if (!trimmed) return;
    await ensureStarted(trimmed);
    setPicker(false);
    setCustomMode(false);
    setCustomDraft("");
  }

  /** End the active session + show a toast summary referencing the
   *  journey's next milestone so the user immediately sees the
   *  contribution. Falls back to a plain "X min logged" if no
   *  journey target is set or the snapshot fetch fails. */
  async function endWithSummary() {
    if (!session) {
      setMenu(false);
      return;
    }
    // Snapshot before end so we have the kind + active seconds for
    // the toast — `session` becomes null right after.
    const kind = session.kind;
    const minutes = Math.max(1, Math.round(activeSecs / 60));
    setMenu(false);
    await end();

    // Best-effort journey lookup so the toast can reference the
    // milestone the contribution counts toward. If the snapshot
    // fetch fails (network blip / HOSTED no-token) we still toast
    // the duration, just without milestone framing.
    let nextMilestone: string | null = null;
    try {
      if (workspace && jSettings.targetLevelId) {
        const [vocab, sessions, reviews] = await Promise.all([
          listVocab(workspace.id),
          listSessions(workspace.id),
          listWorkspaceReviews(workspace.id),
        ]);
        const j = computeLearningJourney({
          workspace,
          vocab,
          reviews,
          sessions,
          scale,
          targetLevelId: jSettings.targetLevelId,
          deadline: jSettings.deadline,
          weeklyMinutesTarget: jSettings.weeklyMinutesTarget,
          manualOverrides: jSettings.manualOverrides,
        });
        const target = j.milestones.find(
          (m) => m.status === "in-progress" || m.status === "locked",
        );
        nextMilestone = target?.label ?? null;
      }
    } catch {
      /* journey snapshot failed — toast falls back below */
    }
    toast.success(`+${minutes} min · ${kindLabel(kind)}`, {
      description: nextMilestone
        ? `Counts toward ${nextMilestone}.`
        : "Set a target level in Journey to see milestone progress.",
    });
  }

  /** Confirmed discard — delete the timed row instead of logging it.
   *  If the session idle-ended while the confirm dialog sat open, the
   *  row still exists (now closed), so delete it by the snapshotted id
   *  anyway: the user's "don't count this" intent wins either way. */
  async function discardConfirmed() {
    const target = pendingDiscard;
    setPendingDiscard(null);
    if (!target) return;
    try {
      if (session?.id === target.id) await discard();
      else await deleteSession(target.id);
      toast("Session discarded", {
        description: `${kindLabel(target.kind)} time won't be counted.`,
      });
    } catch (err) {
      toast.error("Couldn't discard session", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Rendered in both the collapsed and expanded branches — AlertDialog
  // portals to the body, so its placement in the tree doesn't matter.
  const discardDialog = (
    <AlertDialog
      open={pendingDiscard != null}
      onOpenChange={(open) => {
        if (!open) setPendingDiscard(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard this session?</AlertDialogTitle>
          <AlertDialogDescription>
            Throws away the{" "}
            {pendingDiscard && session?.id === pendingDiscard.id
              ? `${formatElapsed(activeSecs)} of ${kindLabel(pendingDiscard.kind)}`
              : pendingDiscard
                ? kindLabel(pendingDiscard.kind)
                : "session"}{" "}
            you've been timing — nothing is logged to your stats.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep session</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => void discardConfirmed()}
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // ── Collapsed sidebar — icon-only entry that opens the popover ──
  if (collapsed) {
    if (!session && external) {
      return (
        <div className="flex justify-center px-2 py-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                aria-label="Immersion session running via the Companion extension"
                className="flex size-8 items-center justify-center rounded-md bg-emerald-500/15"
              >
                <PulseDot />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              Immersing · {formatElapsed(external.secs)} — tracked by the
              Companion extension
            </TooltipContent>
          </Tooltip>
        </div>
      );
    }
    const Icon = session ? (paused ? Pause : Play) : Clock;
    return (
      <div className="flex justify-center px-2 py-1">
        <Popover
          open={session ? menu : picker}
          onOpenChange={session ? setMenu : setPicker}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={session ? "Session options" : "Start session"}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md transition-colors",
                    session
                      ? paused
                        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                        : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {session
                ? `${kindLabel(session.kind)} · ${formatElapsed(activeSecs)}${paused ? " · paused" : ""}`
                : "Start session"}
            </TooltipContent>
          </Tooltip>
          <PopoverContent side="right" align="end" className="w-[260px] p-1.5">
            {session ? (
              <ActiveMenu
                session={session}
                paused={paused}
                onPause={pause}
                onResume={resume}
                onSwitch={async (kind) => {
                  await end();
                  await ensureStarted(kind);
                  setMenu(false);
                }}
                onEnd={endWithSummary}
                onDiscard={() => {
                  setMenu(false);
                  setPendingDiscard({ id: session.id, kind: session.kind });
                }}
              />
            ) : (
              <IdlePicker
                customMode={customMode}
                customDraft={customDraft}
                setCustomMode={setCustomMode}
                setCustomDraft={setCustomDraft}
                onStartCustom={() => void startCustom()}
                onPick={async (kind) => {
                  await ensureStarted(kind);
                  setPicker(false);
                }}
              />
            )}
          </PopoverContent>
        </Popover>
        {discardDialog}
      </div>
    );
  }

  // ── Expanded sidebar — full row ──────────────────────────────
  return (
    <div className="px-3 py-2">
      {session ? (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5",
            paused ? "bg-amber-500/5" : "bg-emerald-500/5",
          )}
        >
          <span className="text-[14px] leading-none">
            {KIND_OPTIONS.find((k) => k.kind === session.kind)?.glyph ?? "⏱"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[12.5px] tabular-nums leading-none text-foreground">
              {formatElapsed(activeSecs)}
            </div>
            <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
              {kindLabel(session.kind)}
              {paused && " · paused"}
            </div>
          </div>
          {/* Inline pause/resume toggle — most-common action is one
              click instead of buried in the ⋯ menu. */}
          {paused ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-7 w-7 shrink-0 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
              onClick={resume}
              title="Resume"
            >
              <Play className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-7 w-7 shrink-0 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
              onClick={pause}
              title="Pause"
            >
              <Pause className="size-3.5" />
            </Button>
          )}
          <Popover open={menu} onOpenChange={setMenu}>
            <PopoverTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                title="Session options"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="top"
              className="w-[260px] p-1.5"
            >
              <ActiveMenu
                session={session}
                paused={paused}
                onPause={pause}
                onResume={resume}
                onSwitch={async (kind) => {
                  await end();
                  await ensureStarted(kind);
                  setMenu(false);
                }}
                onEnd={endWithSummary}
                onDiscard={() => {
                  setMenu(false);
                  setPendingDiscard({ id: session.id, kind: session.kind });
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
      ) : external ? (
        // Companion-driven immersion — mirrored, not controlled: the
        // extension's beats drive the clock; stopping happens at the
        // ⏱ pill in the browser.
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-emerald-500/5 px-2.5 py-1.5"
          title="Live from the Companion extension — the timer follows your watching. Start/stop it from the ⏱ pill on YouTube."
        >
          <PulseDot />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[12.5px] tabular-nums leading-none text-foreground">
              {formatElapsed(external.secs)}
            </div>
            <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
              Immersing · Companion
            </div>
          </div>
          <span className="text-[14px] leading-none" aria-hidden>
            {external.kind === "podcast" ? "🎧" : "📺"}
          </span>
        </div>
      ) : (
        <Popover open={picker} onOpenChange={setPicker}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md border border-dashed border-border bg-transparent px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <Clock className="size-3.5" />
              Start session
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" side="top" className="w-[260px] p-1.5">
            <IdlePicker
              customMode={customMode}
              customDraft={customDraft}
              setCustomMode={setCustomMode}
              setCustomDraft={setCustomDraft}
              onStartCustom={() => void startCustom()}
              onPick={async (kind) => {
                await ensureStarted(kind);
                setPicker(false);
              }}
            />
          </PopoverContent>
        </Popover>
      )}
      {discardDialog}
    </div>
  );
}

function IdlePicker({
  customMode,
  customDraft,
  setCustomMode,
  setCustomDraft,
  onPick,
  onStartCustom,
}: {
  customMode: boolean;
  customDraft: string;
  setCustomMode: (v: boolean) => void;
  setCustomDraft: (v: string) => void;
  onPick: (kind: SessionKind) => void | Promise<void>;
  onStartCustom: () => void | Promise<void>;
}) {
  if (customMode) {
    return (
      <div className="space-y-2 px-1 py-1">
        <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Custom activity
        </p>
        <Input
          autoFocus
          value={customDraft}
          onChange={(e) => setCustomDraft(e.target.value)}
          placeholder="e.g. shadowing, anki, class"
          className="h-8 text-[13px]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && customDraft.trim()) {
              e.preventDefault();
              void onStartCustom();
            } else if (e.key === "Escape") {
              setCustomMode(false);
            }
          }}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11.5px]"
            onClick={() => setCustomMode(false)}
          >
            Back
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-[11.5px]"
            onClick={() => void onStartCustom()}
            disabled={!customDraft.trim()}
          >
            <Play className="size-3" />
            Start
          </Button>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="px-2 py-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        Pick an activity
      </div>
      {KIND_OPTIONS.map((opt) => (
        <button
          key={opt.kind}
          type="button"
          onClick={() => void onPick(opt.kind)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-accent/60"
        >
          <span className="text-[14px]">{opt.glyph}</span>
          {opt.label}
          <Play className="ml-auto size-3 text-muted-foreground" />
        </button>
      ))}
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        onClick={() => setCustomMode(true)}
        className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-left text-[12.5px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      >
        <Plus className="size-3.5" />
        Custom activity…
      </button>
    </>
  );
}

function ActiveMenu({
  session,
  paused,
  onPause,
  onResume,
  onSwitch,
  onEnd,
  onDiscard,
}: {
  session: { kind: string };
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  onSwitch: (kind: SessionKind) => void | Promise<void>;
  onEnd: () => void | Promise<void>;
  onDiscard: () => void;
}) {
  return (
    <>
      {/* Pause/Resume + Stop as the first row — most-used actions on
          top so power users don't have to scan past the switch list. */}
      <div className="flex gap-1 px-1 pb-1.5 pt-1">
        {paused ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 flex-1 text-[11.5px]"
            onClick={onResume}
          >
            <Play className="size-3" />
            Resume
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 flex-1 text-[11.5px]"
            onClick={onPause}
          >
            <Pause className="size-3" />
            Pause
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-1 text-[11.5px] text-destructive hover:bg-destructive/10"
          onClick={() => void onEnd()}
        >
          <Square className="size-3" />
          End
        </Button>
      </div>
      <div className="my-1 h-px bg-border" />
      <div className="px-2 py-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        Switch kind
      </div>
      {KIND_OPTIONS.filter((opt) => opt.kind !== session.kind).map((opt) => (
        <button
          key={opt.kind}
          type="button"
          onClick={() => void onSwitch(opt.kind)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-accent/60"
        >
          <span className="text-[14px]">{opt.glyph}</span>
          {opt.label}
        </button>
      ))}
      <div className="my-1 h-px bg-border" />
      {/* Destructive action last, per menu convention — End (above)
          saves the time, Discard throws it away after a confirm. */}
      <button
        type="button"
        onClick={onDiscard}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="size-3.5" />
        Discard session
      </button>
    </>
  );
}

function formatElapsed(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function kindLabel(kind: string): string {
  const built = KIND_OPTIONS.find((k) => k.kind === kind);
  return built?.label ?? kind;
}
