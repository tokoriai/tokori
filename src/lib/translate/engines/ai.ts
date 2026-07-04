/**
 * AI translation — reuses a configured ChatProvider.
 *
 * The user picks one of the LLM providers they've already set up (OpenAI,
 * Anthropic, Ollama, Gemini, …) and we send a small JSON-output prompt
 * asking the model to translate every word in the batch. This is the
 * "no extra account, just use what you already pay for" lane.
 *
 * Output format:
 *   We ask for a strict JSON array of strings, same length / order as
 *   the input. The parser is forgiving — it strips markdown fences and
 *   tolerates a leading prose sentence, then falls back to a line-by-line
 *   split if JSON parsing still fails. That covers the usual ways small
 *   local models like to wrap their answers.
 */

import { Sparkles } from "lucide-react";
import { languageName } from "../../languages";
import type { TranslateEngine } from "../api";

function buildPrompt(texts: string[], source: string, target: string): string {
  const sourceName = languageName(source);
  const targetName = languageName(target);
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return [
    `Translate each ${sourceName} item to ${targetName}. Concise dictionary gloss (one short translation, not a sentence).`,
    `Output: JSON array of ${texts.length} strings in the same order. No commentary.`,
    "",
    numbered,
  ].join("\n");
}

function stripFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  return t;
}

function tryParseArray(reply: string, expected: number): string[] | null {
  // Find the first bracket-delimited candidate. Models often add a leading
  // "Here you go:" sentence before emitting the array.
  const stripped = stripFence(reply);
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  const slice = stripped.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    if (!Array.isArray(parsed)) return null;
    if (parsed.length !== expected) return null;
    return parsed.map((x) => (x == null ? "" : String(x)));
  } catch {
    return null;
  }
}

function fallbackLineSplit(reply: string, expected: number): string[] {
  const lines = stripFence(reply)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d+[\.\)]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length !== expected) return new Array(expected).fill("");
  return lines;
}

const engine: TranslateEngine = {
  meta: {
    kind: "ai",
    name: "AI (use a configured LLM)",
    description:
      "Reuse one of your chat providers — pick the one you want to bill against and (optionally) override the model.",
    fields: ["provider", "model"],
    icon: Sparkles,
  },
  async translate({ texts, source, target, config, callAi, getProvider }) {
    if (!callAi || !getProvider) {
      throw new Error("AI engine missing host hooks (callAi/getProvider).");
    }
    if (config.providerId == null) {
      throw new Error("Pick a provider in the engine config first.");
    }
    const provider = getProvider(config.providerId);
    if (!provider) {
      throw new Error("Configured provider was deleted — pick a new one.");
    }
    const model = config.model?.trim() || provider.model;
    const prompt = buildPrompt(texts, source, target);
    const reply = await callAi({
      provider,
      model,
      messages: [
        {
          role: "system",
          content: "Translation tool. Reply with a single JSON array of strings, nothing else.",
        },
        { role: "user", content: prompt },
      ],
    });
    return tryParseArray(reply, texts.length) ?? fallbackLineSplit(reply, texts.length);
  },
};

export default engine;
