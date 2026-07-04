/**
 * Shared chrome for plugin "prestart" screens — the gated picker that
 * appears before a session loads. Mirrors the shape of the sentence-card
 * setup so every flashcard mode opens with the same beat: pick options,
 * decide whether SRS is touched, hit start.
 *
 * Plugins compose their own option panels inside `children`; the shell
 * owns the header, the drill-mode toggle, and (optionally) the final
 * action row. A plugin whose own UX makes the start button implicit
 * (e.g. sentence-cards picks a source by clicking a card) can skip
 * `onStart` and just render its own affordances in `children`.
 */

import type { ComponentType, ReactNode } from "react";
import { CheckCircle2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PrestartShellProps = {
  /** Plugin icon — same one shown in the picker. */
  icon: ComponentType<{ className?: string }>;
  pluginName: string;
  title: string;
  description?: string;
  drillMode: boolean;
  setDrillMode: (next: boolean) => void;
  /** "Has today's SRS pass for this workspace already happened?" When
   *  `"alreadyAnchored"`, a calm banner appears above the drill toggle
   *  explaining why drill is pre-flipped on. `"unknown"` and `"free"`
   *  render no banner. */
  srsAnchorState?: "unknown" | "free" | "alreadyAnchored";
  children?: ReactNode;
  /** Optional final action button. When omitted, plugins are expected
   *  to provide their own start affordance inside `children`. */
  onStart?: () => void;
  startLabel?: string;
  startDisabled?: boolean;
  startHint?: string;
};

export function PrestartShell({
  icon: Icon,
  pluginName,
  title,
  description,
  drillMode,
  setDrillMode,
  srsAnchorState = "unknown",
  children,
  onStart,
  startLabel = "Start session",
  startDisabled,
  startHint,
}: PrestartShellProps) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-2xl space-y-5">
        <div className="text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Icon className="size-3.5" />
            {pluginName}
          </div>
          <h2 className="mt-3 font-serif text-3xl tracking-tight">{title}</h2>
          {description && (
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>

        {srsAnchorState === "alreadyAnchored" && (
          <AnchorBanner drillOn={drillMode} />
        )}

        <DrillToggle on={drillMode} onChange={setDrillMode} />

        {children}

        {onStart && (
          <div className="flex flex-col items-end gap-1">
            <Button size="lg" onClick={onStart} disabled={startDisabled}>
              {startLabel}
            </Button>
            {startHint && (
              <p className="text-[11px] text-muted-foreground">{startHint}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Calm banner that appears when today's SRS pass has already happened
 * for this workspace. Pairs with `drillMode` being pre-flipped on at
 * the host level. Tone is informational, not warning — the user has
 * done a good thing (studied today) and is being told the practice
 * they're about to do is "extra reps" rather than "broken SRS".
 *
 * `drillOn` flips the copy between "drill is on, your schedule won't
 * move" and "drill is off — you've already studied today, but if you
 * really want to grade again, go ahead." The latter happens when the
 * user manually flipped drill off mid-session.
 */
function AnchorBanner({ drillOn }: { drillOn: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-emerald-900 dark:text-emerald-100">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">
          Today&apos;s SRS pass is logged for this workspace.
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-emerald-900/80 dark:text-emerald-100/75">
          {drillOn
            ? "Drill mode is on — practising again won't move your schedule. Flip it off below if you really want this session to re-grade."
            : "Drill is off. Grades you assign now WILL move your schedule again — only flip drill on if that's what you want."}
        </p>
      </div>
    </div>
  );
}

/**
 * Pill toggle for the "drill without SRS" mode. Renders prominently at
 * the top of every prestart so the user makes a deliberate choice
 * before grades start flowing. Off by default — drilling is the
 * deliberate opt-in, not the other way around.
 */
export function DrillToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn(
        "flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-all",
        on
          ? "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15"
          : "border-border bg-card hover:border-foreground/30",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
          on
            ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
            : "bg-foreground/5 text-foreground/70",
        )}
      >
        <Zap className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13.5px] font-medium">Drill without SRS</span>
          <SwitchTrack on={on} />
        </div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
          {on
            ? "On — grades stay in-session. Your FSRS schedule isn't touched."
            : "Off — grades drive spaced repetition as usual."}
        </p>
      </div>
    </button>
  );
}

/**
 * Generic prestart switch — same shape as {@link DrillToggle} but with a
 * caller-supplied icon, title, and copy, in a calm sky accent (distinct
 * from drill's amber "this touches your SRS" warning). For benign
 * per-session flow options a plugin wants to surface on its prestart.
 */
export function PrestartToggle({
  on,
  onChange,
  icon: Icon,
  title,
  descriptionOn,
  descriptionOff,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  icon: ComponentType<{ className?: string }>;
  title: string;
  descriptionOn: string;
  descriptionOff: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn(
        "flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-all",
        on
          ? "border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/15"
          : "border-border bg-card hover:border-foreground/30",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
          on
            ? "bg-sky-500/20 text-sky-700 dark:text-sky-300"
            : "bg-foreground/5 text-foreground/70",
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13.5px] font-medium">{title}</span>
          <SwitchTrack on={on} accent="sky" />
        </div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
          {on ? descriptionOn : descriptionOff}
        </p>
      </div>
    </button>
  );
}

function SwitchTrack({
  on,
  accent = "amber",
}: {
  on: boolean;
  accent?: "amber" | "sky";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        on
          ? accent === "sky"
            ? "bg-sky-500"
            : "bg-amber-500"
          : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 transform rounded-full bg-background shadow transition-transform",
          on ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </span>
  );
}
