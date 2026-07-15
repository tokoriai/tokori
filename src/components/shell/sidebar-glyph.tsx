import { cn } from "@/lib/utils";

/**
 * Sidebar-state glyph, shared by the title bar's toggle and the
 * sidebar's own collapse button so the two controls read as one
 * mechanism. A panel outline whose left pane carries a filled pill
 * while the sidebar is visible — state reads at a glance (filled =
 * open), and toggling crossfades the pill instead of hard-swapping
 * between two lucide arrow icons. Drawn at strokeWidth 1.8 so it sits
 * a touch lighter than the neighbouring stroke-2 lucide icons, which
 * suits a chrome control.
 */
export function SidebarGlyph({
  open,
  className,
}: {
  open: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      className={cn("size-4", className)}
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
