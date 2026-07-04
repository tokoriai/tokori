import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Pin, Settings, Square, X } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/build-flags";
import { PLATFORM } from "@/lib/platform";

/**
 * Custom in-app title bar (desktop builds only).
 *
 * Replaces the native window chrome so app controls can live in the
 * top strip, the way macOS apps park accessories next to the traffic
 * lights:
 *
 *   • macOS — native decorations stay on, but `titleBarStyle:
 *     "Overlay"` + `hiddenTitle` (tauri.conf.json) float the system
 *     traffic lights over this bar; we just reserve room for them on
 *     the left. They auto-hide in native fullscreen, so the inset
 *     collapses with them.
 *   • Windows + Linux — decorations are stripped at startup
 *     (`set_decorations(false)` in lib.rs's setup hook) and this bar
 *     supplies its own minimize / maximize / close. Edge resizing
 *     keeps working: tao hit-tests undecorated window borders itself.
 *
 * Every empty stretch carries `data-tauri-drag-region`, so dragging
 * moves the window and double-clicking toggles maximize — both
 * handled by Tauri's injected drag script, no JS here. The attribute
 * only fires on the element itself (not children), which is exactly
 * why the buttons stay clickable.
 *
 * Renders nothing in a plain browser tab (`npm run dev`) and is
 * dead-stripped from the hosted bundle at the call site in shell.tsx.
 */

type TitleBarProps = {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  settingsActive: boolean;
};

export function TitleBar(props: TitleBarProps) {
  // No window to control outside the Tauri shell — and the inner
  // component talks to the window API in effects, so don't mount it.
  if (!isTauri() || PLATFORM === "mobile") return null;
  return <TitleBarChrome {...props} />;
}

function TitleBarChrome({
  sidebarCollapsed,
  onToggleSidebar,
  onOpenSettings,
  settingsActive,
}: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pinned, setPinned] = useState(false);

  // Mirror the real window state. Resize events also fire on
  // maximize / unmaximize / fullscreen transitions, so one listener
  // covers all of them; the getters are cheap boolean IPC calls.
  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    const sync = () => {
      void Promise.all([win.isMaximized(), win.isFullscreen()])
        .then(([max, fs]) => {
          if (disposed) return;
          setMaximized(max);
          setFullscreen(fs);
        })
        .catch(() => undefined);
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      disposed = true;
      void unlisten.then((off) => off());
    };
  }, []);

  // Optimistic flip with revert on failure — there's no
  // `isAlwaysOnTop` getter to re-sync from, so we own this bit.
  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    getCurrentWindow()
      .setAlwaysOnTop(next)
      .catch(() => setPinned(!next));
  };

  const isMac = PLATFORM === "mac";

  return (
    <TooltipProvider delayDuration={120} disableHoverableContent>
      <header
        data-tauri-drag-region
        className="flex h-10 shrink-0 select-none items-center gap-1 border-b border-border bg-sidebar px-2 text-sidebar-foreground"
      >
        {/* Traffic-light inset — sized to clear the lights at the
            `trafficLightPosition` set in tauri.conf.json. */}
        {isMac && !fullscreen && (
          <div data-tauri-drag-region className="w-18 shrink-0" />
        )}

        {/* App icon + name, Windows-titlebar convention. Skipped on
            macOS, where the brand already lives in the native menu
            bar (bold app name) and the Dock — Mac apps don't restate
            it in the window chrome. Every element carries the drag
            attribute (it only fires on the exact target), so grabbing
            the logo or the name moves the window like a native title.
            The asset is public/logo.png — same file index.html uses
            for the favicon. */}
        {!isMac && (
          <div
            data-tauri-drag-region
            className="flex shrink-0 items-center gap-2 pl-1.5 pr-1"
          >
            <img
              data-tauri-drag-region
              src="/logo.png"
              alt=""
              draggable={false}
              className="size-4"
            />
            <span
              data-tauri-drag-region
              className="text-xs font-medium text-muted-foreground"
            >
              {APP_NAME}
            </span>
            {/* Build-time constant (vite define) — synchronous, so the
                bar never reflows the way an async getVersion() would.
                Same source the About screen falls back to. */}
            <span
              data-tauri-drag-region
              className="text-[10px] text-muted-foreground/60"
            >
              v{__APP_VERSION__}
            </span>
          </div>
        )}

        <TitleBarButton
          label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleSidebar}
        >
          <SidebarGlyph open={!sidebarCollapsed} />
        </TitleBarButton>

        <div data-tauri-drag-region className="h-full min-w-0 flex-1" />

        <TitleBarButton
          label={pinned ? "Stop keeping on top" : "Keep on top"}
          onClick={togglePin}
          pressed={pinned}
        >
          <Pin className={cn("size-4", pinned && "fill-current")} />
        </TitleBarButton>

        <TitleBarButton
          label="Settings"
          onClick={onOpenSettings}
          active={settingsActive}
        >
          <Settings className="size-4" />
        </TitleBarButton>

        {!isMac && (
          <div className="-mr-2 ml-1 flex shrink-0 self-stretch">
            <WindowControl
              label="Minimize"
              onClick={() => void getCurrentWindow().minimize()}
            >
              <Minus className="size-4" />
            </WindowControl>
            <WindowControl
              label={maximized ? "Restore" : "Maximize"}
              onClick={() => void getCurrentWindow().toggleMaximize()}
            >
              {maximized ? (
                // Mirrored so the back square sits top-right, like the
                // classic Windows restore glyph.
                <Copy className="size-3.5 -scale-x-100" />
              ) : (
                <Square className="size-3.5" />
              )}
            </WindowControl>
            <WindowControl
              label="Close"
              close
              onClick={() => void getCurrentWindow().close()}
            >
              <X className="size-4" />
            </WindowControl>
          </div>
        )}
      </header>
    </TooltipProvider>
  );
}

function TitleBarButton({
  label,
  onClick,
  active = false,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  /** Highlight without toggle semantics (e.g. Settings tab is open). */
  active?: boolean;
  /** Toggle semantics — also sets aria-pressed (e.g. the pin). */
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition duration-150 hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.94]",
            (active || pressed) && "bg-accent text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Sidebar-state glyph. A panel outline whose left pane carries a
 * filled pill while the sidebar is visible — state reads at a glance
 * (filled = open), and toggling crossfades the pill instead of
 * hard-swapping between two lucide arrow icons. Drawn at strokeWidth
 * 1.8 so it sits a touch lighter than the neighbouring stroke-2
 * lucide icons, which suits a chrome control.
 */
function SidebarGlyph({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
      <rect
        className={cn(
          "transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        x="5.2"
        y="6.8"
        width="2.6"
        height="10.4"
        rx="1.1"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

/**
 * Windows / Linux window control. Full-height flat hit targets in the
 * Windows convention (the close button bleeds into the top-right
 * corner — that's what the wrapper's -mr-2 is for). No tooltips: the
 * glyphs are universal and a hover hint over window chrome is noise.
 */
function WindowControl({
  label,
  onClick,
  close = false,
  children,
}: {
  label: string;
  onClick: () => void;
  close?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "inline-flex h-full w-12 items-center justify-center text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        close
          ? "hover:bg-destructive hover:text-destructive-foreground"
          : "hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
