/**
 * Speech-to-text helpers.
 *
 * Two engines:
 *   - **Browser** — Web Speech API (`webkitSpeechRecognition`). Works
 *     on Edge WebView2 / Chrome / Safari. Does NOT work in Tauri's
 *     WebKitGTK webview on Linux.
 *   - **Whisper** — record with MediaRecorder, POST the blob to a
 *     provider's `/v1/audio/transcriptions` endpoint. Slower than
 *     browser STT but works anywhere a key works.
 *
 * Provider compatibility for Whisper: anything OpenAI-compatible.
 * That includes OpenAI itself (`whisper-1`), Groq (`whisper-large-v3-turbo`,
 * fast + free tier), and most OpenAI-compatible aggregators. We
 * dispatch on `baseUrl` to pick the right model name; users can
 * override via the provider config later if we want.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ProviderConfig } from "./db";

// ── Engine availability ──────────────────────────────────────────────

/** Hard ceiling on a single dictation take. Whisper uploads are paid
 *  per second and MediaRecorder happily fills memory forever if a
 *  user walks away mid-recording — callers auto-stop at this mark. */
export const MAX_DICTATION_MS = 5 * 60_000;

export type SttEngine = "browser" | "whisper" | "local" | "none";

/** Resolve which dictation engine a surface should actually use given
 *  the user's Settings → Voice choice and what's available right now.
 *  "auto" prefers the instant browser engine, then a downloaded local
 *  Whisper model (free, private, offline), then the metered API — the
 *  ordering that matters on Linux, where WebKitGTK has no Web Speech
 *  API at all. */
export function resolveSttEngine(
  choice: "auto" | "browser" | "whisper" | "local",
  browserAvailable: boolean,
  whisperProvider: ProviderConfig | null,
  localModelReady: boolean,
): SttEngine {
  if (choice === "browser") return browserAvailable ? "browser" : "none";
  if (choice === "whisper") return whisperProvider ? "whisper" : "none";
  if (choice === "local") return localModelReady ? "local" : "none";
  if (browserAvailable) return "browser";
  if (localModelReady) return "local";
  if (whisperProvider) return "whisper";
  return "none";
}

export function isBrowserSTTAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** A provider counts as Whisper-capable if it's openai-kind (the same
 *  family the desktop already speaks for chat) and has an api key. */
export function findWhisperProvider(
  providers: ProviderConfig[],
): ProviderConfig | null {
  return (
    providers.find(
      (p) => p.kind === "openai" && !!p.apiKey && !!p.apiKey.trim(),
    ) ?? null
  );
}

// ── Whisper transcription ───────────────────────────────────────────

/** Pick the right whisper model id for the given provider. Heuristic
 *  on `baseUrl` — Groq's API needs `whisper-large-v3-turbo`, OpenAI
 *  defaults to `whisper-1`. Users can later override via env / config. */
export function whisperModelFor(p: ProviderConfig): string {
  const url = (p.baseUrl ?? "").toLowerCase();
  if (url.includes("groq.")) return "whisper-large-v3-turbo";
  return "whisper-1";
}

export type TranscribeResult = { text: string };

/** Upload audio bytes to the provider's /v1/audio/transcriptions
 *  endpoint and return the transcript. Throws on non-2xx upstream. */
export async function transcribeWhisper(
  audio: Blob,
  config: ProviderConfig,
  options: { lang?: string } = {},
): Promise<TranscribeResult> {
  if (config.kind !== "openai") {
    throw new Error(
      `Provider "${config.label}" doesn't expose a Whisper-compatible transcription endpoint.`,
    );
  }
  const baseUrl = (config.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  const fd = new FormData();
  // Filename matters: OpenAI/Groq sniff the format from the extension.
  // MediaRecorder usually emits webm/opus; our defaults below match.
  const filename = audio.type.includes("ogg") ? "speech.ogg" : "speech.webm";
  fd.append("file", audio, filename);
  fd.append("model", whisperModelFor(config));
  // `language` accepts ISO 639-1 ("en", "zh", "de", …). Strip any
  // BCP-47 region suffix the caller passed.
  if (options.lang) {
    fd.append("language", options.lang.split("-")[0]);
  }
  fd.append("response_format", "json");

  const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Whisper ${res.status}: ${text.slice(0, 200) || res.statusText}`,
    );
  }
  const data = (await res.json()) as { text?: string };
  return { text: (data.text ?? "").trim() };
}

// ── Recorder lifecycle ──────────────────────────────────────────────

/** Enumerate the user's audio-input devices. Browsers populate
 *  `MediaDeviceInfo.label` only AFTER the user has granted mic
 *  permission at least once — so on first call we open the mic
 *  briefly (immediately stopping the stream) to claim that
 *  permission, then re-enumerate so the labels are filled in. The
 *  permission ride is a known no-op once it's already been granted,
 *  so subsequent calls return the labelled list immediately. */
export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  let devices = await navigator.mediaDevices.enumerateDevices();
  let inputs = devices.filter((d) => d.kind === "audioinput");
  if (inputs.length > 0 && !inputs[0].label) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices.filter((d) => d.kind === "audioinput");
    } catch {
      /* permission denied — caller still gets unlabelled list */
    }
  }
  return inputs;
}

export type RecorderHandle = {
  /** Stop recording and resolve with the captured blob. Idempotent. */
  stop: () => Promise<Blob>;
  /** Same as stop, but discards the blob (useful for "Cancel"). */
  cancel: () => void;
  /** Live MediaStream so callers can attach a VAD / level meter
   *  alongside the recorder without re-requesting mic permission.
   *  Null on platforms where we couldn't open the stream (the
   *  recorder error path already handles those before this point). */
  stream: MediaStream;
};

/** Start a microphone recording. Returns a handle whose `stop()` resolves
 *  with the captured audio blob.
 *
 *  We pick a mime-type the browser actually supports — MediaRecorder is
 *  surprisingly inconsistent here. Chromium prefers webm/opus; Safari
 *  prefers mp4; WebKitGTK supports webm/opus. The default ("") lets
 *  the browser pick what it can record.
 */
export async function startRecording(
  options: { deviceId?: string } = {},
): Promise<RecorderHandle> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    throw new Error("Microphone capture isn't available in this environment.");
  }
  // Honour the caller's device pick. We use `deviceId.exact` so the
  // browser fails fast (NotFoundError / OverconstrainedError) when
  // the requested mic has been unplugged or its id rotated, instead
  // of silently falling back to whatever the OS calls default. The
  // call site can catch + re-prompt with the latest enumeration.
  const audio: MediaTrackConstraints | true = options.deviceId
    ? { deviceId: { exact: options.deviceId } }
    : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  // Try webm/opus first (best for whisper APIs), fall back to default.
  const preferredMimes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"];
  let mimeType = "";
  for (const mt of preferredMimes) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported?.(mt)
    ) {
      mimeType = mt;
      break;
    }
  }
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  let stopped = false;
  const stoppedPromise = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, {
        type: mimeType || "audio/webm",
      });
      resolve(blob);
    };
  });
  recorder.start();

  return {
    stream,
    async stop() {
      if (stopped) return stoppedPromise;
      stopped = true;
      if (recorder.state !== "inactive") recorder.stop();
      return stoppedPromise;
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      if (recorder.state !== "inactive") recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

// ── Local Whisper (on-device whisper.cpp) ───────────────────────────
//
// The Rust side (`whisper_local.rs`) runs whisper.cpp on 16 kHz mono
// int16 PCM, so instead of MediaRecorder (webm/opus — Rust would need
// a codec stack) we capture raw PCM through an AudioWorklet, exactly
// like the realtime live-voice pipelines do, and ship the buffer over
// IPC as base64.

export const LOCAL_WHISPER_SAMPLE_RATE = 16_000;

const PCM_WORKLET = `
class TokoriPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const f32 = input[0];
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(i16.buffer, [i16.buffer]);
    }
    return true;
  }
}
registerProcessor('tokori-pcm-capture', TokoriPcmCapture);
`;

export type PcmRecorderHandle = {
  /** Stop capturing and resolve with the whole take as 16 kHz mono
   *  int16 samples. Idempotent. */
  stop: () => Promise<Int16Array>;
  /** Stop and discard the take. */
  cancel: () => void;
  /** Live stream for waveform taps — same contract as RecorderHandle. */
  stream: MediaStream;
};

/** Start a raw-PCM microphone recording for the local Whisper engine.
 *  The AudioContext is created at 16 kHz so the browser does the
 *  resampling; whisper.cpp gets exactly the rate it wants. */
export async function startPcmRecording(
  options: { deviceId?: string } = {},
): Promise<PcmRecorderHandle> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    throw new Error("Microphone capture isn't available in this environment.");
  }
  const audio: MediaTrackConstraints | true = options.deviceId
    ? { deviceId: { exact: options.deviceId } }
    : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const ctx = new AudioContext({ sampleRate: LOCAL_WHISPER_SAMPLE_RATE });
  void ctx.resume().catch(() => {});
  const blobUrl = URL.createObjectURL(
    new Blob([PCM_WORKLET], { type: "application/javascript" }),
  );
  try {
    await ctx.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "tokori-pcm-capture");
  const chunks: Int16Array[] = [];
  node.port.onmessage = (e: MessageEvent) => {
    chunks.push(new Int16Array(e.data as ArrayBuffer));
  };
  source.connect(node);
  // The worklet writes no output — this connection only keeps the
  // graph pulling; the destination hears silence.
  node.connect(ctx.destination);

  let finished = false;
  function teardown() {
    try {
      node.disconnect();
    } catch {
      /* already gone */
    }
    try {
      source.disconnect();
    } catch {
      /* already gone */
    }
    if (ctx.state !== "closed") void ctx.close();
    stream.getTracks().forEach((t) => t.stop());
  }

  return {
    stream,
    async stop() {
      if (!finished) {
        finished = true;
        teardown();
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Int16Array(total);
      let offset = 0;
      for (const c of chunks) {
        pcm.set(c, offset);
        offset += c.length;
      }
      return pcm;
    },
    cancel() {
      if (finished) return;
      finished = true;
      teardown();
      chunks.length = 0;
    },
  };
}

/** Run a PCM take through the local whisper.cpp model. The model must
 *  already be downloaded (see lib/whisper-local.ts); Rust returns a
 *  user-facing error message otherwise. */
export async function transcribeLocalWhisper(
  pcm: Int16Array,
  options: { model: string; lang?: string },
): Promise<TranscribeResult> {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)),
    );
  }
  const text = await invoke<string>("whisper_local_transcribe", {
    model: options.model,
    pcmB64: btoa(binary),
    // Same ISO 639-1 trim the API path does.
    lang: options.lang ? options.lang.split("-")[0] : null,
  });
  return { text: text.trim() };
}
