/**
 * Cross-device refresh hub.
 *
 * In the HOSTED build, the same Tokori Cloud account can be open on
 * multiple devices at once: a desktop pushing fresh reviews via the
 * auto-sync hook, and a laptop staring at the dashboard. The laptop
 * reads the cloud DB live on every navigation, but a view that's
 * already mounted won't notice until its host component re-runs its
 * fetch effect. This module is the small bus that triggers that
 * re-fetch without an explicit reload.
 *
 * Public surface:
 *   - `triggerCloudRefresh()` — fire-and-forget signal. Call from a
 *     "Refresh" button, an auto-sync tick, or a tab-focus handler.
 *   - `useCloudRefresh(fn)` — view-side subscription. Calls `fn`
 *     whenever a refresh is requested.
 *
 * Why a custom event rather than a context: every relevant view
 * already has its own `refreshAll` closure tied to its current
 * workspace + state. Threading that through a context would force
 * every host to register/unregister on workspace switches and re-
 * render the tree. The event bus is one listener per consumer,
 * registered with React's useEffect lifecycle, and zero context
 * updates.
 *
 * Desktop note: this is HOSTED-only conceptually but the API is
 * build-flag-agnostic so views can call `useCloudRefresh` without
 * a guard. On desktop nothing dispatches the event, so the handler
 * never fires.
 */

import { useEffect, useRef } from "react";

export const CLOUD_REFRESH_EVENT = "tokori:cloud-refresh";

/** Broadcast a refresh tick. Cheap; safe to call from a button, a
 *  timer, or a visibility change. */
export function triggerCloudRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CLOUD_REFRESH_EVENT));
}

/** Subscribe to refresh ticks. Uses a ref under the hood so the
 *  caller doesn't have to wrap their refresh closure in
 *  `useCallback` — passing a fresh fn each render is fine, the
 *  listener identity stays stable.
 *
 *  Throttle: the handler ignores ticks that arrive within 1 s of the
 *  last one, so a tab focus + a timer firing back-to-back don't
 *  double-fetch. */
export function useCloudRefresh(fn: () => void | Promise<void>): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const lastRunRef = useRef(0);
  useEffect(() => {
    const handler = () => {
      const now = Date.now();
      if (now - lastRunRef.current < 1000) return;
      lastRunRef.current = now;
      void fnRef.current();
    };
    window.addEventListener(CLOUD_REFRESH_EVENT, handler);
    return () => window.removeEventListener(CLOUD_REFRESH_EVENT, handler);
  }, []);
}
