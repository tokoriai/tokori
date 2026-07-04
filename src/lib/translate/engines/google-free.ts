/**
 * Free, key-less Google Translate via the public `gtx` endpoint.
 *
 * The endpoint is unofficial — Google reserves the right to rate-limit it
 * — but it's been stable for years and is the obvious zero-setup default
 * for a local-first app. Keeps the new "translate this row" button in the
 * import dialog working even when the user hasn't configured anything.
 *
 * Each call covers one phrase. We `Promise.all` the batch to keep latency
 * tolerable for ~50 word imports; for very large batches the host can
 * chunk-and-await in serial if it wants to be polite.
 */

import { Globe } from "lucide-react";
import type { TranslateEngine, TranslateRequest } from "../api";

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";

/** The gtx endpoint returns a deeply-nested array; the first element is a
 *  list of translation segments and each segment's first cell is the
 *  translated text. Joining them recreates the full sentence. */
function extractTranslation(payload: unknown): string {
  if (!Array.isArray(payload)) return "";
  const segments = payload[0];
  if (!Array.isArray(segments)) return "";
  return segments
    .map((s) => (Array.isArray(s) ? String(s[0] ?? "") : ""))
    .join("")
    .trim();
}

async function translateOne(
  text: string,
  source: string,
  target: string,
): Promise<string> {
  const url =
    `${ENDPOINT}?client=gtx&sl=${encodeURIComponent(source)}` +
    `&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`google-free ${res.status}`);
  const json = (await res.json()) as unknown;
  return extractTranslation(json);
}

const engine: TranslateEngine = {
  meta: {
    kind: "google-free",
    name: "Google (free)",
    description:
      "Public Google Translate endpoint. No API key, no setup — works as the universal fallback.",
    fields: [],
    zeroConfig: true,
    icon: Globe,
  },
  async translate({ texts, source, target }: TranslateRequest) {
    return Promise.all(
      texts.map((t) =>
        translateOne(t, source, target).catch(() => ""),
      ),
    );
  },
};

export default engine;
