/**
 * Auto-sync hook. When enabled (setting `cloud.autoSync` = "1") AND
 * the user is Pro, runs a full bidirectional `syncNow()` every 5
 * minutes in the background. Mounted once at the app root — see
 * `App.tsx`.
 *
 * Why not a timer in `cloud-context`: keeping the scheduler out of
 * the auth provider keeps it easy to test (no fake CloudProvider
 * needed) and lets the cadence be tuned independently of the
 * sign-in flow. The provider exposes the bits we read.
 *
 * Failure handling: each tick is best-effort. A failed sync logs and
 * leaves the last-synced time unchanged (so the UI shows the stale
 * time). Outcomes that need a human decision (first-sync direction,
 * epoch mismatch after a force-upload elsewhere) surface as an error
 * status pointing at Settings → Cloud — a background timer must never
 * answer those questions by itself.
 */

import { useEffect, useRef, useState } from "react";
import { HOSTED } from "@/lib/build-flags";
import { triggerCloudRefresh } from "@/lib/cloud-refresh";
import { getSetting } from "@/lib/db";
import { syncNow } from "@/lib/sync/engine";
import { useCloud } from "@/lib/cloud-context";

const AUTO_SYNC_KEY = "cloud.autoSync";
const INTERVAL_MS = 5 * 60_000; // 5 minutes.

export type AutoSyncStatus =
  | { kind: "off" }
  | { kind: "off-not-pro" }
  | { kind: "idle"; lastRunAt: number | null }
  | { kind: "syncing" }
  | { kind: "error"; message: string };

export function useAutoSync(): AutoSyncStatus {
  const cloud = useCloud();
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<AutoSyncStatus>({ kind: "off" });
  const runningRef = useRef(false);

  // Read the persisted toggle on mount. We used to poll the setting
  // every few seconds to catch the toggle changing, but on desktop
  // that's "free" (SQLite lookup) while on HOSTED it'd be a GET to
  // `/api/v1/settings` every 5 s — visible as request spam in the
  // Network tab. Settings → Cloud dispatches a window event when the
  // toggle flips, which we listen for explicitly instead.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const raw = await getSetting(AUTO_SYNC_KEY);
      if (cancelled) return;
      setEnabled(raw === "1" || raw === "true");
    };
    void refresh();
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setEnabled(detail === "1" || detail === "true");
    };
    window.addEventListener("tokori:auto-sync-changed", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("tokori:auto-sync-changed", onChange);
    };
  }, []);

  // The timer itself. Two modes:
  //
  //   - Desktop (HOSTED=false): every tick runs `syncNow`, exchanging
  //     local changes with the cloud. Pro-gated.
  //   - Hosted   (HOSTED=true) : every tick fires a
  //     `tokori:cloud-refresh` event so mounted views re-fetch from
  //     the cloud DB. Also re-fires on tab focus so flipping back to
  //     the laptop picks up whatever the desktop just pushed.
  useEffect(() => {
    if (!enabled) {
      setStatus({ kind: "off" });
      return;
    }
    if (!cloud.account) {
      setStatus({ kind: "off" });
      return;
    }
    // Pro is required for desktop sync. In HOSTED the user is
    // already Pro by the time AuthGate let them in, so this check
    // is desktop-only.
    if (!HOSTED && !cloud.isPro) {
      setStatus({ kind: "off-not-pro" });
      return;
    }

    const apiBase = cloud.apiBase;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || runningRef.current) return;
      runningRef.current = true;
      setStatus({ kind: "syncing" });
      try {
        if (HOSTED) {
          // Multi-device pull: just broadcast — the views own their
          // own refetch logic. No bearer needed; the inflight
          // fetches already carry the user's token.
          triggerCloudRefresh();
        } else {
          const outcome = await syncNow({
            apiBase,
            token: cloud.account!.token,
          });
          if (outcome.kind === "first-sync-choice") {
            setStatus({
              kind: "error",
              message:
                "First sync needs a decision — open Settings → Cloud to choose merge, upload, or download.",
            });
            runningRef.current = false;
            return;
          }
          if (outcome.kind === "epoch-mismatch") {
            setStatus({
              kind: "error",
              message:
                "The cloud copy was replaced from another device — open Settings → Cloud to download it.",
            });
            runningRef.current = false;
            return;
          }
        }
        if (!cancelled) {
          setStatus({ kind: "idle", lastRunAt: Date.now() });
        }
      } catch (err) {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        runningRef.current = false;
      }
    };

    // Fire once on mount, then on the interval.
    void tick();
    const handle = setInterval(() => void tick(), INTERVAL_MS);

    // Tab focus / visibility: in HOSTED, also pull when the user
    // returns to the tab. People leave the laptop open, go push
    // reviews on the desktop, and come back — without this hook
    // they'd see stale data until the next 5-min tick.
    let onVisible: (() => void) | null = null;
    if (HOSTED) {
      onVisible = () => {
        if (document.visibilityState === "visible") void tick();
      };
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      cancelled = true;
      clearInterval(handle);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, cloud.isPro, cloud.account, cloud.apiBase]);

  return status;
}

export { AUTO_SYNC_KEY };
