import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Cloud,
  KeyRound,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelPicker } from "@/components/model-picker";
import {
  PROVIDER_KIND_LABEL,
  useProviderConfigs,
} from "@/lib/provider-context";
import { useTTS } from "@/lib/tts-context";
import type { TTSConfig } from "@/lib/tts";
import type { ProviderConfig, ProviderKind } from "@/lib/db";
import { isDemoRequested } from "@/lib/demo-seed";
import { cn } from "@/lib/utils";
import { DemoLockedPanel } from "@/components/settings/demo-locked-panel";

// ─── Provider presets ─────────────────────────────────────────────────────
//
// A "preset" is a friendlier wrapper around the underlying ProviderKind
// the Rust side knows about. Most cloud LLM services these days speak
// OpenAI-compatible JSON, so under the hood they all save as
// `kind = "openai"` with a different `baseUrl`. The preset layer is what
// turns "type api.groq.com/openai/v1 manually" into a one-click choice.
//
// Adding a preset:
//   1. Append a row to PRESETS.
//   2. (optional) Add suggested models — the model picker fetches the
//      live list once the user pastes a key, so this is just a default.
//
// Editing existing providers: presetFor() infers the preset from
// (kind, baseUrl) so old rows still light up the right picker entry.

type Preset = {
  /** Stable picker id. Doesn't need to match ProviderKind. */
  id: string;
  /** Display name in the dropdown. */
  label: string;
  /** Underlying ProviderKind the Rust side actually dispatches on. */
  kind: ProviderKind;
  /** Pre-filled base URL (only when the preset implies a fixed endpoint). */
  baseUrl?: string;
  /** Default label for the saved row when the user doesn't override it. */
  defaultLabel: string;
  /** One-liner shown under the picker. */
  description: string;
  /** Used as the `placeholder` on the API-key input (`null` for ollama). */
  keyPlaceholder: string | null;
  /** Suggested models — model picker fetches the live list when possible. */
  suggestedModels: string[];
  /** Help URL the user can click to get a key (rendered in the description). */
  signupUrl?: string;
};

const PRESETS: Preset[] = [
  {
    id: "ollama",
    kind: "ollama",
    label: "Ollama (local)",
    defaultLabel: "Ollama",
    description:
      "Run a local model. Install Ollama from ollama.com, then `ollama pull llama3.1` (or similar).",
    keyPlaceholder: null,
    suggestedModels: ["llama3.1", "qwen2.5", "gemma3"],
  },
  {
    id: "openai",
    kind: "openai",
    label: "OpenAI",
    defaultLabel: "OpenAI",
    description: "Bring your own OpenAI key. gpt-4o-mini is a cheap, fast default.",
    keyPlaceholder: "sk-…",
    suggestedModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1"],
    signupUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    kind: "anthropic",
    label: "Anthropic",
    defaultLabel: "Anthropic",
    description: "Bring your own Anthropic API key. claude-sonnet-4-6 is a good default.",
    keyPlaceholder: "sk-ant-…",
    suggestedModels: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"],
    signupUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "gemini",
    kind: "gemini",
    label: "Google Gemini",
    defaultLabel: "Google Gemini",
    description:
      "Google AI Studio key (not Vertex AI). Streams native Gemini SSE.",
    keyPlaceholder: "AIza…",
    suggestedModels: [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemini-3.1-flash-live-preview",
      "gemini-2.5-flash-preview-native-audio-dialog",
    ],
    signupUrl: "https://aistudio.google.com/app/apikey",
  },
  {
    id: "qwen",
    kind: "qwen",
    label: "Qwen (Alibaba Model Studio)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultLabel: "Qwen",
    description:
      "DashScope API key from Alibaba Cloud Model Studio. Unlocks Qwen chat models AND the Qwen Realtime backend in live voice. Mainland-China keys: change the base URL to https://dashscope.aliyuncs.com/compatible-mode/v1.",
    keyPlaceholder: "sk-…",
    suggestedModels: ["qwen-plus", "qwen-flash", "qwen-max", "qwen3-omni-flash"],
    signupUrl: "https://modelstudio.console.alibabacloud.com/?tab=model#/api-key",
  },
  {
    id: "groq",
    kind: "openai",
    label: "Groq (free tier — fastest open-source)",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultLabel: "Groq",
    description:
      "Groq's hosted inference for open-weight models (Llama, Qwen, DeepSeek). Free tier is generous and the response speed is unmatched.",
    keyPlaceholder: "gsk_…",
    suggestedModels: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "deepseek-r1-distill-llama-70b",
      "qwen-2.5-32b",
      "gemma2-9b-it",
    ],
    signupUrl: "https://console.groq.com/keys",
  },
  {
    id: "openrouter",
    kind: "openai",
    label: "OpenRouter (free open-source models)",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultLabel: "OpenRouter",
    description:
      "Single key, dozens of providers. Look for model IDs ending in `:free` for the no-cost tier.",
    keyPlaceholder: "sk-or-…",
    suggestedModels: [
      "meta-llama/llama-3.3-70b-instruct:free",
      "deepseek/deepseek-r1:free",
      "google/gemini-2.0-flash-exp:free",
      "qwen/qwen-2.5-72b-instruct:free",
      "mistralai/mistral-7b-instruct:free",
    ],
    signupUrl: "https://openrouter.ai/settings/keys",
  },
  {
    id: "cerebras",
    kind: "openai",
    label: "Cerebras (free tier — fastest Llama)",
    baseUrl: "https://api.cerebras.ai/v1",
    defaultLabel: "Cerebras",
    description:
      "Llama hosted on Cerebras's wafer-scale silicon. Free tier with daily token limits, faster than anything else for the same model.",
    keyPlaceholder: "csk-…",
    suggestedModels: [
      "llama-3.3-70b",
      "llama3.1-8b",
      "llama3.1-70b",
    ],
    signupUrl: "https://cloud.cerebras.ai/platform",
  },
  {
    id: "minimax",
    kind: "minimax",
    label: "Minimax",
    defaultLabel: "Minimax",
    description:
      "Minimax (海螺 / Hailuo) — OpenAI-compatible endpoint at api.minimax.io.",
    keyPlaceholder: "API key from minimax.io",
    suggestedModels: ["MiniMax-M1", "MiniMax-Text-01", "abab6.5s-chat"],
  },
  {
    id: "openai-compat",
    kind: "openai",
    label: "OpenAI-compatible (custom endpoint)",
    defaultLabel: "Custom",
    description:
      "Any OpenAI-compatible endpoint not in the list above (DeepSeek, Together, Fireworks, your own server, …). Set the base URL manually.",
    keyPlaceholder: "API key",
    suggestedModels: [],
  },
];

function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/** Infer the picker preset from a saved provider row. We match on
 *  (kind, baseUrl) so a row saved as a Groq preset still picks Groq when
 *  the user re-opens the editor — even though the underlying kind is
 *  openai. Falls back to the kind's primary preset, then to the
 *  custom-endpoint catchall when nothing matches. */
function presetFor(p: ProviderConfig): Preset {
  const matchByUrl = PRESETS.find(
    (pr) => pr.kind === p.kind && pr.baseUrl && pr.baseUrl === p.baseUrl,
  );
  if (matchByUrl) return matchByUrl;
  if (p.kind === "openai") {
    return PRESETS.find((pr) => pr.id === "openai")!;
  }
  return PRESETS.find((pr) => pr.kind === p.kind) ?? PRESETS[0];
}

/** Which TTS engine a chat provider can double as, if any. The app only
 *  has two providers that also speak: OpenAI and MiniMax. OpenAI's TTS
 *  endpoint is hardcoded to api.openai.com, so only a *real* OpenAI key
 *  (no custom baseUrl) qualifies — a Groq / OpenRouter key saved as
 *  kind="openai" would 401 against OpenAI's speech endpoint. Everything
 *  else (Anthropic, Gemini, Ollama, openai-compat with a custom URL) has
 *  no TTS, so we don't offer the switch. */
function ttsKindForProvider(input: {
  kind: ProviderKind;
  baseUrl?: string | null;
}): "openai" | "minimax" | null {
  if (input.kind === "minimax") return "minimax";
  if (input.kind === "openai" && !input.baseUrl) return "openai";
  return null;
}

export function ProvidersSection({
  openAddOnMount,
  onAddOpened,
}: {
  /** When true, pop the Add Provider dialog as soon as we render. Used
   *  by the chat view's deep-link from no-provider indicators. */
  openAddOnMount?: boolean;
  /** Fires once the Add dialog has been opened in response to
   *  `openAddOnMount`, so the parent can clear its one-shot flag and
   *  avoid re-opening on later re-renders. */
  onAddOpened?: () => void;
} = {}) {
  const { providers, active, setActiveId, saveProvider, deleteProvider, testProvider } =
    useProviderConfigs();
  const tts = useTTS();
  const [editing, setEditing] = useState<ProviderConfig | "new" | null>(null);

  // After saving a provider that can also do text-to-speech (OpenAI /
  // MiniMax) with a key, offer to point the voice system at it too —
  // unless it's already the active TTS engine. Saves the user a separate
  // trip to Settings → Voice to paste the same key again, and gives them
  // a reliable voice when the default Edge TTS is flaky on their machine.
  function offerTtsSwitch(saved: {
    kind: ProviderKind;
    label: string;
    apiKey?: string | null;
    baseUrl?: string | null;
  }) {
    const ttsKind = ttsKindForProvider(saved);
    if (!ttsKind) return;
    if (!saved.apiKey) return;
    if (tts.config.kind === ttsKind) return;
    const name = saved.label || PROVIDER_KIND_LABEL[saved.kind];
    toast(`Use ${name} for voice too?`, {
      description: `Switch text-to-speech to ${name}'s voices instead of the current provider.`,
      action: {
        label: "Switch",
        onClick: () => {
          const next: TTSConfig = { ...tts.config, kind: ttsKind };
          if (ttsKind === "openai") next.openaiKey = saved.apiKey ?? "";
          else next.minimaxKey = saved.apiKey ?? "";
          void tts.setConfig(next);
          toast.success(`Text-to-speech now uses ${name}.`);
        },
      },
    });
  }

  useEffect(() => {
    if (openAddOnMount) {
      setEditing("new");
      onAddOpened?.();
    }
    // We only want this to run when the flag flips on; the parent owns
    // the one-shot semantics via onAddOpened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAddOnMount]);

  // Demo mode lock — same rationale as cloud-section: don't let the
  // marketing iframe collect API keys.
  if (isDemoRequested()) {
    return <DemoLockedPanel kind="providers" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Providers</h2>
          <p className="text-[13px] text-muted-foreground">
            Run a local model with Ollama, plug in OpenAI / Anthropic / Gemini, or
            use a free open-source endpoint like Groq, OpenRouter, or Cerebras.
            Swap freely — every chat uses the active provider.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          Add provider
        </Button>
      </div>

      {providers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-10 text-center">
          <KeyRound className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No providers yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">
            Add Ollama for local-only, or pick a free option like Groq. Keys stay
            in your local SQLite db and never leave the machine unless the
            provider needs them.
          </p>
          <Button size="sm" className="mt-4" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            Add your first
          </Button>
        </div>
      ) : (
        <ul className="grid gap-2">
          {providers.map((p) => {
            const preset = presetFor(p);
            return (
              <li
                key={p.id}
                className={cn(
                  "flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors",
                  active?.id === p.id ? "border-foreground/30 ring-1 ring-foreground/10" : "border-border",
                )}
              >
                <KindIcon presetId={preset.id} kind={p.kind} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 truncate">
                    <span className="font-medium truncate">{p.label}</span>
                    {active?.id === p.id && (
                      <Badge variant="secondary" className="text-[10px]">
                        active
                      </Badge>
                    )}
                    {p.kind === "tokori-cloud" && (
                      <Badge
                        variant="secondary"
                        className="bg-emerald-500/15 text-[10px] text-emerald-700 dark:text-emerald-300"
                      >
                        Cloud
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {p.kind === "tokori-cloud"
                      ? "Hosted · billed in credits"
                      : `${preset.label} · `}
                    {p.kind !== "tokori-cloud" && (
                      <span className="font-mono">{p.model}</span>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void setActiveId(p.id);
                    toast.success(`Now using ${p.label}`);
                  }}
                  disabled={active?.id === p.id}
                >
                  Use
                </Button>
                {/* Edit / Delete are hidden for the synthesized cloud
                    row — it's managed under Settings → Cloud (sign in /
                    sign out). Showing those buttons would imply the
                    user can rename or remove the cloud provider here,
                    which they can't. */}
                {p.kind !== "tokori-cloud" && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={async () => {
                        await deleteProvider(p.id);
                        toast(`Removed ${p.label}`);
                      }}
                      title="Remove"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ProviderEditor
        open={editing != null}
        provider={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSave={async (config) => {
          await saveProvider(config);
          toast.success(`Saved ${config.label || PROVIDER_KIND_LABEL[config.kind]}`);
          setEditing(null);
          offerTtsSwitch(config);
        }}
        onTest={testProvider}
      />
    </div>
  );
}

function KindIcon({ presetId, kind }: { presetId: string; kind: ProviderKind }) {
  if (kind === "ollama") return <Zap className="size-5 text-emerald-500" />;
  if (presetId === "groq") return <Zap className="size-5 text-amber-500" />;
  if (presetId === "cerebras") return <Zap className="size-5 text-rose-500" />;
  if (presetId === "openrouter") return <Sparkles className="size-5 text-cyan-500" />;
  if (kind === "openai") return <Cloud className="size-5 text-sky-500" />;
  if (kind === "anthropic") return <Cloud className="size-5 text-orange-500" />;
  if (kind === "gemini") return <Sparkles className="size-5 text-violet-500" />;
  if (kind === "qwen") return <Sparkles className="size-5 text-indigo-500" />;
  return <Cloud className="size-5 text-rose-500" />;
}

type EditorProps = {
  open: boolean;
  provider: ProviderConfig | null;
  onClose: () => void;
  onSave: (input: {
    id?: number;
    kind: ProviderKind;
    label: string;
    model: string;
    host?: string | null;
    apiKey?: string | null;
    baseUrl?: string | null;
    isDefault?: boolean;
  }) => Promise<void>;
  onTest: (config: ProviderConfig) => Promise<string>;
};

function ProviderEditor({ open, provider, onClose, onSave, onTest }: EditorProps) {
  const [presetId, setPresetId] = useState<string>("ollama");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [host, setHost] = useState("http://localhost:11434");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    if (provider) {
      const preset = presetFor(provider);
      setPresetId(preset.id);
      setLabel(provider.label);
      setModel(provider.model);
      setHost(provider.host ?? "http://localhost:11434");
      setApiKey(provider.apiKey ?? "");
      // Use the preset's fixed baseUrl when the row is bound to a preset
      // that pins one (Groq/OpenRouter/Cerebras); for openai-compat keep
      // whatever the user set.
      setBaseUrl(provider.baseUrl ?? preset.baseUrl ?? "");
      setIsDefault(provider.isDefault);
    } else {
      setPresetId("ollama");
      setLabel("");
      setModel("");
      setHost("http://localhost:11434");
      setApiKey("");
      setBaseUrl("");
      setIsDefault(false);
    }
    setTestResult(null);
  }, [open, provider]);

  const preset = useMemo(() => presetById(presetId), [presetId]);

  // When the user picks a different preset, refresh defaults that depend
  // on the preset (baseUrl, model suggestions). We DON'T clear the API
  // key — pasting "OpenAI key, oh wait actually Groq" shouldn't make
  // them re-paste.
  function handlePresetChange(next: string) {
    const p = presetById(next);
    setPresetId(next);
    if (p.baseUrl) {
      setBaseUrl(p.baseUrl);
    } else if (presetById(presetId).baseUrl) {
      // Switching FROM a fixed-URL preset → clear the inherited URL so
      // the next preset doesn't carry it.
      setBaseUrl("");
    }
    // Reset the model when changing presets — model IDs rarely transfer.
    setModel("");
  }

  const isOllama = preset.kind === "ollama";
  const showBaseUrl =
    preset.kind === "openai" && !preset.baseUrl; // editable only for the custom catchall
  const baseUrlReadonlyHint = preset.baseUrl;

  async function handleSave() {
    setBusy(true);
    try {
      await onSave({
        id: provider?.id,
        kind: preset.kind,
        label: label.trim() || preset.defaultLabel,
        model: model.trim(),
        host: isOllama ? host.trim() : null,
        apiKey: !isOllama ? apiKey.trim() : null,
        baseUrl:
          preset.kind === "openai" || preset.kind === "minimax"
            ? (preset.baseUrl ?? (baseUrl.trim() || null))
            : null,
        isDefault,
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setBusy(true);
    setTestResult(null);
    try {
      const cfg: ProviderConfig = {
        id: provider?.id ?? 0,
        kind: preset.kind,
        label: label.trim() || preset.defaultLabel,
        model: model.trim(),
        host: isOllama ? host.trim() : null,
        apiKey: !isOllama ? apiKey.trim() : null,
        baseUrl:
          preset.kind === "openai" || preset.kind === "minimax"
            ? (preset.baseUrl ?? (baseUrl.trim() || null))
            : null,
        isDefault: false,
        createdAt: 0,
      };
      const reply = await onTest(cfg);
      setTestResult({ ok: true, text: reply || "OK" });
      toast.success("Provider responded — looks good.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({ ok: false, text: msg });
      toast.error("Provider test failed", { description: msg.slice(0, 200) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{provider ? "Edit provider" : "Add provider"}</DialogTitle>
          <DialogDescription>
            {preset.description}
            {preset.signupUrl && (
              <>
                {" "}
                <a
                  href={preset.signupUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-foreground underline-offset-2 hover:underline"
                >
                  Get a key →
                </a>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="preset">Provider</Label>
            <Select
              value={presetId}
              onValueChange={handlePresetChange}
              disabled={!!provider}
            >
              <SelectTrigger id="preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="label">Label</Label>
            <Input
              id="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={preset.defaultLabel}
            />
          </div>

          {isOllama && (
            <div className="grid gap-2">
              <Label htmlFor="host">Host</Label>
              <Input
                id="host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="http://localhost:11434"
              />
            </div>
          )}

          {!isOllama && (
            <div className="grid gap-2">
              <Label htmlFor="apiKey">API key</Label>
              <Input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={preset.keyPlaceholder ?? ""}
              />
              <p className="text-[11.5px] text-muted-foreground">
                Stored in the local SQLite db. Don't commit your db file to source control.
              </p>
            </div>
          )}

          {showBaseUrl && (
            <div className="grid gap-2">
              <Label htmlFor="baseUrl">Base URL</Label>
              <Input
                id="baseUrl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </div>
          )}

          {baseUrlReadonlyHint && preset.kind === "openai" && (
            <p className="text-[11.5px] text-muted-foreground">
              Endpoint:{" "}
              <span className="font-mono">{baseUrlReadonlyHint}</span>
            </p>
          )}

          <div className="grid gap-2">
            <Label>Model</Label>
            <ModelPicker
              kind={preset.kind}
              host={host}
              apiKey={apiKey}
              baseUrl={preset.baseUrl ?? baseUrl}
              value={model}
              onChange={setModel}
              suggested={preset.suggestedModels}
            />
            <p className="text-[11.5px] text-muted-foreground">
              {isOllama
                ? "Open the picker to fetch the list installed on your Ollama server."
                : "Open the picker to fetch the live model list from the provider."}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="size-4"
            />
            Set as default provider
          </label>

          {testResult && (
            <div
              className={cn(
                "rounded-md border px-3 py-2 text-sm",
                testResult.ok
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                  : "border-destructive/30 bg-destructive/5 text-destructive",
              )}
            >
              <div className="flex items-start gap-2">
                {testResult.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <KeyRound className="mt-0.5 size-4 shrink-0" />
                )}
                <span className="break-words">{testResult.text}</span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={handleTest} disabled={busy || !model.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Test
          </Button>
          <Button onClick={handleSave} disabled={busy || !model.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
