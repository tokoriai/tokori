// Shared top-bar action buttons + pause overlay used by every study
// plugin. Lifted out of `hanzi-writing.tsx` so the kaniwani sibling
// can reuse the same patient/destructive controls without forking
// the implementation. Keep the visual treatment in sync — the button
// classes and overlay layout are intentionally identical across
// plugins so the user's muscle memory carries across modes.

import { useEffect, useRef } from "react";
import {
  Pause,
  Play,
  RocketIcon,
  Ban,
  StopCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Active-session time accumulator. Only ticks while the tab is
 *  visible AND `paused === false` — backgrounded tabs, the OS lock
 *  screen, and the in-app pause overlay all stop the count. Returns
 *  a getter that snapshots the current accumulated seconds.
 *
 *  Implementation: we track the wall-clock instant when the timer
 *  was last considered "running" via a ref. On any state change
 *  (visibility flip OR `paused` flip) we flush the elapsed slice
 *  into `accumulatedRef` and either start a fresh slice or leave
 *  the timer halted. Reading the getter folds in the currently
 *  open slice on top of the accumulated whole so the value is
 *  always up to date without needing a per-second tick. */
export function useActiveSessionTime(paused: boolean): () => number {
  const accumulatedRef = useRef(0);
  const visibleSinceRef = useRef<number | null>(null);

  useEffect(() => {
    function isRunning() {
      return (
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        !paused
      );
    }
    function flush() {
      if (visibleSinceRef.current != null) {
        accumulatedRef.current +=
          (Date.now() - visibleSinceRef.current) / 1000;
        visibleSinceRef.current = null;
      }
    }
    if (isRunning()) {
      visibleSinceRef.current = Date.now();
    }
    function onVisibility() {
      if (isRunning()) {
        if (visibleSinceRef.current == null) {
          visibleSinceRef.current = Date.now();
        }
      } else {
        flush();
      }
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      flush();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [paused]);

  return () => {
    let total = accumulatedRef.current;
    if (visibleSinceRef.current != null) {
      total += (Date.now() - visibleSinceRef.current) / 1000;
    }
    return Math.floor(total);
  };
}

/** One of the round-icon controls in the study screen header. */
export function TopBarButton({
  children,
  onClick,
  tooltip,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tooltip: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-center">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/** Boost (re-study later) + Never-again (remove from vocab) +
 *  Pause — laid out as a compact right-aligned group. Callers wire
 *  the three handlers; the icon set + tooltip copy is uniform across
 *  plugins. Pass `disableBoost` when there's no active card for
 *  Boost to operate on (e.g. mid-loading state). */
export function SessionTopBarControls({
  onBoost,
  onNeverAgain,
  onPause,
  disableBoost,
}: {
  onBoost: () => void;
  onNeverAgain: () => void;
  onPause: () => void;
  disableBoost?: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <TopBarButton
        onClick={() => {
          if (disableBoost) return;
          onBoost();
        }}
        tooltip="Boost — re-study this card later in the same session."
        className={cn(
          "text-amber-600 hover:bg-amber-500/10 dark:text-amber-400",
          disableBoost && "pointer-events-none opacity-40",
        )}
      >
        <RocketIcon className="size-4" />
      </TopBarButton>
      <TopBarButton
        onClick={onNeverAgain}
        tooltip="Never show this card again — removes it from your vocabulary."
        className="text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
      >
        <Ban className="size-4" />
      </TopBarButton>
      <div className="mx-1 h-5 w-px bg-border" />
      <TopBarButton onClick={onPause} tooltip="Pause">
        <Pause className="size-4" />
      </TopBarButton>
    </div>
  );
}

/** Fullscreen overlay that takes over the session. Shows the
 *  user's current progress and a Resume / End choice. Active time
 *  tracking should pause while this is on screen (the `elapsedSecs`
 *  is what the parent has accumulated up to the moment of pause). */
export function PauseOverlay({
  progress,
  done,
  total,
  elapsedSecs,
  onResume,
  onEnd,
}: {
  /** 0..100 — already in percent, not 0..1. */
  progress: number;
  done: number;
  total: number;
  elapsedSecs: number;
  onResume: () => void;
  onEnd: () => void;
}) {
  const minutes = Math.max(1, Math.round(elapsedSecs / 60));
  // The overlay covers the custom title bar, so make the backdrop a
  // window drag region — otherwise the window can't be moved while a
  // session is paused. `data-tauri-drag-region` only fires on this exact
  // element, so the Resume / End buttons inside stay clickable. (No-op
  // in the browser / hosted build, where there's no Tauri window.)
  return (
    <div
      data-tauri-drag-region
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/95 backdrop-blur-sm animate-in fade-in"
    >
      <div className="w-full max-w-md px-8 text-center">
        <p className="text-[11px] font-bold uppercase tracking-wider text-foreground/70">
          Paused
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {done} / {total} cards · {minutes}m
        </p>
        <div className="mt-4">
          <Progress value={progress} />
        </div>
        <div className="mt-7 flex justify-center gap-2">
          <Button variant="outline" onClick={onEnd}>
            <StopCircle className="size-4" />
            End session
          </Button>
          <Button onClick={onResume}>
            <Play className="size-4" />
            Resume
          </Button>
        </div>
      </div>
    </div>
  );
}
