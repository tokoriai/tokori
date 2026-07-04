// Gemini Live (BidiGenerateContent) WebSocket client. Connects directly
// from the renderer because we have the API key locally — no Rust proxy
// needed for this provider.

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

/** Wrap mono Int16 PCM in a minimal RIFF/WAVE container so it can be
 *  played through an HTMLAudioElement (`new Audio(blobUrl)`).
 *
 *  Why we don't pipe Gemini's PCM through `AudioContext.createBufferSource`
 *  any more: that path silently fails to reach the system sink on
 *  several Linux WebKit2GTK builds (PipeWire stack, transparent Tauri
 *  windows). The HTMLAudioElement pipeline is what every other audio
 *  surface in the app already uses (preview button, vocab TTS, reader
 *  passages) and it's known to work everywhere. Trade: we batch chunks
 *  per turn instead of sample-streaming, so the user hears the whole
 *  reply at once with ~0.5–1.5s of buffering latency. Acceptable for a
 *  conversational tutor — the visual orb + transcript update live
 *  while the audio buffers, so there's no apparent stall. */
const PLAYBACK_SAMPLE_RATE = 24000; // Gemini Live's native output rate
/** Flush partial PCM into a playable WAV chunk once we've buffered
 *  this many samples. ~1s @ 24kHz keeps the per-chunk transition gap
 *  on `<audio>` element swap (≈30–80ms on most browsers) under 10% of
 *  the chunk duration, which is below the noticeable threshold for
 *  speech continuity. */
const FLUSH_THRESHOLD_SAMPLES = PLAYBACK_SAMPLE_RATE; // 1.0s

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
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, 1, true);  // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);  // block align
  view.setUint16(34, 16, true); // bits/sample
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  // PCM payload (Int16 little-endian — same byte order JS uses
  // natively, so a typed-array `.set()` is correct).
  new Int16Array(buf, 44, samples.length).set(samples);
  return new Blob([buf], { type: "audio/wav" });
}

export function useLiveVoice() {
  const [state, setState] = useState<LiveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  // Capture-only context (16kHz mic → AudioWorklet → WebSocket). Output
  // playback no longer uses an AudioContext; see `pcmToWav` comment.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // Output playback queue. Pending PCM chunks accumulate in
  // `pendingPcmRef`; once they reach FLUSH_THRESHOLD_SAMPLES (or the
  // turn ends / is interrupted) the whole batch is wrapped into a WAV
  // blob URL and pushed onto `wavQueueRef` for sequential `<audio>`
  // playback.
  const pendingPcmRef = useRef<Int16Array[]>([]);
  const pendingSamplesRef = useRef(0);
  const wavQueueRef = useRef<string[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const playingRef = useRef(false);
  const userBufRef = useRef("");
  const asstBufRef = useRef("");
  const stateRef = useRef<LiveState>("idle");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const url = wavQueueRef.current.shift();
    if (!url) {
      // Queue drained AND no pending PCM in the buffer → the turn is
      // fully spoken. Commit the assistant transcript and drop back to
      // listening. (If pending PCM still exists, a flush is about to
      // refill the queue, so we leave the state alone.)
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
    // User-adjustable speed (live settings row). preservesPitch keeps
    // the voice natural; older WebKit ignores the property harmlessly.
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
      console.warn("[live] audio chunk failed to play", audio.error);
      URL.revokeObjectURL(url);
      if (currentAudioRef.current === audio) currentAudioRef.current = null;
      playingRef.current = false;
      playNext();
    };
    void audio.play().catch((err) => {
      console.warn("[live] audio.play() rejected", err);
      URL.revokeObjectURL(url);
      if (currentAudioRef.current === audio) currentAudioRef.current = null;
      playingRef.current = false;
      playNext();
    });
  }, []);

  /** Flush whatever PCM is currently buffered into a WAV blob URL on
   *  the playback queue. Called whenever the buffer crosses the size
   *  threshold mid-turn AND once on `turnComplete` to drain the tail. */
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
    // Stop any in-flight playback and revoke pending blob URLs so we
    // don't leak Object URLs across sessions.
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
      //
      // (Output playback no longer uses an AudioContext at all — see
      // the comment on `pcmToWav`. We play through HTMLAudioElement
      // for parity with every other audio surface in the app.)
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

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

          // Audio → pending PCM buffer. Once we've buffered roughly
          // FLUSH_THRESHOLD_SAMPLES worth (~1s @ 24kHz) we wrap the
          // batch into a WAV blob and queue it for `<audio>` playback.
          // The threshold trades latency for continuity: smaller →
          // start hearing sooner but more inter-chunk gaps; larger →
          // smoother but more upfront delay.
          if (sc.modelTurn?.parts) {
            for (const part of sc.modelTurn.parts) {
              if (part.inlineData?.data) {
                if (stateRef.current !== "speaking") setState("speaking");
                try {
                  const ab = base64ToArrayBuffer(part.inlineData.data);
                  const i16 = new Int16Array(ab);
                  pendingPcmRef.current.push(i16);
                  pendingSamplesRef.current += i16.length;
                  if (
                    pendingSamplesRef.current >= FLUSH_THRESHOLD_SAMPLES
                  ) {
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
            // Drain any partial PCM that didn't reach the flush
            // threshold so the tail of the assistant's reply isn't
            // dropped. Assistant text is committed by playNext() once
            // the audio queue empties.
            flushPending();
          }

          if (sc.interrupted) {
            // Drop everything queued — the model is starting over /
            // got cut off. Stop the in-flight audio element too.
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
    [cleanup, flushPending],
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return { state, error, turns, liveUser, liveAssistant, start, stop };
}
