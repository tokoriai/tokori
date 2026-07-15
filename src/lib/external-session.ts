/**
 * Mirror of Companion-driven live sessions for the sidebar chip.
 *
 * When the browser extension's ⏱ immersion timer runs against a paired
 * desktop, the api_server keeps a live `study_sessions` row fresh and
 * emits `tokori:live-session` Tauri events (start / beat / finish).
 * This hook turns those into a display-only "you are immersing" state
 * — the desktop shows the timer, but the extension owns the session
 * (its beats are the source of truth; there's nothing to pause or end
 * from this side).
 *
 * Timing model: each beat re-anchors to the authoritative accrued
 * seconds; between beats (~30 s apart while the video plays) the
 * display ticks forward optimistically, capped at one beat interval so
 * a paused video can't inflate the readout by more than the gap. Beat
 * silence past STALE_MS means the extension stopped/crashed — the
 * mirror clears rather than showing a frozen timer.
 */

import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type LiveSessionEvent = {
  phase: "start" | "beat" | "finish";
  id: number;
  workspaceId: number;
  kind: string;
  startedAt: number;
  durationSecs: number;
};

type Mirror = {
  id: number;
  kind: string;
  durationSecs: number;
  lastEventAt: number;
};

/** Extension beats arrive every ~30 s while playing. */
const TICK_CAP_SECS = 45;
const STALE_MS = 90_000;

export function useExternalLiveSession(): { kind: string; secs: number } | null {
  const [mirror, setMirror] = useState<Mirror | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<LiveSessionEvent>("tokori:live-session", (e) => {
      const p = e.payload;
      if (p.phase === "finish") {
        setMirror((prev) => (prev == null || prev.id === p.id ? null : prev));
        return;
      }
      setMirror({
        id: p.id,
        kind: p.kind,
        durationSecs: p.durationSecs,
        lastEventAt: Date.now(),
      });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 1 s re-render + staleness sweep, only while something is mirrored —
  // the idle sidebar shouldn't tick.
  const active = mirror != null;
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => {
      setMirror((prev) =>
        prev && Date.now() - prev.lastEventAt > STALE_MS ? null : prev,
      );
      setTick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(t);
  }, [active]);

  if (!mirror) return null;
  const sinceSecs = Math.floor((Date.now() - mirror.lastEventAt) / 1000);
  return {
    kind: mirror.kind,
    secs: mirror.durationSecs + Math.min(sinceSecs, TICK_CAP_SECS),
  };
}
