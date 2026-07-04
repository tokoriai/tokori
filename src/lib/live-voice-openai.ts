/**
 * OpenAI Realtime API client. Same public shape as `useLiveVoice` so
 * `InlineLiveMode` can pick between providers without restructuring its
 * UI.
 *
 * Protocol differences vs Gemini Live we have to handle here:
 *   - URL: wss://api.openai.com/v1/realtime?model=<model>
 *   - Browser WebSocket can't set Authorization headers, so OpenAI
 *     accepts the key via the WebSocket subprotocol negotiation. The
 *     "insecure" prefix in the protocol name is OpenAI's naming —
 *     they're flagging that the key is exposed to the network layer.
 *     For a local desktop app that's fine (same profile as the
 *     Gemini ?key=… we're already doing); for a server-fronted web
 *     deployment you'd mint ephemeral session tokens instead.
 *   - Audio: 24 kHz PCM16 in BOTH directions (Gemini was 16 k in / 24 k
 *     out). Mic AudioContext runs at 24 k.
 *   - Server VAD does end-of-turn detection; we don't have to commit
 *     buffers manually.
 *   - Event shapes: response.audio.delta carries the audio bytes,
 *     response.audio_transcript.delta the text. Final user transcript
 *     arrives via conversation.item.input_audio_transcription.completed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { liveVoiceRate } from "./live-voice-rate";

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

type Options = {
  apiKey: string;
  /** Realtime model id, e.g. "gpt-4o-mini-realtime-preview-2024-12-17"
   *  or "gpt-realtime". The Settings UI exposes a list, but any string
   *  the user types is forwarded. */
  model: string;
  systemPrompt: string;
  /** OpenAI voice name (alloy / echo / fable / onyx / shimmer / ash /
   *  ballad / coral / sage / verse). Defaults to alloy. */
  voiceName?: string;
  /** Input transcription model — feeds the live user-caption bubble.
   *  Defaults to "gpt-realtime-whisper" (the new whisper-style model in
   *  the GA Realtime stack). "whisper-1" is kept available for users on
   *  the legacy preview models. */
  transcriptionModel?: OpenAITranscriptionModel;
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

function int16ToFloat32(int16: Int16Array): Float32Array {
  const f = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    f[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  }
  return f;
}

export function useOpenAILiveVoice() {
  const [state, setState] = useState<LiveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackQueueRef = useRef<Float32Array[]>([]);
  const playingRef = useRef(false);
  const userBufRef = useRef("");
  const asstBufRef = useRef("");
  const stateRef = useRef<LiveState>("idle");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    if (playbackQueueRef.current.length === 0) {
      if (stateRef.current === "speaking") {
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
    const data = playbackQueueRef.current.shift()!;
    const ctx = playbackCtxRef.current!;
    const buffer = ctx.createBuffer(1, data.length, 24000);
    buffer.getChannelData(0).set(data);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // User-adjustable speed. BufferSource rate shifts pitch with it —
    // unavoidable on this pipeline, mild within the offered 0.75–1.5×.
    src.playbackRate.value = liveVoiceRate.current;
    src.connect(ctx.destination);
    src.onended = () => {
      playingRef.current = false;
      playNext();
    };
    src.start();
  }, []);

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
    if (playbackCtxRef.current && playbackCtxRef.current.state !== "closed") {
      void playbackCtxRef.current.close();
    }
    playbackCtxRef.current = null;
    playbackQueueRef.current = [];
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
    async (opts: Options) => {
      setError(null);
      setTurns([]);
      setLiveUser("");
      setLiveAssistant("");
      userBufRef.current = "";
      asstBufRef.current = "";
      setState("connecting");

      try {
        // 1. Mic permission. We ask for 24 kHz to match OpenAI's
        // Realtime audio format directly — saves a resampling step.
        // The browser will negotiate the closest hardware rate.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 24000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;

        // 2. AudioContexts — capture and playback both at 24 k for
        // OpenAI Realtime.
        const audioCtx = new AudioContext({ sampleRate: 24000 });
        audioCtxRef.current = audioCtx;
        const playbackCtx = new AudioContext({ sampleRate: 24000 });
        playbackCtxRef.current = playbackCtx;
        if (playbackCtx.state === "suspended") await playbackCtx.resume();

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

        // 4. WebSocket → OpenAI Realtime.
        //
        // Browser WebSocket can't set HTTP headers, so OpenAI takes the
        // API key via the subprotocol list. The "openai-insecure-api-key"
        // protocol name is OpenAI's own — it signals "this key is
        // travelling in the URL/protocol, not in a server-side
        // Authorization header." For a local desktop app where the
        // user's key is already on this machine, the risk profile is
        // identical to the Gemini ?key=… we're already doing.
        const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(opts.model)}`;
        const ws = new WebSocket(wsUrl, [
          "realtime",
          `openai-insecure-api-key.${opts.apiKey}`,
          "openai-beta.realtime-v1",
        ]);
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
          // session.update is how Realtime config is set. We pick:
          //   - server_vad so OpenAI handles end-of-turn detection
          //   - input_audio_transcription with the user's chosen model
          //     (defaults to gpt-realtime-whisper — the new whisper-style
          //     transcription model OpenAI shipped alongside GA gpt-realtime)
          //     so we get the user's spoken text back as a final transcript
          //   - voice from opts (alloy default)
          //   - instructions from opts.systemPrompt
          const sessionUpdate = {
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              voice: opts.voiceName ?? "alloy",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: {
                model: opts.transcriptionModel ?? "gpt-realtime-whisper",
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
              // User started talking. If the assistant was speaking,
              // OpenAI will deliver a `response.cancelled` shortly;
              // we drop the playback queue here so audio cuts cleanly.
              playbackQueueRef.current = [];
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
            case "response.audio.delta": {
              if (stateRef.current !== "speaking") setState("speaking");
              try {
                const ab = base64ToArrayBuffer(msg.delta);
                const i16 = new Int16Array(ab);
                playbackQueueRef.current.push(int16ToFloat32(i16));
                if (!playingRef.current) playNext();
              } catch {}
              return;
            }
            case "response.audio_transcript.delta":
              asstBufRef.current += msg.delta ?? "";
              setLiveAssistant(asstBufRef.current);
              return;
            case "response.audio_transcript.done":
              // Text finalised; audio may still be playing — let
              // playNext flush the turn into `turns` when the queue
              // drains, same pattern as the Gemini hook.
              return;
            case "response.done":
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
            // bad auth. We don't try to enumerate every code.
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
    [cleanup, playNext],
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

/** OpenAI Realtime voice catalogue. Free-form on the wire — these are
 *  the names OpenAI publishes; any string forward-compatible. */
export const OPENAI_LIVE_VOICES: Array<{ name: string; blurb: string }> = [
  { name: "alloy", blurb: "neutral, clear (default)" },
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

/** Realtime model ids OpenAI exposes. `gpt-realtime` is the GA flagship;
 *  `gpt-realtime-mini` is the cheap GA variant; preview ids are kept
 *  for users on older subscriptions. Input transcription is picked
 *  separately via `OPENAI_TRANSCRIPTION_MODELS`. */
export const OPENAI_LIVE_MODELS: string[] = [
  "gpt-realtime",
  "gpt-realtime-mini",
  "gpt-4o-realtime-preview-2024-12-17",
  "gpt-4o-mini-realtime-preview-2024-12-17",
];
