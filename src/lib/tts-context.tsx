import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { getSetting, setSetting } from "./db";
import { useProviderConfigs } from "./provider-context";
import { requestSettingsIntent } from "./settings-intent";
import { navigateToTab } from "./nav-event";
import {
  bcp47ForLang,
  DEFAULT_TTS_CONFIG,
  playBytes,
  speak,
  stopTTS,
  synthesizeBytes,
  type TTSConfig,
} from "./tts";

const KEY = "tts.config";

type TTSContextValue = {
  config: TTSConfig;
  setConfig: (next: TTSConfig) => Promise<void>;
  /** Speak text through the active provider. `silent` (used by autoplay)
   *  suppresses the failure toast and leaves the global `busy` flag
   *  untouched so it doesn't spin every SpeakButton or toast once per
   *  card — it just tries to play and stays quiet if it can't. */
  speak: (text: string, lang?: string, opts?: { silent?: boolean }) => Promise<void>;
  /** Synthesise to raw bytes — used by the flashcard "Generate audio"
   *  button to persist the result on a vocab row. Falls back to an
   *  error when the active provider is browser-default (which can't be
   *  captured); callers should toast the error. */
  synthesize: (
    text: string,
    lang?: string,
  ) => Promise<{ bytes: Uint8Array; mime: string }>;
  /** Play previously-cached audio bytes. Used for instant + offline
   *  review of cards that already have audio attached. */
  playCached: (bytes: Uint8Array, mime?: string) => Promise<void>;
  stop: () => void;
  /** True while AI providers are fetching / playing audio. */
  busy: boolean;
};

const TTSContext = createContext<TTSContextValue | null>(null);

export function TTSProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<TTSConfig>(DEFAULT_TTS_CONFIG);
  const [busy, setBusy] = useState(false);
  const { providers } = useProviderConfigs();

  useEffect(() => {
    let cancelled = false;
    void getSetting(KEY)
      .then((raw) => {
        if (cancelled || !raw) return;
        try {
          const parsed = JSON.parse(raw) as TTSConfig;
          setConfigState({ ...DEFAULT_TTS_CONFIG, ...parsed });
        } catch {
          /* ignore — keep defaults */
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setConfig = useCallback(async (next: TTSConfig) => {
    setConfigState(next);
    try {
      await setSetting(KEY, JSON.stringify(next));
    } catch {
      // settings table may not exist outside Tauri — that's fine
    }
  }, []);

  const speakNow = useCallback(
    async (text: string, lang?: string, opts?: { silent?: boolean }) => {
      const fallbackOpenaiKey = providers.find((p) => p.kind === "openai")?.apiKey ?? undefined;
      const fallbackMinimaxKey = providers.find((p) => p.kind === "minimax")?.apiKey ?? undefined;
      if (!opts?.silent) setBusy(true);
      try {
        await speak(text, config, {
          lang: lang ? bcp47ForLang(lang) : undefined,
          fallbackOpenaiKey,
          fallbackMinimaxKey,
        });
      } catch (err) {
        // Autoplay stays quiet — a toast per failing card (and a
        // spinner on every SpeakButton) would be worse than silence.
        if (opts?.silent) {
          console.warn("[tts] autoplay failed", err);
          return;
        }
        // Manual play surfaces an actionable toast — the action jumps the
        // user to Settings → Voice with the section pre-selected. Most TTS
        // errors are config-shaped (missing key for the active provider, a
        // voice the OS doesn't ship), and the fix lives on that page.
        toast.error("TTS failed", {
          description: err instanceof Error ? err.message : String(err),
          action: {
            label: "Open settings",
            onClick: () => {
              requestSettingsIntent("openTTS");
              navigateToTab("settings");
            },
          },
        });
      } finally {
        if (!opts?.silent) setBusy(false);
      }
    },
    [config, providers],
  );

  const synthesize = useCallback(
    async (text: string, lang?: string) => {
      const fallbackOpenaiKey = providers.find((p) => p.kind === "openai")?.apiKey ?? undefined;
      const fallbackMinimaxKey = providers.find((p) => p.kind === "minimax")?.apiKey ?? undefined;
      return synthesizeBytes(text, config, {
        lang: lang ? bcp47ForLang(lang) : undefined,
        fallbackOpenaiKey,
        fallbackMinimaxKey,
      });
    },
    [config, providers],
  );

  const playCached = useCallback(async (bytes: Uint8Array, mime?: string) => {
    setBusy(true);
    try {
      await playBytes(bytes, mime);
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(() => {
    stopTTS();
    setBusy(false);
  }, []);

  return (
    <TTSContext.Provider
      value={{
        config,
        setConfig,
        speak: speakNow,
        synthesize,
        playCached,
        stop,
        busy,
      }}
    >
      {children}
    </TTSContext.Provider>
  );
}

export function useTTS() {
  const ctx = useContext(TTSContext);
  if (!ctx) throw new Error("useTTS must be used inside TTSProvider");
  return ctx;
}
