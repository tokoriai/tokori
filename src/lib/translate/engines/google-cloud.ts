/**
 * Official Google Cloud Translation v2 — single-key auth.
 *
 * Unlike the gtx fallback, this one is rate-limited by your billing account
 * and has an SLA. The user pastes an API key from Google Cloud console;
 * the v2 REST endpoint takes the whole batch in one POST.
 */

import { Cloud } from "lucide-react";
import type { TranslateEngine, TranslateRequest } from "../api";

const ENDPOINT = "https://translation.googleapis.com/language/translate/v2";

type V2Response = {
  data?: { translations?: { translatedText: string }[] };
  error?: { message?: string };
};

const engine: TranslateEngine = {
  meta: {
    kind: "google-cloud",
    name: "Google Cloud Translation",
    description:
      "Official Google Cloud Translation v2 — paste your API key from console.cloud.google.com.",
    fields: ["apiKey"],
    icon: Cloud,
  },
  async translate({ texts, source, target, config }: TranslateRequest) {
    const key = config.apiKey?.trim();
    if (!key) throw new Error("Google Cloud Translation requires an API key.");
    const url = `${ENDPOINT}?key=${encodeURIComponent(key)}`;
    const body = {
      q: texts,
      source,
      target,
      format: "text",
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as V2Response;
    if (!res.ok) {
      throw new Error(json.error?.message ?? `google-cloud ${res.status}`);
    }
    const out = json.data?.translations ?? [];
    return texts.map((_, i) => out[i]?.translatedText ?? "");
  },
};

export default engine;
