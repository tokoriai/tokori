import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Live microphone waveform — scrolling level bars, WhatsApp-style.
 *
 * Feed it the MediaStream being recorded; it taps the stream through
 * its own AnalyserNode and never owns it (stopping tracks is the
 * caller's job — the recorder outlives any number of these). Bars are
 * painted in `currentColor`, so tint via a text-* class and both
 * themes come along for free. When `stream` flips to null the last
 * frame stays frozen on the canvas — which is exactly what the
 * "Transcribing…" state wants to show.
 */
export function MicWaveform({
  stream,
  className,
}: {
  stream: MediaStream | null;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stream) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    // Analysis-only context: no sampleRate constraint, nothing routed
    // to the destination, so it can't feed back into the speakers or
    // disturb a MediaRecorder on the same stream. resume() is
    // defensive — the voice-ask popup starts without a user gesture
    // and some engines create contexts suspended in that case.
    const audioCtx = new AudioContext();
    void audioCtx.resume().catch(() => {});
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const BAR_WIDTH = 2.5;
    const BAR_GAP = 2;
    const PUSH_INTERVAL_MS = 45;
    const samples = new Uint8Array(analyser.fftSize);
    const levels: number[] = [];
    let lastPush = 0;
    let raf = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      // Keep the backing store matched to the CSS box — covers the
      // first paint and any flex resize without a ResizeObserver.
      if (
        canvas.width !== Math.round(w * dpr) ||
        canvas.height !== Math.round(h * dpr)
      ) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }

      if (now - lastPush >= PUSH_INTERVAL_MS) {
        lastPush = now;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          const v = (samples[i] - 128) / 128;
          sum += v * v;
        }
        levels.push(Math.sqrt(sum / samples.length));
        const capacity = Math.ceil(w / (BAR_WIDTH + BAR_GAP)) + 1;
        while (levels.length > capacity) levels.shift();
      }

      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.fillStyle = getComputedStyle(canvas).color;
      // Newest bar hugs the right edge; history scrolls left.
      for (let i = 0; i < levels.length; i++) {
        const level = levels[levels.length - 1 - i];
        const x = w - BAR_WIDTH - i * (BAR_WIDTH + BAR_GAP);
        if (x + BAR_WIDTH < 0) break;
        // Speech RMS rarely exceeds ~0.35 — ×3 spreads normal talking
        // across the bar height; the min keeps silence visible as a
        // dotted centre line instead of a blank strip.
        const bh = Math.max(h * 0.08, Math.min(1, level * 3) * h);
        const y = (h - bh) / 2;
        ctx2d.beginPath();
        if (typeof ctx2d.roundRect === "function") {
          ctx2d.roundRect(x, y, BAR_WIDTH, bh, BAR_WIDTH / 2);
        } else {
          ctx2d.rect(x, y, BAR_WIDTH, bh);
        }
        ctx2d.fill();
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      try {
        source.disconnect();
      } catch {
        /* already gone */
      }
      if (audioCtx.state !== "closed") void audioCtx.close();
    };
  }, [stream]);

  return <canvas ref={canvasRef} className={cn("block", className)} aria-hidden />;
}

/** 73_000ms → "1:13". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Ticking elapsed-time readout for a recording that began at
 *  `startedAt` (epoch ms). Re-renders the consumer twice a second
 *  while active; returns "0:00" when idle. */
export function useElapsed(startedAt: number | null): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (startedAt == null) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt == null ? "0:00" : formatClock(Date.now() - startedAt);
}
