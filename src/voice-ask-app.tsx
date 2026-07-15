/**
 * Voice-ask popup UI.
 *
 * Loaded into a small frameless always-on-top webview window when the
 * user hits the voice-ask global shortcut (default Ctrl/Cmd+Shift+Space,
 * registered by the Tauri side when the feature is enabled) or picks
 * "Ask by voice" from the tray.
 *
 * The flow is deliberately one gesture: summon → the mic is already
 * recording (live waveform) → speak → Enter. The transcript is handed
 * to Rust (`focus_main_with_ask`), which hides this popup, brings the
 * main window forward, and emits the question into the open chat —
 * optionally with the tutor's answer read aloud.
 *
 * Same standalone-tree rationale as SpotlightApp: no provider / cloud /
 * chat-list contexts, just direct db reads. It shares localStorage +
 * SQLite with the main window, so the active workspace and the
 * Settings → Voice engine choice always line up.
 */

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Mic, Volume2, VolumeX, X } from "lucide-react";
import { MicWaveform, useElapsed } from "@/components/mic-waveform";
import {
  getSetting,
  listProviders,
  listWorkspaces,
  type ProviderConfig,
  type Workspace,
} from "@/lib/db";
import {
  findWhisperProvider,
  isBrowserSTTAvailable,
  LOCAL_WHISPER_SAMPLE_RATE,
  MAX_DICTATION_MS,
  resolveSttEngine,
  startPcmRecording,
  startRecording,
  transcribeLocalWhisper,
  transcribeWhisper,
  type SttEngine,
} from "@/lib/stt";
import { activeLocalWhisperModel } from "@/lib/whisper-local";
import { bcp47 } from "@/lib/languages";
import { cn } from "@/lib/utils";

const ACTIVE_ID_KEY = "polyglot.activeWorkspaceId";
const SPEAK_REPLY_KEY = "voiceask.speakReply";

type Phase =
  | "idle" // between summons / after a cancel — Enter re-records
  | "recording"
  | "transcribing"
  | "noengine"
  | "error";

type RecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult:
    | ((e: {
        results: { 0: { transcript: string } }[] & {
          [k: number]: { isFinal: boolean };
        };
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

export function VoiceAskApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [liveText, setLiveText] = useState("");
  const [recStream, setRecStream] = useState<MediaStream | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [speakReply, setSpeakReply] = useState<boolean>(
    () => localStorage.getItem(SPEAK_REPLY_KEY) !== "0",
  );
  const elapsed = useElapsed(startedAt);

  // Handlers below are registered once (window keydown, Tauri events)
  // but need current values — mirror the reactive bits into refs.
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const speakReplyRef = useRef(speakReply);
  useEffect(() => {
    speakReplyRef.current = speakReply;
    localStorage.setItem(SPEAK_REPLY_KEY, speakReply ? "1" : "0");
  }, [speakReply]);

  const startingRef = useRef(false);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const recorderRef = useRef<Awaited<ReturnType<typeof startRecording>> | null>(
    null,
  );
  const pcmRecorderRef = useRef<Awaited<
    ReturnType<typeof startPcmRecording>
  > | null>(null);
  const localModelRef = useRef<string | null>(null);
  const vizOwnedRef = useRef<MediaStream | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineRef = useRef<SttEngine>("none");
  const whisperRef = useRef<ProviderConfig | null>(null);
  const langRef = useRef<string | undefined>(undefined);
  const committedRef = useRef("");
  const interimRef = useRef("");
  const finishingRef = useRef(false);
  const cancelledRef = useRef(false);

  function stopViz() {
    vizOwnedRef.current?.getTracks().forEach((t) => t.stop());
    vizOwnedRef.current = null;
  }

  function clearAutoStop() {
    if (autoStopRef.current != null) clearTimeout(autoStopRef.current);
    autoStopRef.current = null;
  }

  function teardownCapture() {
    cancelledRef.current = true;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    pcmRecorderRef.current?.cancel();
    pcmRecorderRef.current = null;
    stopViz();
    clearAutoStop();
    setRecStream(null);
    setStartedAt(null);
    setLiveText("");
  }

  function fail(message: string) {
    setError(message);
    setPhase("error");
    setRecStream(null);
    setStartedAt(null);
  }

  /** Hand the transcript to the main window and reset for next summon.
   *  Rust hides this popup, focuses main, and emits the question. */
  function submit(text: string) {
    const t = text.trim();
    if (!t) {
      fail("Didn't catch anything — press Enter to try again.");
      return;
    }
    void invoke("focus_main_with_ask", {
      question: t,
      speak: speakReplyRef.current,
    }).catch(() => {
      /* not running under Tauri (browser dev) — nothing to hand off to */
    });
    teardownCapture();
    setPhase("idle");
    setError(null);
  }

  /** (Re)start a take. Reads providers + engine choice fresh each time
   *  so a key added in Settings since the last summon just works. */
  async function start() {
    if (startingRef.current || phaseRef.current === "recording") return;
    startingRef.current = true;
    try {
      setError(null);
      setLiveText("");

      const [providers, sttKind, workspaces] = await Promise.all([
        listProviders().catch(() => [] as ProviderConfig[]),
        getSetting("profile.sttKind").catch(() => null),
        listWorkspaces().catch(() => [] as Workspace[]),
      ]);
      const raw = localStorage.getItem(ACTIVE_ID_KEY);
      const id = raw ? Number(raw) : null;
      const ws = workspaces.find((w) => w.id === id) ?? workspaces[0] ?? null;
      setWorkspace(ws);
      // Questions are almost always spoken in the user's own language —
      // same default the composer's dictation uses.
      langRef.current = ws ? bcp47(ws.nativeLang) : undefined;

      const kind =
        sttKind === "browser" || sttKind === "whisper" || sttKind === "local"
          ? sttKind
          : "auto";
      const whisper = findWhisperProvider(providers);
      whisperRef.current = whisper;
      const localModel = await activeLocalWhisperModel(true).catch(() => null);
      localModelRef.current = localModel;
      const engine = resolveSttEngine(
        kind,
        isBrowserSTTAvailable(),
        whisper,
        localModel != null,
      );
      engineRef.current = engine;
      if (engine === "none") {
        setPhase("noengine");
        return;
      }

      // Take-state flags reset HERE, after every await above — a
      // teardown (StrictMode dev remount, quick Esc) that lands while
      // those were in flight must not be un-flagged retroactively.
      committedRef.current = "";
      interimRef.current = "";
      finishingRef.current = false;
      cancelledRef.current = false;

      if (engine === "browser") {
        const Ctor = window as unknown as {
          SpeechRecognition?: new () => RecognitionLike;
          webkitSpeechRecognition?: new () => RecognitionLike;
        };
        const Impl = Ctor.SpeechRecognition ?? Ctor.webkitSpeechRecognition;
        if (!Impl) {
          setPhase("noengine");
          return;
        }
        const rec = new Impl();
        rec.lang = langRef.current ?? "en-US";
        rec.interimResults = true;
        rec.continuous = true;
        rec.onresult = (event) => {
          const results = event.results as unknown as {
            length: number;
            [k: number]: { isFinal: boolean; 0: { transcript: string } };
          };
          let committed = "";
          let interim = "";
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.isFinal) committed += r[0].transcript;
            else interim += r[0].transcript;
          }
          committedRef.current = committed;
          interimRef.current = interim;
          setLiveText(`${committed} ${interim}`.trim());
        };
        rec.onerror = (e) => {
          if (e.error === "no-speech") {
            fail("Didn't catch anything — press Enter to try again.");
          } else if (e.error && e.error !== "aborted") {
            fail(`Mic error: ${e.error}`);
          }
        };
        rec.onend = () => {
          recognitionRef.current = null;
          stopViz();
          setRecStream(null);
          setStartedAt(null);
          if (cancelledRef.current) return;
          // Reached on explicit Enter AND when the engine self-ends on
          // silence — both mean "the take is over", so submit either
          // way. Hands-free asks fall out of this for free.
          if (phaseRef.current === "recording" || finishingRef.current) {
            finishingRef.current = false;
            submit(`${committedRef.current} ${interimRef.current}`.trim());
          }
        };
        recognitionRef.current = rec;
        setPhase("recording");
        setStartedAt(Date.now());
        rec.start();
        // Viz-only tap — SpeechRecognition exposes no stream. Best
        // effort; a denied tap just leaves the stage waveless.
        try {
          const viz = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          if (!recognitionRef.current) {
            viz.getTracks().forEach((t) => t.stop());
            return;
          }
          vizOwnedRef.current = viz;
          setRecStream(viz);
        } catch {
          /* waveform-less stage */
        }
        return;
      }

      if (engine === "local") {
        const handle = await startPcmRecording();
        pcmRecorderRef.current = handle;
        setRecStream(handle.stream);
        setPhase("recording");
        setStartedAt(Date.now());
        autoStopRef.current = setTimeout(() => {
          void finish();
        }, MAX_DICTATION_MS);
        return;
      }

      // Whisper (API)
      const handle = await startRecording();
      recorderRef.current = handle;
      setRecStream(handle.stream);
      setPhase("recording");
      setStartedAt(Date.now());
      autoStopRef.current = setTimeout(() => {
        void finish();
      }, MAX_DICTATION_MS);
    } catch (err) {
      fail(
        err instanceof Error
          ? `Couldn't start mic: ${err.message}`
          : `Couldn't start mic: ${String(err)}`,
      );
    } finally {
      startingRef.current = false;
    }
  }

  /** End the take and ship it: browser lets onend submit; local runs
   *  whisper.cpp; whisper uploads the blob first. */
  async function finish() {
    if (phaseRef.current !== "recording") return;
    clearAutoStop();
    if (recognitionRef.current) {
      setPhase("transcribing");
      finishingRef.current = true;
      recognitionRef.current.stop(); // onend submits
      return;
    }
    const pcmRec = pcmRecorderRef.current;
    if (pcmRec) {
      pcmRecorderRef.current = null;
      setPhase("transcribing");
      setRecStream(null); // freeze the wave on its last frame
      setStartedAt(null);
      try {
        const pcm = await pcmRec.stop();
        if (cancelledRef.current) return;
        if (pcm.length < LOCAL_WHISPER_SAMPLE_RATE / 2) {
          fail("Didn't catch anything — press Enter to try again.");
          return;
        }
        const model = localModelRef.current;
        if (!model) {
          fail("No local Whisper model downloaded — see Settings → Voice.");
          return;
        }
        const { text } = await transcribeLocalWhisper(pcm, {
          model,
          lang: langRef.current,
        });
        if (cancelledRef.current) return;
        submit(text);
      } catch (err) {
        if (cancelledRef.current) return;
        fail(
          err instanceof Error
            ? err.message
            : `Transcription failed: ${String(err)}`,
        );
      }
      return;
    }
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    setPhase("transcribing");
    setRecStream(null); // freeze the wave on its last frame
    setStartedAt(null);
    try {
      const blob = await rec.stop();
      // Esc / blur can land mid-upload — a dismissed take must never
      // fire its question into the main window afterwards.
      if (cancelledRef.current) return;
      if (blob.size < 1024) {
        fail("Didn't catch anything — press Enter to try again.");
        return;
      }
      const whisper = whisperRef.current;
      if (!whisper) {
        fail("Whisper provider unavailable — check Settings → Providers.");
        return;
      }
      const { text } = await transcribeWhisper(blob, whisper, {
        lang: langRef.current,
      });
      if (cancelledRef.current) return;
      submit(text);
    } catch (err) {
      if (cancelledRef.current) return;
      fail(
        err instanceof Error
          ? err.message
          : `Transcription failed: ${String(err)}`,
      );
    }
  }

  function cancelAndHide() {
    teardownCapture();
    setPhase("idle");
    setError(null);
    void invoke("hide_voice_ask").catch(() => {
      /* not running under Tauri (browser dev) — no window to hide */
    });
  }

  // Auto-record on first mount and on every re-summon. The Rust side
  // emits `tokori:voiceask-shown` at the end of its focus dance.
  useEffect(() => {
    void start();
    let unlisten: (() => void) | undefined;
    void listen("tokori:voiceask-shown", () => {
      void start();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* not running under Tauri (browser dev) — no summon events */
      });
    return () => {
      unlisten?.();
      teardownCapture();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The popup has no input element — keys are handled window-wide.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelAndHide();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const p = phaseRef.current;
        if (p === "recording") void finish();
        else if (p === "error" || p === "idle") void start();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dismiss-on-blur with the same arming grace period as the spotlight
  // (see spotlight-app.tsx for why the first summon needs it).
  useEffect(() => {
    let armed = false;
    const armT = setTimeout(() => {
      armed = true;
    }, 250);
    function onBlur() {
      if (!armed) return;
      cancelAndHide();
    }
    function onWindowFocus() {
      armed = false;
      setTimeout(() => {
        armed = true;
      }, 250);
    }
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      clearTimeout(armT);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onWindowFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusLine = (() => {
    if (phase === "recording")
      return liveText || "Listening — speak your question, then press Enter.";
    if (phase === "transcribing") return "Transcribing…";
    if (phase === "error") return error ?? "Something went wrong.";
    return "Press Enter to record.";
  })();

  // Wispr-Flow-style pill: a slim capsule pinned to the window's
  // bottom edge (the window itself floats bottom-center of the
  // screen). One row of dot + waveform + clock + controls, with a
  // status/hints line underneath — same animation language as the
  // chat composer's recording strip.
  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancelAndHide();
      }}
      className="isolate flex h-screen w-screen transform-gpu items-end justify-center p-1 [contain:paint]"
      style={{ backgroundColor: "rgba(0,0,0,0.001)" }}
    >
      <div className="w-full overflow-hidden rounded-[26px] border border-border/60 bg-card/90 shadow-2xl ring-1 ring-foreground/10 backdrop-blur-2xl animate-in fade-in slide-in-from-bottom-3 duration-300">
        {phase === "noengine" ? (
          <p className="px-5 py-3 text-center text-[12px] leading-relaxed text-muted-foreground">
            No dictation engine available. Download a local Whisper model
            under Settings → Voice → Dictation (private, offline), or add an
            OpenAI/Groq API key under Settings → Providers — then summon
            this again.
          </p>
        ) : (
          <div
            data-tauri-drag-region
            className="flex items-center gap-3.5 px-5 py-3.5"
          >
            {phase === "recording" ? (
              <span className="relative flex size-2.5 shrink-0" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive/60" />
                <span className="relative inline-flex size-2.5 rounded-full bg-destructive" />
              </span>
            ) : phase === "transcribing" ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Mic className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <MicWaveform
              stream={recStream}
              className={cn(
                "h-9 min-w-0 flex-1",
                phase === "transcribing"
                  ? "text-muted-foreground/50"
                  : "text-foreground/90",
              )}
            />
            {phase === "recording" && (
              <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">
                {elapsed}
              </span>
            )}
            <button
              type="button"
              onClick={() => setSpeakReply((v) => !v)}
              aria-pressed={speakReply}
              title={
                speakReply
                  ? "The answer will be read aloud — click to disable"
                  : "Read the answer aloud too"
              }
              className={cn(
                "shrink-0 cursor-pointer rounded-full border p-1.5 transition-colors",
                speakReply
                  ? "border-foreground/30 bg-foreground/5 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {speakReply ? (
                <Volume2 className="size-3.5" />
              ) : (
                <VolumeX className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={cancelAndHide}
              title="Dismiss (Esc)"
              aria-label="Dismiss"
              className="shrink-0 cursor-pointer rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        <div className="flex items-center gap-3 border-t border-border/50 bg-muted/20 px-5 py-1.5 text-[10.5px] text-muted-foreground">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[11px]",
              phase === "error"
                ? "text-destructive"
                : liveText
                  ? "text-foreground"
                  : undefined,
            )}
            title={liveText || undefined}
          >
            {statusLine}
          </span>
          {workspace && (
            <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider">
              {workspace.targetLang}
            </span>
          )}
          <span className="inline-flex shrink-0 items-center gap-1">
            <kbd className="rounded border border-border bg-muted/50 px-1 py-0.5 font-mono text-[10px]">
              ↵
            </kbd>
            ask
          </span>
          <span className="inline-flex shrink-0 items-center gap-1">
            <kbd className="rounded border border-border bg-muted/50 px-1 py-0.5 font-mono text-[10px]">
              Esc
            </kbd>
            dismiss
          </span>
        </div>
      </div>
    </div>
  );
}
