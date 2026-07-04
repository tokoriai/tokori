#!/usr/bin/env node
// Tokori MCP server. Exposes the local HTTP API as MCP tools so an
// MCP-aware client can read workspaces, search the dictionary, and write
// vocabulary + collections back into the user's language-learning
// database.
//
// Spawned over stdio by the client per its MCP config; never binds to a
// port itself. All state lives in the desktop app — this server is
// stateless.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  ApiError,
  addWordsToCollection,
  createCollection,
  createVocab,
  health,
  importCollection,
  listCollections,
  listCollectionWords,
  listVocab,
  listWorkspaces,
  searchDict,
} from "./api.js";

const server = new McpServer({
  name: "tokori",
  version: "0.1.0",
});

/** Wrap a tool handler so any thrown error becomes a structured MCP
 *  error message (`isError: true`) instead of crashing the transport. */
function safe<T>(
  fn: (args: T) => Promise<unknown>,
): (args: T) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  return async (args) => {
    try {
      const result = await fn(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `[${err.code}] ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        content: [{ type: "text", text: msg }],
        isError: true,
      };
    }
  };
}

// ── Read-only tools ──────────────────────────────────────────────────────

server.registerTool(
  "list_workspaces",
  {
    title: "List workspaces",
    description:
      "List all language-learning workspaces. Each workspace pairs a target language with a native language and owns its own vocabulary, collections, and notes. Call this first if you need a workspace_id but don't know it.",
    inputSchema: {},
  },
  safe(async () => listWorkspaces()),
);

server.registerTool(
  "list_vocab",
  {
    title: "List vocabulary",
    description:
      "List vocabulary entries in a workspace, newest first. Optional filters: status (new|learning|review|mastered) and a substring search across word/reading/gloss. Default limit 50, max 500.",
    inputSchema: {
      workspace_id: z.number().int().positive(),
      status: z
        .enum(["new", "learning", "review", "mastered"])
        .optional()
        .describe("Filter to a single FSRS status."),
      q: z.string().optional().describe("Substring search across word, reading, gloss."),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  safe(async ({ workspace_id, status, q, limit }) =>
    listVocab(workspace_id, { status, q, limit }),
  ),
);

server.registerTool(
  "list_collections",
  {
    title: "List collections",
    description:
      "List all vocabulary collections in a workspace. Collections group vocab into themed sets (e.g. 'HSK 3 lesson 4', 'Travel words'). The 'is_default' field marks the workspace's default collection.",
    inputSchema: {
      workspace_id: z.number().int().positive(),
    },
  },
  safe(async ({ workspace_id }) => listCollections(workspace_id)),
);

server.registerTool(
  "list_collection_words",
  {
    title: "List words in a collection",
    description:
      "List all vocabulary entries inside a collection, in their saved order.",
    inputSchema: {
      collection_id: z.number().int().positive(),
    },
  },
  safe(async ({ collection_id }) => listCollectionWords(collection_id)),
);

server.registerTool(
  "search_dict",
  {
    title: "Search the installed dictionary",
    description:
      "Look up words in the workspace's dictionary (CC-CEDICT for zh, JMdict for ja, etc.). Useful for filling in readings/glosses before creating vocab entries.",
    inputSchema: {
      lang: z.string().describe("Language code, e.g. 'zh', 'ja', 'ko', 'de'."),
      q: z.string().describe("Query — usually the headword."),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  safe(async ({ lang, q, limit }) => searchDict(lang, q, limit ?? 25)),
);

// ── Write tools ──────────────────────────────────────────────────────────

server.registerTool(
  "create_vocab",
  {
    title: "Create a vocabulary entry",
    description:
      "Add a single word to a workspace's vocabulary. Idempotent on (workspace_id, word) — if the word already exists, returns the existing id with `existed: true`. Optionally links the word into a collection in the same call, and accepts mining fields (cloze sentence, notes, image, audio) when the caller wants to build a richer card.",
    inputSchema: {
      workspace_id: z.number().int().positive(),
      word: z.string().min(1),
      reading: z
        .string()
        .optional()
        .describe("Pronunciation/reading (pinyin, furigana, romanisation)."),
      gloss: z.string().optional().describe("Translation or short definition."),
      collection_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Link the new entry into this collection in the same call."),
      kind: z
        .enum(["vocab", "sentence", "writing"])
        .optional()
        .describe("Card kind. Defaults to 'vocab'."),
      front_extra: z
        .string()
        .optional()
        .describe(
          "Cloze sentence with `{{c1::word}}` markers. Used by the sentence-mining study plugin.",
        ),
      card_notes: z
        .string()
        .optional()
        .describe("Free-form notes shown on the back of the card."),
      image_data: z
        .string()
        .optional()
        .describe(
          "Card image as a data URL (`data:image/png;base64,…`) or bare base64 string.",
        ),
      audio_data: z
        .string()
        .optional()
        .describe("Card audio bytes as a base64 string (no data URL prefix)."),
      audio_mime: z
        .string()
        .optional()
        .describe("MIME type for audio_data. Defaults to 'audio/mpeg'."),
    },
  },
  safe(async ({
    workspace_id,
    word,
    reading,
    gloss,
    collection_id,
    kind,
    front_extra,
    card_notes,
    image_data,
    audio_data,
    audio_mime,
  }) =>
    createVocab(workspace_id, {
      word,
      reading,
      gloss,
      collection_id,
      kind,
      front_extra,
      card_notes,
      image_data,
      audio_data,
      audio_mime,
    }),
  ),
);

server.registerTool(
  "create_collection",
  {
    title: "Create a collection",
    description:
      "Create a new (empty) vocabulary collection in a workspace. Use add_words_to_collection or import_collection to populate it.",
    inputSchema: {
      workspace_id: z.number().int().positive(),
      name: z.string().min(1),
      description: z.string().optional(),
      parent_collection_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Nest under an existing collection (e.g. HSK 3 → Lesson 4)."),
    },
  },
  safe(async ({ workspace_id, name, description, parent_collection_id }) =>
    createCollection(workspace_id, { name, description, parent_collection_id }),
  ),
);

server.registerTool(
  "add_words_to_collection",
  {
    title: "Add words to a collection",
    description:
      "Append words to an existing collection. Pass either `vocab_ids` (link existing entries) or `words` (upsert new entries into the collection's workspace, then link). Returns counts: how many were newly added vs already known vs skipped.",
    inputSchema: {
      collection_id: z.number().int().positive(),
      vocab_ids: z.array(z.number().int().positive()).optional(),
      words: z
        .array(
          z.object({
            word: z.string().min(1),
            reading: z.string().optional(),
            gloss: z.string().optional(),
          }),
        )
        .optional(),
    },
  },
  safe(async ({ collection_id, vocab_ids, words }) =>
    addWordsToCollection(collection_id, { vocab_ids, words }),
  ),
);

server.registerTool(
  "import_collection",
  {
    title: "Import a collection (one-shot batch)",
    description:
      "Create a new collection AND populate it with a batch of words in one call. Best for scrape/import workflows like 'pull every vocab word from this article and save them as a collection in workspace 3'. Returns the new collection plus per-word counts (added/existed/skipped).",
    inputSchema: {
      workspace_id: z.number().int().positive(),
      name: z.string().min(1),
      description: z.string().optional(),
      words: z
        .array(
          z.object({
            word: z.string().min(1),
            reading: z.string().optional(),
            gloss: z.string().optional(),
          }),
        )
        .min(1),
    },
  },
  safe(async ({ workspace_id, name, description, words }) =>
    importCollection(workspace_id, { name, description, words }),
  ),
);

// ── Health (handy for "is the app running?" debugging) ──────────────────

server.registerTool(
  "health",
  {
    title: "Check API health",
    description:
      "Probe the local API. Returns `{ status: 'ok', service, version }` when the desktop app is running and the local API is enabled.",
    inputSchema: {},
  },
  safe(async () => health()),
);

// ── Boot ────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr is the only safe place to log — stdout is the JSON-RPC channel.
  process.stderr.write(`tokori-mcp failed to start: ${err}\n`);
  process.exit(1);
});
