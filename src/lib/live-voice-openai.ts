/**
 * OpenAI Realtime API client. Same public shape as `useLiveVoice` so
 * `InlineLiveMode` can pick between providers without restructuring its
 * UI.
 *
 * Two backends share this file's core (`useOpenAIRealtime`):
 *   - `useOpenAILiveVoice` (here) — BYOK: the user's own key rides the
 *     WebSocket subprotocol straight to api.openai.com.
 *   - `useCloudOpenAIVoice` (live-voice-cloud-openai.ts) — Tokori
 *     Cloud mints an ephemeral client secret (the server key never
 *     reaches the client) and the same subprotocol slot carries it.
 *
 * Protocol notes (verified live against the real endpoint, 2026-07-09,
 * on gpt-realtime-2.1 and gpt-realtime-2.1-mini):
 *   - URL: wss://api.openai.com/v1/realtime?model=<model>
 *   - Browser WebSocket can't set Authorization headers, so the key —
 *     API key or ephemeral `ek_…` secret — travels in the
 *     "openai-insecure-api-key.<key>" subprotocol. The "insecure"
 *     prefix is OpenAI's naming, flagging that the key is visible to
 *     the network layer.
 *   - GA shape ONLY. The old beta protocol (the
 *     "openai-beta.realtime-v1" subprotocol + flat `session.update`
 *     fields + `response.audio.delta` events) is hard-disabled
 *     server-side since the 2.1 release — connecting with it closes
 *     `4000 beta_api_shape_disabled`. GA renames: audio config nests
 *     under `session.audio.{input,output}`, audio arrives via
 *     `response.output_audio.delta`, transcripts via
 *     `response.output_audio_transcript.delta`.
 *   - Audio: 24 kHz PCM16 in BOTH directions (Gemini was 16 k in /
 *     24 k out). Mic AudioContext runs at 24 k.
 *   - Server VAD does end-of-turn detection; we don't have to commit
 *     buffers manually. Final user transcript arrives via
 *     conversation.item.input_audio_transcription.completed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { liveVoiceRate } from "./live-voice-rate";
import {
  createPcmStreamPlayer,
  type PcmStreamPlayer,
} from "./pcm-stream-player";

export type LiveState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

export type LiveTurn = {
  role: "user" | "assistant";
  content: string;
};

export type OpenAILiveOptions = {
  /** BYOK API key. Ignored by the cloud backend (its resolver mints an
   *  ephemeral secret instead). */
  apiKey: string;
  /** Realtime model id, e.g. "gpt-realtime-2.1". The Settings UI
   *  exposes a list, but any string the user types is forwarded. */
  model: string;
  systemPrompt: string;
  /** OpenAI voice name (marin / cedar / alloy / …). Defaults to marin. */
  voiceName?: string;
  /** Input transcription model — feeds the live user-caption bubble. */
  transcriptionModel?: OpenAITranscriptionModel;
  /** Mic device. Omit for the system default. */
  deviceId?: string;
};

/** How a session reaches OpenAI: the ws URL (with ?model=) plus the
 *  subprotocol list carrying the credential. */
export type OpenAIRealtimeConnection = {
  wsUrl: string;
  protocols: string[];
};

export type OpenAITranscriptionModel =
  | "gpt-realtime-whisper"
  | "gpt-4o-transcribe"
  | "gpt-4o-mini-transcribe"
  | "whisper-1";

export const OPENAI_TRANSCRIPTION_MODELS: {
  id: OpenAITranscriptionModel;
  blurb: string;
}[] = [
  { id: "gpt-realtime-whisper", blurb: "new — recommended" },
  { id: "gpt-4o-transcribe", blurb: "accurate, slower" },
  { id: "gpt-4o-mini-transcribe", blurb: "cheap" },
  { id: "whisper-1", blurb: "legacy" },
];

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
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Shared OpenAI Realtime session driver. `resolve` supplies the
 * connection (URL + credential-bearing subprotocols) — that's the only
 * thing the BYOK and cloud backends disagree about. It may throw an
 * Error with user-facing copy (bad key, cloud gate, no credits…);
 * start() surfaces it verbatim.
 */
export function useOpenAIRealtime(
  resolve: (opts: OpenAILiveOptions) => Promise<OpenAIRealtimeConnection>,
) {
  const [state, setState] = useState<LiveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // Output playback — gapless scheduled PCM (see pcm-stream-player.ts).
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const userBufRef = useRef("");
  const asstBufRef = useRef("");
  const stateRef = useRef<LiveState>("idle");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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
    playerRef.current?.destroy();
    playerRef.current = null;
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
    async (opts: OpenAILiveOptions) => {
      setError(null);
      setTurns([]);
      setLiveUser("");
      setLiveAssistant("");
      userBufRef.current = "";
      asstBufRef.current = "";
      setState("connecting");

      try {
        // Create the capture context AND the playback player
        // SYNCHRONOUSLY, before the resolver / getUserMedia awaits
        // below, so they inherit the user activation from the click
        // that called start(). A context created *after* those awaits
        // can land in "suspended" with no live activation left to
        // resume it — the mic worklet's process() never runs and the
        // tutor sits silent. Same hard-won invariant as the Gemini
        // hooks (live-voice.ts / live-voice-cloud.ts); it matters even
        // more here because the cloud resolver adds a token round-trip
        // before the mic is touched.
        const audioCtx = new AudioContext({ sampleRate: 24000 });
        audioCtxRef.current = audioCtx;
        playerRef.current?.destroy();
        const player = createPcmStreamPlayer({
          sampleRate: 24000,
          rate: () => liveVoiceRate.current,
        });
        player.onDrain = () => {
          // Playback finished with nothing new queued → the assistant
          // turn is fully spoken. Commit it and drop back to listening.
          if (stateRef.current !== "speaking") return;
          if (asstBufRef.current.trim()) {
            const text = asstBufRef.current.trim();
            setTurns((prev) => [...prev, { role: "assistant", content: text }]);
            asstBufRef.current = "";
          }
          setLiveAssistant("");
          setState("listening");
        };
        playerRef.current = player;

        // 1. Resolve the connection (BYOK: immediate; cloud: token mint).
        const conn = await resolve(opts);

        // 2. Mic permission. We ask for 24 kHz to match OpenAI's
        // Realtime audio format directly — saves a resampling step.
        // The browser will negotiate the closest hardware rate.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
            sampleRate: 24000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;

        // 3. AudioWorklet for PCM capture
        const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        await audioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const source = audioCtx.createMediaStreamSource(stream);
        sourceRef.current = source;
        const worklet = new AudioWorkletNode(audioCtx, "pcm-processor");
        workletRef.current = worklet;
        source.connect(worklet);
        worklet.connect(audioCtx.destination);

        // 4. WebSocket → OpenAI Realtime, credential in the subprotocols.
        const ws = new WebSocket(conn.wsUrl, conn.protocols);
        wsRef.current = ws;

        const setupTimeout = setTimeout(() => {
          if (stateRef.current === "connecting") {
            setError(
              "Voice connection timed out — check your OpenAI API key and that the model name is a Realtime model.",
            );
            cleanup();
            setState("error");
          }
        }, 15000);

        ws.onopen = () => {
          // GA session.update. We pick:
          //   - server_vad so OpenAI handles end-of-turn detection
          //   - input transcription with the user's chosen model so we
          //     get the spoken text back for the caption bubble
          //   - voice + instructions from opts
          // The client's session.update is authoritative even on
          // ephemeral-secret sessions (verified live), which is why the
          // cloud token route doesn't bake any of this server-side.
          const sessionUpdate = {
            type: "session.update",
            session: {
              type: "realtime",
              output_modalities: ["audio"],
              instructions: opts.systemPrompt,
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: 24000 },
                  transcription: {
                    model: opts.transcriptionModel ?? "gpt-realtime-whisper",
                  },
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 700,
                  },
                },
                output: {
                  format: { type: "audio/pcm", rate: 24000 },
                  voice: opts.voiceName ?? "marin",
                },
              },
            },
          };
          ws.send(JSON.stringify(sessionUpdate));

          // Start streaming mic right away. Server VAD on OpenAI side
          // will commit buffers and fire response.create automatically.
          worklet.port.onmessage = (e: MessageEvent) => {
            if (wsRef.current?.readyState !== WebSocket.OPEN) return;
            const buf = e.data as ArrayBuffer;
            wsRef.current.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: arrayBufferToBase64(buf),
              }),
            );
          };
          setState("listening");
          clearTimeout(setupTimeout);
        };

        ws.onmessage = async (event) => {
          let raw: string;
          if (event.data instanceof Blob) raw = await event.data.text();
          else if (event.data instanceof ArrayBuffer)
            raw = new TextDecoder().decode(event.data);
          else raw = event.data;
          let msg: any;
          try {
            msg = JSON.parse(raw);
          } catch {
            return;
          }

          switch (msg.type) {
            case "error": {
              setError(
                msg.error?.message ?? "OpenAI Realtime returned an error",
              );
              cleanup();
              setState("error");
              return;
            }
            case "session.created":
            case "session.updated":
              return;
            case "input_audio_buffer.speech_started":
              // User started talking. Server VAD interrupts the response
              // on its side; we drop the playback queue so audio cuts
              // cleanly here too.
              player.clear();
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
              return;
            case "conversation.item.input_audio_transcription.delta":
              userBufRef.current += msg.delta ?? "";
              setLiveUser(userBufRef.current);
              return;
            case "conversation.item.input_audio_transcription.completed":
              if ((msg.transcript ?? "").trim()) {
                setTurns((prev) => [
                  ...prev,
                  { role: "user", content: msg.transcript.trim() },
                ]);
              }
              userBufRef.current = "";
              setLiveUser("");
              return;
            case "response.output_audio.delta": {
              if (stateRef.current !== "speaking") setState("speaking");
              try {
                const ab = base64ToArrayBuffer(msg.delta);
                player.enqueue(new Int16Array(ab));
              } catch {}
              return;
            }
            case "response.output_audio_transcript.delta":
              asstBufRef.current += msg.delta ?? "";
              setLiveAssistant(asstBufRef.current);
              return;
            case "response.output_audio_transcript.done":
              // Text finalised; audio may still be playing — the
              // player's onDrain flushes the turn into `turns` when
              // playback finishes, same pattern as the Gemini hook.
              return;
            case "response.done":
              // Response boundary — make any sub-threshold tail on the
              // player's fallback path audible (no-op when gapless).
              player.flush();
              return;
          }
        };

        ws.onerror = () => {
          clearTimeout(setupTimeout);
          setError("Voice connection error.");
          cleanup();
          setState("error");
        };

        ws.onclose = (e) => {
          clearTimeout(setupTimeout);
          if (stateRef.current !== "idle" && stateRef.current !== "error") {
            // Unexpected close — surface a hint based on the close code.
            // 1008 = policy violation, often "model not allowed"; 4001 =
            // bad auth; 4000 = protocol shape rejected. We don't try to
            // enumerate every code.
            setError(
              `Voice connection closed (${e.code}). Check your model name and API key.`,
            );
            cleanup();
            setState("error");
          }
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Couldn't start voice: ${msg}`);
        cleanup();
        setState("error");
      }
    },
    [cleanup, resolve],
  );

  // Best-effort cleanup on unmount.
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    state,
    error,
    turns,
    liveUser,
    liveAssistant,
    start,
    stop,
  };
}

/** BYOK connection: the user's own key straight to api.openai.com. */
async function resolveByok(
  opts: OpenAILiveOptions,
): Promise<OpenAIRealtimeConnection> {
  if (!opts.apiKey) {
    throw new Error(
      "Add your OpenAI API key under Settings → Providers first.",
    );
  }
  return {
    wsUrl: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(opts.model)}`,
    protocols: ["realtime", `openai-insecure-api-key.${opts.apiKey}`],
  };
}

export function useOpenAILiveVoice() {
  return useOpenAIRealtime(resolveByok);
}

/** OpenAI Realtime voice catalogue. Free-form on the wire — these are
 *  the names OpenAI publishes; any string forward-compatible. */
export const OPENAI_LIVE_VOICES: Array<{ name: string; blurb: string }> = [
  { name: "marin", blurb: "natural, warm (new — recommended)" },
  { name: "cedar", blurb: "deep, grounded (new)" },
  { name: "alloy", blurb: "neutral, clear" },
  { name: "ash", blurb: "warm, conversational" },
  { name: "ballad", blurb: "soft, story-telling" },
  { name: "coral", blurb: "bright, friendly" },
  { name: "echo", blurb: "male, even" },
  { name: "fable", blurb: "expressive, theatrical" },
  { name: "onyx", blurb: "deep, authoritative" },
  { name: "sage", blurb: "calm, professional" },
  { name: "shimmer", blurb: "youthful, energetic" },
  { name: "verse", blurb: "melodic, poetic" },
];

/** Realtime model ids OpenAI exposes. gpt-realtime-2.1 /
 *  gpt-realtime-2.1-mini (July 2026) are the current generation —
 *  lower latency, realtime reasoning + tool use on the mini tier.
 *  Older GA ids are kept for users who pinned them. Input
 *  transcription is picked separately via
 *  `OPENAI_TRANSCRIPTION_MODELS`. */
export const OPENAI_LIVE_MODELS: string[] = [
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
  "gpt-realtime",
  "gpt-realtime-mini",
];
