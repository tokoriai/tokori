/**
 * Cross-context URL opener.
 *
 * Tauri 2's webview silently swallows window.open + anchor target=_blank
 * for external HTTPS — opening Stripe Checkout, billing portal, marketing
 * links has to go through the OS shell instead. We use `@tauri-apps/
 * plugin-opener` for that. Outside Tauri (browser preview, plain web)
 * we fall back to window.open which works there.
 *
 * Single function so the call sites stay tidy and the Tauri-vs-web
 * distinction is in one place. Returns a promise so callers can await
 * an error if the open failed (e.g., URL scheme not whitelisted).
 */

import { isTauri } from "@tauri-apps/api/core";

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    // Lazy-load so the OSS app still bundles cleanly when the plugin
    // isn't installed (older builds, web preview).
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  // Web fallback. May be popup-blocked depending on browser settings,
  // but that's the user's choice — they'll see the blocker prompt.
  window.open(url, "_blank", "noopener");
}
