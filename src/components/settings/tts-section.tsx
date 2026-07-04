import { useEffect, useState } from "react";
import { Loader2, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProviderConfigs } from "@/lib/provider-context";
import { useProfile } from "@/lib/profile-context";
import { findWhisperProvider, isBrowserSTTAvailable } from "@/lib/stt";
import { useTTS } from "@/lib/tts-context";
import {
  EDGE_DEFAULT_VOICE_BY_LANG,
  MINIMAX_DEFAULT_VOICE_BY_LANG,
  OPENAI_VOICES,
  SUPERTONIC_DEFAULT_VOICE_BY_LANG,
  SUPERTONIC_VOICES,
  type TTSKind,
} from "@/lib/tts";
import { profileFor } from "@/lib/languages";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";

const PROVIDERS: { id: TTSKind; label: string; sub: string; cost: string }[] = [
  {
    id: "browser",
    label: "Browser (free)",
    sub: "Built into your OS — no key, no internet.",
    cost: "Free",
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    sub: "Free, no key. Surprisingly good Neural voices for every language.",
    cost: "Free",
  },
  {
    id: "openai",
    label: "OpenAI",
    sub: "tts-1 / tts-1-hd. Reuses your OpenAI key if you have one.",
    cost: "$0.015 / 1k chars",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    sub: "Best voices, multilingual. Paid API key required.",
    cost: "From $5/mo",
  },
  {
    id: "minimax",
    label: "MiniMax",
    sub: "Best Mandarin and Japanese voices, multilingual. Paid API key.",
    cost: "Pay-as-you-go",
  },
  {
    id: "fish",
    label: "Fish-speech / OmniVoice",
    sub: "Local server — runs entirely on your machine. No keys, no network. Ideal for offline / privacy.",
    cost: "Free (self-hosted)",
  },
  {
    id: "supertonic",
    label: "Supertonic",
    sub: "On-device ONNX TTS, 31 languages, ~167× real-time. Run `supertonic serve` locally — no keys, no network.",
    cost: "Free (self-hosted)",
  },
];

export function TTSSection() {
  const { active: workspace } = useWorkspace();
  const { providers } = useProviderConfigs();
  const tts = useTTS();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [testing, setTesting] = useState(false);

  // Load installed browser voices (async on Chromium).
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const refresh = () => setVoices(window.speechSynthesis.getVoices());
    refresh();
    window.speechSynthesis.onvoiceschanged = refresh;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const openaiProviderKey = providers.find((p) => p.kind === "openai")?.apiKey ?? "";
  const minimaxProviderKey = providers.find((p) => p.kind === "minimax")?.apiKey ?? "";
  const langHint = workspace?.targetLang ?? "en";
  // Sample sentence for the "Test voice" button is pulled straight from the
  // language profile so adding a language only touches language-profiles.ts.
  const sample = profileFor(langHint).ttsSample;

  async function testVoice() {
    setTesting(true);
    try {
      await tts.speak(sample, langHint);
    } finally {
      setTesting(false);
    }
  }

  // Filter browser voices to ones likely matching the workspace's target language,
  // but always allow picking from the full list.
  const matchingVoices = voices.filter((v) =>
    v.lang.toLowerCase().startsWith(langHint.toLowerCase()),
  );
  const otherVoices = voices.filter((v) => !matchingVoices.includes(v));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Text-to-speech</h2>
        <p className="text-[13px] text-muted-foreground">
          Pick a voice provider for the speak buttons in chat, the word popover, and
          flashcards. Browser is free; OpenAI and ElevenLabs sound better but use your
          API key.
        </p>
      </div>

      {/* Provider picker */}
      <div className="grid gap-2 sm:grid-cols-3">
        {PROVIDERS.map((p) => {
          const active = tts.config.kind === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                void tts.setConfig({ ...tts.config, kind: p.id })
              }
              className={cn(
                "flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all",
                active
                  ? "border-foreground/40 bg-accent/30"
                  : "border-border hover:border-foreground/20 hover:bg-accent/20",
              )}
            >
              <div className="flex w-full items-center justify-between">
                <span className="text-[13.5px] font-medium">{p.label}</span>
                <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
                  {p.cost}
                </span>
              </div>
              <p className="text-[12px] text-muted-foreground">{p.sub}</p>
            </button>
          );
        })}
      </div>

      {/* Per-provider config */}
      {tts.config.kind === "browser" && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="grid gap-2">
            <Label>Voice</Label>
            <Select
              value={tts.config.browserVoiceURI ?? "default"}
              onValueChange={(v) =>
                void tts.setConfig({
                  ...tts.config,
                  browserVoiceURI: v === "default" ? undefined : v,
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Default voice" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">System default</SelectItem>
                {matchingVoices.length > 0 && (
                  <>
                    {matchingVoices.map((v) => (
                      <SelectItem key={v.voiceURI} value={v.voiceURI}>
                        {v.name} · {v.lang}
                      </SelectItem>
                    ))}
                  </>
                )}
                {otherVoices.length > 0 && (
                  <>
                    {otherVoices.slice(0, 30).map((v) => (
                      <SelectItem key={v.voiceURI} value={v.voiceURI}>
                        {v.name} · {v.lang}
                      </SelectItem>
                    ))}
                  </>
                )}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {voices.length === 0
                ? "Loading installed voices…"
                : `${matchingVoices.length} match ${langHint.toUpperCase()} of ${voices.length} total.`}
            </p>
          </div>
          <RateSlider />
        </div>
      )}

      {tts.config.kind === "openai" && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="grid gap-2">
            <Label>Voice</Label>
            <Select
              value={tts.config.openaiVoice ?? "alloy"}
              onValueChange={(v) =>
                void tts.setConfig({ ...tts.config, openaiVoice: v })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPENAI_VOICES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Model</Label>
            <Select
              value={tts.config.openaiModel ?? "tts-1"}
              onValueChange={(v) =>
                void tts.setConfig({ ...tts.config, openaiModel: v })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tts-1">tts-1 — fast / cheaper</SelectItem>
                <SelectItem value="tts-1-hd">tts-1-hd — better quality</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>API key</Label>
            <Input
              type="password"
              placeholder={openaiProviderKey ? "Using your OpenAI provider key" : "sk-…"}
              value={tts.config.openaiKey ?? ""}
              onChange={(e) =>
                void tts.setConfig({ ...tts.config, openaiKey: e.target.value || undefined })
              }
            />
            <p className="text-[11px] text-muted-foreground">
              Leave blank to reuse the key from Settings → Providers (OpenAI).
            </p>
          </div>
          <RateSlider />
        </div>
      )}

      {tts.config.kind === "elevenlabs" && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="grid gap-2">
            <Label>Voice ID</Label>
            <Input
              value={tts.config.elevenVoiceId ?? ""}
              onChange={(e) =>
                void tts.setConfig({ ...tts.config, elevenVoiceId: e.target.value })
              }
              placeholder="21m00Tcm4TlvDq8ikWAM"
              className="font-mono text-[13px]"
            />
            <p className="text-[11px] text-muted-foreground">
              Browse voices at elevenlabs.io/voices and paste the voice ID here.
            </p>
          </div>
          <div className="grid gap-2">
            <Label>Model</Label>
            <Select
              value={tts.config.elevenModel ?? "eleven_multilingual_v2"}
              onValueChange={(v) =>
                void tts.setConfig({ ...tts.config, elevenModel: v })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="eleven_multilingual_v2">eleven_multilingual_v2</SelectItem>
                <SelectItem value="eleven_turbo_v2_5">eleven_turbo_v2_5 (fast)</SelectItem>
                <SelectItem value="eleven_flash_v2_5">eleven_flash_v2_5 (cheap)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>API key</Label>
            <Input
              type="password"
              placeholder="xi-…"
              value={tts.config.elevenKey ?? ""}
              onChange={(e) =>
                void tts.setConfig({ ...tts.config, elevenKey: e.target.value || undefined })
              }
            />
          </div>
        </div>
      )}

      {tts.config.kind === "edge" && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="grid gap-2">
            <Label>Voice</Label>
            <Input
              value={tts.config.edgeVoice ?? ""}
              onChange={(e) =>
                void tts.setConfig({ ...tts.config, edgeVoice: e.target.value })
              }
              placeholder={
                EDGE_DEFAULT_VOICE_BY_LANG[langHint] ??
                EDGE_DEFAULT_VOICE_BY_LANG.en
              }
              className="font-mono text-[13px]"
            />
            <p className="text-[11px] text-muted-foreground">
              Leave blank to use the recommended Neural voice for{" "}
              <span className="font-medium">{langHint.toUpperCase()}</span>:{" "}
              <span className="font-mono">
                {EDGE_DEFAULT_VOICE_BY_LANG[langHint] ??
                  EDGE_DEFAULT_VOICE_BY_LANG.en}
              </span>
              . Browse all voices at{" "}
              <a
                href="https://learn.microsoft.com/azure/ai-services/speech-service/language-support?tabs=tts"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Microsoft's voice catalogue
              </a>
              .
            </p>
          </div>
          <RateSlider />
        </div>
      )}

      {tts.config.kind === "fish" && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="grid gap-2">
            <Label>Server URL</Label>
            <Input
              value={tts.config.fishUrl ?? ""}
              onChange={(e) =>
                void tts.setConfig({ ...tts.config, fishUrl: e.target.value })
              }
              placeholder="http://localhost:8080"
              className="font-mono text-[12.5px]"
            />
            <p className="text-[11px] text-muted-foreground">
              Where the fish-speech / OmniVoice server is listening.
              fish-speech defaults to <code className="font-mono">8080</code>; OmniVoice forks vary.
              Run the server from the project's CLI ({" "}
              <a
                href="https://github.com/fishaudio/fish-speech"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                fish-speech docs
              </a>
              ) and paste its address here.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>API shape</Label>
              <Select
                value={tts.config.fishApiShape ?? "fish"}
                onValueChange={(v) =>
                  void tts.setConfig({
                    ...tts.config,
                    fishApiShape: v as "fish" | "openai-compat",
                  })
                }
              >
                <SelectTrigger className="text-[12.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fish">
                    fish-speech native (POST /v1/tts)
                  </SelectItem>
                  <SelectItem value="openai-compat">
                    OpenAI-compatible (POST /v1/audio/speech)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Voice / reference</Label>
              <Input
                value={tts.config.fishVoice ?? ""}
                onChange={(e) =>
                  void tts.setConfig({
                    ...tts.config,
                    fishVoice: e.target.value,
                  })
                }
                placeholder="default"
                className="font-mono text-[12.5px]"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Voice maps to fish-speech's <code className="font-mono">reference_id</code> (a
            voice slot name) or the OpenAI-compat <code className="font-mono">voice</code> field.
            Leave blank to use the server's default voice.
          </p>
          <RateSlider />
        </div>
      )}

      {tts.config.kind === "supertonic" && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="grid gap-2">
            <Label>Server URL</Label>
            <Input
              value={tts.config.supertonicUrl ?? ""}
              onChange={(e) =>
                void tts.setConfig({
                  ...tts.config,
                  supertonicUrl: e.target.value,
                })
              }
              placeholder="http://localhost:7788"
              className="font-mono text-[12.5px]"
            />
            <p className="text-[11px] text-muted-foreground">
              Where your local Supertonic server is listening. Install
              with <code className="font-mono">pip install 'supertonic[serve]'</code>{" "}
              and start it via{" "}
              <code className="font-mono">supertonic serve --port 7788</code>.
              See the{" "}
              <a
                href="https://github.com/supertone-inc/supertonic"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Supertonic docs
              </a>
              .
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>API shape</Label>
              <Select
                value={tts.config.supertonicApiShape ?? "supertonic"}
                onValueChange={(v) =>
                  void tts.setConfig({
                    ...tts.config,
                    supertonicApiShape: v as "supertonic" | "openai-compat",
                  })
                }
              >
                <SelectTrigger className="text-[12.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="supertonic">
                    Supertonic native (POST /v1/tts)
                  </SelectItem>
                  <SelectItem value="openai-compat">
                    OpenAI-compatible (POST /v1/audio/speech)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Voice</Label>
              <Select
                value={
                  tts.config.supertonicVoice ||
                  SUPERTONIC_DEFAULT_VOICE_BY_LANG[langHint] ||
                  "F3"
                }
                onValueChange={(v) =>
                  void tts.setConfig({
                    ...tts.config,
                    supertonicVoice: v,
                  })
                }
              >
                <SelectTrigger className="text-[12.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPERTONIC_VOICES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Format</Label>
              <Select
                value={tts.config.supertonicFormat ?? "wav"}
                onValueChange={(v) =>
                  void tts.setConfig({
                    ...tts.config,
                    supertonicFormat: v as "wav" | "flac" | "ogg",
                  })
                }
              >
                <SelectTrigger className="text-[12.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wav">WAV</SelectItem>
                  <SelectItem value="flac">FLAC</SelectItem>
                  <SelectItem value="ogg">OGG</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Language override</Label>
            <Input
              value={tts.config.supertonicLang ?? ""}
              onChange={(e) =>
                void tts.setConfig({
                  ...tts.config,
                  supertonicLang: e.target.value,
                })
              }
              placeholder={langHint || "auto (workspace language)"}
              className="font-mono text-[12.5px]"
            />
            <p className="text-[11px] text-muted-foreground">
              Two-letter code (en, ja, zh, …) or <code className="font-mono">na</code>{" "}
              for language-agnostic mode. Blank = derive from the current
              workspace. Only the native endpoint reads this; the
              OpenAI-compat shape uses the server's default.
            </p>
          </div>
          <RateSlider />
        </div>
      )}

      {tts.config.kind === "minimax" && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="grid gap-2">
            <Label>Voice ID</Label>
            <Input
              value={tts.config.minimaxVoiceId ?? ""}
              onChange={(e) =>
                void tts.setConfig({ ...tts.config, minimaxVoiceId: e.target.value })
              }
              placeholder={
                MINIMAX_DEFAULT_VOICE_BY_LANG[langHint] ??
                MINIMAX_DEFAULT_VOICE_BY_LANG.en
              }
              className="font-mono text-[13px]"
            />
            <p className="text-[11px] text-muted-foreground">
              Leave blank to use the recommended voice for{" "}
              <span className="font-medium">{langHint.toUpperCase()}</span>:{" "}
              <span className="font-mono">
                {MINIMAX_DEFAULT_VOICE_BY_LANG[langHint] ??
                  MINIMAX_DEFAULT_VOICE_BY_LANG.en}
              </span>
              . Browse the full list in your MiniMax dashboard → Voices.
            </p>
          </div>
          <div className="grid gap-2">
            <Label>Model</Label>
            <Select
              value={tts.config.minimaxModel ?? "speech-02-hd"}
              onValueChange={(v) =>
                void tts.setConfig({ ...tts.config, minimaxModel: v })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="speech-02-hd">speech-02-hd — best quality</SelectItem>
                <SelectItem value="speech-02-turbo">speech-02-turbo — faster</SelectItem>
                <SelectItem value="speech-01-hd">speech-01-hd — legacy HD</SelectItem>
                <SelectItem value="speech-01-turbo">speech-01-turbo — legacy fast</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>API key</Label>
            <Input
              type="password"
              placeholder={
                minimaxProviderKey
                  ? "Using your MiniMax provider key"
                  : "paste your MiniMax key…"
              }
              value={tts.config.minimaxKey ?? ""}
              onChange={(e) =>
                void tts.setConfig({
                  ...tts.config,
                  minimaxKey: e.target.value || undefined,
                })
              }
            />
            <p className="text-[11px] text-muted-foreground">
              Leave blank to reuse the key from Settings → Providers (MiniMax).
            </p>
          </div>
          <div className="grid gap-2">
            <Label>Group ID (optional)</Label>
            <Input
              placeholder="only required by some accounts"
              value={tts.config.minimaxGroupId ?? ""}
              onChange={(e) =>
                void tts.setConfig({
                  ...tts.config,
                  minimaxGroupId: e.target.value || undefined,
                })
              }
            />
          </div>
          <RateSlider />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={testVoice} disabled={testing || tts.busy}>
          {testing || tts.busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Volume2 className="size-4" />
          )}
          Test voice
        </Button>
        <span className="text-[12px] text-muted-foreground truncate">
          {sample}
        </span>
      </div>

      <p className="rounded-lg border border-dashed border-border bg-card/40 px-4 py-3 text-[12px] text-muted-foreground">
        Hosted "Tokori credits" voice (single key, multiple providers behind it) is
        on the roadmap — same place AI chat credits will live. For now, BYOK only.
      </p>

      <DictationSection />
    </div>
  );
}

// ─── Dictation (speech-to-text) ─────────────────────────────────────
//
// The Mic button in the chat composer captures speech; this picker
// chooses the engine that turns it into text. Auto picks the best
// available — important on Linux where the WebKitGTK webview can't
// run Web Speech and we have to fall back to Whisper.

function DictationSection() {
  const { profile, update } = useProfile();
  const { providers } = useProviderConfigs();
  const browserAvailable = isBrowserSTTAvailable();
  const whisperProvider = findWhisperProvider(providers);

  const choices: {
    id: "auto" | "browser" | "whisper";
    label: string;
    sub: string;
    available: boolean;
    detail?: string;
  }[] = [
    {
      id: "auto",
      label: "Auto",
      sub: "Browser when available, otherwise Whisper.",
      available: browserAvailable || !!whisperProvider,
      detail: browserAvailable
        ? "Currently using browser speech recognition."
        : whisperProvider
          ? `Currently using Whisper via "${whisperProvider.label}".`
          : "Nothing available — set up an OpenAI/Groq provider for Whisper.",
    },
    {
      id: "browser",
      label: "Browser",
      sub: "Web Speech API. Instant + free, but missing on Linux's WebKitGTK webview.",
      available: browserAvailable,
      detail: browserAvailable
        ? "Available in this build."
        : "Not available in this webview — pick Auto or Whisper.",
    },
    {
      id: "whisper",
      label: "Whisper (OpenAI / Groq)",
      sub: "Records audio, transcribes via your openai-compatible provider's /v1/audio/transcriptions. Works anywhere a key works.",
      available: !!whisperProvider,
      detail: whisperProvider
        ? `Will use "${whisperProvider.label}" — model auto-picked from base URL.`
        : "Add an OpenAI or Groq provider in Settings → Providers to enable Whisper.",
    },
  ];

  return (
    <div className="space-y-3 border-t border-border/60 pt-6">
      <div>
        <h3 className="text-base font-semibold tracking-tight">Dictation</h3>
        <p className="text-[13px] text-muted-foreground">
          Engine for the chat's microphone button. The dictation language
          follows the workspace's "Explain to me in" setting.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {choices.map((c) => {
          const active = profile.sttKind === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => void update({ sttKind: c.id })}
              className={cn(
                "flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
                active
                  ? "border-foreground/40 bg-accent/40"
                  : "border-border bg-card hover:bg-accent/20",
                !c.available && !active && "opacity-70",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium">{c.label}</span>
                {!c.available && (
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                    not ready
                  </span>
                )}
                {c.available && active && (
                  <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
                    active
                  </span>
                )}
              </div>
              <p className="text-[11.5px] leading-snug text-muted-foreground">
                {c.sub}
              </p>
              {c.detail && (
                <p className="text-[11px] leading-snug text-muted-foreground/80">
                  {c.detail}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RateSlider() {
  const tts = useTTS();
  return (
    <div className="grid gap-1.5">
      <Label className="flex items-center justify-between">
        <span>Speed</span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {(tts.config.rate ?? 1.0).toFixed(2)}x
        </span>
      </Label>
      <input
        type="range"
        min={0.5}
        max={1.75}
        step={0.05}
        value={tts.config.rate ?? 1.0}
        onChange={(e) =>
          void tts.setConfig({ ...tts.config, rate: Number(e.target.value) })
        }
        className="w-full accent-foreground"
      />
    </div>
  );
}
