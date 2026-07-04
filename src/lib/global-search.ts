/**
 * Global Search settings — keys + boot-time sync.
 *
 * The user's enabled/shortcut choice persists in the `settings` table.
 * On app boot, `applyGlobalSearchOnBoot` re-invokes the Tauri command
 * with the saved values so the tray + shortcut come back up after a
 * relaunch without the user needing to revisit Settings.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { getSetting } from "./db";

export const GLOBAL_SEARCH_ENABLED_KEY = "desktop.globalSearch.enabled";
export const GLOBAL_SEARCH_SHORTCUT_KEY = "desktop.globalSearch.shortcut";
/** A sane default that doesn't collide with browser find-in-page. */
export const DEFAULT_GLOBAL_SHORTCUT = "CmdOrCtrl+Shift+F";

export async function applyGlobalSearchOnBoot(): Promise<void> {
  if (!isTauri()) return;
  try {
    const [enabledRaw, shortcutRaw] = await Promise.all([
      getSetting(GLOBAL_SEARCH_ENABLED_KEY),
      getSetting(GLOBAL_SEARCH_SHORTCUT_KEY),
    ]);
    const enabled = enabledRaw === "1";
    if (!enabled) return;
    await invoke("set_global_search_enabled", {
      enabled: true,
      shortcut: shortcutRaw || DEFAULT_GLOBAL_SHORTCUT,
    });
  } catch (err) {
    // Silent — user can re-toggle from Settings if something went wrong.
    console.warn("[global-search] boot sync failed", err);
  }
}
