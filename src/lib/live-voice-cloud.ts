/**
 * Cloud live voice — Gemini Live via tokori-cloud-issued ephemeral
 * token.
 *
 * Same end-to-end UX as the local `useLiveVoice` hook (Gemini's
 * BidiGenerateContent WebSocket: realtime mic → realtime speech →
 * realtime audio playback, with built-in VAD and barge-in), but the
 * authentication token is minted server-side via
 * `/api/ai/v1/live/gemini/token`. The desktop never sees the raw
 * Gemini API key; it just gets a one-shot `auth_tokens/...` string
 * that's locked to the session config (model, voice, system
 * prompt). The cloud charges a flat credit cost per token, since
 * Gemini doesn't return per-turn usage we can debit incrementally.
 *
 * Why not a WebSocket proxy through the cloud: Next.js App Router
 * doesn't support WS upgrades natively, and a separate `ws` server
 * adds deploy surface we don't want yet. The ephemeral-token flow
 * is Google's documented alternative and matches what the python-
 * genai SDK does when an api_key string starts with `auth_tokens/`.
 *
 * The capture / playback / state-machine code below is a deliberate
 * port of the local `useLiveVoice` hook — kept structurally close so
 * a fix in one is easy to mirror to the other.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { liveVoiceRate } from "./live-voice-rate";
import { useCloud } from "./cloud-context";

export type CloudLiveState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

export type CloudLiveTurn = { role: "user" | "assistant"; content: string };

export type CloudLiveStartOptions = {
  /** Ignored — auth is the cloud session bearer + a server-side
   *  Gemini key. Kept on the type so InlineLiveMode can pass the
   *  same shape to all backends without branching. */
  apiKey?: string;
  /** Gemini Live model id. Falls back to the cloud's default
   *  preview model if omitted. */
  model?: string;
  /** Goes into the Gemini setup as systemInstruction. */
  systemPrompt: string;
  /** Gemini prebuilt voice id (Aoede / Charon / …). */
  voiceName?: string;
  /** Unused on the cloud-Gemini path (Gemini's audio output rate is
   *  fixed). Kept for parity with local hooks. */
  ttsLang?: string;
  sttLang?: string;
  /** Mic device id from `navigator.mediaDevices.enumerateDevices()`.
   *  Forwarded to getUserMedia. */
  deviceId?: string;
};

export type CloudLiveControls = {
  state: CloudLiveState;
  error: string | null;
  turns: CloudLiveTurn[];
  liveUser: string;
  liveAssistant: string;
  start: (opts: CloudLiveStartOptions) => Promise<void>;
  stop: () => void;
};

const WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const float32 = input[0];
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Wrap mono Int16 PCM in a minimal RIFF/WAVE container so it can
 *  be played through an HTMLAudioElement (the audio path that
 *  works reliably on Linux WebKit2GTK; AudioBufferSource has issues
 *  on that stack). Same helper the standalone Gemini hook uses. */
const PLAYBACK_SAMPLE_RATE = 24000;
const FLUSH_THRESHOLD_SAMPLES = PLAYBACK_SAMPLE_RATE; // ≈ 1s
function concatInt16(parts: Int16Array[]): Int16Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44, samples.length).set(samples);
  return new Blob([buf], { type: "audio/wav" });
}

export function useCloudLiveVoice(): CloudLiveControls {
  const cloud = useCloud();
  const [state, setState] = useState<CloudLiveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<CloudLiveTurn[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // Playback queue (HTMLAudioElement-based, see comment on pcmToWav).
  const pendingPcmRef = useRef<Int16Array[]>([]);
  const pendingSamplesRef = useRef(0);
  const wavQueueRef = useRef<string[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const playingRef = useRef(false);
  const userBufRef = useRef("");
  const asstBufRef = useRef("");
  const stateRef = useRef<CloudLiveState>("idle");
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const url = wavQueueRef.current.shift();
    if (!url) {
      if (
        stateRef.current === "speaking" &&
        pendingPcmRef.current.length === 0
      ) {
        if (asstBufRef.current.trim()) {
          const text = asstBufRef.current.trim();
          setTurns((prev) => [...prev, { role: "assistant", content: text }]);
          asstBufRef.current = "";
        }
        setLiveAssistant("");
        setState("listening");
      }
      return;
    }
    playingRef.current = true;
    const audio = new Audio(url);
    audio.playbackRate = liveVoiceRate.current;
    (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch =
      true;
    currentAudioRef.current = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (currentAudioRef.current === audio) currentAudioRef.current = null;
      playingRef.current = false;
      playNext();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (currentAudioRef.current === audio) currentAudioRef.current = null;
      playingRef.current = false;
      playNext();
    };
    void audio.play().catch(() => {
      URL.revokeObjectURL(url);
      if (currentAudioRef.current === audio) currentAudioRef.current = null;
      playingRef.current = false;
      playNext();
    });
  }, []);

  const flushPending = useCallback(() => {
    if (pendingPcmRef.current.length === 0) return;
    const samples = concatInt16(pendingPcmRef.current);
    pendingPcmRef.current = [];
    pendingSamplesRef.current = 0;
    const blob = pcmToWav(samples, PLAYBACK_SAMPLE_RATE);
    const url = URL.createObjectURL(blob);
    wavQueueRef.current.push(url);
    if (!playingRef.current) playNext();
  }, [playNext]);

  const cleanup = useCallback(() => {
    try {
      workletRef.current?.disconnect();
    } catch {}
    workletRef.current = null;
    try {
      sourceRef.current?.disconnect();
    } catch {}
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      void audioCtxRef.current.close();
    }
    audioCtxRef.current = null;
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
      } catch {}
      currentAudioRef.current.src = "";
      currentAudioRef.current = null;
    }
    for (const url of wavQueueRef.current) URL.revokeObjectURL(url);
    wavQueueRef.current = [];
    pendingPcmRef.current = [];
    pendingSamplesRef.current = 0;
    playingRef.current = false;
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      try {
        wsRef.current.close();
      } catch {}
    }
    wsRef.current = null;
  }, []);

  const stop = useCallback(() => {
    cleanup();
    userBufRef.current = "";
    asstBufRef.current = "";
    setLiveUser("");
    setLiveAssistant("");
    setState("idle");
  }, [cleanup]);

  const start = useCallback(
    async (opts: CloudLiveStartOptions) => {
      setError(null);
      setTurns([]);
      setLiveUser("");
      setLiveAssistant("");
      userBufRef.current = "";
      asstBufRef.current = "";
      setState("connecting");

      try {
        if (!cloud.account) {
          throw new Error(
            "Sign in to Tokori Cloud under Settings → Cloud first.",
          );
        }

        // Create the capture-side AudioContext SYNCHRONOUSLY, before the
        // token fetch / getUserMedia awaits below, so it inherits the
        // user activation from the click that called start(). A context
        // created *after* those awaits can land in "suspended" with no
        // live activation left to resume it — on which the mic worklet's
        // process() never runs, no audio reaches Gemini, and the tutor
        // sits silent because it never hears the user. Same hard-won
        // invariant as the BYOK Gemini hook (live-voice.ts).
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = audioCtx;

        // 1) Fetch ephemeral token from cloud (charges credits there).
        const tokenRes = await fetch(
          `${cloud.apiBase}/api/ai/v1/live/gemini/token`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${cloud.account.token}`,
            },
            body: JSON.stringify({
              model: opts.model,
              systemPrompt: opts.systemPrompt,
              voiceName: opts.voiceName,
              withTranscription: true,
            }),
          },
        );
        const tokenData = (await tokenRes.json().catch(() => ({}))) as {
          token?: string;
          wsUrl?: string;
          error?: string;
          message?: string;
          status?: number;
        };
        if (!tokenRes.ok || !tokenData.token) {
          // Map the common gate failures to actionable copy — a raw
          // "token mint failed (401): Sign in first" reads like the
          // feature is broken when it's really a session/entitlement
          // state the user can fix in two clicks.
          if (tokenRes.status === 401) {
            throw new Error(
              "Your Tokori Cloud session has expired. Sign out and back in under Settings → Cloud, then try again.",
            );
          }
          if (tokenRes.status === 403) {
            throw new Error(
              "Live voice needs an active Tokori Pro trial or subscription.",
            );
          }
          if (tokenRes.status === 402) {
            throw new Error(
              "Not enough credits for a live voice session — top up under Settings → Cloud.",
            );
          }
          throw new Error(
            `Cloud live token mint failed (${tokenRes.status})${
              tokenData.message ? `: ${tokenData.message}` : ""
            }`,
          );
        }
        // Refresh balance now — the cloud charged a flat session
        // credit when minting the token.
        void cloud.refreshBalance().catch(() => {});

        // 2) Mic + AudioContexts. Capture context fixed at 16kHz
        //    (Gemini's expected input rate).
        const audioConstraint: MediaTrackConstraints | true = opts.deviceId
          ? {
              deviceId: { exact: opts.deviceId },
              sampleRate: 16000,
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : {
              sampleRate: 16000,
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            };
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraint,
        });
        streamRef.current = stream;

        // Context was created synchronously above (before the awaits) so
        // it kept the click's activation; resume() here is a no-op when
        // it's already "running" and the safety net otherwise.
        if (audioCtx.state === "suspended") await audioCtx.resume();

        const blob = new Blob([WORKLET_CODE], {
          type: "application/javascript",
        });
        const url = URL.createObjectURL(blob);
        await audioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;
        const worklet = new AudioWorkletNode(audioCtx, "pcm-processor");
        workletRef.current = worklet;
        source.connect(worklet);
        // Sink the worklet to a muted destination — required on
        // some WebKit builds for `process()` to actually run.
        const sink = audioCtx.createGain();
        sink.gain.value = 0;
        worklet.connect(sink);
        sink.connect(audioCtx.destination);

        // 3) Open the v1alpha BidiGenerateContentConstrained
        //    WebSocket using the ephemeral token. Two non-obvious
        //    invariants of this endpoint (vs. the v1beta BYOK path):
        //
        //    a) Auth is `?access_token=`, not `?key=`. The
        //       unconstrained `BidiGenerateContent` endpoint only
        //       reads `?key=<API_KEY>` and answers an ephemeral
        //       token with `1008 unregistered callers`.
        //    b) The token's `bidiGenerateContentSetup` is the
        //       *validation envelope* for what the client may set
        //       up — it is NOT a substitute for the client's setup
        //       frame. The protocol still requires the client to
        //       send `setup` as the first message; sending audio
        //       first triggers `1007 setup must be the first message
        //       and only the first`. Gemini validates the client's
        //       setup against the token's constraints, replies with
        //       `setupComplete`, and only then accepts realtime
        //       input. We mirror the BYOK Gemini hook's flow here.
        const wsUrl = `${tokenData.wsUrl}?access_token=${encodeURIComponent(
          tokenData.token,
        )}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        // Safety net: if no `setupComplete` arrives within 15s the
        // session is wedged — could be a model id that doesn't
        // match the token's constraints, region issue, or quota
        // throttle. Same TTL the BYOK Gemini hook uses.
        const setupTimeout = window.setTimeout(() => {
          if (stateRef.current === "connecting") {
            console.warn(
              "[cloud-live/gemini] setup timed out — no setupComplete after 15s",
            );
            setError(
              "Cloud live session didn't respond. The model may be unavailable — try a different one in Settings.",
            );
            cleanup();
            setState("error");
          }
        }, 15000);

        // Build the setup frame. Same shape as the token's
        // `bidiGenerateContentSetup` so Gemini's constraint check
        // passes — model with `models/` prefix, response modality
        // under `generationConfig`, system instruction at the top
        // level alongside the transcription opt-ins.
        const setupPayload: Record<string, unknown> = {
          setup: {
            model: opts.model
              ? opts.model.startsWith("models/")
                ? opts.model
                : `models/${opts.model}`
              : "models/gemini-3.1-flash-live-preview",
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: opts.voiceName ?? "Aoede",
                  },
                },
              },
            },
            ...(opts.systemPrompt
              ? {
                  systemInstruction: {
                    parts: [{ text: opts.systemPrompt }],
                  },
                }
              : {}),
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        };

        ws.onopen = () => {
          ws.send(JSON.stringify(setupPayload));
        };

        ws.onmessage = async (event) => {
          let raw: string;
          if (event.data instanceof Blob) raw = await event.data.text();
          else if (event.data instanceof ArrayBuffer)
            raw = new TextDecoder().decode(event.data);
          else raw = event.data;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(raw);
          } catch {
            return;
          }

          if (msg.setupComplete) {
            window.clearTimeout(setupTimeout);
            setState("listening");
            // Pipe mic → ws now that Gemini is ready to accept audio.
            worklet.port.onmessage = (e: MessageEvent) => {
              if (wsRef.current?.readyState !== WebSocket.OPEN) return;
              const buf = e.data as ArrayBuffer;
              wsRef.current.send(
                JSON.stringify({
                  realtimeInput: {
                    audio: {
                      data: arrayBufferToBase64(buf),
                      mimeType: "audio/pcm;rate=16000",
                    },
                  },
                }),
              );
            };
            return;
          }

          const sc = (msg as { serverContent?: ServerContent }).serverContent;
          if (!sc) return;

          // Audio reply chunks → flush queue.
          if (sc.modelTurn?.parts) {
            for (const part of sc.modelTurn.parts) {
              if (part.inlineData?.data) {
                if (stateRef.current !== "speaking") setState("speaking");
                try {
                  const ab = base64ToArrayBuffer(part.inlineData.data);
                  const i16 = new Int16Array(ab);
                  pendingPcmRef.current.push(i16);
                  pendingSamplesRef.current += i16.length;
                  if (pendingSamplesRef.current >= FLUSH_THRESHOLD_SAMPLES) {
                    flushPending();
                  }
                } catch {}
              }
            }
          }
          if (sc.inputTranscription?.text) {
            userBufRef.current += sc.inputTranscription.text;
            setLiveUser(userBufRef.current);
          }
          if (sc.outputTranscription?.text) {
            asstBufRef.current += sc.outputTranscription.text;
            setLiveAssistant(asstBufRef.current);
          }
          if (sc.turnComplete) {
            if (userBufRef.current.trim()) {
              const t = userBufRef.current.trim();
              setTurns((prev) => [...prev, { role: "user", content: t }]);
              userBufRef.current = "";
              setLiveUser("");
            }
            flushPending();
          }
          if (sc.interrupted) {
            for (const url of wavQueueRef.current) URL.revokeObjectURL(url);
            wavQueueRef.current = [];
            pendingPcmRef.current = [];
            pendingSamplesRef.current = 0;
            if (currentAudioRef.current) {
              try {
                currentAudioRef.current.pause();
              } catch {}
              currentAudioRef.current.src = "";
              currentAudioRef.current = null;
            }
            playingRef.current = false;
            if (asstBufRef.current.trim()) {
              setTurns((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: asstBufRef.current.trim() + "…",
                },
              ]);
              asstBufRef.current = "";
              setLiveAssistant("");
            }
            setState("listening");
          }
        };

        ws.onerror = (ev) => {
          console.error("[cloud-live/gemini] ws error", ev);
          window.clearTimeout(setupTimeout);
          setError("Voice WebSocket error.");
          cleanup();
          setState("error");
        };
        ws.onclose = (ev) => {
          window.clearTimeout(setupTimeout);
          console.warn("[cloud-live/gemini] ws closed", {
            code: ev.code,
            reason: ev.reason,
            wasClean: ev.wasClean,
            state: stateRef.current,
          });
          if (stateRef.current === "connecting") {
            setError(
              `Voice setup rejected (code ${ev.code})${
                ev.reason ? ` — ${ev.reason}` : ""
              }`,
            );
            cleanup();
            setState("error");
          } else if (stateRef.current !== "idle") {
            cleanup();
            setState("idle");
          }
        };
      } catch (err) {
        console.error("[cloud-live/gemini] start failed", err);
        cleanup();
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    },
    [cloud, cleanup, flushPending],
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return { state, error, turns, liveUser, liveAssistant, start, stop };
}

// Minimal duck-typed shape of Gemini's serverContent frame so we
// don't have to depend on the SDK's type defs.
type ServerContent = {
  modelTurn?: {
    parts?: Array<{ inlineData?: { data?: string } }>;
  };
  inputTranscription?: { text?: string };
  outputTranscription?: { text?: string };
  turnComplete?: boolean;
  interrupted?: boolean;
};
