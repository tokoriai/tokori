/**
 * In-app auto-update (desktop only).
 *
 * The Tauri updater plugin checks the GitHub Releases `latest.json`
 * feed, verifies the downloaded bundle against the minisign public key
 * baked into `tauri.conf.json` (`plugins.updater.pubkey`), and installs
 * it in place. The matching private key lives only in CI as the
 * `TAURI_SIGNING_PRIVATE_KEY` secret — see the maintainer release
 * notes (launch/RELEASING.md).
 *
 * Everything here no-ops cleanly off the desktop:
 *   • The hosted web build references the plugins only inside `!HOSTED`
 *     blocks, so Rollup tree-shakes them out entirely (same strip
 *     pattern as cloud-client — no orphan chunk, nothing shipped).
 *   • The browser demo and `npm run dev` short-circuit at runtime via
 *     `isTauri()`.
 * Callers get a typed `UpdateCheck` and never have to know which
 * surface they're on. This module stays UI-free (no toasts, no React);
 * the nudge + progress UX lives in `components/updater-nudge.tsx`.
 */
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { HOSTED } from "@/lib/build-flags";

export type UpdateCheck =
  | { kind: "unsupported" } // not a packaged desktop build (web / demo / dev-browser)
  | { kind: "up-to-date"; currentVersion: string }
  | { kind: "error"; message: string }
  | {
      kind: "available";
      version: string; // the release on offer, e.g. "0.2.0"
      currentVersion: string; // what's installed right now
      notes: string; // release body, trimmed; "" when none
      update: Update; // handle the installer acts on
    };

/** Download progress as a 0–1 fraction, or `null` when the server sent
 *  no Content-Length and only an indeterminate state is knowable. */
export type UpdateProgress = number | null;

/**
 * Look for a newer release. Never throws — being offline, a missing
 * `latest.json` (no published release yet), or a malformed feed all
 * resolve to a typed result the caller can branch on.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  // The plugin calls live only inside this `!HOSTED` block, so the
  // hosted bundle tree-shakes the updater away. `isTauri()` covers the
  // desktop bundle's non-Tauri surfaces (static demo, `npm run dev`).
  if (!HOSTED && isTauri()) {
    try {
      const update = await check();
      if (!update) {
        return { kind: "up-to-date", currentVersion: await getVersion() };
      }
      return {
        kind: "available",
        version: update.version,
        currentVersion: update.currentVersion,
        notes: (update.body ?? "").trim(),
        update,
      };
    } catch (err) {
      return {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { kind: "unsupported" };
}

/**
 * Download + stage the update (reporting byte progress), then relaunch
 * into the new version. The relaunch tears down the webview, so on
 * success this never resolves — a thrown error is the only outcome a
 * caller needs to handle.
 */
export async function installUpdateAndRestart(
  update: Update,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  if (!HOSTED) {
    let total = 0;
    let received = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          onProgress?.(total > 0 ? 0 : null);
          break;
        case "Progress":
          received += event.data.chunkLength;
          onProgress?.(total > 0 ? Math.min(1, received / total) : null);
          break;
        case "Finished":
          onProgress?.(1);
          break;
      }
    });
    await relaunch();
  }
}

/**
 * The running app's version, or `null` when it can't be known (hosted /
 * browser demo). `null` is the deliberate "not-yet/never" tri-state —
 * the caller shows the build-time `__APP_VERSION__` fallback instead.
 */
export async function getAppVersion(): Promise<string | null> {
  if (!HOSTED && isTauri()) {
    try {
      return await getVersion();
    } catch {
      return null;
    }
  }
  return null;
}
