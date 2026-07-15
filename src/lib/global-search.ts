/**
 * Desktop shortcut features (global search + voice ask) — settings
 * keys + boot-time sync.
 *
 * The user's enabled/shortcut choices persist in the `settings` table.
 * On app boot, the apply*OnBoot functions re-invoke the Tauri commands
 * with the saved values so the tray + shortcuts come back up after a
 * relaunch without the user needing to revisit Settings.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { getSetting } from "./db";

export const GLOBAL_SEARCH_ENABLED_KEY = "desktop.globalSearch.enabled";
export const GLOBAL_SEARCH_SHORTCUT_KEY = "desktop.globalSearch.shortcut";
/** A sane default that doesn't collide with browser find-in-page. */
export const DEFAULT_GLOBAL_SHORTCUT = "CmdOrCtrl+Shift+F";

export const VOICE_ASK_ENABLED_KEY = "desktop.voiceAsk.enabled";
export const VOICE_ASK_SHORTCUT_KEY = "desktop.voiceAsk.shortcut";
export const DEFAULT_VOICE_ASK_SHORTCUT = "CmdOrCtrl+Shift+Space";

async function applyShortcutFeatureOnBoot(
  command: string,
  enabledKey: string,
  shortcutKey: string,
  defaultShortcut: string,
): Promise<void> {
  if (!isTauri()) return;
  try {
    const [enabledRaw, shortcutRaw] = await Promise.all([
      getSetting(enabledKey),
      getSetting(shortcutKey),
    ]);
    if (enabledRaw !== "1") return;
    await invoke(command, {
      enabled: true,
      shortcut: shortcutRaw || defaultShortcut,
    });
  } catch (err) {
    // Silent — user can re-toggle from Settings if something went wrong.
    console.warn(`[${command}] boot sync failed`, err);
  }
}

export async function applyGlobalSearchOnBoot(): Promise<void> {
  return applyShortcutFeatureOnBoot(
    "set_global_search_enabled",
    GLOBAL_SEARCH_ENABLED_KEY,
    GLOBAL_SEARCH_SHORTCUT_KEY,
    DEFAULT_GLOBAL_SHORTCUT,
  );
}

export async function applyVoiceAskOnBoot(): Promise<void> {
  return applyShortcutFeatureOnBoot(
    "set_voice_ask_enabled",
    VOICE_ASK_ENABLED_KEY,
    VOICE_ASK_SHORTCUT_KEY,
    DEFAULT_VOICE_ASK_SHORTCUT,
  );
}
