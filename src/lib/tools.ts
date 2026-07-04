// Prompt-engineered tool calling. The LLM emits fenced ```polyglot-tool JSON
// blocks; we parse them after streaming and dispatch to the executor. Works with
// every provider (no native function-calling needed) and degrades gracefully.

import {
  bulkAddToCollection,
  createChapter,
  createCollection,
  getOrCreateDefaultCollection,
  listCollections,
  listLibrary,
  saveLibraryItem,
  saveVocab,
  updateVocabFields,
  type VocabStatus,
} from "./db";
import { serialiseExamples } from "./examples";

const TOOL_BLOCK_RX = /```polyglot-tool\s*\n([\s\S]+?)\n```/g;
const TOOL_RESULT_BLOCK_RX = /```polyglot-tool-result\s*\n([\s\S]+?)\n```/g;

const VOCAB_BULK_LIMIT = 200;
const CHAPTERS_LIMIT = 200;

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type ToolResult = {
  ok: boolean;
  /** Human-readable one-liner shown in the assistant bubble. */
  summary: string;
  /** Optional structured detail (e.g. list of words added). */
  details?: unknown;
};

export type ToolCallWithResult = ToolCall & { result: ToolResult };

/** System-prompt section injected on every turn so the LLM knows what it can do. */
export const TOOL_SYSTEM_INSTRUCTIONS = `
=== POLYGLOT PLATFORM ACTIONS ===

ABSOLUTE RULE — READ FIRST:
You may NOT add, save, import, modify, or create any of the user's data
unless the user's CURRENT message contains an explicit imperative like
"add", "save", "import", "create", "make", "set up", or "put". Generating
a list of words for the user to look at is NOT a request to save them.
Helpfulness is not a license to mutate data. When in doubt, do nothing
and offer in plain text: "Want me to save these? Say 'add them' and I will."

If you violate this rule the user will see an "AI tried to add X words —
[Approve] [Discard]" toast and almost always tap Discard. So the only
outcome of an unprompted tool call is wasted tokens and broken trust.

You can mutate the user's data by emitting fenced code blocks tagged with
"polyglot-tool". Each block must contain a single JSON object: {"name":"...","args":{...}}.

After your reply finishes, the host app shows the user an Approve/Discard
toast for any blocks you emit, then runs the approved ones.

Available tools:
- add_vocab: add ONE word to the user's vocabulary.
  args: { word: string, reading?: string, gloss?: string, status?: "new"|"learning"|"review"|"mastered" }
- add_vocab_bulk: add MANY words at once (up to ${VOCAB_BULK_LIMIT}). Prefer this over many add_vocab calls.
  args: { entries: [{ word, reading?, gloss?, status? }, ...] }
- import_vocab_csv: parse CSV (first row is the header) and bulk-add. Headers like
  "word/hanzi/term", "reading/pinyin/romaji", "gloss/english/meaning" are auto-mapped.
  args: { csv: string }
- add_to_collection: add words into a NAMED collection (creates the collection if missing).
  Words are also saved into vocabulary so they enter flashcard review.
  args: { collection: string, description?: string, entries: [{ word, reading?, gloss? }, ...] }
- create_flashcard: create ONE rich flashcard for a single word. Supports an
  optional cloze sentence (the word blanked out) and an example sentence — use
  this instead of add_vocab when the user wants a fuller card for one word.
  args: { word: string, reading?: string, gloss?: string, cloze?: string, example?: string, exampleTranslation?: string, status?: "new"|"learning"|"review"|"mastered" }
  For "cloze", give a natural sentence that USES the word, with the word wrapped
  as {{c1::word}} (e.g. "我每天{{c1::喝}}咖啡。").
- create_sentence_cards: create one or more SENTENCE cards — the whole sentence is
  the unit of study (front = sentence, back = translation). Use for "make sentence
  cards from these" / "turn this into a sentence card".
  args: { entries: [{ sentence: string, translation?: string, reading?: string }, ...] }
- add_textbook: create a textbook in the library.
  args: { title: string, author?: string, totalUnits?: number }
- add_textbook_chapters: append chapters to an existing textbook (matched by title).
  args: { textbookTitle: string, chapters: [{ title: string, position?: number }, ...] }

Rules:
1. RE-READ THE ABSOLUTE RULE ABOVE. The most common failure is emitting a
   tool block after the user asked a question that didn't include any
   action verb. Don't do that.
2. Phrases that count as EXPLICIT mutation requests:
     - "add this/these to vocab", "save this/these", "import this list"
     - "make a collection of …", "create a textbook for …"
     - "put this in my vocab", "set up a deck for …"
3. Phrases that DO NOT count (these are list/question requests, NOT mutation):
     - "give me five HSK 3 verbs"           → just list them
     - "what does X mean?"                  → just explain
     - "show me example sentences for X"    → just list them
     - "recommend some words to learn"      → just list them
     - "translate this paragraph"           → just translate
     - "explain this grammar"               → just explain
4. If the request is ambiguous, default to NOT emitting a tool — just list
   the data. End with: "Want me to save these to your vocab? Just say so."
5. Briefly say in plain language what you're doing before the block.
6. For more than 5 vocab entries, use add_vocab_bulk or import_vocab_csv
   (not many add_vocab).
7. Status defaults to "new" if you don't specify it.
8. If you're unsure about an argument, ask first instead of guessing.

Examples:

User: "Give me five HSK 3 verbs."  ← list-only, no save
Reply: a markdown table or numbered list of the five verbs, with a final
line like "Want these saved to your vocab? Just say 'add them' and I will."
DO NOT emit a tool block.

User: "Save these five HSK 3 verbs to my vocab."  ← explicit save
Reply:

I'll add those to your vocab now.

\`\`\`polyglot-tool
{"name":"add_vocab_bulk","args":{"entries":[
  {"word":"还是","reading":"háishi","gloss":"or; still"},
  {"word":"或者","reading":"huòzhě","gloss":"or; perhaps"}
]}}
\`\`\`

Done — let me know if you want me to mark any as "learning".

User: "Make a cloze flashcard for 喝."  ← explicit create
Reply:

Here's a cloze card for 喝 (to drink).

\`\`\`polyglot-tool
{"name":"create_flashcard","args":{"word":"喝","reading":"hē","gloss":"to drink","cloze":"我每天{{c1::喝}}咖啡。","example":"我每天喝咖啡。","exampleTranslation":"I drink coffee every day."}}
\`\`\`

User: "Turn these three into sentence cards."  ← explicit create
Reply:

Adding those as sentence cards.

\`\`\`polyglot-tool
{"name":"create_sentence_cards","args":{"entries":[
  {"sentence":"我每天喝咖啡。","translation":"I drink coffee every day."}
]}}
\`\`\`
=== END PLATFORM ACTIONS ===
`.trim();

/** Pull every tool block out of the assistant content. */
export function parseToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  TOOL_BLOCK_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_BLOCK_RX.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj.name === "string") {
        calls.push({
          name: obj.name,
          args: (obj.args ?? {}) as Record<string, unknown>,
        });
      }
    } catch {
      // ignore malformed JSON
    }
  }
  return calls;
}

/** Pull saved tool results back out of the message content (added on send). */
export function parseToolResults(content: string): ToolResult[] {
  const results: ToolResult[] = [];
  TOOL_RESULT_BLOCK_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_RESULT_BLOCK_RX.exec(content)) !== null) {
    try {
      results.push(JSON.parse(m[1]) as ToolResult);
    } catch {
      /* ignore */
    }
  }
  return results;
}

/** Strip both polyglot-tool and polyglot-tool-result fences from a string. */
export function stripToolBlocks(content: string): string {
  return content
    .replace(TOOL_BLOCK_RX, "")
    .replace(TOOL_RESULT_BLOCK_RX, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TOOL_FENCE = "```polyglot-tool";

/** Hide a *partial* tool fence at the streaming tail ("``", "```poly",
 *  …). It may be the start of a tool block whose marker hasn't fully
 *  streamed yet — show nothing until the next chunk disambiguates. A
 *  legit opening code fence reappears one token later (once a non-
 *  matching language tag arrives), so the cost of a wrong guess is a
 *  single hidden frame. Tails that *close* an open ordinary code block
 *  are kept: when the preceding text has an odd number of ``` fences,
 *  the trailing one is a closer, not a potential tool-block opener. */
function trimPartialFenceTail(s: string): string {
  const max = Math.min(TOOL_FENCE.length - 1, s.length);
  for (let take = max; take >= 1; take--) {
    if (!TOOL_FENCE.startsWith(s.slice(-take))) continue;
    const before = s.slice(0, s.length - take);
    const fencesBefore = (before.match(/```/g) ?? []).length;
    if (fencesBefore % 2 !== 0) return s;
    return before.trimEnd();
  }
  return s;
}

/** Streaming-safe variant of `stripToolBlocks`. While tokens arrive a
 *  tool block is usually *unterminated* — the opening fence is present
 *  but the closing one hasn't streamed yet — so the complete-block
 *  regex can't see it and the raw JSON would leak into the bubble char
 *  by char. This also truncates at an unclosed opening fence, hides a
 *  trailing partial fence, and reports the in-flight tool (once its
 *  `"name"` has streamed in) so the UI can show a thinking-style pulse
 *  instead of the JSON. */
export function sanitizeStreamingReply(content: string): {
  text: string;
  /** A tool block — complete or still streaming — is present. */
  toolPending: boolean;
  /** Name of the first pending tool, null until it has streamed in. */
  pendingToolName: string | null;
} {
  const fenceIdx = content.indexOf(TOOL_FENCE);
  let pendingToolName: string | null = null;
  if (fenceIdx !== -1) {
    const m = content.slice(fenceIdx).match(/"name"\s*:\s*"([\w-]+)"/);
    if (m) pendingToolName = m[1];
  }
  // Complete blocks first, then anything left from an unterminated
  // opening fence through to the end of the text.
  let text = stripToolBlocks(content);
  const openIdx = text.indexOf(TOOL_FENCE);
  if (openIdx !== -1) text = text.slice(0, openIdx).trimEnd();
  text = trimPartialFenceTail(text);
  return { text, toolPending: fenceIdx !== -1, pendingToolName };
}

/** Present-progressive label for the pulse shown while a tool block is
 *  still streaming. `null` name = the JSON hasn't got that far yet. */
export function pendingToolLabel(name: string | null): string {
  switch (name) {
    case "add_vocab":
    case "add_vocab_bulk":
      return "Adding vocabulary…";
    case "import_vocab_csv":
      return "Preparing a vocab import…";
    case "add_to_collection":
      return "Adding to a collection…";
    case "add_textbook":
      return "Creating a textbook…";
    case "add_textbook_chapters":
      return "Adding chapters…";
    case "create_flashcard":
      return "Creating a flashcard…";
    case "create_sentence_cards":
      return "Creating sentence cards…";
    default:
      return "Preparing an action…";
  }
}

/** Append result blocks to a message after execution so they survive reload. */
export function appendToolResults(content: string, results: ToolResult[]): string {
  if (results.length === 0) return content;
  const blocks = results
    .map((r) => "```polyglot-tool-result\n" + JSON.stringify(r) + "\n```")
    .join("\n\n");
  return content.trimEnd() + "\n\n" + blocks;
}

// ── Translation blur enforcement ─────────────────────────────────────────
//
// The system prompt instructs the model to wrap translations in `((…))`
// so the chat-markdown renderer can blur-by-default and reveal-on-click
// (forces active recall before peeking at the meaning). Smaller / local
// models sometimes ignore the convention and emit single-paren `(…)`
// instead — those leak the translation unblurred.
//
// We post-process the model output to convert single-paren spans that
// "look like translations" into double-paren ones. The heuristic is
// deliberately conservative — false positives (blurring a legitimate
// parenthetical like "(see chapter 3)") are worse than false negatives
// (occasionally missing a translation we should have wrapped). We only
// run this for CJK target languages where the script difference makes
// the heuristic robust. Latin-script targets (de, es, fr) share the
// alphabet with English, so the same heuristic would over-fire.

const CJK_TARGETS = new Set(["zh", "ja", "ko"]);

function isMostlyLatin(s: string): boolean {
  let latin = 0;
  let total = 0;
  for (const ch of s) {
    // Skip whitespace, digits, common punctuation. We're trying to gauge
    // whether the meaningful letters are Latin or something else.
    if (/[\s\d.,;:!?"'\-—–()[\]{}]/.test(ch)) continue;
    total++;
    // Latin block + Latin-1 supplement + extended (covers German/French/Spanish).
    if (/[a-zA-ZÀ-ɏ]/.test(ch)) latin++;
  }
  return total > 0 && latin / total >= 0.6;
}

const CITATION_LEAD = /^(?:p\.|pp\.|cf\.|see |chap|ch\.|fig\.|lit\.|n\.|cl:|note|see also)/i;

/**
 * Convert single-paren translation spans to `((…))` so the renderer
 * blurs them. Conservative: only runs for CJK target languages, only
 * matches spans of length ≥ 4, only if the inside is mostly Latin
 * script, never inside an existing `((` `))` pair, never if the inside
 * looks like a citation.
 *
 * Existing double-paren spans are left untouched. Markdown code fences
 * are skipped so URLs and code samples don't get clobbered.
 */
export function enforceTranslationBlur(text: string, targetLang: string): string {
  if (!CJK_TARGETS.has(targetLang)) return text;

  // Split on fenced code blocks so we don't mangle URLs / paths / code.
  // A more robust parser would also skip inline code, but the cost is
  // not worth it — translations almost never appear inside backticks.
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue; // odd indices are fenced blocks — skip
    parts[i] = parts[i].replace(
      // Single-paren span, NOT preceded by `(` (avoid `((…)`) and NOT
      // followed by `)` (avoid `(…))`). Inside has no parens.
      /(?<!\()\(([^()]{4,})\)(?!\))/g,
      (full, inside: string) => {
        const trimmed = inside.trim();
        if (CITATION_LEAD.test(trimmed)) return full;
        if (!isMostlyLatin(trimmed)) return full;
        return `((${inside}))`;
      },
    );
  }
  return parts.join("");
}

// ── Tool call summarisation (for the approval toast) ─────────────────────
//
// One short sentence describing what the model wants to do. Used by the
// chat-view approval toast so the user knows what they're approving
// without having to read the raw JSON.

export function summarizeToolCalls(calls: ToolCall[]): string {
  if (calls.length === 0) return "make changes";
  const fragments: string[] = [];
  for (const c of calls) {
    if (c.name === "add_vocab") {
      fragments.push("add 1 word to vocab");
    } else if (c.name === "add_vocab_bulk") {
      const n = Array.isArray(c.args.entries) ? c.args.entries.length : 0;
      fragments.push(`add ${n} word${n === 1 ? "" : "s"} to vocab`);
    } else if (c.name === "import_vocab_csv") {
      const csv = typeof c.args.csv === "string" ? c.args.csv : "";
      const rows = Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1);
      fragments.push(`import ~${rows} word${rows === 1 ? "" : "s"} from CSV`);
    } else if (c.name === "add_to_collection") {
      const n = Array.isArray(c.args.entries) ? c.args.entries.length : 0;
      const name =
        typeof c.args.collection === "string" ? c.args.collection : "a collection";
      fragments.push(`add ${n} word${n === 1 ? "" : "s"} to "${name}"`);
    } else if (c.name === "add_textbook") {
      const title =
        typeof c.args.title === "string" ? c.args.title : "new textbook";
      fragments.push(`create textbook "${title}"`);
    } else if (c.name === "add_textbook_chapters") {
      const n = Array.isArray(c.args.chapters) ? c.args.chapters.length : 0;
      fragments.push(`add ${n} chapter${n === 1 ? "" : "s"}`);
    } else if (c.name === "create_flashcard") {
      const w = typeof c.args.word === "string" ? c.args.word : "a word";
      fragments.push(`create a flashcard for "${w}"`);
    } else if (c.name === "create_sentence_cards") {
      const n = Array.isArray(c.args.entries) ? c.args.entries.length : 0;
      fragments.push(`create ${n} sentence card${n === 1 ? "" : "s"}`);
    } else {
      fragments.push(c.name);
    }
  }
  return fragments.join(", ");
}

// ── Executor ──

export async function executeToolCall(
  call: ToolCall,
  workspaceId: number,
): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "add_vocab":
        return await runAddVocab(call.args, workspaceId);
      case "add_vocab_bulk":
        return await runAddVocabBulk(call.args, workspaceId);
      case "import_vocab_csv":
        return await runImportVocabCsv(call.args, workspaceId);
      case "add_textbook":
        return await runAddTextbook(call.args, workspaceId);
      case "add_textbook_chapters":
        return await runAddTextbookChapters(call.args, workspaceId);
      case "add_to_collection":
        return await runAddToCollection(call.args, workspaceId);
      case "create_flashcard":
        return await runCreateFlashcard(call.args, workspaceId);
      case "create_sentence_cards":
        return await runCreateSentenceCards(call.args, workspaceId);
      default:
        return { ok: false, summary: `Unknown tool: ${call.name}` };
    }
  } catch (err) {
    return {
      ok: false,
      summary: `${call.name} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const VALID_STATUSES: VocabStatus[] = ["new", "learning", "review", "mastered"];

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asStatus(v: unknown): VocabStatus {
  return typeof v === "string" && (VALID_STATUSES as string[]).includes(v)
    ? (v as VocabStatus)
    : "new";
}

async function runAddVocab(
  args: Record<string, unknown>,
  workspaceId: number,
): Promise<ToolResult> {
  const word = asString(args.word);
  if (!word) return { ok: false, summary: "add_vocab: missing 'word'" };
  await saveVocab({
    workspaceId,
    word,
    reading: asString(args.reading),
    gloss: asString(args.gloss),
    source: "ai",
  });
  // status is optional — saveVocab defaults to "new", and the caller can set it later.
  void asStatus(args.status);
  return { ok: true, summary: `Added "${word}" to vocabulary` };
}

async function runAddVocabBulk(
  args: Record<string, unknown>,
  workspaceId: number,
): Promise<ToolResult> {
  const entries = args.entries;
  if (!Array.isArray(entries))
    return { ok: false, summary: "add_vocab_bulk: 'entries' must be an array" };
  if (entries.length > VOCAB_BULK_LIMIT)
    return {
      ok: false,
      summary: `add_vocab_bulk: capped at ${VOCAB_BULK_LIMIT} entries (got ${entries.length})`,
    };
  let added = 0;
  const skipped: string[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") {
      skipped.push("(non-object)");
      continue;
    }
    const e = raw as Record<string, unknown>;
    const word = asString(e.word) ?? asString(e.hanzi) ?? asString(e.term);
    if (!word) {
      skipped.push("(missing word)");
      continue;
    }
    await saveVocab({
      workspaceId,
      word,
      reading: asString(e.reading) ?? asString(e.pinyin) ?? asString(e.romaji),
      gloss: asString(e.gloss) ?? asString(e.english) ?? asString(e.meaning),
      source: "ai",
    });
    added++;
  }
  return {
    ok: true,
    summary: `Added ${added} word${added === 1 ? "" : "s"} to vocabulary${
      skipped.length ? ` (skipped ${skipped.length})` : ""
    }`,
  };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === "," || ch === "\t") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const HEADER_KEYS = {
  word: ["word", "hanzi", "term", "kanji", "headword"],
  reading: ["reading", "pinyin", "romaji", "kana", "ipa", "pronunciation"],
  gloss: ["gloss", "english", "meaning", "definition", "translation"],
};

async function runImportVocabCsv(
  args: Record<string, unknown>,
  workspaceId: number,
): Promise<ToolResult> {
  const csv = asString(args.csv);
  if (!csv) return { ok: false, summary: "import_vocab_csv: missing 'csv'" };
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2)
    return { ok: false, summary: "import_vocab_csv: needs a header + at least one row" };
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const findCol = (keys: string[]) =>
    header.findIndex((h) => keys.includes(h));
  const wordCol = findCol(HEADER_KEYS.word);
  const readingCol = findCol(HEADER_KEYS.reading);
  const glossCol = findCol(HEADER_KEYS.gloss);
  if (wordCol === -1)
    return {
      ok: false,
      summary: `import_vocab_csv: no recognized "word" column. Header was: ${header.join(", ")}`,
    };

  let added = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const word = cols[wordCol]?.trim();
    if (!word) continue;
    if (added >= VOCAB_BULK_LIMIT) break;
    await saveVocab({
      workspaceId,
      word,
      reading: readingCol >= 0 ? cols[readingCol]?.trim() || null : null,
      gloss: glossCol >= 0 ? cols[glossCol]?.trim() || null : null,
      source: "ai-csv",
    });
    added++;
  }
  return { ok: true, summary: `Imported ${added} entries from CSV` };
}

async function runAddTextbook(
  args: Record<string, unknown>,
  workspaceId: number,
): Promise<ToolResult> {
  const title = asString(args.title);
  if (!title) return { ok: false, summary: "add_textbook: missing 'title'" };
  const item = await saveLibraryItem({
    workspaceId,
    kind: "textbook",
    title,
    author: asString(args.author) ?? null,
    totalUnits:
      typeof args.totalUnits === "number" && Number.isFinite(args.totalUnits)
        ? Math.max(0, Math.floor(args.totalUnits))
        : null,
    unitLabel: "chapters",
    status: "active",
  });
  return {
    ok: true,
    summary: `Created textbook "${item.title}"`,
    details: { id: item.id },
  };
}

async function runAddTextbookChapters(
  args: Record<string, unknown>,
  workspaceId: number,
): Promise<ToolResult> {
  const titleQuery = asString(args.textbookTitle);
  const chapters = args.chapters;
  if (!titleQuery)
    return { ok: false, summary: "add_textbook_chapters: missing 'textbookTitle'" };
  if (!Array.isArray(chapters))
    return { ok: false, summary: "add_textbook_chapters: 'chapters' must be an array" };
  if (chapters.length > CHAPTERS_LIMIT)
    return {
      ok: false,
      summary: `add_textbook_chapters: capped at ${CHAPTERS_LIMIT}`,
    };

  const lib = await listLibrary(workspaceId);
  const tbs = lib.filter((l) => l.kind === "textbook");
  const lower = titleQuery.toLowerCase();
  const matches = tbs.filter((t) => t.title.toLowerCase().includes(lower));
  if (matches.length === 0)
    return {
      ok: false,
      summary: `No textbook matching "${titleQuery}". Use add_textbook first.`,
    };
  if (matches.length > 1)
    return {
      ok: false,
      summary: `Multiple textbooks match "${titleQuery}" (${matches
        .map((t) => `"${t.title}"`)
        .join(", ")}). Be more specific.`,
    };

  const tb = matches[0];
  let added = 0;
  for (let i = 0; i < chapters.length; i++) {
    const raw = chapters[i];
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const t = asString(c.title);
    if (!t) continue;
    const pos =
      typeof c.position === "number" && Number.isFinite(c.position)
        ? Math.max(0, Math.floor(c.position))
        : i;
    await createChapter({ itemId: tb.id, title: t, position: pos });
    added++;
  }
  return {
    ok: true,
    summary: `Added ${added} chapter${added === 1 ? "" : "s"} to "${tb.title}"`,
  };
}

async function runAddToCollection(
  args: Record<string, unknown>,
  workspaceId: number,
): Promise<ToolResult> {
  const name = asString(args.collection);
  if (!name)
    return {
      ok: false,
      summary: "add_to_collection: missing 'collection' name",
    };
  const entries = args.entries;
  if (!Array.isArray(entries))
    return {
      ok: false,
      summary: "add_to_collection: 'entries' must be an array",
    };

  // Find or create the collection. Match case-insensitive on name; fall back
  // to the workspace default for the literal name "default".
  const existing = await listCollections(workspaceId);
  let target = existing.find(
    (c) => c.name.toLowerCase() === name.toLowerCase(),
  );
  if (!target && name.toLowerCase() === "default") {
    target = await getOrCreateDefaultCollection(workspaceId);
  }
  if (!target) {
    target = await createCollection({
      workspaceId,
      name,
      description: asString(args.description) ?? null,
    });
  }

  const words = entries
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      word:
        asString(e.word) ??
        asString(e.hanzi) ??
        asString(e.term) ??
        "",
      reading:
        asString(e.reading) ??
        asString(e.pinyin) ??
        asString(e.romaji) ??
        null,
      gloss:
        asString(e.gloss) ??
        asString(e.english) ??
        asString(e.meaning) ??
        null,
    }))
    .filter((e) => e.word.length > 0);

  if (words.length === 0) {
    return { ok: false, summary: "add_to_collection: no valid words to add" };
  }

  const result = await bulkAddToCollection({
    workspaceId,
    collectionId: target.id,
    words,
  });
  return {
    ok: true,
    summary: `Added ${result.added} word${result.added === 1 ? "" : "s"} to "${target.name}"${
      result.skipped ? ` (skipped ${result.skipped})` : ""
    }`,
    details: { collectionId: target.id, name: target.name },
  };
}

// ── Card-creation tools ──────────────────────────────────────────────────
//
// These emit the SAME storage shapes the CardComposerDialog produces (see
// card-styles.ts): a "standard"/"cloze" card is kind="vocab" with the cloze
// in `frontExtra`; a sentence card is kind="sentence" with the sentence in
// `word` and the translation in `gloss`. Reusing those shapes means cards
// the tutor proposes are indistinguishable from hand-authored ones — the
// study plugins and addon card-enrichers see them identically.

/** Stable id for an example-sentence row. `crypto.randomUUID` exists in the
 *  Tauri webview; the fallback keeps this safe in any non-secure context. */
function exampleId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalise a model-supplied cloze string into a `{{c1::word}}` front.
 * If the model already wrapped a deletion, trust it. Otherwise wrap the
 * first occurrence of the headword. If the word isn't in the sentence we
 * leave it unwrapped — a sentence with no deletion still renders as a
 * readable front, which beats discarding the card. Pure + unit-tested.
 */
export function normalizeClozeFront(word: string, cloze: string): string {
  if (/\{\{c\d+::/.test(cloze)) return cloze;
  const idx = cloze.indexOf(word);
  if (idx === -1) return cloze;
  return cloze.slice(0, idx) + `{{c1::${word}}}` + cloze.slice(idx + word.length);
}

export type NormalizedSentence = {
  sentence: string;
  translation: string | null;
  reading: string | null;
};

/**
 * Coerce the loosely-typed `entries` arg of create_sentence_cards into
 * clean rows, tolerating the field aliases models reach for
 * (target/native/text/gloss). Drops anything without a sentence. Pure +
 * unit-tested so the parsing contract is locked down without a DB.
 */
export function normalizeSentenceEntries(raw: unknown): NormalizedSentence[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedSentence[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const sentence = asString(o.sentence) ?? asString(o.target) ?? asString(o.text);
    if (!sentence) continue;
    out.push({
      sentence,
      translation:
        asString(o.translation) ?? asString(o.native) ?? asString(o.gloss) ?? null,
      reading: asString(o.reading) ?? asString(o.pinyin) ?? asString(o.romaji) ?? null,
    });
  }
  return out;
}

async function runCreateFlashcard(
  args: Record<string, unknown>,
  workspaceId: number,
): Promise<ToolResult> {
  const word = asString(args.word);
  if (!word) return { ok: false, summary: "create_flashcard: missing 'word'" };

  const clozeRaw = asString(args.cloze);
  const frontExtra = clozeRaw ? normalizeClozeFront(word, clozeRaw) : null;

  const example = asString(args.example);
  const cardNotes = example
    ? serialiseExamples([
        {
          id: exampleId(),
          target: example,
          native: asString(args.exampleTranslation),
          source: "ai",
        },
      ])
    : null;

  const created = await saveVocab({
    workspaceId,
    word,
    reading: asString(args.reading),
    gloss: asString(args.gloss),
    kind: "vocab",
    source: "ai",
  });
  // saveVocab doesn't take frontExtra/cardNotes; set them in one follow-up
  // write only when there's actually something to store.
  if (frontExtra || cardNotes) {
    await updateVocabFields({ id: created.id, frontExtra, cardNotes });
  }
  // status is optional — saveVocab seeds "new"; the user can re-grade later.
  void asStatus(args.status);

  return {
    ok: true,
    summary: `Created a flashcard for "${word}"${frontExtra ? " (cloze)" : ""}`,
    details: { id: created.id },
  };
}

async function runCreateSentenceCards(
  args: Record<string, unknown>,
  workspaceId: number,
): Promise<ToolResult> {
  const entries = normalizeSentenceEntries(args.entries);
  if (entries.length === 0)
    return {
      ok: false,
      summary: "create_sentence_cards: no valid sentences in 'entries'",
    };
  if (entries.length > VOCAB_BULK_LIMIT)
    return {
      ok: false,
      summary: `create_sentence_cards: capped at ${VOCAB_BULK_LIMIT} (got ${entries.length})`,
    };

  let added = 0;
  for (const e of entries) {
    // kind="sentence": the sentence IS the prompt (front), the translation
    // is the answer (gloss). Matches the "sentence" card style exactly.
    await saveVocab({
      workspaceId,
      word: e.sentence,
      reading: e.reading ?? undefined,
      gloss: e.translation ?? undefined,
      kind: "sentence",
      source: "ai",
    });
    added++;
  }
  return {
    ok: true,
    summary: `Created ${added} sentence card${added === 1 ? "" : "s"}`,
  };
}
