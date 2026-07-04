/**
 * Local push-to-talk live voice pipeline.
 *
 * Chains three components the app already speaks: Whisper for STT
 * (lib/stt.ts), the active chat provider for the LLM, and the user's
 * configured TTS (lib/tts.ts — Edge / Fish-speech / OpenAI / etc.).
 * No bidirectional WebSocket, no model-side voice — just record → STT
 * → chat → TTS → play, looping while the session is "on".
 *
 * Why a separate hook from `useLiveVoice` (Gemini) and
 * `useOpenAILiveVoice`: those are realtime / WebSocket models that
 * stream audio both directions. This one is intentionally *not* —
 * it's slower per turn but works fully offline (whisper.cpp +
 * fish-speech + Ollama is the canonical local trio) and over any
 * provider you've already configured.
 *
 * Shape matches the other two hooks closely so the InlineLiveMode UI
 * can render against a unified contract: `state`, `error`, `turns`,
 * `liveUser`, `liveAssistant`, `start`, `stop`, plus a `finishTurn`
 * action specific to push-to-talk.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { liveVoiceRate } from "./live-voice-rate";
import { useProviderConfigs } from "./provider-context";
import { useTTS } from "./tts-context";
import { startRecording, transcribeWhisper, findWhisperProvider } from "./stt";

export type LocalLiveState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type LocalLiveTurn = { role: "user" | "assistant"; content: string };

/**
 * Options shape is intentionally a superset of the WebSocket backends'
 * options so InlineLiveMode can call `live.start(opts)` without
 * branching on backend at every call site. The local backend ignores
 * `apiKey`, `model`, and `voiceName` — those concerns are handled by
 * the chat provider config and the TTS settings, respectively.
 */
export type LocalLiveStartOptions = {
  apiKey?: string;
  model?: string;
  systemPrompt: string;
  voiceName?: string;
  /** BCP-47 hint for Whisper (the user's native or workspace target). */
  sttLang?: string;
  /** BCP-47 hint for TTS (workspace target language usually). */
  ttsLang?: string;
};

export type LocalLiveControls = {
  state: LocalLiveState;
  error: string | null;
  turns: LocalLiveTurn[];
  liveUser: string;
  liveAssistant: string;
  start: (opts: LocalLiveStartOptions) => Promise<void>;
  stop: () => void;
  /** Push-to-talk: stop the current recording and process the audio. */
  finishTurn: () => Promise<void>;
  /** Cut off the assistant's TTS playback and return to listening. */
  interrupt: () => void;
};

export function useLocalLiveVoice(): LocalLiveControls {
  const [state, setState] = useState<LocalLiveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<LocalLiveTurn[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");

  const { providers, sendChat } = useProviderConfigs();
  const tts = useTTS();

  // Refs for state that survives re-renders without triggering them.
  const recorderRef = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const sessionActiveRef = useRef(false);
  const optsRef = useRef<LocalLiveStartOptions | null>(null);
  // Conversation history retained across turns so the LLM has context.
  const historyRef = useRef<LocalLiveTurn[]>([]);

  // Mirror state into a ref so callbacks can read it without becoming
  // stale closures.
  const stateRef = useRef<LocalLiveState>("idle");
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  function teardownRecorder() {
    const r = recorderRef.current;
    recorderRef.current = null;
    r?.cancel();
  }

  function teardownAudio() {
    const el = audioElRef.current;
    audioElRef.current = null;
    if (el) {
      try {
        el.pause();
        el.src = "";
      } catch {
        /* ignore */
      }
    }
  }

  const stop = useCallback(() => {
    sessionActiveRef.current = false;
    teardownRecorder();
    teardownAudio();
    setLiveUser("");
    setLiveAssistant("");
    setState("idle");
    setError(null);
  }, []);

  const interrupt = useCallback(() => {
    teardownAudio();
    if (sessionActiveRef.current) {
      // Drop back to listening so the user can immediately push to
      // talk again.
      setLiveAssistant("");
      setState("listening");
    }
  }, []);

  // Reset on unmount so a navigation away doesn't leave a hanging
  // mic permission indicator or playing audio.
  useEffect(() => {
    return () => {
      sessionActiveRef.current = false;
      teardownRecorder();
      teardownAudio();
    };
  }, []);

  /** Process a recorded blob: transcribe, send to LLM, speak the
   *  reply. State transitions thinking → speaking → listening. */
  async function runTurn(blob: Blob, opts: LocalLiveStartOptions) {
    const whisperProvider = findWhisperProvider(providers);
    if (!whisperProvider) {
      throw new Error(
        "No Whisper-capable provider configured. Add an OpenAI or Groq provider with an API key.",
      );
    }
    setState("thinking");
    // Transcribe.
    let transcript: string;
    try {
      const { text } = await transcribeWhisper(blob, whisperProvider, {
        lang: opts.sttLang,
      });
      transcript = text.trim();
    } catch (err) {
      throw new Error(
        `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!transcript) {
      // No speech detected — quietly return to listening rather than
      // dragging the user through a "no input" toast each time.
      if (sessionActiveRef.current) setState("listening");
      return;
    }
    setLiveUser(transcript);
    historyRef.current = [
      ...historyRef.current,
      { role: "user", content: transcript },
    ];
    setTurns((prev) => [...prev, { role: "user", content: transcript }]);

    // LLM. We assemble a fresh messages array each turn so any system
    // prompt edits propagate immediately.
    const messages = [
      { role: "system" as const, content: opts.systemPrompt },
      ...historyRef.current.map((t) => ({
        role: t.role as "user" | "assistant",
        content: t.content,
      })),
    ];
    let reply = "";
    try {
      reply = await sendChat({
        messages,
        onToken: (delta) => {
          // Stream the assistant text into the UI as it arrives so
          // the user sees the response taking shape before TTS
          // starts. Doesn't change the eventual TTS payload.
          reply += delta;
          setLiveAssistant(reply);
        },
      });
    } catch (err) {
      throw new Error(
        `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const finalReply = reply.trim();
    if (!finalReply) {
      if (sessionActiveRef.current) setState("listening");
      return;
    }
    historyRef.current = [
      ...historyRef.current,
      { role: "assistant", content: finalReply },
    ];
    setTurns((prev) => [...prev, { role: "assistant", content: finalReply }]);
    setLiveAssistant(finalReply);

    // TTS. We synthesize-then-play instead of using `tts.speak`
    // because we need an explicit "ended" event to advance state.
    setState("speaking");
    try {
      const { bytes, mime } = await tts.synthesize(finalReply, opts.ttsLang);
      // Stream into a HTMLAudioElement we can interrupt() on demand.
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = liveVoiceRate.current;
      (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch =
        true;
      audioElRef.current = audio;
      await new Promise<void>((resolve) => {
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (audioElRef.current === audio) audioElRef.current = null;
          resolve();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          if (audioElRef.current === audio) audioElRef.current = null;
          resolve();
        };
        void audio.play().catch(() => resolve());
      });
    } catch (err) {
      // TTS failure leaves the text reply on screen; don't blow up
      // the session — the user can read what came back even when
      // speech synthesis is misbehaving.
      console.warn("local live tts failed", err);
    }

    // Clear the per-turn buffers so the next turn starts fresh in
    // the UI, but keep the conversation history accumulating.
    setLiveUser("");
    setLiveAssistant("");
    if (sessionActiveRef.current) setState("listening");
  }

  const finishTurn = useCallback(async () => {
    const opts = optsRef.current;
    if (!opts) return;
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    let blob: Blob | null = null;
    try {
      blob = await rec.stop();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
      return;
    }
    if (!blob || blob.size < 1024) {
      // Nothing meaningful captured — go back to listening
      // immediately, no point round-tripping Whisper.
      if (sessionActiveRef.current) setState("listening");
      return;
    }
    try {
      await runTurn(blob, opts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, sendChat, tts]);

  const start = useCallback(
    async (opts: LocalLiveStartOptions) => {
      if (sessionActiveRef.current) return;
      setError(null);
      setTurns([]);
      historyRef.current = [];
      optsRef.current = opts;
      sessionActiveRef.current = true;
      setState("connecting");
      try {
        // Validate up-front. We need both a Whisper-capable provider
        // (for STT) and a chat provider with an active config (for
        // the LLM step). The TTS check happens lazily — most kinds
        // (edge/browser) work without setup.
        if (!findWhisperProvider(providers)) {
          throw new Error(
            "No Whisper-capable provider configured. Add an OpenAI or Groq provider in Settings → Providers.",
          );
        }
        const handle = await startRecording();
        recorderRef.current = handle;
        setState("listening");
      } catch (err) {
        sessionActiveRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    },
    [providers],
  );

  // Push-to-talk: when state flips back to listening (post-turn),
  // automatically start a new recording so the user can immediately
  // talk again. The user explicitly tap-to-finish each turn via
  // finishTurn().
  useEffect(() => {
    if (!sessionActiveRef.current) return;
    if (state !== "listening") return;
    if (recorderRef.current) return;
    void (async () => {
      try {
        const handle = await startRecording();
        recorderRef.current = handle;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    })();
  }, [state]);

  return {
    state,
    error,
    turns,
    liveUser,
    liveAssistant,
    start,
    stop,
    finishTurn,
    interrupt,
  };
}
