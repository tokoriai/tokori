/**
 * Gapless streamed-PCM playback for the live-voice hooks.
 *
 * The problem this replaces: every hook played incoming audio by
 * chaining chunks — an HTMLAudioElement per ~1 s WAV batch (the Gemini
 * hooks) or an AudioBufferSourceNode kicked off in the previous one's
 * `onended` (OpenAI / Qwen). Both put a main-thread hop *between*
 * chunks, so each transition costs 30–300 ms of silence depending on
 * platform load — an audible on/off pulse through the whole reply.
 *
 * The fix: one AudioContext, one time cursor. Every chunk is scheduled
 * with `source.start(at)` where `at` continues exactly where the
 * previous chunk ends — sample-accurate, nothing on the main thread in
 * the gap. A small priming pad absorbs network jitter at the start of
 * each burst.
 *
 * The sink: scheduled audio is routed into a
 * MediaStreamAudioDestinationNode and played through a hidden <audio>
 * element rather than `ctx.destination`. On several Linux WebKit2GTK +
 * PipeWire builds the context renders happily (clock advances) while
 * `destination` never reaches the platform sink — silent output with
 * no detectable error, the historical reason the Gemini hooks batched
 * WAVs through HTMLAudioElement. The media element uses the same
 * playout pipeline as every other audio surface in the app (TTS,
 * previews), which is known to reach the speakers everywhere, while
 * Web Audio still does the sample-accurate gapless scheduling.
 *
 * Platform pre-seed: on the Linux desktop build (Tauri → WebKit2GTK)
 * we don't attempt the Web Audio graph at all — the player starts on
 * the WAV/HTMLAudioElement pipeline directly. Verified failure mode on
 * those builds: the graph "plays" by every observable signal (context
 * clock advances, the sink element neither rejects play() nor stalls)
 * while nothing reaches PipeWire, so no probe can be trusted there.
 * The WAV pipeline is the one every other audio surface uses and is
 * known audible. Debug override (per-profile, no rebuild):
 * `localStorage["tokori:pcm-gapless"]` — "1" forces the gapless
 * attempt, "0" forces WAV, unset → platform default.
 *
 * Fallbacks when the gapless path IS attempted, in order:
 *   1. MediaStream sink unavailable / play() refused → schedule into
 *      `ctx.destination` directly (healthy on non-Linux platforms).
 *   2. Probe failure ~1 s after the first chunk — context clock stuck
 *      (context never renders) OR the sink element's own clock stuck
 *      (element accepted play() but never actually started, i.e. the
 *      graph renders into a void) → permanent switch to the
 *      WAV/HTMLAudioElement batching pipeline, replaying what was
 *      scheduled so far — the reply is delayed, not lost. Choppier,
 *      but audible on every build.
 *
 * Construct SYNCHRONOUSLY in a click handler — the same hard-won
 * invariant as the hooks' capture contexts: an AudioContext created
 * after an await can land "suspended" with no user activation left to
 * resume it (and the sink element's play() needs that activation too).
 */

import { isTauri } from "@tauri-apps/api/core";

export type PcmStreamPlayer = {
  /** Queue a chunk of mono int16 PCM (at the constructor's sample
   *  rate) for seamless playback. */
  enqueue(pcm: Int16Array): void;
  /** Turn boundary: make sure everything buffered becomes audible.
   *  No-op on the gapless path (chunks are already scheduled); flushes
   *  the partial WAV batch on the fallback path. */
  flush(): void;
  /** Barge-in: stop playback and drop everything queued. Never fires
   *  onDrain. */
  clear(): void;
  /** clear() + close the AudioContext. The player is unusable after. */
  destroy(): void;
  /** Fires when everything queued has finished playing and nothing new
   *  arrived — the hooks' "assistant turn fully spoken" signal. */
  onDrain: (() => void) | null;
};

/** Scheduling pad at the start of a burst — absorbs jitter between the
 *  decode tick and the audio clock without adding audible latency. */
const PRIME_PAD_S = 0.06;
/** How long after the first scheduled chunk to check that the context
 *  clock actually advances. */
const PROBE_AFTER_MS = 1000;
/** Fallback path: flush pending PCM into a playable WAV once ~1 s has
 *  accumulated (same trade the old Gemini pipeline made). */
const FALLBACK_FLUSH_SECONDS = 1;

/** Debug override for the pipeline choice (see module docs). */
const GAPLESS_OVERRIDE_KEY = "tokori:pcm-gapless";

/** Whether to skip Web Audio entirely and batch WAVs from the start.
 *  True on the Linux desktop build (Tauri → WebKit2GTK), where the
 *  gapless graph can report healthy on every observable signal while
 *  producing no sound. Hosted builds in a real browser, and the
 *  macOS/Windows desktop WebViews, keep the gapless path. */
function preferWavPipeline(): boolean {
  try {
    const v = window.localStorage.getItem(GAPLESS_OVERRIDE_KEY);
    if (v === "1") return false;
    if (v === "0") return true;
  } catch {
    /* storage disabled — fall through to the platform default */
  }
  return isTauri() && navigator.userAgent.includes("Linux");
}

export function createPcmStreamPlayer(opts: {
  sampleRate: number;
  /** Playback rate, read per chunk so a mid-session speed change
   *  applies from the next chunk. */
  rate?: () => number;
}): PcmStreamPlayer {
  const { sampleRate } = opts;
  const rateOf = () => {
    const r = opts.rate?.() ?? 1;
    return Number.isFinite(r) && r > 0 ? r : 1;
  };

  const wavOnly = preferWavPipeline();
  const ctx = wavOnly ? null : new AudioContext();
  if (ctx) void ctx.resume().catch(() => {});

  let destroyed = false;
  let fallback = wavOnly;
  let nextTime = 0;
  const active = new Set<AudioBufferSourceNode>();
  // Chunks scheduled but not yet proven audible. Replayed through the
  // fallback if the probe finds the clock stuck; dropped once it passes.
  let limbo: Int16Array[] | null = wavOnly ? null : [];
  let probeTimer: ReturnType<typeof setTimeout> | null = null;

  // Media-element sink (see module docs). Falls back to
  // ctx.destination when the stream sink can't be built or refuses to
  // play — and to full WAV batching if the probe finds either clock
  // stuck.
  let sinkNode: AudioNode | null = ctx ? ctx.destination : null;
  let sinkEl: HTMLAudioElement | null = null;
  if (ctx) {
    try {
      const streamDest = ctx.createMediaStreamDestination();
      const el = new Audio();
      el.srcObject = streamDest.stream;
      void el.play().catch(() => {
        // Playout refused (activation lost, element failure). Scheduled
        // audio would be inaudible through this element — reroute.
        switchToFallback("media sink play() rejected");
      });
      sinkNode = streamDest;
      sinkEl = el;
    } catch {
      /* createMediaStreamDestination/srcObject unsupported — direct out */
    }
  }

  function teardownSinkEl() {
    if (!sinkEl) return;
    try {
      sinkEl.pause();
    } catch {
      /* already stopped */
    }
    sinkEl.srcObject = null;
    sinkEl = null;
  }

  /** Permanent (per player) switch to the WAV/HTMLAudio pipeline —
   *  the context isn't reaching the speakers. Replays every chunk not
   *  yet proven audible so the reply is delayed rather than lost. */
  function switchToFallback(reason: string) {
    if (destroyed || fallback) return;
    console.warn(`[pcm-player] ${reason} — falling back to WAV/HTMLAudio batching`);
    fallback = true;
    stopAllScheduled();
    teardownSinkEl();
    const replay = limbo ?? [];
    limbo = null;
    for (const pcm of replay) fbPending.push(pcm);
    fbPendingSamples = replay.reduce((n, c) => n + c.length, 0);
    // Make the buffered opening audible immediately — don't sit on it
    // until the next threshold crossing.
    fbFlush();
  }

  function fireDrain() {
    if (!destroyed) player.onDrain?.();
  }

  // ── Gapless scheduled path ─────────────────────────────────────────

  function scheduleChunk(pcm: Int16Array) {
    if (!ctx || !sinkNode) return;
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      f32[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);
    }
    // Buffers carry their own sample rate; the context resamples to
    // the device rate on playback, so no manual conversion needed.
    const buffer = ctx.createBuffer(1, f32.length, sampleRate);
    buffer.getChannelData(0).set(f32);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const rate = rateOf();
    // BufferSource rate shifts pitch with speed — unavoidable on this
    // pipeline, mild within the offered 0.75–1.5×.
    src.playbackRate.value = rate;
    src.connect(sinkNode);
    const at = Math.max(ctx.currentTime + PRIME_PAD_S, nextTime);
    nextTime = at + buffer.duration / rate;
    active.add(src);
    src.onended = () => {
      active.delete(src);
      if (!fallback && active.size === 0) fireDrain();
    };
    try {
      src.start(at);
    } catch {
      active.delete(src);
    }
  }

  function stopAllScheduled() {
    // Detach onended BEFORE stopping so a barge-in clear can't fire a
    // spurious drain for a turn the caller is already unwinding.
    for (const s of Array.from(active)) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    active.clear();
    nextTime = 0;
  }

  function armProbe() {
    if (probeTimer != null || fallback || destroyed || limbo == null || !ctx)
      return;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (destroyed || fallback) return;
      const ctxAlive = ctx.currentTime > 0.05;
      // A healthy MediaStream-backed sink element advances its own
      // clock from the moment play() succeeds — the stream is live
      // even while only silence is scheduled, and the element was
      // created ≥1 s before this probe. One still sitting at ~0
      // accepted play() but never actually started: the graph is
      // rendering into a void and the scheduled audio is inaudible.
      const sinkAlive = !sinkEl || sinkEl.currentTime > 0.05;
      if (ctxAlive && sinkAlive) {
        // Both clocks advancing → the path renders on this build. The
        // safety copy can go.
        limbo = null;
        return;
      }
      switchToFallback(
        ctxAlive
          ? "media sink element clock stuck"
          : "AudioContext clock stuck",
      );
    }, PROBE_AFTER_MS);
  }

  // ── Fallback path: WAV batches through HTMLAudioElement ───────────
  // Byte-for-byte the pipeline the Gemini hooks used to inline; every
  // other audio surface in the app (TTS, previews) shares it, so it's
  // known to reach the sink on the builds where Web Audio doesn't.

  let fbPending: Int16Array[] = [];
  let fbPendingSamples = 0;
  const fbQueue: string[] = [];
  let fbPlaying = false;
  let fbCurrent: HTMLAudioElement | null = null;

  function fbEnqueue(pcm: Int16Array) {
    fbPending.push(pcm);
    fbPendingSamples += pcm.length;
    if (fbPendingSamples >= sampleRate * FALLBACK_FLUSH_SECONDS) fbFlush();
  }

  function fbFlush() {
    if (fbPending.length === 0) return;
    let total = 0;
    for (const p of fbPending) total += p.length;
    const samples = new Int16Array(total);
    let off = 0;
    for (const p of fbPending) {
      samples.set(p, off);
      off += p.length;
    }
    fbPending = [];
    fbPendingSamples = 0;
    fbQueue.push(URL.createObjectURL(pcmToWav(samples, sampleRate)));
    if (!fbPlaying) fbPlayNext();
  }

  function fbPlayNext() {
    if (fbPlaying || destroyed) return;
    const url = fbQueue.shift();
    if (!url) {
      if (fbPending.length === 0) fireDrain();
      return;
    }
    fbPlaying = true;
    const audio = new Audio(url);
    audio.playbackRate = rateOf();
    (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch =
      true;
    fbCurrent = audio;
    const advance = () => {
      URL.revokeObjectURL(url);
      if (fbCurrent === audio) fbCurrent = null;
      fbPlaying = false;
      fbPlayNext();
    };
    audio.onended = advance;
    audio.onerror = advance;
    void audio.play().catch(advance);
  }

  function fbClear() {
    for (const url of fbQueue) URL.revokeObjectURL(url);
    fbQueue.length = 0;
    fbPending = [];
    fbPendingSamples = 0;
    if (fbCurrent) {
      fbCurrent.onended = null;
      fbCurrent.onerror = null;
      try {
        fbCurrent.pause();
      } catch {
        /* already stopped */
      }
      fbCurrent.src = "";
      fbCurrent = null;
    }
    fbPlaying = false;
  }

  // ── Public surface ─────────────────────────────────────────────────

  const player: PcmStreamPlayer = {
    onDrain: null,
    enqueue(pcm: Int16Array) {
      if (destroyed || pcm.length === 0) return;
      if (fallback) {
        fbEnqueue(pcm);
        return;
      }
      if (limbo) limbo.push(pcm);
      scheduleChunk(pcm);
      armProbe();
    },
    flush() {
      if (destroyed) return;
      if (fallback) fbFlush();
      // Gapless path: chunks are already scheduled; nothing to force.
    },
    clear() {
      if (limbo) limbo = [];
      stopAllScheduled();
      fbClear();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (probeTimer != null) clearTimeout(probeTimer);
      probeTimer = null;
      stopAllScheduled();
      teardownSinkEl();
      fbClear();
      if (ctx && ctx.state !== "closed") void ctx.close();
    },
  };
  return player;
}

/** Wrap mono Int16 PCM in a minimal RIFF/WAVE container so it can be
 *  played through an HTMLAudioElement. */
function pcmToWav(samples: Int16Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits/sample
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  // Int16 little-endian — same byte order JS uses natively.
  new Int16Array(buf, 44, samples.length).set(samples);
  return new Blob([buf], { type: "audio/wav" });
}
