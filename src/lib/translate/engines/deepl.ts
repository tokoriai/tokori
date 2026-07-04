/**
 * DeepL — Free or Pro.
 *
 * The two tiers live on different hosts (`api-free` vs `api`) but share the
 * request shape. The user can override `baseUrl` to switch tiers; the
 * engine defaults to `api-free.deepl.com/v2/translate` because that's
 * what DeepL hands out without billing on file.
 *
 * DeepL doesn't expose a "Chinese" target — it only knows `ZH`. We
 * uppercase the supplied target code to match their convention.
 */

import { Languages } from "lucide-react";
import type { TranslateEngine, TranslateRequest } from "../api";

const DEFAULT_ENDPOINT = "https://api-free.deepl.com/v2/translate";

type DeeplResponse = {
  translations?: { text: string }[];
  message?: string;
};

const engine: TranslateEngine = {
  meta: {
    kind: "deepl",
    name: "DeepL",
    description:
      "DeepL Free or Pro. Override base URL to switch tiers (api-free.deepl.com vs api.deepl.com).",
    fields: ["apiKey", "baseUrl"],
    icon: Languages,
  },
  async translate({ texts, source, target, config }: TranslateRequest) {
    const key = config.apiKey?.trim();
    if (!key) throw new Error("DeepL requires an API key (DeepL-Auth-Key).");
    const endpoint = config.baseUrl?.trim() || DEFAULT_ENDPOINT;
    const params = new URLSearchParams();
    for (const t of texts) params.append("text", t);
    params.set("source_lang", source.toUpperCase());
    params.set("target_lang", target.toUpperCase());
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const json = (await res.json()) as DeeplResponse;
    if (!res.ok) {
      throw new Error(json.message ?? `deepl ${res.status}`);
    }
    const out = json.translations ?? [];
    return texts.map((_, i) => out[i]?.text ?? "");
  },
};

export default engine;
