import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpenText,
  Drama,
  EyeOff,
  Expand,
  Hash,
  Languages as LanguagesIcon,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  PanelBottom,
  PanelRight,
  Play,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Tokenized } from "@/components/tokenized";
import { listAudioInputs } from "@/lib/stt";
import {
  addMessage,
  createChat,
  listDueVocab,
  listSystemPrompts,
  listVocab,
  type ProviderConfig,
} from "@/lib/db";
import { useChatList } from "@/lib/chat-list-context";
import { useCloud } from "@/lib/cloud-context";
import { HOSTED } from "@/lib/build-flags";
import { useLiveVoice } from "@/lib/live-voice";
import { useCloudLiveVoice } from "@/lib/live-voice-cloud";
import { useLocalLiveVoice } from "@/lib/live-voice-local";
import {
  OPENAI_LIVE_MODELS,
  OPENAI_LIVE_VOICES,
  OPENAI_TRANSCRIPTION_MODELS,
  useOpenAILiveVoice,
  type OpenAITranscriptionModel,
} from "@/lib/live-voice-openai";
import {
  QWEN_LIVE_MODELS,
  QWEN_LIVE_VOICES,
  useQwenLiveVoice,
  type QwenRegion,
} from "@/lib/live-voice-qwen";
import {
  previewGeminiVoice,
  previewOpenAIVoice,
} from "@/lib/live-voice-preview";
import { playBytes } from "@/lib/tts";
import { LIVE_VOICE_RATES, liveVoiceRate } from "@/lib/live-voice-rate";
import { navigateToTab } from "@/lib/nav-event";
import { requestSettingsIntent } from "@/lib/settings-intent";
import { useProviderConfigs } from "@/lib/provider-context";
import { useSession } from "@/lib/session-context";
import { useWorkspace } from "@/lib/workspace-context";
import { getWorkspaceFocus } from "@/lib/focus";
import { formatHitsForPrompt, searchKnowledge } from "@/lib/knowledge";
import { languageName, type LanguageCode } from "@/lib/languages";
import { studentLevelFor } from "@/lib/text-simplifier";
import { translateTexts } from "@/lib/translate/run";
import { cn } from "@/lib/utils";

/** Where the live transcript sits relative to the orb stage.
 *  - "side": right rail next to the orb (the default for desktop).
 *  - "bottom": collapsible drawer under the orb (the old behaviour).
 *  - "fullscreen": transcript fills the screen, orb shrinks into a corner badge. */
type LiveLayout = "side" | "bottom" | "fullscreen";

/**
 * Live mode model selection.
 *
 * The Gemini Live API only accepts a small set of models, and not every
 * "live"-named model that appears in suggestion lists actually works on
 * v1beta with a direct API key. The previous GA option
 * `gemini-2.0-flash-live-001` is left out: in practice it returns 1008s
 * and audio dropouts more often than the preview models, so keeping it
 * in the picker only led users to a dead end. The picker now offers the
 * preview / native-audio variants that actually work.
 *
 * Strategy: pass the user's choice through ONLY when it's on the known-good
 * list. Otherwise fall back to the first model below. Order matters —
 * it's how we present them in the picker, so the most reliable preview
 * comes first.
 */
const KNOWN_LIVE_MODELS: readonly string[] = [
  "gemini-3.1-flash-live-preview",                // Default — best latency/quality balance at the time of writing
  "gemini-2.5-flash-preview-native-audio-dialog", // Native audio variant
  "gemini-2.5-flash-exp-native-audio-thinking-dialog", // Experimental
];
const DEFAULT_LIVE_MODEL = KNOWN_LIVE_MODELS[0];

/**
 * Cloud backend model list — Gemini Live models reachable through the
 * cloud's `v1alpha` ephemeral-token flow. The token route mints an
 * UNCONSTRAINED `auth_tokens/...` and the client sends the model id
 * in its own `setup` frame, so the cloud endpoint accepts any Live
 * model that v1alpha hosts (which now includes Gemini 3.1).
 *
 * History: an earlier iteration used `BidiGenerateContentConstrained`
 * and baked the model server-side; that endpoint silently hung for
 * non-native-audio models, which was misread at the time as "v1alpha
 * doesn't host 3.1". Per Gemini's official `auth_tokens.create`
 * example, v1alpha DOES host `gemini-3.1-flash-live-preview` — so
 * once we switched to the unconstrained variant the 3.1 model became
 * reachable through the same flow as 2.5. Keep the first entry the
 * recommended default so a fresh cloud user lands on the flagship.
 */
const CLOUD_LIVE_MODELS: readonly string[] = [
  "gemini-3.1-flash-live-preview",
  "gemini-2.5-flash-preview-native-audio-dialog",
  "gemini-2.5-flash-exp-native-audio-thinking-dialog",
];
const DEFAULT_CLOUD_LIVE_MODEL = CLOUD_LIVE_MODELS[0];

/**
 * Inline live-mode overlay. Takes over the chat content area (not a modal)
 * — bigger and more "present" than the dialog, with a breathing avatar.
 */
export function InlineLiveMode({
  modelInitial,
  onLeave,
}: {
  modelInitial: string;
  onLeave: () => void;
}) {
  const { active: workspace } = useWorkspace();
  const { providers, sendChat } = useProviderConfigs();
  const { ensureStarted, end: endSession } = useSession();
  const { refresh: refreshChats } = useChatList();
  const cloud = useCloud();
  // Both hooks expose the same { state, turns, start, stop, … } shape,
  // so the rest of the component doesn't care which provider is
  // actually running — we just route the active one's values through.
  // React forbids conditional hook *calls*, but mounting both hooks is
  // fine: only the one we `start()` opens a WebSocket.
  const gemini = useLiveVoice();
  const openai = useOpenAILiveVoice();
  // Qwen Realtime (Alibaba DashScope) — OpenAI-compatible realtime
  // protocol, BYOK like the gemini/openai backends.
  const qwen = useQwenLiveVoice();
  // Local push-to-talk pipeline — Whisper + chat provider + TTS,
  // chained. Slower per turn than the WebSocket backends but works
  // entirely on whatever the user has already configured (handy
  // offline / on Linux where some realtime APIs are flaky).
  const local = useLocalLiveVoice();
  // Cloud-routed push-to-talk pipeline. Mirrors the local one but
  // sends LLM + TTS through the tokori-cloud proxy (chat via
  // /api/ai/v1/chat/completions, TTS via /api/ai/v1/tts/minimax).
  // STT is still local Whisper for now — cloud STT is a future
  // build, and this hook surfaces a clear error if the user hasn't
  // configured a Whisper-shaped provider.
  const cloudLive = useCloudLiveVoice();

  // Provider for the live session. Persists in localStorage so a user
  // who picked OpenAI doesn't get bounced back to Gemini on reload.
  //
  // In HOSTED, "cloud" is the only backend that works: gemini/openai
  // need BYOK keys (no provider settings UI in hosted), and the local
  // pipeline needs Tauri filesystem access (no Tauri in hosted). Force
  // cloud here and ignore any stale localStorage value left over from
  // a desktop or BYOK session in the same browser profile — otherwise
  // a saved "local" or "gemini" silently disables the Start button
  // and the user sees "I speak but nothing happens".
  type LiveBackend = "gemini" | "openai" | "qwen" | "local" | "cloud";
  const [liveBackend, setLiveBackend] = useState<LiveBackend>(() => {
    if (HOSTED) return "cloud";
    const v = readString("live.backend", "gemini");
    return v === "openai" || v === "qwen" || v === "local" || v === "cloud"
      ? v
      : "gemini";
  });
  // First-time default: a user with no BYOK keys but a signed-in
  // cloud account should land on the cloud backend, not on Gemini
  // (whose start button is gated on a Gemini API key they don't
  // have). Only fires when there's no saved preference, so users
  // who explicitly picked a backend keep it. Skipped in HOSTED since
  // the init above already forced "cloud".
  useEffect(() => {
    if (HOSTED) return;
    const raw = typeof window === "undefined"
      ? ""
      : window.localStorage.getItem("live.backend");
    if (raw) return;
    const hasGemini = providers.some(
      (p) => p.kind === "gemini" && !!p.apiKey,
    );
    const hasOpenAI = providers.some(
      (p) => p.kind === "openai" && !!p.apiKey,
    );
    const hasQwen = providers.some((p) => p.kind === "qwen" && !!p.apiKey);
    if (!hasGemini && !hasOpenAI && hasQwen) {
      // Qwen is the only realtime key on the machine — land there
      // instead of on a disabled Gemini default.
      setLiveBackend("qwen");
    } else if (!hasGemini && !hasOpenAI && cloud.account) {
      setLiveBackend("cloud");
    }
  }, [providers, cloud.account]);
  useEffect(() => {
    if (typeof window === "undefined" || HOSTED) return;
    window.localStorage.setItem("live.backend", liveBackend);
  }, [liveBackend]);

  const live =
    liveBackend === "openai"
      ? openai
      : liveBackend === "qwen"
        ? qwen
        : liveBackend === "local"
          ? local
          : liveBackend === "cloud"
            ? cloudLive
            : gemini;
  const { state, error, turns, liveUser, liveAssistant, start, stop } = live;
  const [systemPrompt, setSystemPrompt] = useState<string>("");

  const geminiProvider: ProviderConfig | undefined = useMemo(
    () => providers.find((p) => p.kind === "gemini"),
    [providers],
  );
  const openaiProvider: ProviderConfig | undefined = useMemo(
    () => providers.find((p) => p.kind === "openai"),
    [providers],
  );
  const qwenProvider: ProviderConfig | undefined = useMemo(
    () => providers.find((p) => p.kind === "qwen"),
    [providers],
  );
  const activeProvider =
    liveBackend === "openai"
      ? openaiProvider
      : liveBackend === "qwen"
        ? qwenProvider
        : geminiProvider;
  // DashScope keys are region-bound; the provider row's base URL is the
  // source of truth (the Settings preset defaults to the international
  // endpoint, mainland users point it at dashscope.aliyuncs.com).
  const qwenRegion: QwenRegion =
    qwenProvider?.baseUrl?.includes("dashscope.aliyuncs.com") ? "cn" : "intl";

  // Allow swapping the Live model from inside the overlay so a user who hits
  // a 1008 on one preview can fall back to the GA model without leaving live.
  const initialModel = useMemo(
    () =>
      liveBackend === "openai"
        ? OPENAI_LIVE_MODELS[0]
        : liveBackend === "qwen"
          ? QWEN_LIVE_MODELS[0]
          : liveBackend === "cloud"
            ? DEFAULT_CLOUD_LIVE_MODEL
            : pickLiveModel(geminiProvider?.model ?? ""),
    [geminiProvider?.model, liveBackend],
  );
  const [liveModel, setLiveModel] = useState<string>(initialModel);
  useEffect(() => {
    setLiveModel(initialModel);
  }, [initialModel]);

  // Voice picker, scoped per backend. Each provider has its own voice
  // catalogue, so we key the localStorage entry by backend to avoid
  // a name from one bleeding into the other ("Aoede" doesn't exist in
  // OpenAI; "alloy" doesn't exist in Gemini; MiniMax voice ids are
  // long strings unrelated to either).
  // Voice key is also scoped per workspace target language for the
  // cloud backend — when the user switches between a Chinese and a
  // Japanese workspace, the picker should land on a voice in that
  // language by default, not whichever voice they last picked
  // globally. localStorage keys are namespaced as
  // `live.voice.cloud.<lang>` for that reason.
  const voiceKey =
    liveBackend === "openai"
      ? "live.voice.openai"
      : liveBackend === "qwen"
        ? "live.voice.qwen"
        : liveBackend === "cloud"
          ? // Cloud now goes through Gemini Live, so voices share the
            // same Gemini catalogue (Aoede, Charon, …). Different key
            // from the direct Gemini Live backend so a user can keep
            // separate preferences for the two.
            "live.voice.cloud-gemini"
          : "live.voice";
  const voiceDefault =
    liveBackend === "openai" ? "alloy" : liveBackend === "qwen" ? "Cherry" : "Aoede";
  const [liveVoice, setLiveVoice] = useState<string>(() =>
    readString(voiceKey, voiceDefault),
  );
  useEffect(() => {
    // Re-read when backend flips so the dropdown reflects the right
    // catalogue's saved choice.
    setLiveVoice(readString(voiceKey, voiceDefault));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBackend]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(voiceKey, liveVoice);
  }, [liveVoice, voiceKey]);

  // Voice playback speed — shared by every backend via the
  // `liveVoiceRate` cell each playback pipeline reads per chunk, so a
  // mid-session change applies from the next chunk. Persisted globally
  // (a pacing preference, not per provider).
  const [voiceRate, setVoiceRate] = useState<number>(() => {
    const n = Number(readString("live.playbackRate", "1"));
    return LIVE_VOICE_RATES.includes(n as (typeof LIVE_VOICE_RATES)[number])
      ? n
      : 1;
  });
  useEffect(() => {
    liveVoiceRate.current = voiceRate;
    if (typeof window !== "undefined") {
      window.localStorage.setItem("live.playbackRate", String(voiceRate));
    }
    // Reset to normal speed when live mode unmounts so other audio
    // surfaces sharing the pipelines later never inherit a stale rate.
    return () => {
      liveVoiceRate.current = 1;
    };
  }, [voiceRate]);

  // Conversation mode for the session — feeds the system prompt. Picked
  // on the pre-start screen; "roleplay" and "topic" take a free-text
  // seed. Persisted so a routine ("textbook practice every morning")
  // doesn't need re-picking.
  type LiveSessionMode = "free" | "textbook" | "roleplay" | "topic";
  const [sessionMode, setSessionModeState] = useState<LiveSessionMode>(() => {
    const v = readString("live.sessionMode", "free");
    return v === "textbook" || v === "roleplay" || v === "topic" ? v : "free";
  });
  function setSessionMode(next: LiveSessionMode) {
    setSessionModeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("live.sessionMode", next);
    }
  }
  const [sessionTopic, setSessionTopic] = useState<string>(() =>
    readString("live.sessionTopic", ""),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("live.sessionTopic", sessionTopic);
  }, [sessionTopic]);

  // OpenAI-only: which transcription model feeds the user-caption bubble.
  // `gpt-realtime-whisper` is the new whisper-style model OpenAI ships
  // alongside the GA gpt-realtime stack; older accounts can fall back to
  // `whisper-1` or the gpt-4o-transcribe family.
  const [transcriptionModel, setTranscriptionModel] =
    useState<OpenAITranscriptionModel>(() => {
      const saved = readString("live.openai.transcription", "gpt-realtime-whisper");
      const known = OPENAI_TRANSCRIPTION_MODELS.some((m) => m.id === saved);
      return known ? (saved as OpenAITranscriptionModel) : "gpt-realtime-whisper";
    });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("live.openai.transcription", transcriptionModel);
  }, [transcriptionModel]);

  // Preview the selected voice through each provider's regular (non-
  // realtime) TTS endpoint. Spinning up the realtime socket just for
  // a 3-second sample would be wasteful; the regular endpoints share
  // the same voice catalogue so the preview is faithful.
  const [previewing, setPreviewing] = useState(false);
  async function previewVoice() {
    if (previewing) return;
    if (!activeProvider?.apiKey) {
      toast.error("Add an API key in Settings → Providers first");
      return;
    }
    setPreviewing(true);
    try {
      const out =
        liveBackend === "openai"
          ? await previewOpenAIVoice({
              apiKey: activeProvider.apiKey,
              voiceName: liveVoice,
            })
          : await previewGeminiVoice({
              apiKey: activeProvider.apiKey,
              voiceName: liveVoice,
            });
      await playBytes(out.bytes, out.mime);
    } catch (err) {
      toast.error("Preview failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPreviewing(false);
    }
  }

  // ── Display toggles persisted in localStorage so a user's preference sticks
  // across sessions (e.g. "always blur EN", "always audio-only"). ──
  const [showPinyin, setShowPinyin] = useState<boolean>(
    () => workspace?.targetLang === "zh",
  );
  const [hideText, setHideText] = useState<boolean>(
    () => readBool("live.hideText", false),
  );
  const [showChat, setShowChat] = useState<boolean>(
    () => readBool("live.showChat", true),
  );
  const [blurEn, setBlurEn] = useState<boolean>(() => readBool("live.blurEn", true));
  // Where the transcript panel sits. Default = "side" so the user has the
  // text to look at while the orb breathes — the previous default was a
  // collapsed bottom drawer that most users never opened.
  const [layout, setLayout] = useState<LiveLayout>(
    () => (localStorage.getItem("live.layout") as LiveLayout) || "side",
  );
  // Mic device picker for the stitched pipelines (cloud + local).
  // Browsers don't show a "which mic?" UI on getUserMedia, so without
  // this the OS default mic is silently chosen — and on Linux that's
  // often a virtual monitor input or an unplugged headset. The list
  // is populated lazily; the first call to `listAudioInputs` will
  // briefly request mic permission to fill in device labels.
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string>(() =>
    readString("live.mic.deviceId", ""),
  );
  useEffect(() => {
    void listAudioInputs().then((devs) => {
      setMicDevices(devs);
      // If the previously-saved device id no longer exists (mic
      // unplugged, system rotated ids on reboot), drop the
      // selection so the next start uses the OS default instead
      // of failing OverconstrainedError.
      if (
        micDeviceId &&
        !devs.some((d) => d.deviceId === micDeviceId)
      ) {
        setMicDeviceId("");
      }
    });
    // We intentionally only run this once per component mount; if
    // the user plugs in a new mic, they can reopen the live mode
    // overlay to refresh the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("live.mic.deviceId", micDeviceId);
    }
  }, [micDeviceId]);

  // After the user ends a session, this holds the AI's written feedback so
  // the summary modal can render it. `null` means we've never asked.
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  // The persistent chat row this session is being saved to. Created on the
  // first `stop()` call so a session that's started, talked, and ended is
  // recoverable from the chat list later.
  const savedChatIdRef = useRef<number | null>(null);

  useEffect(() => {
    localStorage.setItem("live.hideText", hideText ? "1" : "0");
  }, [hideText]);
  useEffect(() => {
    localStorage.setItem("live.showChat", showChat ? "1" : "0");
  }, [showChat]);
  useEffect(() => {
    localStorage.setItem("live.blurEn", blurEn ? "1" : "0");
  }, [blurEn]);
  useEffect(() => {
    localStorage.setItem("live.layout", layout);
  }, [layout]);

  // The "current focus" — what the user is meant to read RIGHT NOW.
  // Priority: live assistant > live user > most recent assistant turn.
  const currentFocus: { role: "user" | "assistant"; text: string; isLive: boolean } | null =
    (() => {
      if (liveAssistant) return { role: "assistant", text: liveAssistant, isLive: true };
      if (liveUser) return { role: "user", text: liveUser, isLive: true };
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].role === "assistant") {
          return { role: "assistant", text: turns[i].content, isLive: false };
        }
      }
      return null;
    })();

  // Translate the current focus when it's a completed assistant turn.
  // We don't translate live (still-streaming) turns to avoid burning tokens.
  const [centreTranslation, setCentreTranslation] = useState<string | null>(null);
  useEffect(() => {
    if (!currentFocus || currentFocus.role !== "assistant") {
      setCentreTranslation(null);
      return;
    }
    if (currentFocus.isLive) {
      // Show whatever cached translation we may have for matching text but
      // don't fire a new request mid-stream.
      const cached = translationCache.current.get(currentFocus.text.slice(0, 300));
      setCentreTranslation(cached ?? null);
      return;
    }
    let cancelled = false;
    void translateFn(currentFocus.text).then((t) => {
      if (!cancelled) setCentreTranslation(t);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFocus?.text, currentFocus?.role, currentFocus?.isLive]);

  // Shared translation cache. Keyed on the first 300 chars to avoid
  // re-translating equivalent turns. Lives across re-renders via useRef.
  const translationCache = useRef<Map<string, string>>(new Map());
  // Goes through the user's default translate engine (Settings →
  // Translation), falling back to free Google when nothing is set —
  // same path the sentence analyzer uses. The previous version was
  // hard-wired to a Gemini API key, so users on the OpenAI / Qwen /
  // local backends never saw the EN line at all.
  const translateFn = useMemo(() => {
    return async (text: string): Promise<string | null> => {
      if (!workspace) return null;
      const key = text.slice(0, 300);
      const cached = translationCache.current.get(key);
      if (cached) return cached;
      try {
        const [out] = await translateTexts({
          texts: [text],
          source: workspace.targetLang,
          target: workspace.nativeLang,
          sendChat,
        });
        const trimmed = (out ?? "").trim();
        if (trimmed) translationCache.current.set(key, trimmed);
        return trimmed || null;
      } catch {
        return null;
      }
    };
  }, [workspace, sendChat]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    // Live Mode is single-shot: the system prompt is set when the
    // session opens and never updated mid-call. So unlike the regular
    // chat — which can search RAG against the student's first message
    // — we have to seed retrieval from something already known. The
    // current focus title is the strongest signal: if the student is
    // mid-chapter on "餐馆" we want the tutor to walk in already
    // primed with restaurant vocabulary and example sentences from
    // their library. When no focus is set we just skip RAG entirely.
    //
    // Debounced: the topic input is a dep, and rebuilding (a full
    // vocab fetch) on every keystroke would hammer the DB for nothing.
    const debounce = setTimeout(() => {
    Promise.all([
      listSystemPrompts().catch(() => []),
      listVocab(workspace.id).catch(() => []),
      listDueVocab(workspace.id, 30).catch(() => []),
      getWorkspaceFocus(workspace.id).catch(() => null),
    ])
      .then(async ([prompts, vocab, dueVocab, focus]) => {
        if (cancelled) return;
        const persona = prompts.find((p) => p.isDefault) ?? prompts[0];
        const target = languageName(workspace.targetLang);
        const native = languageName(workspace.nativeLang);
        const base = (
          persona?.body ??
          `You are a friendly, patient ${target} voice tutor. The student's native language is ${native}. Speak naturally in ${target}; switch to ${native} only when the student is clearly stuck. Keep replies short and conversational — this is voice.`
        )
          .replaceAll("{target}", target)
          .replaceAll("{native}", native);
        const known = vocab
          .filter((v) => v.status === "mastered")
          .slice(0, 60)
          .map((v) => v.word);
        const learning = vocab
          .filter((v) => v.status === "learning" || v.status === "review")
          .slice(0, 30)
          .map((v) => v.word);
        const lines = [base];

        // Hard level calibration. Voice models default to native-speed,
        // native-register speech — overwhelming for a learner. The level
        // is derived from the vocab the student actually knows (0 hours
        // = conservative, which is the right direction for speech).
        const level = studentLevelFor({
          lang: workspace.targetLang,
          vocab,
          immersionHours: 0,
          goalLevelId: null,
        });
        lines.push(
          "",
          "Speaking style — follow these strictly:",
          `- The student is roughly ${level} level. Never speak above it.`,
          "- Short sentences only: about 10 words (or 12 characters) each, one idea per sentence.",
          "- Ask ONE question at a time, then wait.",
          "- Use the most common everyday words. No idioms, no slang, no rare words.",
          `- If the student hesitates, answers in ${native}, or asks for help: rephrase the same thing with simpler words, slower. After a second miss, give the ${native} meaning in a few words, then continue in ${target}.`,
          `- When the student makes a mistake, repeat their sentence back correctly in ${target} (a natural recast), then move on — no grammar lectures.`,
          "- Encourage often, briefly.",
        );

        if (known.length || learning.length) {
          lines.push("", "Student vocabulary context:");
          if (known.length) lines.push(`- Mastered: ${known.join(", ")}`);
          if (learning.length) lines.push(`- Learning: ${learning.join(", ")}`);
          lines.push(
            "Build your sentences from the mastered list wherever possible; lean on the learning list when relevant; introduce new vocabulary sparingly (at most one new word per few turns, and gloss it).",
          );
        }
        if (dueVocab.length) {
          const dueWords = dueVocab.slice(0, 20).map((v) => v.word);
          lines.push(
            "",
            `Due for review today (${dueVocab.length} cards): ${dueWords.join(", ")}.`,
            "Where it fits naturally, weave one or two of these into the conversation so the student practises them out loud.",
          );
        }

        // Conversation mode — picked on the pre-start screen.
        const topic = sessionTopic.trim();
        if (sessionMode === "free") {
          lines.push(
            "",
            "Conversation mode: free talk. Open with an easy, friendly question about the student's day, then let them steer. Keep the chat flowing with short follow-up questions.",
          );
        } else if (sessionMode === "topic") {
          lines.push(
            "",
            topic
              ? `Conversation mode: topic talk. Today's topic: "${topic}". Open with one easy question about it and keep the conversation anchored there.`
              : "Conversation mode: topic talk — the student didn't type a topic, so start by asking what they'd like to talk about today.",
          );
        } else if (sessionMode === "roleplay") {
          lines.push(
            "",
            topic
              ? `Conversation mode: roleplay. Scenario: "${topic}".`
              : "Conversation mode: roleplay. The student didn't pick a scene — offer two or three simple options (ordering food, asking for directions, buying a ticket) and let them choose.",
            "Play the other character in the scene, staying at the student's level. Keep your turns to one or two short lines. Stay in character; every five or six exchanges, step out briefly to give one gentle correction, then resume the scene.",
          );
        } else if (sessionMode === "textbook") {
          lines.push(
            "",
            focus?.libraryItemTitle || focus?.chapterTitle
              ? "Conversation mode: textbook practice — anchor the whole conversation on the study-focus material below. Practise its vocabulary and themes together; quiz gently, one question at a time."
              : "Conversation mode: textbook practice — the student hasn't set a study focus, so open by asking what chapter or material they're working on, then practise that together.",
          );
        }

        if (sessionMode === "textbook" && (focus?.libraryItemTitle || focus?.chapterTitle)) {
          const itemKindLabel = focus?.libraryItemKind ?? "material";
          const parts: string[] = [];
          if (focus?.libraryItemTitle) {
            parts.push(`${itemKindLabel} "${focus.libraryItemTitle}"`);
          }
          if (focus?.chapterTitle) {
            parts.push(
              focus.chapterPosition
                ? `chapter ${focus.chapterPosition}: "${focus.chapterTitle}"`
                : `chapter "${focus.chapterTitle}"`,
            );
          }
          lines.push(
            "",
            `Current study focus: the student is currently working through ${parts.join(", ")}.`,
            "Open the conversation by inviting them to talk about a topic from this material — phrase it as a friendly question, not an instruction.",
          );

          // Seed RAG from the focus title. Voice prompts can't
          // re-query mid-session, so this is the one shot we get to
          // give the tutor concrete sentences from the chapter.
          // Falls through silently if retrieval errors.
          try {
            const seedQuery = focus.chapterTitle ?? focus.libraryItemTitle ?? "";
            if (seedQuery) {
              const hits = await searchKnowledge(workspace.id, seedQuery, 4);
              const ragBlock = formatHitsForPrompt(hits);
              if (ragBlock && !cancelled) lines.push(ragBlock);
            }
          } catch {
            /* RAG seed is best-effort */
          }
        }
        if (!cancelled) setSystemPrompt(lines.join("\n"));
      })
      .catch(() => {});
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, sessionMode, sessionTopic]);

  // Stop the WebSocket session AND finalize the study_sessions row
  // when leaving the overlay. Without the endSession call the row
  // started by `ensureStarted("speaking")` keeps `duration_secs=null`,
  // so the dashboard's Skills Radar reads zero hours for speaking
  // even after a real live conversation. The session context's idle
  // timer would eventually close it, but only after 5 minutes — long
  // enough that the dashboard looks broken when the user immediately
  // navigates back to check their stats.
  useEffect(() => {
    return () => {
      stop();
      void endSession().catch((err) => {
        console.warn("[live] endSession on unmount failed", err);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop]);

  if (!workspace) return null;

  const isActive =
    state === "listening" ||
    state === "speaking" ||
    state === "connecting" ||
    state === "thinking";
  // Local + cloud pipelines don't gate on `activeProvider` (Gemini /
  // OpenAI realtime). Each hook validates its own dependencies on
  // start() — for local, a Whisper-capable provider configured
  // locally; for cloud, a signed-in cloud account (the cloud
  // server mints a Gemini ephemeral token, so no per-user provider
  // setup is needed beyond the cloud session bearer).
  const canStart =
    liveBackend === "cloud"
      ? // Cloud needs a signed-in account — the server mints the Gemini
        // ephemeral token against the session bearer.
        !!systemPrompt && !!cloud.account
      : liveBackend === "local"
        ? !!systemPrompt
        : !!activeProvider?.apiKey && !!systemPrompt;

  /**
   * Persist whatever was said into a regular chat row so the user can
   * re-open the conversation from the chat list later. Idempotent — we
   * keep the chat id in a ref so a second call (e.g. after generating the
   * summary) just appends rather than creating a new chat.
   */
  async function persistTurns(): Promise<number | null> {
    if (!workspace || turns.length === 0) return null;
    if (savedChatIdRef.current != null) return savedChatIdRef.current;
    try {
      // Title from the first user turn so the chat list shows something
      // recognisable; fall back to a date-stamped fallback.
      const firstUser = turns.find((t) => t.role === "user")?.content ?? "";
      const title =
        firstUser.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 60) ||
        `Voice session · ${new Date().toLocaleString()}`;
      const chat = await createChat(workspace.id, `🎙️ ${title}`);
      // System message marks this row as a voice session so chat-view can
      // render a small badge later if we want to differentiate.
      await addMessage({
        chatId: chat.id,
        role: "system",
        content: "TOKORI_VOICE_SESSION",
      });
      for (const t of turns) {
        await addMessage({
          chatId: chat.id,
          role: t.role,
          content: t.content,
        });
      }
      savedChatIdRef.current = chat.id;
      void refreshChats();
      return chat.id;
    } catch (err) {
      console.error("Failed to persist voice session", err);
      return null;
    }
  }

  /**
   * Ask the active provider to grade the session. Walks every user turn
   * with the corresponding assistant context and asks for: strengths,
   * mistakes (with corrections), and vocab to study next. Output goes
   * into `summary` for the modal to render as plain markdown.
   */
  async function generateSummary() {
    if (turns.length === 0 || !workspace) {
      toast.info("No turns to summarise yet.");
      return;
    }
    setSummaryBusy(true);
    setSummaryOpen(true);
    try {
      const transcript = turns
        .map((t) => `${t.role === "user" ? "You" : "Tutor"}: ${t.content}`)
        .join("\n");
      const target = languageName(workspace.targetLang);
      const native = languageName(workspace.nativeLang);
      const reply = await sendChat({
        messages: [
          {
            role: "system",
            content:
              `You're a patient ${target} tutor reviewing a voice-practice session. ` +
              `The student is learning ${target}; they speak ${native} natively. ` +
              `Read their transcript and give them feedback they can act on.\n\n` +
              `Output exactly four sections in GitHub-flavoured markdown, in ${native}, in this order:\n` +
              `1. **What went well** — 2-3 specific things the student did right (real quotes from the transcript).\n` +
              `2. **Mistakes & corrections** — bulleted list. For each: quote the student's original ${target} sentence, then the correction in ${target}, then a one-sentence explanation in ${native}.\n` +
              `3. **Vocabulary to study next** — 5 ${target} words/phrases that came up where the student hesitated or was wrong. Render this section as a MARKDOWN TABLE with exactly three columns: \`Word\` (in ${target}), \`Reading\` (pronunciation/romanisation, or "—" if not applicable), and \`Translation\` (in ${native}). One word per row.\n` +
              `4. **Next time** — one concrete focus for the next session.\n\n` +
              `Be encouraging but honest. Don't invent mistakes; only call out what's actually in the transcript. Always emit a real markdown table for section 3 (pipes + header separator), never a bulleted list.`,
          },
          { role: "user", content: transcript },
        ],
        onToken: () => {},
      });
      setSummary(reply.trim());
      // Save the summary as an assistant message on the persisted chat so
      // the user can re-read it from chat history later.
      const chatId = await persistTurns();
      if (chatId) {
        await addMessage({
          chatId,
          role: "assistant",
          content: `**Session summary**\n\n${reply.trim()}`,
        });
      }
    } catch (err) {
      toast.error("Couldn't generate summary", {
        description: err instanceof Error ? err.message : String(err),
      });
      setSummaryOpen(false);
    } finally {
      setSummaryBusy(false);
    }
  }

  function leave() {
    stop();
    // Finalize the study_sessions row now so dashboard widgets pick
    // up the speaking hours immediately, before the unmount effect
    // re-fires. Best-effort; the unmount cleanup is the safety net.
    void endSession().catch(() => {
      /* will be retried on unmount */
    });
    // Best-effort save in the background; closing shouldn't wait on the DB.
    void persistTurns();
    onLeave();
  }

  // The "no provider configured" empty state only applies when the
  // user ALSO has no cloud account — the cloud backend mints a
  // Gemini Live token server-side, so a signed-in cloud user doesn't
  // need any BYOK keys. (Local Whisper is gated separately inside
  // the local hook; we don't auto-pick it because it requires a
  // running Ollama instance the user explicitly set up.)
  if (!geminiProvider && !openaiProvider && !qwenProvider && !cloud.account) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <Mic className="size-7 text-muted-foreground" />
        <h2 className="font-serif text-2xl tracking-tight">
          Live mode needs a provider or cloud account.
        </h2>
        <p className="max-w-md text-[13.5px] text-muted-foreground">
          Live voice runs on Google Gemini Live, OpenAI Realtime, or Qwen
          Realtime. Either add a Gemini / OpenAI / Qwen key in Settings →
          Providers, or sign in to Tokori Cloud under Settings → Cloud to
          use the managed Gemini Live backend.
        </p>
        <Button onClick={leave}>Back to chat</Button>
      </div>
    );
  }

  // The transcript panel reused by all three layouts. Computed up front so
  // the JSX below stays readable.
  const transcript =
    showChat && !hideText ? (
      <TranscriptPanel
        turns={turns}
        liveUser={liveUser}
        liveAssistant={liveAssistant}
        targetLang={workspace.targetLang}
        showPinyin={showPinyin}
        translateFn={translateFn}
        blurEn={blurEn}
      />
    ) : null;

  return (
    <div className="flex h-full flex-col">
      {/* Header — display toggles + leave button */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Live · {languageName(workspace.targetLang)}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <ToggleChip
            on={!hideText}
            onClick={() => setHideText((v) => !v)}
            icon={hideText ? EyeOff : Volume2}
            label={hideText ? "Audio only" : "Show text"}
            title={hideText ? "Show text" : "Audio only — hide all text"}
          />
          <ToggleChip
            on={showChat}
            onClick={() => setShowChat((v) => !v)}
            icon={MessageSquare}
            label="Chat"
            title="Show / hide the full transcript history"
          />
          {/* Layout cycle: side → bottom → fullscreen → side. Disabled when
              the chat panel itself is hidden — there's nothing to position. */}
          {showChat && (
            <ToggleChip
              on
              onClick={() =>
                setLayout((l) =>
                  l === "side" ? "bottom" : l === "bottom" ? "fullscreen" : "side",
                )
              }
              icon={
                layout === "side"
                  ? PanelRight
                  : layout === "bottom"
                    ? PanelBottom
                    : Expand
              }
              label={
                layout === "side"
                  ? "Side"
                  : layout === "bottom"
                    ? "Bottom"
                    : "Full"
              }
              title={`Transcript layout: ${layout}. Click to cycle.`}
            />
          )}
          {workspace.targetLang === "zh" && !hideText && (
            <ToggleChip
              on={showPinyin}
              onClick={() => setShowPinyin((v) => !v)}
              icon={LanguagesIcon}
              label="Pinyin"
              title={showPinyin ? "Hide pinyin" : "Show pinyin"}
            />
          )}
          {!hideText && (
            <ToggleChip
              on={!blurEn}
              onClick={() => setBlurEn((v) => !v)}
              icon={blurEn ? VolumeX : Volume2}
              label={blurEn ? "Blur EN" : "Show EN"}
              title={blurEn ? "Translation is blurred — click to reveal" : "Translation is shown"}
            />
          )}
          <button
            type="button"
            onClick={leave}
            className="ml-1 flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <X className="size-3.5" />
            Leave
          </button>
        </div>
      </div>

      {/* Body. The orb stage + transcript flow change shape based on `layout`:
          - "side": flex-row, orb takes flex-1, transcript on a fixed right rail
          - "bottom": flex-col with transcript collapsed under the orb
          - "fullscreen": transcript fills the body, orb collapses to a corner
            badge (rendered inside the transcript panel itself). */}
      <div
        className={cn(
          "flex flex-1 min-h-0",
          layout === "side" ? "flex-row" : "flex-col",
        )}
      >
      {/* Main center stage — orb + current text + translation + start button.
          Hidden in fullscreen mode so the transcript can use all the space. */}
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-5 px-6 py-6 overflow-y-auto",
          layout === "side" && "flex-1",
          layout === "bottom" && "flex-1",
          layout === "fullscreen" && transcript ? "hidden" : "flex-1",
        )}
      >
        <BreathingOrb state={state} initial={modelInitial} />

        <div className="text-center">
          <h2 className="font-serif text-xl tracking-tight">
            {state === "idle" && "Tap start to begin"}
            {state === "connecting" && "Connecting…"}
            {state === "listening" && "I'm listening"}
            {state === "speaking" && "Speaking…"}
            {state === "error" && "Something went wrong"}
          </h2>
        </div>

        {/* Live text near the orb — what the AI is saying right now (or last said) */}
        {!hideText && currentFocus && (
          <div className="w-full max-w-2xl space-y-2 text-center">
            <div
              className={cn(
                "text-[18px] leading-relaxed transition-opacity",
                currentFocus.role === "user" && "italic opacity-70",
                currentFocus.isLive && "opacity-90",
              )}
            >
              <Tokenized
                text={currentFocus.text}
                lang={workspace.targetLang}
                showRuby={showPinyin}
              />
              {currentFocus.isLive && (
                <span className="ml-1 inline-block h-4 w-1 animate-pulse rounded-full bg-emerald-500/80 align-middle" />
              )}
            </div>
            {centreTranslation && currentFocus.role === "assistant" && (
              <button
                type="button"
                onClick={() => setBlurEn((v) => !v)}
                className="block w-full select-none text-center"
                title={blurEn ? "Click to reveal" : "Click to blur"}
              >
                <p
                  className={cn(
                    "text-[14px] leading-relaxed text-muted-foreground transition-all duration-300",
                    blurEn ? "blur-[3.5px] hover:blur-[2px]" : "blur-0",
                  )}
                >
                  {centreTranslation}
                </p>
              </button>
            )}
          </div>
        )}

        {hideText && isActive && (
          <p className="text-[12.5px] italic text-muted-foreground">
            Audio only — text hidden. Toggle "Show text" up top to bring it back.
          </p>
        )}

        {/* Pre-session setup: what to talk about. Chips pick the mode;
            roleplay/topic take a free-text seed that lands in the
            system prompt. Hidden once the conversation is running. */}
        {!isActive && (
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-card/60 px-5 py-4 text-left shadow-sm">
            <p className="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              Conversation
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  {
                    id: "free",
                    icon: MessageSquare,
                    label: "Free talk",
                    blurb: "Open chat — the tutor follows your lead",
                  },
                  {
                    id: "textbook",
                    icon: BookOpenText,
                    label: "Textbook chapter",
                    blurb:
                      "Practise your current study-focus chapter (set it from the Library)",
                  },
                  {
                    id: "roleplay",
                    icon: Drama,
                    label: "Roleplay",
                    blurb: "Act out a scene — you and the tutor play characters",
                  },
                  {
                    id: "topic",
                    icon: Hash,
                    label: "Topic",
                    blurb: "Talk about something specific",
                  },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSessionMode(m.id)}
                  aria-pressed={sessionMode === m.id}
                  title={m.blurb}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
                    sessionMode === m.id
                      ? "border-foreground/30 bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  <m.icon className="size-3.5" />
                  {m.label}
                </button>
              ))}
            </div>
            {(sessionMode === "roleplay" || sessionMode === "topic") && (
              <Input
                value={sessionTopic}
                onChange={(e) => setSessionTopic(e.target.value)}
                placeholder={
                  sessionMode === "roleplay"
                    ? "Scenario — e.g. ordering at a restaurant, checking into a hotel…"
                    : "Topic — e.g. weekend plans, football, my hometown…"
                }
                className="mt-2.5 h-8 text-[13px]"
              />
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {sessionMode === "free"
                ? "The tutor opens with an easy question and keeps it conversational, at your level."
                : sessionMode === "textbook"
                  ? "The tutor anchors the chat on your current study focus — vocabulary, themes, gentle quizzing."
                  : sessionMode === "roleplay"
                    ? "The tutor plays the other character and stays in scene, stepping out briefly for corrections."
                    : "The tutor keeps the conversation on your topic with short, simple questions."}
            </p>
          </div>
        )}

        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-muted-foreground",
            // Pre-session, the engine knobs sit in a card matching the
            // Conversation block; mid-session they collapse back to the
            // quiet inline strip (speed stays adjustable).
            !isActive &&
              "w-full max-w-2xl rounded-2xl border border-border bg-card/60 px-5 py-4 shadow-sm",
          )}
        >
          <div className="flex items-center gap-2">
            <label htmlFor="live-backend" className="opacity-70">
              Provider
            </label>
            <select
              id="live-backend"
              value={liveBackend}
              disabled={isActive}
              onChange={(e) => setLiveBackend(e.target.value as LiveBackend)}
              className="rounded-md border border-border bg-background px-2 py-0.5 text-[11.5px] text-foreground disabled:opacity-50"
            >
              {!HOSTED && (
                <option value="gemini" disabled={!geminiProvider}>
                  Gemini Live{!geminiProvider ? " (no key)" : ""}
                </option>
              )}
              {!HOSTED && (
                <option value="openai" disabled={!openaiProvider}>
                  OpenAI Realtime{!openaiProvider ? " (no key)" : ""}
                </option>
              )}
              {!HOSTED && (
                <option value="qwen" disabled={!qwenProvider}>
                  Qwen Realtime{!qwenProvider ? " (no key)" : ""}
                </option>
              )}
              <option value="cloud">
                {HOSTED
                  ? "Tokori Cloud (Gemini Live)"
                  : "Tokori Cloud (Gemini Live, server-proxied)"}
                {!cloud.account ? " — sign in required" : ""}
              </option>
              {!HOSTED && (
                <option value="local">
                  Local pipeline (Whisper + LLM + TTS)
                </option>
              )}
            </select>
          </div>
          {liveBackend === "gemini" ||
          liveBackend === "openai" ||
          liveBackend === "qwen" ? (
            <>
              <div className="flex items-center gap-2">
                <label htmlFor="live-model" className="opacity-70">
                  Model
                </label>
                <select
                  id="live-model"
                  value={liveModel}
                  disabled={isActive}
                  onChange={(e) => setLiveModel(e.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[11.5px] text-foreground disabled:opacity-50"
                >
                  {(liveBackend === "openai"
                    ? OPENAI_LIVE_MODELS
                    : liveBackend === "qwen"
                      ? QWEN_LIVE_MODELS
                      : KNOWN_LIVE_MODELS
                  ).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="live-voice" className="opacity-70">
                  Voice
                </label>
                <select
                  id="live-voice"
                  value={liveVoice}
                  disabled={isActive}
                  onChange={(e) => setLiveVoice(e.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-0.5 text-[11.5px] text-foreground disabled:opacity-50"
                >
                  {(liveBackend === "openai"
                    ? OPENAI_LIVE_VOICES
                    : liveBackend === "qwen"
                      ? QWEN_LIVE_VOICES
                      : GEMINI_LIVE_VOICES
                  ).map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} — {v.blurb}
                    </option>
                  ))}
                </select>
                {/* Preview goes through each provider's regular TTS
                    endpoint — wired for Gemini + OpenAI only; Qwen's
                    voices are realtime-only here, so no sample button. */}
                {liveBackend !== "qwen" && (
                  <button
                    type="button"
                    onClick={() => void previewVoice()}
                    disabled={isActive || previewing || !activeProvider?.apiKey}
                    title="Hear a sample"
                    className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground transition-colors hover:bg-accent/60 disabled:opacity-50"
                  >
                    {previewing ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Play className="size-3" />
                    )}
                    Preview
                  </button>
                )}
                {liveBackend === "qwen" && (
                  <span
                    className="text-[10.5px] opacity-60"
                    title="Derived from your Qwen provider's base URL — keys are region-bound"
                  >
                    · {qwenRegion === "cn" ? "China region" : "International"}
                  </span>
                )}
              </div>
              {liveBackend === "openai" && (
                <div className="flex items-center gap-2">
                  <label htmlFor="live-transcription" className="opacity-70">
                    Transcription
                  </label>
                  <select
                    id="live-transcription"
                    value={transcriptionModel}
                    disabled={isActive}
                    onChange={(e) =>
                      setTranscriptionModel(e.target.value as OpenAITranscriptionModel)
                    }
                    title="Model used to transcribe your speech for the live caption"
                    className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[11.5px] text-foreground disabled:opacity-50"
                  >
                    {OPENAI_TRANSCRIPTION_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id} — {m.blurb}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          ) : liveBackend === "cloud" && !cloud.account ? (
            // Cloud backend picked without a signed-in account — the
            // server can't mint a Live token, so Start is disabled.
            // Say so here instead of letting the button silently stay
            // grey.
            <span className="inline-flex flex-wrap items-center gap-2 text-[11.5px]">
              <span className="text-amber-700 dark:text-amber-400">
                Tokori Cloud needs a signed-in account for live voice.
              </span>
              <button
                type="button"
                onClick={() => {
                  requestSettingsIntent("openCloud");
                  navigateToTab("settings");
                }}
                className="cursor-pointer rounded-md border border-border bg-background px-2 py-0.5 text-[11.5px] text-foreground transition-colors hover:bg-accent/60"
              >
                Sign in — Settings → Cloud
              </button>
            </span>
          ) : liveBackend === "cloud" ? (
            // Cloud Gemini Live — the cloud server mints an
            // ephemeral auth token, the desktop opens a WS to
            // Gemini directly with it. Gemini's prebuilt voices
            // are language-agnostic (Aoede / Charon / … all speak
            // any language the model supports), so we don't filter
            // the list by workspace target — same picker the
            // direct Gemini Live backend uses.
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="live-model-cloud" className="opacity-70">
                Model
              </label>
              <select
                id="live-model-cloud"
                value={liveModel}
                disabled={isActive}
                onChange={(e) => setLiveModel(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[11.5px] text-foreground disabled:opacity-50"
                title="Cloud Live mints a Gemini v1alpha ephemeral token; the desktop opens the WS directly. The 3.1 preview is the recommended default; the 2.5 native-audio-dialog variants are retained for fallback."
              >
                {CLOUD_LIVE_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <label htmlFor="live-voice-cloud" className="opacity-70">
                Voice
              </label>
              <select
                id="live-voice-cloud"
                value={liveVoice}
                disabled={isActive}
                onChange={(e) => setLiveVoice(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-0.5 text-[11.5px] text-foreground disabled:opacity-50"
              >
                {GEMINI_LIVE_VOICES.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} — {v.blurb}
                  </option>
                ))}
              </select>
              <label htmlFor="live-mic-cloud" className="opacity-70">
                Mic
              </label>
              <select
                id="live-mic-cloud"
                value={micDeviceId}
                disabled={isActive}
                onChange={(e) => setMicDeviceId(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-0.5 text-[11.5px] text-foreground disabled:opacity-50"
                title="Pick which microphone to capture from. Defaults to OS default."
              >
                <option value="">System default</option>
                {micDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>
              <span className="text-[10.5px] opacity-60">
                · realtime Gemini Live via your cloud credits ·
                auto-detects when you stop · API key stays server-
                side
              </span>
            </div>
          ) : (
            // Local pipeline doesn't pick a "live model" or "live
            // voice" the way the WebSocket backends do — STT, LLM,
            // and TTS each have their own settings elsewhere
            // (Settings → Voice, Settings → Providers). Surface a
            // short summary instead so the user knows what's wired.
            <span className="text-[11.5px] opacity-70">
              Push-to-talk · Whisper STT + active chat provider + TTS from
              Settings → Voice. Configure each in its own section.
            </span>
          )}
          {/* Voice speed — every backend, adjustable mid-session (the
              pipelines read the rate per chunk). */}
          <div className="flex items-center gap-2">
            <label htmlFor="live-rate" className="opacity-70">
              Speed
            </label>
            <select
              id="live-rate"
              value={String(voiceRate)}
              onChange={(e) => setVoiceRate(Number(e.target.value))}
              title="Voice playback speed — applies from the next reply chunk. On the OpenAI / Qwen backends pitch shifts slightly with speed."
              className="rounded-md border border-border bg-background px-2 py-0.5 text-[11.5px] tabular-nums text-foreground"
            >
              {LIVE_VOICE_RATES.map((r) => (
                <option key={r} value={String(r)}>
                  {r}×
                </option>
              ))}
            </select>
          </div>
        </div>

        {state === "error" && error && (
          <div className="flex max-w-md items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        <div className="flex gap-3">
          {!isActive ? (
            <Button
              size="lg"
              onClick={() => {
                void ensureStarted("speaking");
                // Pick the workspace target language as the STT
                // hint so MiniMax's ASR doesn't try to detect it
                // from a one-second clip — bonus accuracy for free.
                start({
                  apiKey: activeProvider?.apiKey ?? "",
                  model: liveModel,
                  systemPrompt,
                  voiceName: liveVoice,
                  transcriptionModel,
                  // DashScope routing for the Qwen backend — ignored by
                  // the others.
                  region: qwenRegion,
                  sttLang: workspace?.targetLang,
                  ttsLang: workspace?.targetLang,
                  deviceId: micDeviceId || undefined,
                });
              }}
              disabled={!canStart}
              className="rounded-full px-6"
            >
              <Mic className="size-4" />
              {state === "error"
                ? "Try again"
                : sessionMode === "free"
                  ? "Start free talk"
                  : sessionMode === "textbook"
                    ? "Start chapter practice"
                    : sessionMode === "roleplay"
                      ? "Start roleplay"
                      : "Start topic talk"}
            </Button>
          ) : (
            <>
              {/* Manual end-of-turn for the stitched local
                  pipeline. Cloud mode now uses Gemini Live's
                  built-in VAD (auto-detects when you stop talking
                  on the model side, no client-side silence timer
                  needed), so it doesn't need a Stop talking
                  button — same UX as the direct Gemini Live
                  backend. */}
              {liveBackend === "local" && state === "listening" && (
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => {
                    const lc = live as { finishTurn?: () => Promise<void> };
                    void lc.finishTurn?.();
                  }}
                  className="rounded-full px-6"
                  title="Stop talking and let the assistant respond"
                >
                  <MicOff className="size-4" />
                  Stop talking
                </Button>
              )}
              <Button
                size="lg"
                variant="destructive"
                onClick={async () => {
                  stop();
                  // Close the study_sessions row so the dashboard
                  // Skill balance picks up the speaking minutes. The
                  // unmount effect handles this too, but the user
                  // often lingers on the summary modal after clicking
                  // End — without this call, the row stays open
                  // (duration_secs=null) until the idle timer fires.
                  void endSession().catch(() => {});
                  // Persist first, then offer to summarise. Both run in
                  // parallel — the user shouldn't have to wait on either to
                  // see the modal open.
                  void persistTurns();
                  if (turns.length > 0) {
                    void generateSummary();
                  }
                }}
                className="rounded-full px-6"
              >
                <MicOff className="size-4" />
                End session
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Transcript panel — position depends on `layout`. */}
      {transcript && (
        <div
          className={cn(
            layout === "side" &&
              "w-[400px] xl:w-[460px] shrink-0 overflow-y-auto border-l border-border bg-muted/20",
            layout === "bottom" &&
              "max-h-[35vh] overflow-y-auto border-t border-border bg-muted/30",
            layout === "fullscreen" && "flex-1 overflow-y-auto bg-muted/10",
          )}
        >
          {/* In fullscreen we float a small orb badge in the top-right so the
              user still sees activity even though the main stage is hidden. */}
          {layout === "fullscreen" && (
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background/85 px-4 py-2 backdrop-blur">
              <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <BreathingOrb state={state} initial={modelInitial} small />
                <span>
                  {state === "listening"
                    ? "Listening"
                    : state === "speaking"
                      ? "Speaking"
                      : state === "connecting"
                        ? "Connecting…"
                        : state === "thinking"
                          ? "Thinking…"
                          : state === "error"
                            ? "Error"
                            : "Idle"}
                </span>
              </div>
              {isActive && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={async () => {
                    stop();
                    void persistTurns();
                    if (turns.length > 0) void generateSummary();
                  }}
                  className="rounded-full"
                >
                  <MicOff className="size-3.5" />
                  End
                </Button>
              )}
            </div>
          )}
          {transcript}
        </div>
      )}
      </div>

      {/* Session summary modal — opens automatically after End session, or
          on demand from the "Summarise" button below. The body is rendered
          through ChatMarkdown so it gets the same treatment as a regular
          assistant bubble: GFM markdown (headings, tables, lists), plus
          the Tokenized click-to-define popovers on every target-language
          word that appears in quoted sentences and the vocab table. The
          tutor prompt asks for section 3 as a real markdown table so the
          vocab list lands as a clean grid (Word / Reading / Translation)
          rather than a bulleted dump. */}
      <Dialog open={summaryOpen} onOpenChange={(v) => !v && setSummaryOpen(false)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4" />
              Session feedback
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[65vh] overflow-y-auto pr-1">
            {summaryBusy && !summary && (
              <div className="flex items-center gap-2 px-1 py-2 text-[13px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Reading the transcript…
              </div>
            )}
            {summary && (
              <ChatMarkdown text={summary} lang={workspace.targetLang} />
            )}
          </div>
          <DialogFooter className="items-center">
            {savedChatIdRef.current != null && (
              <p className="mr-auto text-[11.5px] text-muted-foreground">
                Saved to chat history.
              </p>
            )}
            <Button variant="outline" onClick={() => setSummaryOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Renders the running list of completed turns. Extracted so all three
 *  layouts can reuse identical content without repeating the JSX. */
function TranscriptPanel({
  turns,
  liveUser,
  liveAssistant,
  targetLang,
  showPinyin,
  translateFn,
  blurEn,
}: {
  turns: { role: "user" | "assistant"; content: string }[];
  liveUser: string | null;
  liveAssistant: string | null;
  targetLang: LanguageCode;
  showPinyin: boolean;
  translateFn: (text: string) => Promise<string | null>;
  blurEn: boolean;
}) {
  if (turns.length === 0 && !liveUser && !liveAssistant) {
    return (
      <p className="px-5 py-6 text-center text-[12.5px] text-muted-foreground">
        Transcript will appear here as you speak.
      </p>
    );
  }
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-2.5 px-5 py-4 text-[13.5px]">
      {turns.map((t, i) => (
        <TranscriptBubble
          key={i}
          role={t.role}
          content={t.content}
          lang={targetLang}
          showPinyin={showPinyin}
          translate={translateFn}
          blurEn={blurEn}
        />
      ))}
    </div>
  );
}

/** Small filled-pill toggle used in the live header. */
function ToggleChip({
  on,
  onClick,
  icon: Icon,
  label,
  title,
}: {
  on: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
        on
          ? "bg-foreground text-background"
          : "border border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

function BreathingOrb({
  state,
  initial,
  small,
}: {
  state: string;
  initial: string;
  /** Compact ~24px variant for the fullscreen-mode header strip. The
   *  rings + avatar drop their padding and animation depth so the badge
   *  reads at a glance without dominating the strip. */
  small?: boolean;
}) {
  const isListening = state === "listening";
  const isSpeaking = state === "speaking";
  const isConnecting = state === "connecting";
  const isError = state === "error";

  if (small) {
    return (
      <div
        className={cn(
          "flex size-6 items-center justify-center rounded-full text-[11px] font-semibold text-background transition-colors",
          isSpeaking && "bg-violet-500 animate-pulse",
          isListening && "bg-emerald-500",
          isConnecting && "bg-amber-500 animate-pulse",
          isError && "bg-destructive",
          !isSpeaking && !isListening && !isConnecting && !isError && "bg-muted-foreground",
        )}
      >
        {initial}
      </div>
    );
  }

  return (
    <div className="relative flex size-[200px] items-center justify-center">
      {/* Outer breathing rings */}
      <div
        className={cn(
          "absolute inset-0 rounded-full transition-colors duration-300",
          isListening && "bg-emerald-500/15 animate-[breath_2.4s_ease-in-out_infinite]",
          isSpeaking && "bg-violet-500/20 animate-[breath_1.4s_ease-in-out_infinite]",
          isConnecting && "bg-amber-500/15 animate-pulse",
          isError && "bg-destructive/15",
          !isListening &&
            !isSpeaking &&
            !isConnecting &&
            !isError &&
            "bg-muted/40",
        )}
      />
      <div
        className={cn(
          "absolute inset-6 rounded-full transition-colors duration-300",
          isListening && "bg-emerald-500/20 animate-[breath_2.4s_ease-in-out_infinite_0.2s]",
          isSpeaking && "bg-violet-500/30 animate-[breath_1.4s_ease-in-out_infinite_0.2s]",
          isConnecting && "bg-amber-500/20",
          isError && "bg-destructive/25",
          !isListening &&
            !isSpeaking &&
            !isConnecting &&
            !isError &&
            "bg-muted/60",
        )}
      />
      {/* Core avatar — model initial */}
      <div
        className={cn(
          "relative flex size-[110px] items-center justify-center rounded-full text-background shadow-lg transition-all duration-300",
          isSpeaking
            ? "bg-violet-600 scale-105"
            : isListening
              ? "bg-emerald-600"
              : isError
                ? "bg-destructive"
                : "bg-foreground",
        )}
      >
        <span className="font-serif text-4xl tracking-tight">{initial}</span>
      </div>
    </div>
  );
}

function TranscriptBubble({
  role,
  content,
  lang,
  live = false,
  showPinyin = false,
  translate,
  blurEn = true,
}: {
  role: "user" | "assistant";
  content: string;
  lang: LanguageCode;
  live?: boolean;
  showPinyin?: boolean;
  translate?: (text: string) => Promise<string | null>;
  /** Whether the EN translation should start blurred. Per-bubble click also toggles. */
  blurEn?: boolean;
}) {
  const [translation, setTranslation] = useState<string | null>(null);
  const [overrideReveal, setOverrideReveal] = useState<boolean | null>(null);
  const fetchedRef = useRef(false);

  // Auto-fetch translation for completed assistant turns only.
  useEffect(() => {
    if (role !== "assistant" || live || fetchedRef.current || !translate) return;
    if (content.trim().length < 4) return;
    fetchedRef.current = true;
    void translate(content).then((t) => {
      if (t) setTranslation(t);
    });
  }, [role, content, live, translate]);

  // Effective reveal: header default (blurEn) overridden by per-bubble click.
  const revealed = overrideReveal ?? !blurEn;

  // Both bubbles keep the normal theme foreground (no color inversion):
  // pinyin tone colors, vocab-status underlines, and the click-to-define
  // popover triggers are all tuned against the regular background, and
  // the old inverted user bubble rendered them illegibly in dark mode.
  // Extra leading when ruby is on so the reading rail doesn't collide
  // with the line above.
  if (role === "user") {
    return (
      <div
        className={cn(
          "self-end",
          live && "animate-pulse opacity-80",
          !live && "animate-in fade-in slide-in-from-bottom-1 duration-300",
        )}
      >
        <div
          className={cn(
            "ml-auto w-fit max-w-[80%] rounded-[16px] rounded-tr-sm border border-foreground/10 bg-foreground/[0.05] px-3.5 py-2 text-[13.5px] leading-relaxed shadow-sm",
            "dark:border-white/10 dark:bg-white/[0.07]",
            showPinyin && "leading-[2.1]",
          )}
        >
          <Tokenized text={content} lang={lang} showRuby={showPinyin} />
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        live && "animate-pulse opacity-80",
        !live && "animate-in fade-in slide-in-from-bottom-1 duration-300",
      )}
    >
      <div
        className={cn(
          "w-fit max-w-[88%] rounded-[16px] rounded-tl-sm border border-border/70 bg-card px-3.5 py-2 text-[13.5px] leading-relaxed shadow-sm",
          "dark:border-white/10 dark:bg-white/[0.04]",
          showPinyin && "leading-[2.1]",
        )}
      >
        <Tokenized text={content} lang={lang} showRuby={showPinyin} />
        {translation && !live && (
          <button
            type="button"
            onClick={() => setOverrideReveal((v) => (v == null ? !revealed : !v))}
            className="mt-1.5 block w-full cursor-pointer select-none border-t border-border/50 pt-1.5 text-left"
            title={revealed ? "Click to blur the translation" : "Click to reveal the translation"}
          >
            <p
              className={cn(
                "text-[12.5px] leading-relaxed text-muted-foreground transition-all duration-300",
                revealed ? "blur-0" : "blur-[3px] hover:blur-[2px]",
              )}
            >
              {translation}
            </p>
          </button>
        )}
      </div>
    </div>
  );
}

function pickLiveModel(model: string): string {
  // Strip any "models/" prefix the user might have typed.
  const stripped = model.replace(/^models\//, "").trim();
  if (KNOWN_LIVE_MODELS.includes(stripped)) return stripped;
  return DEFAULT_LIVE_MODEL;
}

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw == null) return fallback;
  return raw === "1";
}

function readString(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return window.localStorage.getItem(key) ?? fallback;
}

/**
 * MiniMax T2A voice catalogue (curated subset). The full list is
 * fetchable via MiniMax's voice-management API — we ship a
 * pinned-and-tasted subset here so the picker is short and the
 * desktop doesn't pay a network round-trip just to populate a
 * dropdown. Users can still pass an arbitrary id by editing the
 * stored value in `live.voice.cloud`. Voice ids must match
 * MiniMax's catalogue verbatim — these aren't friendly aliases.
 *
 * Each entry tags the language it best fits so the live-mode UI
 * can default to the right voice for the workspace's target
 * language and hide the picker (with a "not available" message)
 * when MiniMax doesn't ship a voice for that language at all.
 */
export const MINIMAX_LIVE_VOICES: Array<{
  name: string;
  blurb: string;
  lang: LanguageCode;
}> = [
  { name: "English_Graceful_Lady", blurb: "warm, conversational", lang: "en" },
  { name: "English_Insightful_Speaker", blurb: "measured, expository", lang: "en" },
  { name: "English_radiant_girl", blurb: "bright, energetic", lang: "en" },
  { name: "English_Persuasive_Man", blurb: "deep, persuasive", lang: "en" },
  { name: "English_Lucky_Robot", blurb: "playful synthetic", lang: "en" },
  {
    name: "Chinese (Mandarin)_Lyrical_Voice",
    blurb: "soft, lyrical",
    lang: "zh",
  },
  {
    name: "Chinese (Mandarin)_HK_Flight_Attendant",
    blurb: "professional",
    lang: "zh",
  },
  {
    name: "Japanese_Whisper_Belle",
    blurb: "soft, intimate",
    lang: "ja",
  },
];

/** Voices filtered to the workspace's target language. Used by the
 *  picker dropdown — when this is empty for the current workspace,
 *  the UI flips to a "MiniMax doesn't support {language} yet"
 *  message instead of showing an empty select. */
export function minimaxVoicesForLanguage(
  lang: LanguageCode,
): Array<{ name: string; blurb: string; lang: LanguageCode }> {
  return MINIMAX_LIVE_VOICES.filter((v) => v.lang === lang);
}

/** First voice for `lang`, or `null` if MiniMax has nothing in that
 *  language. The hook below uses this as the default — Chinese
 *  workspace lands on a Mandarin voice, Japanese on a Japanese one,
 *  English on the warm English default. */
export function defaultMinimaxVoiceFor(lang: LanguageCode): string | null {
  return minimaxVoicesForLanguage(lang)[0]?.name ?? null;
}

/**
 * Gemini Live's prebuilt voice catalogue. Names come from the
 * BidiGenerateContent docs — Google occasionally adds voices, so we
 * accept any string from the user but show this list as suggestions.
 *
 * The descriptors are subjective hints sourced from informal community
 * comparisons; ymmv across languages. For language learners the
 * practical choice is "warm vs neutral" — the actual accent comes from
 * the LLM's pronunciation, not from the voice persona.
 */
export const GEMINI_LIVE_VOICES: Array<{ name: string; blurb: string }> = [
  { name: "Aoede", blurb: "warm, expressive (default)" },
  { name: "Charon", blurb: "deep, measured" },
  { name: "Fenrir", blurb: "energetic, gravelly" },
  { name: "Kore", blurb: "neutral, clear" },
  { name: "Puck", blurb: "playful, lively" },
  { name: "Leda", blurb: "soft, gentle" },
  { name: "Orus", blurb: "professional, even" },
  { name: "Zephyr", blurb: "bright, conversational" },
];
