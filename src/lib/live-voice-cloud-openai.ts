/**
 * Tokori Cloud OpenAI Realtime backend.
 *
 * Same session driver as the BYOK OpenAI hook (`useOpenAIRealtime` in
 * live-voice-openai.ts) — the only difference is where the credential
 * comes from: instead of a user-supplied key, tokori-cloud mints a
 * short-lived ephemeral client secret (`POST
 * /api/ai/v1/live/openai/token`, Pro-gated, flat credit charge) and
 * the raw OPENAI_API_KEY never leaves the server. The ephemeral
 * secret rides the same "openai-insecure-api-key.<ek>" subprotocol
 * slot the BYOK path uses — verified live 2026-07-09.
 *
 * Sibling of live-voice-cloud.ts (the Gemini-backed cloud voice); the
 * token-fetch error mapping mirrors that file so both backends speak
 * the same language about auth/Pro/credit gates.
 */

import { useCallback, useRef } from "react";
import { useCloud } from "./cloud-context";
import {
  useOpenAIRealtime,
  type OpenAILiveOptions,
  type OpenAIRealtimeConnection,
} from "./live-voice-openai";

/** Models the cloud token route allows (it bakes the model into the
 *  ephemeral secret, so the list is server-enforced — keep in sync
 *  with ALLOWED_LIVE_MODELS in tokori-cloud's live/openai/token
 *  route). Order = UI order; first entry is the default. */
export const CLOUD_OPENAI_LIVE_MODELS: Array<{ id: string; blurb: string }> = [
  { id: "gpt-realtime-2.1-mini", blurb: "fast — recommended" },
  { id: "gpt-realtime-2.1", blurb: "highest quality" },
];

export function useCloudOpenAIVoice() {
  const cloud = useCloud();
  // The resolver must be referentially stable (it's a dep of the
  // driver's start callback) while still seeing fresh cloud state.
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;

  const resolve = useCallback(
    async (opts: OpenAILiveOptions): Promise<OpenAIRealtimeConnection> => {
      const c = cloudRef.current;
      if (!c.account) {
        throw new Error(
          "Sign in to Tokori Cloud under Settings → Cloud first.",
        );
      }
      const tokenRes = await fetch(`${c.apiBase}/api/ai/v1/live/openai/token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${c.account.token}`,
        },
        body: JSON.stringify({
          model: opts.model,
          voiceName: opts.voiceName,
        }),
      });
      const tokenData = (await tokenRes.json().catch(() => ({}))) as {
        token?: string;
        wsUrl?: string;
        model?: string;
        error?: string;
        message?: string;
      };
      if (!tokenRes.ok || !tokenData.token) {
        // Same actionable-copy mapping as the Gemini cloud backend —
        // a raw "mint failed (403)" reads like a bug when it's an
        // entitlement state the user can fix in two clicks.
        if (tokenRes.status === 401) {
          throw new Error(
            "Your Tokori Cloud session has expired. Sign out and back in under Settings → Cloud, then try again.",
          );
        }
        if (tokenRes.status === 403) {
          throw new Error(
            "Live voice needs an active Tokori Pro trial or subscription.",
          );
        }
        if (tokenRes.status === 402) {
          throw new Error(
            "Not enough credits for a live voice session — top up under Settings → Cloud.",
          );
        }
        if (tokenRes.status === 404) {
          // The deployed cloud predates the OpenAI live route (it 404s
          // with an HTML page, hence the empty tokenData). Say so —
          // "mint failed (404)" reads like a client bug when the fix
          // is a server redeploy.
          throw new Error(
            "The cloud server doesn't offer OpenAI Realtime yet — it needs a redeploy with the /live/openai/token route. The Gemini cloud backend works meanwhile.",
          );
        }
        throw new Error(
          `Cloud live token mint failed (${tokenRes.status})${
            tokenData.message ? `: ${tokenData.message}` : ""
          }`,
        );
      }
      // The cloud charged a flat session credit at mint time.
      void c.refreshBalance().catch(() => {});

      const base = tokenData.wsUrl ?? "wss://api.openai.com/v1/realtime";
      const model = tokenData.model ?? opts.model;
      return {
        wsUrl: `${base}?model=${encodeURIComponent(model)}`,
        protocols: ["realtime", `openai-insecure-api-key.${tokenData.token}`],
      };
    },
    [],
  );

  return useOpenAIRealtime(resolve);
}
