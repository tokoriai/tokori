/**
 * Dashboard widget registry.
 *
 * The dashboard is composed of widgets — discrete cards rendered into
 * a CSS grid. Built-in widgets register themselves at module-load
 * time; future plugins can call `registerWidget` to add their own
 * cards. The dashboard reads `useWidgetRegistry()` and the user's
 * stored layout to decide what to render and where.
 *
 * Layout decisions:
 *   • Sizes are "1" | "2" | "3" columns out of a 3-column grid. Auto-
 *     flow handles row breaks. This keeps the layout schema simple
 *     (a flat array, no row math) while still supporting full-width
 *     widgets.
 *   • Each widget receives a shared `WidgetContext` with the workspace
 *     + the loaded data the dashboard already fetches (vocab, sessions,
 *     library, notes, due cards). Widgets are pure render functions —
 *     they don't fetch their own data — so the dashboard stays a single
 *     IPC round-trip on load.
 *   • A widget can opt out of the edit-mode delete handle by setting
 *     `removable: false` (e.g. a "Add widget" CTA you never want to
 *     hide). Defaults to true.
 */

import { useSyncExternalStore } from "react";
import type {
  LibraryItem,
  Note,
  StudySession,
  VocabEntry,
  VocabReview,
  Workspace,
} from "./db";
import type { TabId } from "@/components/shell/shell";

/**
 * Column span (out of 12). The dashboard renders on a 12-column grid
 * so widgets can divide cleanly into thirds (4), quarters (3), halves
 * (6), two-thirds (8), or full width (12). The edit-mode resize button
 * cycles through the common sizes; plugins can pass any 1–12 value.
 */
export type WidgetSize = number;

export type WidgetCategory =
  | "stats"
  | "actions"
  | "study"
  | "library"
  | "custom";

export type WidgetContext = {
  workspace: Workspace;
  vocab: VocabEntry[];
  sessions: StudySession[];
  library: LibraryItem[];
  notes: Note[];
  due: VocabEntry[];
  /** What the next study session would actually queue — i.e. due
   *  cards + new cards, deduped, capped by the workspace's
   *  `dailyReviewLimit` / `dailyNewLimit`. Use this (not `due.length`)
   *  for any "X cards ready" badge so it matches the count the
   *  flashcards picker shows. */
  sessionQueue: VocabEntry[];
  /** Workspace-wide review history, ascending by `reviewedAt`. Used
   *  by the vocab growth chart to drive the SRS-aware retention
   *  curve (replays each word's reviews forward to compute the
   *  per-day "known" / "learning" / "leeches" buckets and to fold
   *  in retrievability decay between sessions). */
  reviews: VocabReview[];
  /** Navigate to another top-level tab (used by action cards / CTAs). */
  onNavigate: (tab: TabId) => void;
  /** Re-fetch the dashboard's underlying data (e.g. after a widget
   *  mutation like marking a chapter complete). Best-effort; widgets
   *  shouldn't await it on the render path. */
  refresh: () => Promise<void>;
  /** Open the "Log activity" dialog. Hosted by the dashboard so the
   *  dialog has a single mount point; widgets just request that it
   *  appear. Plugins can ignore this and bring their own dialogs. */
  openLogActivity: () => void;
  /** Open the Vocabulary CSV importer. Surfaced from the dashboard's
   *  vocab-growth widget's empty state so a brand-new workspace can
   *  bulk-import known words from Duolingo / HackChinese / Anki
   *  without having to navigate away. Same single-mount-point
   *  contract as `openLogActivity`. */
  openImportVocab: () => void;
  /** Open the pack-import dialog (free packs + cloud store). Shown
   *  alongside the CSV importer in the vocab-growth widget's empty
   *  state so a new workspace can install a whole textbook in one
   *  click as an alternative to typing words in or importing a CSV. */
  openRedeemPack: () => void;
};

export type WidgetDefinition = {
  /** Stable id used in stored layouts. Don't rename built-ins —
   *  user layouts reference these strings. */
  id: string;
  title: string;
  description?: string;
  category: WidgetCategory;
  /** Default span when first added to a layout. Users can resize
   *  in edit mode. */
  defaultSize: WidgetSize;
  /** Widget body. The card frame (title bar + edit-mode handles)
   *  lives in the dashboard view; the widget controls everything
   *  inside the frame. Pass `frameless: true` to drop the frame
   *  entirely (e.g. for full-bleed action grids). */
  Component: React.ComponentType<{ ctx: WidgetContext }>;
  /** When true, the dashboard renders the component without its
   *  card frame — useful for grids of buttons or a stats strip
   *  that owns its own visual style. */
  frameless?: boolean;
  /** When false, the edit-mode "remove" button is hidden. Defaults
   *  to true. */
  removable?: boolean;
  /** Free-text source attribution. Built-ins use "built-in"; a
   *  plugin should set its plugin id here so the widget picker can
   *  group third-party widgets. */
  source?: string;
};

// ─── Registry ────────────────────────────────────────────────────────────

const widgets = new Map<string, WidgetDefinition>();
const listeners = new Set<() => void>();
// Cached snapshot for useSyncExternalStore — must be referentially
// stable between emissions, otherwise React loops on every render.
let snapshot: WidgetDefinition[] = [];

function emit() {
  snapshot = Array.from(widgets.values());
  for (const fn of listeners) fn();
}

/** Register a dashboard widget. Idempotent on `id` — calling twice
 *  with the same id replaces the previous definition (lets a plugin
 *  hot-update during dev). */
export function registerWidget(def: WidgetDefinition): void {
  widgets.set(def.id, def);
  emit();
}

/** Remove a widget from the registry. Layouts that still reference
 *  the id will skip-render the slot (handled by the dashboard). */
export function unregisterWidget(id: string): void {
  if (widgets.delete(id)) emit();
}

export function getWidget(id: string): WidgetDefinition | undefined {
  return widgets.get(id);
}

export function listWidgets(): WidgetDefinition[] {
  return snapshot;
}

/** React subscription to the registry. Re-renders the consumer when
 *  widgets are registered / unregistered (so a plugin loaded after
 *  mount shows up immediately). */
export function useWidgetRegistry(): WidgetDefinition[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
}
