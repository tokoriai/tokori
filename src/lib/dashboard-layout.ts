/**
 * Per-workspace dashboard layout. Persisted in the `settings` table
 * as JSON under the key `dashboard.layout.<workspaceId>` so the user's
 * arrangement survives reloads / device restarts.
 *
 * Schema is intentionally tiny — a flat list of `{ widgetId, size }`
 * slots. Auto-flow grid handles wrapping; sizes are 1/2/3 column spans
 * out of a 3-column grid. New layouts (or unrecognised widget ids in
 * a stale layout) fall back to `DEFAULT_LAYOUT_IDS` so the dashboard
 * always has *something* to render.
 */

import { getSetting, setSetting } from "./db";
import { getWidget, type WidgetSize } from "./widget-registry";

export type DashboardSlot = {
  widgetId: string;
  size: WidgetSize;
};

export type DashboardLayout = {
  /** Schema version — bump if the slot shape changes so old rows can
   *  be migrated rather than silently rejected.
   *  v2 = 12-col grid + individual KPI / stat / action tile widgets.
   *  v3 = level-card-with-mini-KPIs row + bundled quick-actions.
   *  v4 = top row trims immersion + grows streak/words; stats row
   *       swaps "longest single session" for "today's immersion". */
  version: 4;
  slots: DashboardSlot[];
};

/**
 * Default ordering. Sized for a 12-column grid. Tiles that should
 * appear three to a row use size 4; the four stat tiles use size 3
 * so they share a single row of equal-height cards. Wider chart /
 * list widgets use 8 + 4 splits.
 */
export const DEFAULT_LAYOUT: DashboardLayout = {
  version: 4,
  slots: [
    // Top row: smaller level estimate + two prominent KPIs.
    // 6 + 3 + 3 = 12. Day-streak and Words-known each get 3× the
    // horizontal real estate of the previous "tiny KPI" slot — they
    // read at a glance now, which is what a learner actually wants
    // on first paint. Immersion moves to the second row as
    // "today's immersion".
    { widgetId: "level-card", size: 6 },
    { widgetId: "kpi-streak", size: 3 },
    { widgetId: "kpi-words", size: 3 },
    // Stats row — four identical-height tiles.
    { widgetId: "stat-total", size: 3 },
    { widgetId: "stat-week", size: 3 },
    { widgetId: "stat-daily-avg", size: 3 },
    { widgetId: "stat-today", size: 3 },
    // Quick actions — bundled into a single widget.
    { widgetId: "quick-actions", size: 12 },
    // Charts.
    { widgetId: "vocab-growth", size: 8 },
    { widgetId: "skills-radar", size: 4 },
    // Study commitments.
    { widgetId: "goals", size: 8 },
    { widgetId: "textbook", size: 4 },
    // Heatmap full-bleed.
    { widgetId: "consistency-heatmap", size: 12 },
    // Library / notes.
    { widgetId: "library-list", size: 8 },
    { widgetId: "notes-list", size: 4 },
    // Recent activity.
    { widgetId: "recent-activities", size: 12 },
  ],
};

function settingsKey(workspaceId: number): string {
  return `dashboard.layout.${workspaceId}`;
}

/** Load the layout for a workspace, or fall back to the default when
 *  none is stored / the stored row is malformed. */
export async function loadDashboardLayout(
  workspaceId: number,
): Promise<DashboardLayout> {
  try {
    const raw = await getSetting(settingsKey(workspaceId));
    if (!raw) return cloneDefault();
    const parsed = JSON.parse(raw) as Partial<DashboardLayout> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.slots) ||
      parsed.version !== 4
    ) {
      // Older versions referenced widgets that no longer exist
      // (kpi-strip, stats-strip, action-review, etc.); drop them and
      // fall back to the default rather than half-render.
      return cloneDefault();
    }
    // Strip slots that reference unknown widgets (e.g. a plugin that
    // was uninstalled) so the dashboard doesn't render empty cards.
    const slots = parsed.slots
      .filter(
        (s): s is DashboardSlot =>
          !!s &&
          typeof s.widgetId === "string" &&
          typeof s.size === "number" &&
          s.size >= 1 &&
          s.size <= 12,
      )
      .filter((s) => getWidget(s.widgetId) != null);
    if (slots.length === 0) return cloneDefault();
    return { version: 4, slots };
  } catch {
    return cloneDefault();
  }
}

export async function saveDashboardLayout(
  workspaceId: number,
  layout: DashboardLayout,
): Promise<void> {
  await setSetting(settingsKey(workspaceId), JSON.stringify(layout));
}

/** Reset a workspace's dashboard back to the default layout. */
export async function resetDashboardLayout(workspaceId: number): Promise<void> {
  await saveDashboardLayout(workspaceId, cloneDefault());
}

function cloneDefault(): DashboardLayout {
  return { version: 4, slots: DEFAULT_LAYOUT.slots.map((s) => ({ ...s })) };
}
