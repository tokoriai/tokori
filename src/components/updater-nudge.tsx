/**
 * Startup update nudge + the shared install flow.
 *
 * `<UpdaterNudge />` mounts once near the top of the app, runs a single
 * silent update check shortly after launch, and — if a newer release is
 * live — raises a dismissible toast offering to restart into it. It
 * renders nothing.
 *
 * The check runs once per launch by design: no background polling loop.
 * A user who dismisses the toast is left alone until the next launch,
 * and Settings → About offers a manual "Check for updates" for anyone
 * who wants to look sooner.
 *
 * The check is inert wherever it should be: `checkForUpdate()` no-ops
 * off the packaged desktop build, and the dev guard below keeps a
 * published release from nagging while you iterate (`tauri dev` reports
 * the bundled version and would otherwise flag every release as an
 * update).
 *
 * `promptInstall` is the shared "download → toast progress → relaunch"
 * routine. The Settings → About "Check for updates" button reuses it so
 * both entry points behave identically.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdate, installUpdateAndRestart } from "@/lib/updater";

/** Download the update behind a live progress toast, then relaunch.
 *  Shared by the startup nudge and the About-screen button. */
export function promptInstall(update: Update, version: string): void {
  const id = toast.loading(`Downloading Tokori ${version}…`, {
    description: "Starting…",
    duration: Infinity,
  });
  // Only repaint the toast when the whole-percent changes — the progress
  // callback fires per network chunk, far more often than is worth a
  // re-render.
  let lastPct = -1;
  void installUpdateAndRestart(update, (progress) => {
    const pct = progress == null ? null : Math.round(progress * 100);
    if (pct !== null && pct === lastPct) return;
    if (pct !== null) lastPct = pct;
    toast.loading(`Downloading Tokori ${version}…`, {
      id,
      description: pct == null ? "Downloading…" : `${pct}%`,
      duration: Infinity,
    });
  }).catch((err: unknown) => {
    toast.error("Update failed", {
      id,
      description: err instanceof Error ? err.message : String(err),
      duration: 6000,
    });
  });
}

export function UpdaterNudge() {
  // StrictMode double-invokes effects in dev; the ref keeps the check
  // (and its toast) from firing twice.
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    // Don't nag during development — `tauri dev` reports the bundled
    // version and would surface every published release as an update.
    if (import.meta.env.DEV) return;

    void (async () => {
      const result = await checkForUpdate();
      if (result.kind !== "available") return;
      toast("Update available", {
        description: `Tokori ${result.version} is ready to install.`,
        action: {
          label: "Restart & update",
          onClick: () => promptInstall(result.update, result.version),
        },
        // Persist until the user acts or dismisses — an update is worth
        // not auto-hiding, and it simply reappears on the next launch.
        duration: Infinity,
      });
    })();
  }, []);

  return null;
}
