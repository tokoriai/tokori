// TTS dispatch layer. Browser SpeechSynthesis is the always-on default;
// OpenAI and ElevenLabs are opt-in (paid / API key).

export type TTSKind =
  | "browser"
  | "openai"
  | "elevenlabs"
  | "minimax"
  | "edge"
  | "fish"
  | "supertonic";

export type TTSConfig = {
  kind: TTSKind;
  /** OpenAI voice ("alloy"|"echo"|"fable"|"onyx"|"nova"|"shimmer"|"verse"|"ballad"). */
  openaiVoice?: string;
  /** OpenAI model — "tts-1" (fast/cheap) or "tts-1-hd" (better). */
  openaiModel?: string;
  /** OpenAI key — when missing, falls back to the OpenAI provider key. */
  openaiKey?: string;
  /** ElevenLabs voice id (e.g. "21m00Tcm4TlvDq8ikWAM" for Rachel). */
  elevenVoiceId?: string;
  elevenModel?: string;
  elevenKey?: string;
  /** MiniMax — strong Mandarin voices, multilingual. */
  minimaxVoiceId?: string;
  minimaxModel?: string;
  minimaxKey?: string;
  /** Optional GroupId, only required by some MiniMax accounts. */
  minimaxGroupId?: string;
  /** Edge TTS — free, no key, multi-voice per language. Voice id like
   * "zh-CN-XiaoxiaoNeural" / "ja-JP-NanamiNeural". */
  edgeVoice?: string;
  /** Local fish-speech / OmniVoice server. Both projects expose a
   *  similar HTTP shape (POST /v1/tts {text, reference_id?, format}),
   *  so one config covers both — point this at whichever you're
   *  running. Default fish-speech port is 8080. */
  fishUrl?: string;
  /** Optional reference voice id / speaker name. fish-speech uses
   *  `reference_id` to look up a stored voice; OmniVoice forks tend
   *  to call it `voice` or `speaker_id`. We send both keys so the
   *  same string works against either. Empty = server default. */
  fishVoice?: string;
  /** Whether the local server is fish-speech (the default) or an
   *  OpenAI-compatible TTS server (in which case we hit
   *  /v1/audio/speech with {input, voice, model}). Lets users plug
   *  in any OpenAI-compatible local TTS without us inventing a
   *  separate kind for each. */
  fishApiShape?: "fish" | "openai-compat";
  /** Supertonic — on-device ONNX TTS. The server runs as
   *  `supertonic serve --port 7788`, exposing both a native /v1/tts
   *  endpoint and an OpenAI-compatible /v1/audio/speech. 31 languages
   *  plus a language-agnostic "na" mode; voices are presets like
   *  F3/F4/F5/M1–M5. */
  supertonicUrl?: string;
  /** Voice preset id. Supertonic ships F3/F4/F5/M1/M2/M3/M4/M5. Empty
   *  means we send the per-language default (see SUPERTONIC_DEFAULT). */
  supertonicVoice?: string;
  /** Override language code sent to Supertonic's native endpoint. Empty
   *  means "derive from the workspace's lang" — Supertonic uses 2-letter
   *  codes (en, ja, zh, …) and accepts "na" for language-agnostic. */
  supertonicLang?: string;
  /** Native (POST /v1/tts with {text, voice, lang}) or OpenAI-compatible
   *  (POST /v1/audio/speech with {model, input, voice}). The native
   *  endpoint exposes language selection; the OpenAI-compat one is
   *  simpler but uses the server's default language. */
  supertonicApiShape?: "supertonic" | "openai-compat";
  /** Output format Supertonic emits — wav/flac/ogg. Supertonic does
   *  NOT produce mp3, so we keep this dedicated rather than reusing
   *  the OpenAI knob. WAV is the safest default for in-browser audio
   *  playback. */
  supertonicFormat?: "wav" | "flac" | "ogg";
  /** Browser voice URI (window.speechSynthesis.getVoices()). */
  browserVoiceURI?: string;
  /** 0.5–2.0 — applied to all backends where supported. */
  rate?: number;
};

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  // Edge is the default — free, no key, decent quality across the
  // supported workspace languages. Browser SpeechSynthesis used to be
  // the default but its voice quality varies wildly between OS/locale
  // and a fresh Linux install often has no useful voice at all. With
  // no `edgeVoice` set, the synth path picks a sensible per-language
  // default via EDGE_DEFAULT_VOICE_BY_LANG.
  kind: "edge",
  openaiVoice: "alloy",
  openaiModel: "tts-1",
  elevenVoiceId: "21m00Tcm4TlvDq8ikWAM", // Rachel — multilingual
  elevenModel: "eleven_multilingual_v2",
  minimaxModel: "speech-02-hd",
  fishUrl: "http://localhost:8080",
  fishApiShape: "fish",
  supertonicUrl: "http://localhost:7788",
  supertonicApiShape: "supertonic",
  supertonicFormat: "wav",
  rate: 1.0,
};

/** Supertonic preset voices. Documented in the supertonic-py serve guide;
 *  F* are female voices and M* are male voices. Listed here so the settings
 *  UI can show a dropdown instead of asking the user to memorise codes. */
export const SUPERTONIC_VOICES = [
  "F3",
  "F4",
  "F5",
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
] as const;

/** Per-language default Supertonic voice. The presets aren't language-
 *  specific (Supertonic is multilingual per voice), but picking a known-
 *  good default per language saves users from having to test all 8.
 *  F3 is a reasonable all-rounder; we keep one entry per language we
 *  ship a profile for. */
export const SUPERTONIC_DEFAULT_VOICE_BY_LANG: Record<string, string> = {
  zh: "F3",
  ja: "F3",
  ko: "F3",
  de: "F3",
  es: "F3",
  en: "F3",
  fr: "F3",
  it: "F3",
  pt: "F3",
};

const OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
export { OPENAI_VOICES };

// Default MiniMax voice ids per workspace language are owned by language-profiles.ts.
// This proxy preserves the old call site in tts-section while pointing at the
// single source of truth.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { CLOUD_API_BASE, HOSTED } from "./build-flags";
import { cloudAuthToken } from "./cloud-client";
import { LANGUAGE_PROFILES } from "./language-profiles";
export const MINIMAX_DEFAULT_VOICE_BY_LANG: Record<string, string> =
  Object.fromEntries(
    Object.values(LANGUAGE_PROFILES).map((p) => [p.code, p.minimaxVoice]),
  );

let currentAudio: HTMLAudioElement | null = null;

/** Stop any TTS currently playing — browser utterance + paid-provider audio. */
export function stopTTS(): void {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
}

export type SpeakOptions = {
  lang?: string; // BCP-47, e.g. "zh-CN", "ja-JP", "en-US"
  /** Optional fallback OpenAI key from your existing provider config. */
  fallbackOpenaiKey?: string;
  /** Optional fallback MiniMax key from your existing provider config.
   *  Mirrors the OpenAI fallback so users don't have to paste the same key
   *  twice — once under Providers, once under TTS. */
  fallbackMinimaxKey?: string;
};

/** Speak some text using the configured TTS provider. Stops any prior speech. */
export async function speak(
  text: string,
  config: TTSConfig,
  opts: SpeakOptions = {},
): Promise<void> {
  stopTTS();
  const trimmed = text.trim();
  if (!trimmed) return;

  if (config.kind === "openai") {
    const key = config.openaiKey || opts.fallbackOpenaiKey;
    if (!key) throw new Error("OpenAI TTS needs an API key");
    const buf = await openaiTTS({
      key,
      text: trimmed,
      voice: config.openaiVoice ?? "alloy",
      model: config.openaiModel ?? "tts-1",
      speed: config.rate ?? 1.0,
    });
    await playAudio(buf, "audio/mpeg");
    return;
  }

  if (config.kind === "elevenlabs") {
    const key = config.elevenKey;
    if (!key) throw new Error("ElevenLabs needs an API key");
    const buf = await elevenLabsTTS({
      key,
      text: trimmed,
      voiceId: config.elevenVoiceId ?? "21m00Tcm4TlvDq8ikWAM",
      model: config.elevenModel ?? "eleven_multilingual_v2",
    });
    await playAudio(buf, "audio/mpeg");
    return;
  }

  if (config.kind === "edge") {
    const langCode = (opts.lang ?? "").slice(0, 2).toLowerCase();
    const voice =
      config.edgeVoice?.trim() ||
      EDGE_DEFAULT_VOICE_BY_LANG[langCode] ||
      EDGE_DEFAULT_VOICE_BY_LANG.en;
    const { buf } = await edgeTTS({
      text: trimmed,
      voice,
      rate: rateToEdge(config.rate ?? 1.0),
    });
    await playAudio(buf, "audio/mpeg");
    return;
  }

  if (config.kind === "minimax") {
    const key = config.minimaxKey || opts.fallbackMinimaxKey;
    if (!key) throw new Error("MiniMax TTS needs an API key");
    const langCode = (opts.lang ?? "").slice(0, 2).toLowerCase();
    const voiceId =
      config.minimaxVoiceId?.trim() ||
      MINIMAX_DEFAULT_VOICE_BY_LANG[langCode] ||
      MINIMAX_DEFAULT_VOICE_BY_LANG.en;
    const buf = await minimaxTTS({
      key,
      groupId: config.minimaxGroupId?.trim() || "",
      text: trimmed,
      voiceId,
      model: config.minimaxModel ?? "speech-02-hd",
      speed: config.rate ?? 1.0,
    });
    await playAudio(buf, "audio/mpeg");
    return;
  }

  if (config.kind === "fish") {
    const buf = await fishTTS({
      url: config.fishUrl ?? "http://localhost:8080",
      shape: config.fishApiShape ?? "fish",
      text: trimmed,
      voice: config.fishVoice?.trim() || null,
    });
    await playAudio(buf, "audio/mpeg");
    return;
  }

  if (config.kind === "supertonic") {
    const { buf, mime } = await supertonicTTS({
      url: config.supertonicUrl ?? "http://localhost:7788",
      shape: config.supertonicApiShape ?? "supertonic",
      format: config.supertonicFormat ?? "wav",
      text: trimmed,
      voice: pickSupertonicVoice(config, opts.lang),
      lang: pickSupertonicLang(config, opts.lang),
      speed: config.rate ?? 1.0,
    });
    await playAudio(buf, mime);
    return;
  }

  // Browser default
  if (typeof window === "undefined" || !window.speechSynthesis) {
    throw new Error("Browser TTS not available");
  }
  const u = new SpeechSynthesisUtterance(trimmed);
  if (opts.lang) u.lang = opts.lang;
  if (config.rate) u.rate = config.rate;
  const voices = window.speechSynthesis.getVoices();
  if (config.browserVoiceURI) {
    const v = voices.find((v) => v.voiceURI === config.browserVoiceURI);
    if (v) u.voice = v;
  } else if (opts.lang) {
    // Auto-pick the first installed voice that matches the workspace target lang.
    // Without this, browsers often fall back to the default English voice and
    // mispronounce the sample (which is in the target language).
    const prefix = opts.lang.toLowerCase().slice(0, 2);
    const match =
      voices.find((v) => v.lang.toLowerCase() === opts.lang!.toLowerCase()) ??
      voices.find((v) => v.lang.toLowerCase().startsWith(prefix + "-")) ??
      voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
    if (match) u.voice = match;
  }
  window.speechSynthesis.speak(u);
}

// ─── Synthesise (return audio bytes for a player UI) ─────────────────────
//
// Mirror of `speak`, but instead of playing immediately and resolving
// when the audio ends, this returns a Blob URL the caller can hand to
// an `<audio controls>` element. Used by the reader page's "Generate
// audio" button to power a play / pause / scrub UI on top of a
// passage.
//
// Browser SpeechSynthesis is not supported here — that API doesn't
// expose a way to capture the synthesised waveform. Callers should
// fall back to `speak()` if the user only has the browser-default TTS
// configured.

export type SynthesizeResult = {
  /** Blob URL pointing at the audio bytes. The caller is responsible
   *  for revoking it (URL.revokeObjectURL) when the player is closed. */
  url: string;
  mime: string;
};

export async function synthesize(
  text: string,
  config: TTSConfig,
  opts: SpeakOptions = {},
): Promise<SynthesizeResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Nothing to synthesise");

  if (config.kind === "openai") {
    const key = config.openaiKey || opts.fallbackOpenaiKey;
    if (!key) throw new Error("OpenAI TTS needs an API key");
    const buf = await openaiTTS({
      key,
      text: trimmed,
      voice: config.openaiVoice ?? "alloy",
      model: config.openaiModel ?? "tts-1",
      speed: config.rate ?? 1.0,
    });
    return bufferToObjectUrl(buf, "audio/mpeg");
  }

  if (config.kind === "elevenlabs") {
    const key = config.elevenKey;
    if (!key) throw new Error("ElevenLabs needs an API key");
    const buf = await elevenLabsTTS({
      key,
      text: trimmed,
      voiceId: config.elevenVoiceId ?? "21m00Tcm4TlvDq8ikWAM",
      model: config.elevenModel ?? "eleven_multilingual_v2",
    });
    return bufferToObjectUrl(buf, "audio/mpeg");
  }

  if (config.kind === "edge") {
    const langCode = (opts.lang ?? "").slice(0, 2).toLowerCase();
    const voice =
      config.edgeVoice?.trim() ||
      EDGE_DEFAULT_VOICE_BY_LANG[langCode] ||
      EDGE_DEFAULT_VOICE_BY_LANG.en;
    const { buf } = await edgeTTS({
      text: trimmed,
      voice,
      rate: rateToEdge(config.rate ?? 1.0),
    });
    return bufferToObjectUrl(buf, "audio/mpeg");
  }

  if (config.kind === "minimax") {
    const key = config.minimaxKey || opts.fallbackMinimaxKey;
    if (!key) throw new Error("MiniMax TTS needs an API key");
    const langCode = (opts.lang ?? "").slice(0, 2).toLowerCase();
    const voiceId =
      config.minimaxVoiceId?.trim() ||
      MINIMAX_DEFAULT_VOICE_BY_LANG[langCode] ||
      MINIMAX_DEFAULT_VOICE_BY_LANG.en;
    const buf = await minimaxTTS({
      key,
      groupId: config.minimaxGroupId?.trim() || "",
      text: trimmed,
      voiceId,
      model: config.minimaxModel ?? "speech-02-hd",
      speed: config.rate ?? 1.0,
    });
    return bufferToObjectUrl(buf, "audio/mpeg");
  }

  if (config.kind === "fish") {
    const buf = await fishTTS({
      url: config.fishUrl ?? "http://localhost:8080",
      shape: config.fishApiShape ?? "fish",
      text: trimmed,
      voice: config.fishVoice?.trim() || null,
    });
    return bufferToObjectUrl(buf, "audio/mpeg");
  }

  if (config.kind === "supertonic") {
    const { buf, mime } = await supertonicTTS({
      url: config.supertonicUrl ?? "http://localhost:7788",
      shape: config.supertonicApiShape ?? "supertonic",
      format: config.supertonicFormat ?? "wav",
      text: trimmed,
      voice: pickSupertonicVoice(config, opts.lang),
      lang: pickSupertonicLang(config, opts.lang),
      speed: config.rate ?? 1.0,
    });
    return bufferToObjectUrl(buf, mime);
  }

  // Browser SpeechSynthesis can't be captured to a buffer — surface
  // a clear error so the caller can fall back to `speak()` or nudge
  // the user to configure a real TTS provider.
  throw new Error(
    "Browser-default TTS can't be captured for playback controls. Configure OpenAI, MiniMax, ElevenLabs, or Edge TTS in Settings → Voice.",
  );
}

function bufferToObjectUrl(buf: ArrayBuffer, mime: string): SynthesizeResult {
  const blob = new Blob([buf], { type: mime });
  return { url: URL.createObjectURL(blob), mime };
}

/** Same engine selection as `speak` / `synthesize`, but returns raw
 *  bytes + mime so callers can persist them (vocab audio cache, file
 *  export, etc.). For the Edge backend, also returns per-word
 *  `boundaries` so the reader can do karaoke-style highlighting; other
 *  backends leave that field undefined. Throws for the browser-default
 *  kind for the same reason `synthesize` does — SpeechSynthesis can't
 *  be captured. */
export async function synthesizeBytes(
  text: string,
  config: TTSConfig,
  opts: SpeakOptions = {},
): Promise<{ bytes: Uint8Array; mime: string; boundaries?: WordBoundary[] }> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Nothing to synthesise");

  if (config.kind === "openai") {
    const key = config.openaiKey || opts.fallbackOpenaiKey;
    if (!key) throw new Error("OpenAI TTS needs an API key");
    const buf = await openaiTTS({
      key,
      text: trimmed,
      voice: config.openaiVoice ?? "alloy",
      model: config.openaiModel ?? "tts-1",
      speed: config.rate ?? 1.0,
    });
    return { bytes: new Uint8Array(buf), mime: "audio/mpeg" };
  }

  if (config.kind === "elevenlabs") {
    const key = config.elevenKey;
    if (!key) throw new Error("ElevenLabs needs an API key");
    const buf = await elevenLabsTTS({
      key,
      text: trimmed,
      voiceId: config.elevenVoiceId ?? "21m00Tcm4TlvDq8ikWAM",
      model: config.elevenModel ?? "eleven_multilingual_v2",
    });
    return { bytes: new Uint8Array(buf), mime: "audio/mpeg" };
  }

  if (config.kind === "edge") {
    const langCode = (opts.lang ?? "").slice(0, 2).toLowerCase();
    const voice =
      config.edgeVoice?.trim() ||
      EDGE_DEFAULT_VOICE_BY_LANG[langCode] ||
      EDGE_DEFAULT_VOICE_BY_LANG.en;
    const { buf, boundaries } = await edgeTTS({
      text: trimmed,
      voice,
      rate: rateToEdge(config.rate ?? 1.0),
    });
    return { bytes: new Uint8Array(buf), mime: "audio/mpeg", boundaries };
  }

  if (config.kind === "minimax") {
    const key = config.minimaxKey || opts.fallbackMinimaxKey;
    if (!key) throw new Error("MiniMax TTS needs an API key");
    const langCode = (opts.lang ?? "").slice(0, 2).toLowerCase();
    const voiceId =
      config.minimaxVoiceId?.trim() ||
      MINIMAX_DEFAULT_VOICE_BY_LANG[langCode] ||
      MINIMAX_DEFAULT_VOICE_BY_LANG.en;
    const buf = await minimaxTTS({
      key,
      groupId: config.minimaxGroupId?.trim() || "",
      text: trimmed,
      voiceId,
      model: config.minimaxModel ?? "speech-02-hd",
      speed: config.rate ?? 1.0,
    });
    return { bytes: new Uint8Array(buf), mime: "audio/mpeg" };
  }

  if (config.kind === "fish") {
    const buf = await fishTTS({
      url: config.fishUrl ?? "http://localhost:8080",
      shape: config.fishApiShape ?? "fish",
      text: trimmed,
      voice: config.fishVoice?.trim() || null,
    });
    return { bytes: new Uint8Array(buf), mime: "audio/mpeg" };
  }

  if (config.kind === "supertonic") {
    const { buf, mime } = await supertonicTTS({
      url: config.supertonicUrl ?? "http://localhost:7788",
      shape: config.supertonicApiShape ?? "supertonic",
      format: config.supertonicFormat ?? "wav",
      text: trimmed,
      voice: pickSupertonicVoice(config, opts.lang),
      lang: pickSupertonicLang(config, opts.lang),
      speed: config.rate ?? 1.0,
    });
    return { bytes: new Uint8Array(buf), mime };
  }

  throw new Error(
    "Browser-default TTS can't be captured to bytes. Configure OpenAI, MiniMax, ElevenLabs, Edge, Fish-speech, or Supertonic TTS in Settings → Voice.",
  );
}

/** Play a raw audio buffer that was previously cached. Used by the
 *  flashcard playback path so reviewing a card with cached audio is
 *  instant + offline. Stops any currently-playing TTS first, mirroring
 *  `speak`'s behaviour. */
export async function playBytes(
  bytes: Uint8Array,
  mime = "audio/mpeg",
): Promise<void> {
  stopTTS();
  // .slice() always returns a Uint8Array backed by a fresh
  // ArrayBuffer (never SharedArrayBuffer), which keeps the Blob ctor
  // happy across the TS lib versions we target.
  await playAudio(bytes.slice().buffer as ArrayBuffer, mime);
}

/** Local fish-speech / OmniVoice / OpenAI-compatible TTS server.
 *
 *  fish-speech (default `shape: "fish"`):
 *    POST {url}/v1/tts
 *    body: { text, reference_id?, format: "mp3" }
 *    response: audio bytes (mp3).
 *
 *  OpenAI-compatible local TTS (`shape: "openai-compat"`):
 *    POST {url}/v1/audio/speech
 *    body: { input, voice, model: "tts-1", response_format: "mp3" }
 *    response: audio bytes.
 *
 *  Both are bare HTTP — no auth — because they're local. If a user
 *  wants to put an auth proxy in front, that's a future config knob.
 */
async function fishTTS(args: {
  url: string;
  shape: "fish" | "openai-compat";
  text: string;
  voice: string | null;
}): Promise<ArrayBuffer> {
  const base = args.url.replace(/\/$/, "");
  if (args.shape === "openai-compat") {
    const r = await fetch(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: args.text,
        voice: args.voice ?? "default",
        model: "tts-1",
        response_format: "mp3",
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Local TTS ${r.status}: ${txt.slice(0, 200) || r.statusText}`);
    }
    return r.arrayBuffer();
  }
  // fish-speech native shape. We send both `reference_id` and
  // `voice` so the request also works against OmniVoice forks that
  // accept the latter — the server ignores unknown keys.
  const r = await fetch(`${base}/v1/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: args.text,
      reference_id: args.voice ?? undefined,
      voice: args.voice ?? undefined,
      format: "mp3",
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(
      `fish-speech ${r.status}: ${txt.slice(0, 200) || r.statusText}. Is the server running at ${base}?`,
    );
  }
  return r.arrayBuffer();
}

/** Supertonic local server.
 *
 *  Native shape (default):
 *    POST {url}/v1/tts
 *    body: { text, voice, lang, response_format, speed }
 *    response: audio bytes (WAV/FLAC/OGG per response_format).
 *
 *  OpenAI-compatible shape:
 *    POST {url}/v1/audio/speech
 *    body: { model: "supertonic-3", input, voice, response_format, speed }
 *    response: audio bytes.
 *
 *  Bare HTTP, no auth — Supertonic listens on 127.0.0.1 by default and
 *  is local to the user. The default port is 7788; users can change it
 *  via `supertonic serve --port`.
 */
async function supertonicTTS(args: {
  url: string;
  shape: "supertonic" | "openai-compat";
  format: "wav" | "flac" | "ogg";
  text: string;
  voice: string;
  lang: string;
  speed: number;
}): Promise<{ buf: ArrayBuffer; mime: string }> {
  const base = args.url.replace(/\/$/, "");
  const mime = supertonicMime(args.format);
  // Supertonic only accepts speeds in [0.7, 2.0]; our rate slider runs
  // 0.5–2.0, so clamp at the edges rather than letting the server reject
  // a perfectly reasonable request.
  const speed = Math.max(0.7, Math.min(2.0, args.speed));
  if (args.shape === "openai-compat") {
    const r = await fetch(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "supertonic-3",
        input: args.text,
        voice: args.voice,
        response_format: args.format,
        speed,
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(
        `Supertonic ${r.status}: ${txt.slice(0, 200) || r.statusText}. Is the server running at ${base}?`,
      );
    }
    return { buf: await r.arrayBuffer(), mime };
  }
  // Native /v1/tts. Both `voice` and `lang` are required.
  const r = await fetch(`${base}/v1/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: args.text,
      voice: args.voice,
      lang: args.lang,
      response_format: args.format,
      speed,
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(
      `Supertonic ${r.status}: ${txt.slice(0, 200) || r.statusText}. Is the server running at ${base}? Start it with \`supertonic serve --port 7788\`.`,
    );
  }
  return { buf: await r.arrayBuffer(), mime };
}

function supertonicMime(format: "wav" | "flac" | "ogg"): string {
  switch (format) {
    case "flac":
      return "audio/flac";
    case "ogg":
      return "audio/ogg";
    default:
      return "audio/wav";
  }
}

/** Resolve the voice id we send to Supertonic. Explicit user override
 *  wins; otherwise we look up the per-language default. Supertonic's
 *  native endpoint REQUIRES a non-empty voice, so we fall back to F3
 *  as a last resort to keep "first-run with no config" working. */
function pickSupertonicVoice(
  config: TTSConfig,
  lang: string | undefined,
): string {
  const explicit = config.supertonicVoice?.trim();
  if (explicit) return explicit;
  const code = (lang ?? "").slice(0, 2).toLowerCase();
  return SUPERTONIC_DEFAULT_VOICE_BY_LANG[code] ?? "F3";
}

/** Resolve the language we send to Supertonic. Explicit config override
 *  wins; otherwise we use the BCP-47 prefix from the workspace lang
 *  (Supertonic accepts 2-letter ISO codes). Falls back to "na" — the
 *  documented language-agnostic mode — so a request never fails for a
 *  missing lang on the native endpoint. */
function pickSupertonicLang(
  config: TTSConfig,
  lang: string | undefined,
): string {
  const explicit = config.supertonicLang?.trim();
  if (explicit) return explicit;
  const code = (lang ?? "").slice(0, 2).toLowerCase();
  return code || "na";
}

async function openaiTTS(args: {
  key: string;
  text: string;
  voice: string;
  model: string;
  speed: number;
}): Promise<ArrayBuffer> {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.key}`,
    },
    body: JSON.stringify({
      model: args.model,
      voice: args.voice,
      input: args.text,
      speed: args.speed,
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`OpenAI TTS ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r.arrayBuffer();
}

/** Default Edge TTS voice per workspace language. Maps to one of Microsoft's
 * Neural voices; user can paste any other voice id from the Edge TTS catalogue. */
export const EDGE_DEFAULT_VOICE_BY_LANG: Record<string, string> = {
  zh: "zh-CN-XiaoxiaoNeural",
  ja: "ja-JP-NanamiNeural",
  ko: "ko-KR-SunHiNeural",
  de: "de-DE-KatjaNeural",
  es: "es-ES-ElviraNeural",
  en: "en-US-AriaNeural",
  fr: "fr-FR-DeniseNeural",
  it: "it-IT-ElsaNeural",
  pt: "pt-BR-FranciscaNeural",
};

function rateToEdge(rate: number): string {
  // Edge TTS expects rate as a percentage offset like "+0%", "-25%", "+50%".
  const pct = Math.round((rate - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

/** One word the TTS service spoke, with start time relative to the
 *  audio buffer. Currently only Edge populates this — other providers
 *  don't expose word-level timing. The reader uses these for
 *  karaoke-style highlighting. */
export type WordBoundary = {
  /** Audio start time in milliseconds. */
  offsetMs: number;
  /** Word duration in milliseconds. */
  durationMs: number;
  /** The literal word as Edge spoke it (used to find the word in the
   *  source text by sequential matching, since SSML offsets don't
   *  cleanly map back to the markdown-laden original). */
  text: string;
};

async function edgeTTS(args: {
  text: string;
  voice: string;
  rate: string;
}): Promise<{ buf: ArrayBuffer; boundaries: WordBoundary[] }> {
  // HOSTED: route through the cloud's `/api/ai/v1/tts/edge` server-side
  // port of the same Rust protocol. Same wire shape so we can share the
  // result handling on both paths.
  if (HOSTED) {
    return edgeTTSHosted(args);
  }
  if (!isTauri()) {
    throw new Error("Edge TTS requires the desktop build (Tauri).");
  }
  const result = await invoke<{
    audio: number[];
    boundaries: { offset_ms: number; duration_ms: number; text: string }[];
  }>("edge_tts", {
    text: args.text,
    voice: args.voice,
    rate: args.rate,
    pitch: null,
  });
  return {
    buf: new Uint8Array(result.audio).buffer,
    boundaries: result.boundaries.map((b) => ({
      offsetMs: b.offset_ms,
      durationMs: b.duration_ms,
      text: b.text,
    })),
  };
}

async function edgeTTSHosted(args: {
  text: string;
  voice: string;
  rate: string;
}): Promise<{ buf: ArrayBuffer; boundaries: WordBoundary[] }> {
  // Cloud-side Edge TTS endpoint mirrors the Rust command's response
  // shape. Auth is the same bearer used everywhere else in HOSTED.
  const token = cloudAuthToken();
  if (!token) throw new Error("Edge TTS requires sign-in.");
  const res = await fetch(`${CLOUD_API_BASE}/api/ai/v1/tts/edge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      text: args.text,
      voice: args.voice,
      rate: args.rate,
    }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string; error?: string };
      msg = j.message ?? j.error ?? msg;
    } catch {
      /* keep status */
    }
    throw new Error(`Edge TTS (hosted): ${msg}`);
  }
  const j = (await res.json()) as {
    audio: string; // base64
    boundaries: { offset_ms: number; duration_ms: number; text: string }[];
  };
  const binary = atob(j.audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return {
    buf: bytes.buffer,
    boundaries: j.boundaries.map((b) => ({
      offsetMs: b.offset_ms,
      durationMs: b.duration_ms,
      text: b.text,
    })),
  };
}

async function minimaxTTS(args: {
  key: string;
  groupId: string;
  text: string;
  voiceId: string;
  model: string;
  speed: number;
}): Promise<ArrayBuffer> {
  // MiniMax serves T2A on api.minimax.io (overseas) and api.minimax.chat (mainland).
  // GroupId is required by some accounts; harmless to omit for others.
  const base = "https://api.minimax.io/v1/t2a_v2";
  const url = args.groupId
    ? `${base}?GroupId=${encodeURIComponent(args.groupId)}`
    : base;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.key}`,
    },
    body: JSON.stringify({
      model: args.model,
      text: args.text,
      stream: false,
      voice_setting: {
        voice_id: args.voiceId,
        speed: args.speed,
        vol: 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`MiniMax TTS ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  // The audio is hex-encoded inside data.data.audio per MiniMax's spec.
  const hex: string | undefined = data?.data?.audio;
  if (!hex) {
    const code = data?.base_resp?.status_code;
    const msg = data?.base_resp?.status_msg ?? "no audio in response";
    throw new Error(`MiniMax TTS: ${msg}${code != null ? ` (code ${code})` : ""}`);
  }
  return hexToArrayBuffer(hex);
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

async function elevenLabsTTS(args: {
  key: string;
  text: string;
  voiceId: string;
  model: string;
}): Promise<ArrayBuffer> {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(args.voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": args.key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: args.text,
        model_id: args.model,
      }),
    },
  );
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`ElevenLabs ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r.arrayBuffer();
}

async function playAudio(buf: ArrayBuffer, mime: string): Promise<void> {
  const blob = new Blob([buf], { type: mime });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  return new Promise<void>((resolve, reject) => {
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      reject(new Error("audio playback failed"));
    };
    void audio.play().catch(reject);
  });
}

/** Re-export the central BCP-47 mapper. Kept here so callers don't have to
 * cross between tts.ts and languages.ts. */
export { bcp47 as bcp47ForLang } from "./languages";
