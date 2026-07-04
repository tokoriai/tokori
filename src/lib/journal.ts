/**
 * Journal AI helpers — topic suggestions and sentence-level corrections.
 *
 * Both helpers route through the user's active provider via
 * `useProviderConfigs().sendChat`. The caller passes `sendChat` in so
 * we don't have to wire a hook into a non-component module — same
 * pattern the simplifier and vocab extractor use.
 *
 * The correction prompt asks the LLM for STRICT JSON. We accept
 * fenced (```json ... ```) wrapping and strip it. If parsing fails we
 * surface the raw text so the user can retry with a different model
 * rather than silently giving up.
 */

import type { JournalCorrection } from "./db";
import { languageName, type LanguageCode } from "./languages";

type SendChat = (args: {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  onToken: (delta: string) => void;
}) => Promise<string>;

export type SuggestTopicInput = {
  targetLang: LanguageCode;
  nativeLang: LanguageCode;
  /** A handful of words the student already knows — biases the topic
   *  toward something they can plausibly write about with their
   *  current vocabulary. */
  knownWords?: string[];
  /** When set, anchor the topic to a textbook chapter so the practice
   *  is on-curriculum. */
  chapterTitle?: string | null;
  /** Optional theme nudge from the user (e.g. "weekend", "office"). */
  hint?: string | null;
  sendChat: SendChat;
};

/** The structured shape the Journal needs: a short scannable heading
 *  for the sidebar list AND a longer "exercise" prompt for the entry
 *  view. Both come from the AI in the student's NATIVE language so
 *  there's no comprehension overhead reading the brief. */
export type SuggestedTopic = {
  title: string;
  prompt: string;
};

export async function suggestTopic(input: SuggestTopicInput): Promise<SuggestedTopic> {
  const { targetLang, nativeLang, knownWords, chapterTitle, hint, sendChat } = input;
  const targetName = languageName(targetLang);
  const nativeName = languageName(nativeLang);

  const lines: string[] = [
    `You generate ONE journal-writing exercise for a ${targetName} learner whose native language is ${nativeName}.`,
    `The student should be able to write 4–8 short sentences about it in ${targetName}.`,
    "",
    "Output format — STRICT JSON, no markdown fences, no preface:",
    `{"title": "<short label>", "prompt": "<the exercise>"}`,
    "",
    "Rules:",
    `- BOTH "title" and "prompt" must be written in ${nativeName} so the student understands the brief instantly. They will write their answer in ${targetName}.`,
    `- "title" — a short scannable label, 2–6 words, no trailing punctuation. Example shape: "Weekend plans", "A childhood memory", "Describing your room".`,
    `- "prompt" — the exercise itself, 1–3 sentences (under 220 characters). Be concrete: ask for a scene, a memory, a description; suggest what to mention (3–5 things, a tense to use, etc.).`,
    `- Make it concrete and writable rather than abstract.`,
    `- Output ONLY the JSON object. No preamble. No closing remarks.`,
  ];
  if (chapterTitle) {
    lines.push(
      "",
      `Anchor the exercise to the textbook chapter "${chapterTitle}" — pick something the student would naturally practise after that lesson.`,
    );
  }
  if (knownWords && knownWords.length > 0) {
    const sample = knownWords.slice(0, 80).join(", ");
    lines.push(
      "",
      `Known vocabulary (use as a level guide — the exercise should be writable using mostly these words):`,
      sample,
    );
  }
  if (hint && hint.trim()) {
    lines.push("", `Theme nudge from the user: ${hint.trim()}`);
  }

  const reply = await sendChat({
    messages: [
      { role: "system", content: lines.join("\n") },
      { role: "user", content: "Generate one exercise." },
    ],
    onToken: () => {},
  });
  return parseSuggestedTopic(reply);
}

/** Parse the LLM's JSON, tolerating fence wrapping and trailing prose.
 *  Falls back to using the cleaned raw string as both title and
 *  prompt so a broken model still produces a usable entry (the user
 *  can always re-suggest or edit). Exported for unit tests. */
export function parseSuggestedTopic(raw: string): SuggestedTopic {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  // Some models prefix with "Here is..." — find the first '{' and last '}'.
  const lo = s.indexOf("{");
  const hi = s.lastIndexOf("}");
  if (lo >= 0 && hi > lo) s = s.slice(lo, hi + 1);

  try {
    const parsed = JSON.parse(s) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
    if (title && prompt) {
      return {
        title: cleanLine(title).slice(0, 80),
        prompt: cleanLine(prompt).slice(0, 320),
      };
    }
  } catch {
    /* fall through */
  }

  // Fallback path: model emitted plain prose. Use it for both fields
  // so the user gets *something*; the title slice trims it to a
  // scannable label.
  const cleaned = cleanLine(raw);
  return {
    title: cleaned.slice(0, 60),
    prompt: cleaned.slice(0, 320),
  };
}

function cleanLine(raw: string): string {
  let s = raw.trim();
  // Strip leading/trailing markdown bold and quotes.
  s = s.replace(/^[*_"'“”„«»]+|[*_"'“”„«»]+$/g, "");
  const firstLine = s.split(/\r?\n/).find((l) => l.trim());
  return (firstLine ?? s).trim();
}

export type CorrectInput = {
  targetLang: LanguageCode;
  nativeLang: LanguageCode;
  /** The original topic (for context — the corrector should judge the
   *  body against the topic, not just grammar in isolation). */
  topic?: string | null;
  body: string;
  sendChat: SendChat;
};

/**
 * Run a sentence-by-sentence correction pass. Returns one
 * `JournalCorrection` per sentence the model identified in the input.
 *
 * The LLM is instructed to:
 *   - Keep already-correct sentences (severity="ok") so the user can
 *     see what worked, not only what didn't.
 *   - Provide a corrected version even for ok sentences (= identical
 *     copy) so the diff view has uniform shape.
 *   - Explain in the user's NATIVE language why the change was made.
 */
export async function correctJournal(input: CorrectInput): Promise<JournalCorrection[]> {
  const { targetLang, nativeLang, topic, body, sendChat } = input;
  const targetName = languageName(targetLang);
  const nativeName = languageName(nativeLang);

  const systemPrompt = [
    `You are a strict but supportive ${targetName} writing tutor. The student is a ${nativeName} speaker practising ${targetName} composition by writing a journal entry.`,
    "",
    "Your task: split their writing into sentences and return one correction object per sentence.",
    "",
    "Output format — STRICT JSON, no prose, no markdown fences. Return a JSON array of objects shaped like:",
    `[{"original": "...", "corrected": "...", "explanation": "...", "severity": "ok" | "minor" | "major"}, ...]`,
    "",
    "Rules:",
    `- "original" — the user's sentence, character-for-character (don't trim quotes / punctuation).`,
    `- "corrected" — the polished sentence in ${targetName}. If the original was already correct, copy it verbatim.`,
    `- "explanation" — written in ${nativeName}. ONE concise sentence describing what changed and why. For ok sentences, a brief affirmation ("Correct.") is fine.`,
    `- "severity": "ok" if no change, "minor" for small grammar/style tweaks, "major" if meaning was off, words were missing, or a learner-style mistake distorted the sentence.`,
    `- Do NOT translate the corrected sentence into ${nativeName}. Translations belong only in the explanation, and only when needed.`,
    `- Preserve every sentence the user wrote — don't merge or drop them.`,
    `- Output ONLY the JSON array. No preamble. No closing remarks.`,
  ].join("\n");

  const userPrompt = [
    topic ? `Topic: ${topic}` : null,
    "",
    "Student's writing:",
    body.trim(),
  ]
    .filter((x) => x !== null)
    .join("\n");

  const raw = await sendChat({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    onToken: () => {},
  });

  return parseCorrections(raw);
}

function parseCorrections(raw: string): JournalCorrection[] {
  // Strip markdown fences if the model couldn't help itself.
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  // Some models prefix with "Here is..." — find the first '['.
  const bracket = s.indexOf("[");
  if (bracket > 0) s = s.slice(bracket);
  // And cut anything after the matching closing bracket.
  const lastBracket = s.lastIndexOf("]");
  if (lastBracket >= 0) s = s.slice(0, lastBracket + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new Error(
      "Couldn't parse the correction response as JSON. Try a different model — smaller models sometimes wander off the JSON contract.",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Correction response wasn't a JSON array.");
  }
  const out: JournalCorrection[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const original = typeof o.original === "string" ? o.original : "";
    const corrected = typeof o.corrected === "string" ? o.corrected : original;
    const explanation = typeof o.explanation === "string" ? o.explanation : "";
    const sev = o.severity;
    const severity: JournalCorrection["severity"] =
      sev === "minor" || sev === "major" || sev === "ok" ? sev : "minor";
    if (!original.trim()) continue;
    out.push({ original, corrected, explanation, severity });
  }
  if (out.length === 0) {
    throw new Error("Correction response had no usable sentences.");
  }
  return out;
}
