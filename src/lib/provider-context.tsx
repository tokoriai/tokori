import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  deleteProvider as dbDeleteProvider,
  getSetting,
  listProviders,
  saveProvider as dbSaveProvider,
  setSetting,
  type ProviderConfig,
  type ProviderKind,
} from "./db";
import { useCloud } from "./cloud-context";
import { HOSTED } from "./build-flags";
import { isDemoRequested } from "./demo-seed";
import {
  resolveChatProvider,
  rustProviderConfig,
  type ChatStreamArgs,
} from "./chat-providers";

export type { ChatMessage } from "./chat-providers";
export { InsufficientCloudCreditsError } from "./chat-providers";

type SendArgs = ChatStreamArgs & { override?: ProviderConfig };

type ProviderContextValue = {
  loading: boolean;
  providers: ProviderConfig[];
  active: ProviderConfig | null;
  setActiveId: (id: number | null) => Promise<void>;
  refresh: () => Promise<void>;
  saveProvider: typeof dbSaveProvider;
  deleteProvider: (id: number) => Promise<void>;
  sendChat: (args: SendArgs) => Promise<string>;
  testProvider: (config: ProviderConfig) => Promise<string>;
};

const ProviderContext = createContext<ProviderContextValue | null>(null);

const ACTIVE_KEY = "providers.activeId";


/** Sentinel id for the synthesized "Tokori Cloud" provider. Negative
 *  so it can never collide with a real DB row (rowids are always > 0).
 *  When present in `providers`, the row was injected by us, not loaded
 *  from sqlite — `saveProvider` / `deleteProvider` short-circuit. */
const CLOUD_PROVIDER_ID = -1;

/** Build the synthetic cloud provider row from the cloud account. The
 *  desktop's settings UI sees this in the providers list when the user
 *  is signed in; picking it routes chats through the cloud proxy.
 *  `tier` is reflected in the `model` field; the chat top-bar maps it
 *  to a friendly label ("Cloud: Fast" / "Cloud: Smart") for display. */
function buildCloudProvider(
  email: string,
  tier: "fast" | "advanced",
): ProviderConfig {
  return {
    id: CLOUD_PROVIDER_ID,
    kind: "tokori-cloud",
    label: `Tokori Cloud (${email})`,
    // Model = the tier label. The cloud route resolves the actual
    // MiniMax model id from this; anything beyond "fast" / "advanced"
    // server-side is opaque to the desktop.
    model: tier,
    apiKey: null,
    host: null,
    baseUrl: null,
    isDefault: false,
    createdAt: 0,
  };
}

export function ProviderConfigProvider({ children }: { children: ReactNode }) {
  const cloud = useCloud();
  const [dbProviders, setDbProviders] = useState<ProviderConfig[]>([]);
  const [activeId, setActiveIdState] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Tracks the last-warmed (host, model) for Ollama. setActiveId
  // checks this to avoid re-firing /api/generate on a click that
  // doesn't change the active row.
  const warmedRef = useRef<string | null>(null);

  // Synthesize the cloud row from the (already-loaded) cloud account
  // so it appears alongside the real DB-backed providers. Re-rendered
  // automatically when sign-in / sign-out changes the account ref.
  //
  // Hosted mode (HOSTED=true): there are no BYOK providers — the cloud
  // is the only option. Filter out any DB rows entirely. The AuthGate
  // upstream guarantees `cloud.account` is non-null before we render,
  // so the cloud row is always present.
  //
  // Demo mode (?demo=1): same hosted bundle but no signed-in account.
  // We synthesise a placeholder cloud provider anyway so the chat view
  // has something to point at — the actual chat replies in demo run
  // through `mock-ai.ts` (the !isTauri() branch in `sendChat`), so the
  // provider's apiKey field is never used.
  const providers = useMemo<ProviderConfig[]>(() => {
    if (HOSTED) {
      if (cloud.account) {
        return [buildCloudProvider(cloud.account.user.email, cloud.tier)];
      }
      if (isDemoRequested()) {
        return [buildCloudProvider("demo@tokori.ai", cloud.tier)];
      }
      return [];
    }
    if (!cloud.account) return dbProviders;
    return [
      buildCloudProvider(cloud.account.user.email, cloud.tier),
      ...dbProviders,
    ];
  }, [dbProviders, cloud.account, cloud.tier]);

  const refresh = useCallback(async () => {
    let list = await listProviders();
    // One-time cleanup pass for installs that ran the legacy
    // TokoriProviderSync (now removed) — that component wrote a
    // real openai-kind DB row labelled "Cloud (Tokori)" with the
    // session bearer baked in. The new architecture exposes the
    // cloud via the synthesised `tokori-cloud` row instead, so
    // the legacy row is now a stale duplicate sitting next to it
    // in the provider picker. We delete it here on every refresh
    // (idempotent — once it's gone, the find returns undefined
    // and this is a no-op).
    const legacy = list.find(
      (p) => p.label === "Cloud (Tokori)" && p.kind === "openai",
    );
    if (legacy) {
      try {
        await dbDeleteProvider(legacy.id);
        list = list.filter((p) => p.id !== legacy.id);
      } catch (err) {
        console.warn("[providers] could not remove legacy cloud row", err);
      }
    }
    setDbProviders(list);
    // Hosted mode: cloud is the only provider, full stop. Pin it as
    // active so the chat / translate / TTS surfaces never have to ask
    // the user to pick. The AuthGate guarantees the account is
    // present by the time we render here.
    if (HOSTED) {
      setActiveIdState(CLOUD_PROVIDER_ID);
      return;
    }
    const stored = await getSetting(ACTIVE_KEY);
    const storedId = stored ? Number(stored) : null;
    if (storedId === CLOUD_PROVIDER_ID) {
      // The user previously activated the cloud provider. Keep it
      // active (the cloud account may still be present) — the
      // synthesized row will appear via the `providers` memo. Falls
      // back to a real provider below if the cloud is now gone.
      setActiveIdState(CLOUD_PROVIDER_ID);
      return;
    }
    if (storedId && list.some((p) => p.id === storedId)) {
      setActiveIdState(storedId);
    } else {
      const fallback = list.find((p) => p.isDefault) ?? list[0] ?? null;
      setActiveIdState(fallback?.id ?? null);
    }
  }, []);

  useEffect(() => {
    refresh()
      .catch((e) => console.error("load providers", e))
      .finally(() => setLoading(false));
  }, [refresh]);

  // Auto-activate cloud on first sign-in. The synthesised cloud row
  // already appears in `providers` whenever `cloud.account` is set,
  // but the *active* provider stays whatever the user last picked.
  // For the MVP cloud experience the user expects "I signed in →
  // I'm using cloud" without an extra click, so we bump cloud into
  // the active slot the first time it becomes available IF the user
  // doesn't have any other provider configured (we don't want to
  // override someone's local Ollama setup just because they signed
  // up to back up vocab). Once a user has explicitly picked a
  // provider, this effect is a no-op on subsequent renders.
  const cloudAccountId = cloud.account?.user.id ?? null;
  useEffect(() => {
    if (cloudAccountId == null) return;
    if (loading) return;
    // Only auto-claim the active slot when there's nothing else set
    // — either no active id at all, or an active id pointing at a
    // provider that no longer exists.
    const haveActive =
      activeId != null &&
      (activeId === CLOUD_PROVIDER_ID ||
        dbProviders.some((p) => p.id === activeId));
    if (haveActive) return;
    void setActiveId(CLOUD_PROVIDER_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudAccountId, loading]);

  async function setActiveId(id: number | null) {
    setActiveIdState(id);
    await setSetting(ACTIVE_KEY, id == null ? "" : String(id));
    // Warm up Ollama only on an explicit user switch — never at app
    // start. The previous useEffect-based warm-up fired whenever
    // `active` resolved to an Ollama row on mount, which loaded the
    // model into memory even for users who'd actually configured
    // cloud (or another provider) but had a stale Ollama active id
    // persisted from a prior session. Now: clicking "Use" on an
    // Ollama row warms; restarting the app does nothing — the first
    // chat lazy-loads.
    if (id == null) return;
    const target = providers.find((p) => p.id === id);
    if (!target || target.kind !== "ollama" || !target.model) return;
    const host = (target.host ?? "http://localhost:11434").replace(/\/$/, "");
    const key = `${host}::${target.model}`;
    if (warmedRef.current === key) return;
    warmedRef.current = key;
    void warmOllama(host, target.model).catch((err) => {
      // Silent — a failing warm-up shouldn't block the user. Logged so
      // a misconfigured host (wrong port, daemon down) still leaves a
      // breadcrumb in the console.
      // eslint-disable-next-line no-console
      console.warn("[ollama] warm-up failed", err);
    });
  }

  async function saveProvider(input: Parameters<typeof dbSaveProvider>[0]) {
    // The synthetic cloud row isn't a real DB entry — saving it is a
    // no-op. This keeps the Settings UI safe: even if a future change
    // accidentally surfaces an "edit cloud provider" form, hitting
    // save won't blow up the DB layer.
    if ((input as { kind?: ProviderKind }).kind === "tokori-cloud") {
      throw new Error("Tokori Cloud is managed via Settings → Cloud");
    }
    const result = await dbSaveProvider(input);
    await refresh();
    return result;
  }

  async function deleteProvider(id: number) {
    if (id === CLOUD_PROVIDER_ID) {
      throw new Error("Sign out under Settings → Cloud to remove this provider");
    }
    await dbDeleteProvider(id);
    await refresh();
    if (activeId === id) await setActiveId(null);
  }

  const active = providers.find((p) => p.id === activeId) ?? null;

  async function sendChat({ messages, onToken, onDone, onError, override }: SendArgs) {
    // Dispatch through the runtime — cloud / mock / rust selection
    // lives in `chat-providers.ts`. This function is just the glue
    // that resolves the active config + cloud account into the right
    // provider instance.
    const cfg = override ?? active;
    const provider = resolveChatProvider(cfg, cloud);
    return provider.send({ messages, onToken, onDone, onError });
  }

  async function testProvider(config: ProviderConfig) {
    if (!isTauri()) return "(stubbed — Tauri IPC unavailable in dev)";
    return invoke<string>("provider_test", { config: rustProviderConfig(config) });
  }

  const value = useMemo<ProviderContextValue>(
    () => ({
      loading,
      providers,
      active,
      setActiveId,
      refresh,
      saveProvider,
      deleteProvider,
      sendChat,
      testProvider,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading, providers, active],
  );

  return <ProviderContext.Provider value={value}>{children}</ProviderContext.Provider>;
}

export function useProviderConfigs() {
  const ctx = useContext(ProviderContext);
  if (!ctx) throw new Error("useProviderConfigs outside ProviderConfigProvider");
  return ctx;
}

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  ollama: "Ollama (local)",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  minimax: "Minimax",
  qwen: "Qwen (DashScope)",
  "tokori-cloud": "Tokori Cloud",
};

/** Pre-warm an Ollama model by issuing an empty /api/generate request
 *  with `keep_alive: "24h"`. Ollama treats an empty prompt as "load
 *  the model and return immediately"; the keep_alive tells the daemon
 *  to pin the weights for the next 24 hours rather than evicting after
 *  the default 5-minute idle.
 *
 *  Two reasons we don't go through Rust here:
 *    1. The webview can hit localhost:11434 directly — no IPC overhead.
 *    2. We want this to be best-effort and silent. A Tauri command path
 *       would surface as a noisy unwrapped error if the daemon is down.
 *
 *  Bounded by AbortController so a hung Ollama (rare but possible if
 *  another model is loading) doesn't hold a connection open forever. */
async function warmOllama(host: string, model: string): Promise<void> {
  const ctrl = new AbortController();
  // 60s — generous, since the load itself can take a while on a cold
  // cache. We're not waiting for the response in the UI; this just
  // bounds the request lifetime so it eventually gives up.
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        // String form of a duration. Ollama accepts "24h", "30m", "-1"
        // (forever), and a few others. 24h is a reasonable
        // workstation default — long enough for a day of study, not
        // so long that a forgotten machine pins VRAM forever.
        keep_alive: "24h",
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama warm-up ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/* `sendCloudChat` and `InsufficientCloudCreditsError` now live in
   `chat-providers.ts` (as `CloudChatProvider` + the error class).
   The error class is re-exported at the top of this file for
   back-compat with `import { InsufficientCloudCreditsError } from
   "@/lib/provider-context"`. */
