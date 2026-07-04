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

import type { ProviderConfig } from "./db";

// ── Engine availability ──────────────────────────────────────────────

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
