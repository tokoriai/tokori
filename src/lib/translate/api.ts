/**
 * Public translation-engine API.
 *
 * The vocab-import dialog (and, later, click-to-define when CC-CEDICT
 * misses) need to translate a list of foreign words into the user's
 * native language. There's no single "right" service for that, so we
 * model translation the same way we model `ChatProvider`: a pluggable
 * engine identified by `kind`, configured per-engine, instantiable
 * many times, with one set as default.
 *
 * Engine kinds shipped today:
 *
 *   - `google-free`   Public unauthenticated `translate.googleapis.com`
 *                     endpoint. Zero setup — works as a permanent
 *                     fallback even if the user configures nothing.
 *                     Unofficial, no SLA, but reliable for low volume.
 *   - `google-cloud`  Official Google Cloud Translation v2 (API key).
 *   - `deepl`         DeepL API (free or pro).
 *   - `baidu`         Baidu Fanyi (appid + secret).
 *   - `ai`            Reuse a configured ChatProvider — useful for users
 *                     who already pay for OpenAI/Anthropic/etc and want
 *                     LLM-quality translations without adding another
 *                     subscription.
 *
 * Authoring a new engine:
 *   1. `src/lib/translate/engines/<kind>.ts` exporting `default { meta, translate }`.
 *   2. Append to `ENGINES` in `./registry.ts`.
 *   3. Update the `TranslateKind` union below.
 *
 * Engines see only the per-row config the user filled in; they don't
 * touch the DB. The host code (settings UI, import dialog) handles
 * persistence and engine selection.
 */

import type { ComponentType } from "react";
import type { ChatMessage } from "../provider-context";
import type { ProviderConfig } from "../db";

/** Stable identifier for the engine implementation. */
export type TranslateKind =
  | "google-free"
  | "google-cloud"
  | "deepl"
  | "baidu"
  | "ai";

/** Per-engine config row, persisted in `translate_configs`. Optional fields
 *  apply to a subset of engines — the editor UI picks which inputs to show
 *  based on `engine.meta.fields`. */
export type TranslateConfig = {
  id: number;
  kind: TranslateKind;
  label: string;
  /** API key (Google Cloud, DeepL) or appid (Baidu). */
  apiKey: string | null;
  /** Secondary key — Baidu's secret. */
  secondaryKey: string | null;
  /** Custom endpoint override (optional for DeepL Pro/Free split). */
  baseUrl: string | null;
  /**
   * For `kind = "ai"`: id of the ProviderConfig to call. Stored as a
   * separate column so the FK survives provider edits cleanly.
   */
  providerId: number | null;
  /** For `kind = "ai"`: optional model override (else use the provider's). */
  model: string | null;
  isDefault: boolean;
  createdAt: number;
};

/** Form-field hint so the editor knows what inputs to render. */
export type TranslateField =
  | "apiKey"
  | "secondaryKey"
  | "baseUrl"
  | "provider"
  | "model";

export type TranslateEngineMeta = {
  kind: TranslateKind;
  /** Display name. */
  name: string;
  /** Short pitch shown in the editor. */
  description: string;
  /** Inputs the editor should expose for this engine. */
  fields: TranslateField[];
  /** True if this engine works without any user config (google-free). */
  zeroConfig?: boolean;
  /** Optional Lucide icon. */
  icon?: ComponentType<{ className?: string }>;
};

/** Arguments handed to an engine for one batch of strings. */
export type TranslateRequest = {
  /** ISO-639 code (or BCP-47 tag) of the source. Whatever the workspace's
   *  target language code is — engines may map it as needed. */
  source: string;
  /** ISO-639 code of the destination (workspace's native language). */
  target: string;
  /** Words/phrases to translate, in order. */
  texts: string[];
  /** Resolved config row for this engine. */
  config: TranslateConfig;
  /**
   * Hook the host injects so AI engines can reuse the existing chat
   * pipeline. The engine calls this with the messages it wants the LLM
   * to handle and gets back the full response. Non-AI engines ignore it.
   */
  callAi?: (args: {
    provider: ProviderConfig;
    model: string;
    messages: ChatMessage[];
  }) => Promise<string>;
  /** Lookup a ProviderConfig by id (for AI engines that need it). */
  getProvider?: (id: number) => ProviderConfig | null;
};

export type TranslateEngine = {
  meta: TranslateEngineMeta;
  /** Translate `texts` into `target` language. Must return an array of the
   *  same length as `request.texts`; missing entries should come back as
   *  empty strings rather than throwing for the whole batch. */
  translate: (req: TranslateRequest) => Promise<string[]>;
};
