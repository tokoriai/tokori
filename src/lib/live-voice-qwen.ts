/**
 * Qwen Realtime (Alibaba DashScope) client. Same public shape as
 * `useLiveVoice` / `useOpenAILiveVoice` so `InlineLiveMode` can pick
 * between providers without restructuring its UI.
 *
 * DashScope's realtime surface is OpenAI-Realtime-API compatible — the
 * event names, session.update shape, and server-VAD flow all match —
 * so this client mirrors `live-voice-openai.ts` with the Qwen specifics
 * folded in:
 *
 *   - URL: wss://dashscope[-intl].aliyuncs.com/api-ws/v1/realtime?model=…
 *     Two regions; DashScope keys are region-bound, so the caller picks
 *     (derived from the provider row's base URL in the live-mode UI).
 *   - Auth: DashScope requires an `Authorization: Bearer` HEADER on the
 *     upgrade request — the browser WebSocket API can't set one (the
 *     OpenAI-style subprotocol trick gets a 1006 here), so on desktop
 *     we connect through tauri-plugin-websocket, whose Rust client
 *     attaches real headers. The browser path (npm run dev, no Tauri)
 *     keeps the subprotocol attempt as a best-effort fallback.
 *   - Audio: 16 kHz PCM16 in (Qwen-Omni's expected input rate),
 *     24 kHz PCM16 out.
 *   - Input transcription: DashScope's gummy-realtime-v1 ASR feeds the
 *     live user-caption bubble.
 *   - Event names: handles both the legacy ("response.audio.delta") and
 *     the renamed GA ("response.output_audio.delta") spellings so a
 *     server-side protocol bump doesn't silently mute the client.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
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

export type QwenRegion = "intl" | "cn";

type Options = {
  apiKey: string;
  /** Realtime model id, e.g. "qwen3-omni-flash-realtime". */
  model: string;
  systemPrompt: string;
  /** Qwen-Omni voice name (Cherry / Serena / Ethan / Chelsie). */
  voiceName?: string;
  /** DashScope region — keys are region-bound. Defaults to "intl". */
  region?: QwenRegion;
  /** Specific microphone to capture from; OS default when omitted. */
  deviceId?: string;
};

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

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

function wsUrlFor(region: QwenRegion, model: string): string {
  const host =
    region === "cn"
      ? "dashscope.aliyuncs.com"
      : "dashscope-intl.aliyuncs.com";
  return `wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
}

/** Minimal common surface over the two transports (Tauri plugin socket
 *  with header auth, browser WebSocket with subprotocol auth) so the
 *  event plumbing below is written once. */
type LiveSocket = {
  send: (data: string) => void;
  close: () => void;
};

export function useQwenLiveVoice() {
  const [state, setState] = useState<LiveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");

  const sockRef = useRef<LiveSocket | null>(null);
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
    try {
      sockRef.current?.close();
    } catch {}
    sockRef.current = null;
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
    async (opts: Options) => {
      setError(null);
      setTurns([]);
      setLiveUser("");
      setLiveAssistant("");
      userBufRef.current = "";
      asstBufRef.current = "";
      setState("connecting");

      try {
        // Playback player, created SYNCHRONOUSLY before any await so
        // it inherits the click's user activation — the same invariant
        // the Gemini/OpenAI hooks follow. onDrain commits the finished
        // assistant turn.
        playerRef.current?.destroy();
        const player = createPcmStreamPlayer({
          sampleRate: OUTPUT_SAMPLE_RATE,
          rate: () => liveVoiceRate.current,
        });
        player.onDrain = () => {
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

        // 1. Mic permission @16 kHz — Qwen-Omni's input rate. The
        // browser negotiates the closest hardware rate; the capture
        // AudioContext below enforces 16 k on the samples we send.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
            sampleRate: INPUT_SAMPLE_RATE,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;

        // 2. Capture AudioContext — 16 k (playback lives in the player).
        const audioCtx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
        audioCtxRef.current = audioCtx;

        // 3. AudioWorklet for PCM capture
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
        worklet.connect(audioCtx.destination);

        // 4. Socket → DashScope Realtime (OpenAI-compatible protocol).
        const wsUrl = wsUrlFor(opts.region ?? "intl", opts.model);

        const setupTimeout = setTimeout(() => {
          if (stateRef.current === "connecting") {
            setError(
              "Voice connection timed out — check your DashScope API key, that Model Studio is activated, and that the key's region matches (intl vs mainland China).",
            );
            cleanup();
            setState("error");
          }
        }, 15000);

        // Fires once the socket is up: configure the session, then
        // start streaming mic PCM (server VAD commits the turns).
        const handleOpen = () => {
          const sessionUpdate = {
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              voice: opts.voiceName ?? "Cherry",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              // DashScope's streaming ASR — feeds the live user caption.
              input_audio_transcription: {
                model: "gummy-realtime-v1",
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 700,
              },
              instructions: opts.systemPrompt,
            },
          };
          sockRef.current?.send(JSON.stringify(sessionUpdate));
          worklet.port.onmessage = (e: MessageEvent) => {
            const sock = sockRef.current;
            if (!sock) return;
            const buf = e.data as ArrayBuffer;
            sock.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: arrayBufferToBase64(buf),
              }),
            );
          };
          setState("listening");
          clearTimeout(setupTimeout);
        };

        const handleClose = (code: number, reason: string) => {
          clearTimeout(setupTimeout);
          if (stateRef.current !== "idle" && stateRef.current !== "error") {
            const tail = reason?.trim() ? ` — ${reason.trim()}` : "";
            setError(
              `Voice connection closed (${code})${tail}. Check the model name, your DashScope key, and the key's region (intl vs mainland China).`,
            );
            cleanup();
            setState("error");
          }
        };

        const handleMessage = (raw: string) => {
          let msg: any;
          try {
            msg = JSON.parse(raw);
          } catch {
            return;
          }

          switch (msg.type) {
            case "error": {
              setError(
                msg.error?.message ?? "Qwen Realtime returned an error",
              );
              cleanup();
              setState("error");
              return;
            }
            case "session.created":
            case "session.updated":
              return;
            case "input_audio_buffer.speech_started":
              // Barge-in: drop queued audio so playback cuts cleanly.
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
            // Legacy + renamed GA spellings — DashScope tracks OpenAI's
            // protocol, which renamed audio events in the GA bump.
            case "response.audio.delta":
            case "response.output_audio.delta": {
              if (stateRef.current !== "speaking") setState("speaking");
              try {
                const ab = base64ToArrayBuffer(msg.delta);
                player.enqueue(new Int16Array(ab));
              } catch {}
              return;
            }
            case "response.audio_transcript.delta":
            case "response.output_audio_transcript.delta":
              asstBufRef.current += msg.delta ?? "";
              setLiveAssistant(asstBufRef.current);
              return;
            case "response.audio_transcript.done":
            case "response.output_audio_transcript.done":
              // Text finalised; audio may still be playing — the
              // player's onDrain flushes the turn when playback ends.
              return;
            case "response.done":
              // Response boundary — surface any sub-threshold tail on
              // the player's fallback path (no-op when gapless).
              player.flush();
              return;
          }
        };

        if (isTauri()) {
          // Desktop: connect from Rust so the Authorization header
          // actually reaches DashScope. connect() resolving = the
          // upgrade succeeded; a rejection carries the HTTP error.
          const TauriWebSocket = (await import("@tauri-apps/plugin-websocket"))
            .default;
          let conn: Awaited<ReturnType<typeof TauriWebSocket.connect>>;
          try {
            conn = await TauriWebSocket.connect(wsUrl, {
              headers: { Authorization: `Bearer ${opts.apiKey}` },
            });
          } catch (err) {
            clearTimeout(setupTimeout);
            const msg = err instanceof Error ? err.message : String(err);
            setError(
              `Voice connection refused: ${msg.slice(0, 280)} — check your DashScope key, its region (intl vs mainland China), and that Model Studio is activated.`,
            );
            cleanup();
            setState("error");
            return;
          }
          sockRef.current = {
            send: (data) => {
              void conn.send(data).catch(() => {});
            },
            close: () => {
              void conn.disconnect().catch(() => {});
            },
          };
          conn.addListener((m) => {
            if (m.type === "Text" && typeof m.data === "string") {
              handleMessage(m.data);
            } else if (m.type === "Close") {
              const info = m.data as { code?: number; reason?: string } | null;
              handleClose(info?.code ?? 1006, info?.reason ?? "");
            }
          });
          handleOpen();
        } else {
          // Browser dev fallback — no header support, so try the
          // OpenAI-style subprotocol auth and surface whatever happens.
          const ws = new WebSocket(wsUrl, [
            "realtime",
            `openai-insecure-api-key.${opts.apiKey}`,
            "openai-beta.realtime-v1",
          ]);
          sockRef.current = {
            send: (data) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(data);
            },
            close: () => {
              try {
                ws.close();
              } catch {}
            },
          };
          ws.onopen = handleOpen;
          ws.onmessage = async (event) => {
            let raw: string;
            if (event.data instanceof Blob) raw = await event.data.text();
            else if (event.data instanceof ArrayBuffer)
              raw = new TextDecoder().decode(event.data);
            else raw = event.data;
            handleMessage(raw);
          };
          ws.onerror = () => {
            clearTimeout(setupTimeout);
            setError("Voice connection error.");
            cleanup();
            setState("error");
          };
          ws.onclose = (e) => handleClose(e.code, e.reason);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Couldn't start voice: ${msg}`);
        cleanup();
        setState("error");
      }
    },
    [cleanup],
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

/** Qwen-Omni realtime voice catalogue. Free-form on the wire — any
 *  string DashScope accepts is forwarded. */
export const QWEN_LIVE_VOICES: Array<{ name: string; blurb: string }> = [
  { name: "Cherry", blurb: "female, warm (default)" },
  { name: "Serena", blurb: "female, soft" },
  { name: "Ethan", blurb: "male, bright" },
  { name: "Chelsie", blurb: "female, gentle" },
];

/** Realtime model ids DashScope exposes. The flash variant is the
 *  current flagship; turbo is the earlier generation kept for accounts
 *  that still default to it. */
export const QWEN_LIVE_MODELS: string[] = [
  "qwen3-omni-flash-realtime",
  "qwen-omni-turbo-realtime",
];
