// Gemini Live (BidiGenerateContent) WebSocket client. Connects directly
// from the renderer because we have the API key locally — no Rust proxy
// needed for this provider.

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

type Options = {
  apiKey: string;
  model: string;
  systemPrompt: string;
  voiceName?: string;
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

/** Gemini Live's native output rate. Playback goes through the shared
 *  gapless PCM player (pcm-stream-player.ts), which schedules chunks
 *  on one AudioContext clock and auto-falls back to WAV/HTMLAudio
 *  batching on the WebKitGTK builds where Web Audio doesn't render. */
const PLAYBACK_SAMPLE_RATE = 24000;

export function useLiveVoice() {
  const [state, setState] = useState<LiveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  // Capture-only context (16kHz mic → AudioWorklet → WebSocket).
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
    async (opts: Options) => {
      setError(null);
      setTurns([]);
      setLiveUser("");
      setLiveAssistant("");
      userBufRef.current = "";
      asstBufRef.current = "";
      setState("connecting");

      // Create the capture-side AudioContext SYNCHRONOUSLY, before any
      // awaits, so it inherits the user activation from the click that
      // called start(). After getUserMedia user activation has expired
      // and a freshly-created context can be stuck in "suspended" with
      // no way to resume it.
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      // Playback player — created synchronously too, same activation
      // invariant. onDrain is the "assistant turn fully spoken"
      // signal: commit the transcript and drop back to listening.
      playerRef.current?.destroy();
      const player = createPcmStreamPlayer({
        sampleRate: PLAYBACK_SAMPLE_RATE,
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

      try {
        // 1. Mic permission
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;

        // 2. Make sure the capture context is running.
        if (audioCtx.state === "suspended") await audioCtx.resume();

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
        worklet.connect(audioCtx.destination); // sink to keep it processing

        // 4. WebSocket → Gemini Live.
        //
        // We use v1beta with the direct API key — v1alpha only accepts ephemeral
        // auth tokens (created server-side). v1beta accepts both GA models like
        // gemini-2.0-flash-live-001 and recent preview live models.
        const apiVersion = "v1beta";
        const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
          opts.apiKey,
        )}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        const setupTimeout = setTimeout(() => {
          if (stateRef.current === "connecting") {
            setError("Voice connection timed out — check your Gemini API key.");
            cleanup();
            setState("error");
          }
        }, 15000);

        const setupPayload = {
          setup: {
            model: opts.model.startsWith("models/")
              ? opts.model
              : `models/${opts.model}`,
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
            systemInstruction: {
              parts: [{ text: opts.systemPrompt }],
            },
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
          let msg: any;
          try {
            msg = JSON.parse(raw);
          } catch {
            return;
          }

          if (msg.setupComplete) {
            clearTimeout(setupTimeout);
            setState("listening");
            // Pipe mic to ws
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

          const sc = msg.serverContent;
          if (!sc) return;

          // Audio → the gapless player. Chunks are scheduled back to
          // back on the audio clock as they arrive, so playback is
          // continuous regardless of network pacing.
          if (sc.modelTurn?.parts) {
            for (const part of sc.modelTurn.parts) {
              if (part.inlineData?.data) {
                if (stateRef.current !== "speaking") setState("speaking");
                try {
                  const ab = base64ToArrayBuffer(part.inlineData.data);
                  player.enqueue(new Int16Array(ab));
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
            // Make sure any tail below the fallback path's batching
            // threshold becomes audible. Assistant text is committed
            // by the player's onDrain once playback finishes.
            player.flush();
          }

          if (sc.interrupted) {
            // Drop everything queued — the model is starting over /
            // got cut off.
            player.clear();
            if (asstBufRef.current.trim()) {
              setTurns((prev) => [
                ...prev,
                { role: "assistant", content: asstBufRef.current.trim() + "…" },
              ]);
              asstBufRef.current = "";
              setLiveAssistant("");
            }
            setState("listening");
          }
        };

        ws.onerror = () => {
          clearTimeout(setupTimeout);
          setError("Voice connection error.");
          cleanup();
          setState("error");
        };

        ws.onclose = (ev) => {
          clearTimeout(setupTimeout);
          if (stateRef.current === "connecting") {
            // Surface whatever the server told us in `ev.reason` — usually the
            // most useful clue for setup rejections.
            const reason = ev.reason?.trim();
            const tail = reason
              ? ` — ${reason}`
              : ev.code === 1008
                ? " — Live setup rejected. Most often this is a deprecated or wrong model name. " +
                  "Try gemini-3.1-flash-live-preview. " +
                  "Make sure your Gemini API key has Live API access enabled in AI Studio."
                : ev.code === 1007
                  ? " — invalid frame data sent."
                  : "";
            setError(`Voice setup rejected (code ${ev.code})${tail}`);
            console.warn("[live] websocket closed during setup", {
              code: ev.code,
              reason: ev.reason,
              wasClean: ev.wasClean,
              apiVersion,
              model: opts.model,
            });
            cleanup();
            setState("error");
          } else if (stateRef.current !== "idle") {
            cleanup();
            setState("idle");
          }
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Permission denied") || msg.includes("NotAllowedError")) {
          setError("Microphone access denied.");
        } else {
          setError(msg);
        }
        cleanup();
        setState("error");
      }
    },
    [cleanup],
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return { state, error, turns, liveUser, liveAssistant, start, stop };
}
