import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Persistent collapse state for a secondary sidebar (the list-on-left
 * pane in reader / journal / notes / collections / settings). Returns
 * an open flag, a toggle, and the matching `<SidebarCollapser>` button
 * a view drops in at the seam between the aside and the main content.
 *
 * `storageKey` should be unique per view (e.g. "reader.sidebarOpen")
 * so collapsing one pane doesn't inadvertently collapse another. The
 * default-open behaviour matches the existing reader-view pattern —
 * once a user hides the pane it stays hidden across reloads.
 */
export function useSidebarCollapse(
  storageKey: string,
  defaultOpen = true,
): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw == null) return defaultOpen;
      return raw === "1";
    } catch {
      return defaultOpen;
    }
  });
  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* localStorage may be denied (private mode, embedded webviews) */
      }
      return next;
    });
  }
  return { open, toggle };
}

/**
 * Round chevron handle that sits on the seam between a secondary
 * sidebar and the main content. Lives at the right edge of the aside
 * when open, jumps to the left edge of the content when collapsed —
 * mirrors the Discord / VS Code sidebar pattern.
 *
 * The parent must be `position: relative` for the absolute positioning
 * to anchor correctly. `width` is the open width of the aside in
 * pixels (defaults to 260 to match most current views).
 */
export function SidebarCollapser({
  open,
  onToggle,
  width = 260,
  hiddenLabel = "Show panel",
  visibleLabel = "Hide panel",
}: {
  open: boolean;
  onToggle: () => void;
  width?: number;
  hiddenLabel?: string;
  visibleLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={open ? visibleLabel : hiddenLabel}
      aria-label={open ? visibleLabel : hiddenLabel}
      className="absolute top-1/2 z-10 -translate-y-1/2 flex size-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground"
      style={{ left: open ? width - 12 : 4 }}
    >
      {open ? (
        <ChevronLeft className="size-3.5" />
      ) : (
        <ChevronRight className="size-3.5" />
      )}
    </button>
  );
}
