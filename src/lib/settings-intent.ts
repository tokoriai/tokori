/**
 * One-shot intent channel for deep-linking into the Settings view.
 *
 * Callers (e.g. the chat view's no-provider buttons) call
 * `requestSettingsIntent("addProvider")` before flipping the active tab
 * to "settings". The SettingsView reads + clears the intent on mount
 * and routes to the right section / opens the right dialog.
 *
 * Implemented over `sessionStorage` so it survives a Vite HMR or a
 * Tauri webview reload during dev, and so we don't have to thread an
 * extra prop through every onNavigate call site.
 */

const KEY = "tokori.settings.intent";

export type SettingsIntent =
  | "addProvider"
  | "openDictionaries"
  | "openTTS"
  | "openCloud";

export function requestSettingsIntent(intent: SettingsIntent): void {
  try {
    sessionStorage.setItem(KEY, intent);
  } catch {
    // SSR / private mode — silently no-op. The user will just land on
    // the default settings section.
  }
}

/** Read and clear the pending intent. Returns null when nothing's set. */
export function consumeSettingsIntent(): SettingsIntent | null {
  try {
    const v = sessionStorage.getItem(KEY);
    if (v) sessionStorage.removeItem(KEY);
    return (v as SettingsIntent | null) ?? null;
  } catch {
    return null;
  }
}
