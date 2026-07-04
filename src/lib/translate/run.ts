// Shared "translate a batch of strings with the user's default engine" path.
// The sentence analyzer resolves the configured engine (falling back to free
// Google), wires up the AI shim, and calls `engine.translate`. This keeps that
// wiring in one place.

import { listProviders, listTranslateConfigs, type ProviderConfig } from "@/lib/db";
import type { ChatMessage } from "@/lib/provider-context";
import type { TranslateConfig } from "./api";
import { engineByKind, FALLBACK_ENGINE } from "./registry";

/** Zero-config Google row used when the user hasn't set up any engine — so a
 *  translate request never silently fails. */
const GOOGLE_FREE_FALLBACK: TranslateConfig = {
  id: 0,
  kind: "google-free",
  label: "Google (free)",
  apiKey: null,
  secondaryKey: null,
  baseUrl: null,
  providerId: null,
  model: null,
  isDefault: true,
  createdAt: 0,
};

type SendChat = (args: {
  messages: ChatMessage[];
  onToken: (delta: string) => void;
}) => Promise<string>;

/**
 * Translate `texts` from `source` → `target` using the user's default
 * translate engine (or free Google when nothing is configured). Returns an
 * array the same length as `texts`; an engine that can't translate a given
 * entry returns "" for it rather than throwing the whole batch.
 */
export async function translateTexts(args: {
  texts: string[];
  source: string;
  target: string;
  sendChat: SendChat;
}): Promise<string[]> {
  const { texts, source, target, sendChat } = args;
  if (texts.length === 0) return [];
  const cfgs = await listTranslateConfigs().catch(() => [] as TranslateConfig[]);
  const def = cfgs.find((c) => c.isDefault) ?? cfgs[0] ?? null;
  const engine = def ? engineByKind(def.kind) ?? FALLBACK_ENGINE : FALLBACK_ENGINE;
  const config = def ?? GOOGLE_FREE_FALLBACK;
  const providers = await listProviders().catch(() => [] as ProviderConfig[]);
  return engine.translate({
    source,
    target,
    texts,
    config,
    // AI-backed engines reuse the active chat provider via this shim.
    callAi: async ({ messages }) => sendChat({ messages, onToken: () => {} }),
    getProvider: (id: number) => providers.find((p) => p.id === id) ?? null,
  });
}
