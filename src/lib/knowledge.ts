/**
 * Knowledge base — chunked content (reader docs, library chapters,
 * notes, chat replies, library packs) retrieved with SQLite FTS5
 * keyword search: fast, deterministic, zero dependencies.
 *
 * The chat layer and the voice tutor stitch the top hits into the
 * system prompt as reference material; the study plugins use it to pull
 * example sentences from the student's own library. Indexing is wired in
 * `db.ts` (every reader doc / chapter / note / assistant reply is
 * reindexed on write) so search "just works" without callers knowing
 * about FTS. Desktop-only — every entry point no-ops under `!isTauri()`.
 */

import Database from "@tauri-apps/plugin-sql";
import { isTauri } from "@tauri-apps/api/core";

export type SourceKind = "reader" | "chapter" | "note" | "chat" | "library";

export type SearchHit = {
  sourceKind: SourceKind;
  sourceId: number;
  sourceTitle: string | null;
  /** A short snippet of the matching text (already trimmed). */
  snippet: string;
  /** FTS5 rank (lower = better). Useful for debugging only. */
  rank: number;
};

const MAX_CHUNK_LEN = 600;
const MIN_CHUNK_LEN = 30;

// ── Chunking ──

/**
 * Split arbitrary text into ~MAX_CHUNK_LEN chunks at paragraph then sentence
 * boundaries. Keeps chunks small enough to fit in a system prompt and big
 * enough that FTS keyword matches feel like real context.
 */
export function chunkText(text: string, maxLen = MAX_CHUNK_LEN): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxLen) return [cleaned];

  const out: string[] = [];
  let current = "";

  function flush() {
    const t = current.trim();
    if (t.length >= MIN_CHUNK_LEN) out.push(t);
    current = "";
  }
  function add(piece: string, sep: string) {
    if (current.length + piece.length + sep.length > maxLen && current) {
      flush();
    }
    current += (current ? sep : "") + piece;
  }

  for (const para of cleaned.split(/\n{2,}/)) {
    if (para.length <= maxLen) {
      add(para, "\n\n");
      continue;
    }
    // Split a long paragraph at sentence boundaries (Latin + CJK punctuation).
    const sentences = para.split(/(?<=[.!?。！？])\s+/);
    for (const s of sentences) {
      if (s.length > maxLen) {
        // Hard split at maxLen as a final fallback.
        for (let i = 0; i < s.length; i += maxLen) {
          add(s.slice(i, i + maxLen), " ");
        }
      } else {
        add(s, " ");
      }
    }
  }
  flush();
  return out;
}

// ── DB layer ──

let dbPromise: Promise<Database> | null = null;
async function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:tokori.db");
  return dbPromise;
}

/** Replace all chunks for a given source with freshly-chunked content. */
export async function reindexSource(input: {
  workspaceId: number;
  sourceKind: SourceKind;
  sourceId: number;
  sourceTitle: string | null;
  content: string;
}): Promise<void> {
  if (!isTauri()) return;
  const chunks = chunkText(input.content);
  const db = await getDb();
  await db.execute(
    "DELETE FROM knowledge_chunks WHERE workspace_id = $1 AND source_kind = $2 AND source_id = $3",
    [input.workspaceId, input.sourceKind, input.sourceId],
  );
  for (let i = 0; i < chunks.length; i++) {
    await db.execute(
      `INSERT INTO knowledge_chunks (workspace_id, source_kind, source_id, source_title, position, content)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.workspaceId,
        input.sourceKind,
        input.sourceId,
        input.sourceTitle,
        i,
        chunks[i],
      ],
    );
  }
}

/** Drop all chunks for a deleted source. */
export async function deleteSource(
  workspaceId: number,
  sourceKind: SourceKind,
  sourceId: number,
): Promise<void> {
  if (!isTauri()) return;
  const db = await getDb();
  await db.execute(
    "DELETE FROM knowledge_chunks WHERE workspace_id = $1 AND source_kind = $2 AND source_id = $3",
    [workspaceId, sourceKind, sourceId],
  );
}

// ── Search ──

/**
 * FTS5 has a small grammar: `*` for prefix, `OR`, quoted phrases. User input
 * can contain anything (apostrophes, parentheses, CJK punctuation), so we
 * tokenise to safe terms and OR them — last token gets a prefix wildcard so
 * partial typing works.
 */
function buildFtsQuery(input: string): string {
  const tokens = input
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (tokens.length === 0) return "";
  return tokens
    .map((t, i) => {
      const safe = t.replace(/"/g, "");
      return i === tokens.length - 1 ? `${safe}*` : safe;
    })
    .join(" OR ");
}

/**
 * Top-K relevant chunks for a query via SQLite FTS5 keyword search.
 * Returns an empty list off-desktop or when the query has no usable
 * terms; callers stitch the hits into the system prompt as context.
 */
export async function searchKnowledge(
  workspaceId: number,
  query: string,
  k = 5,
): Promise<SearchHit[]> {
  if (!isTauri()) return [];
  const fts = buildFtsQuery(query);
  if (!fts) return [];
  const db = await getDb();
  type Row = {
    source_kind: string;
    source_id: number;
    source_title: string | null;
    content: string;
    rank: number;
  };
  const rows = await db.select<Row[]>(
    `SELECT k.source_kind, k.source_id, k.source_title, k.content, knowledge_fts.rank
       FROM knowledge_fts
       JOIN knowledge_chunks AS k ON k.id = knowledge_fts.rowid
      WHERE knowledge_fts MATCH $1
        AND k.workspace_id = $2
      ORDER BY knowledge_fts.rank
      LIMIT $3`,
    [fts, workspaceId, k],
  );
  return rows.map((r) => ({
    sourceKind: r.source_kind as SourceKind,
    sourceId: r.source_id,
    sourceTitle: r.source_title,
    snippet: r.content.length > 500 ? r.content.slice(0, 500) + "…" : r.content,
    rank: r.rank,
  }));
}

/** Render hits as a system-prompt-ready bullet list. */
export function formatHitsForPrompt(hits: SearchHit[]): string {
  if (hits.length === 0) return "";
  const lines = ["", "Reference material from the student's library, notes, and reader:"];
  for (const h of hits) {
    const label = labelForSource(h.sourceKind, h.sourceTitle);
    lines.push(`- [${label}] ${h.snippet}`);
  }
  lines.push(
    "Use this material when it's directly relevant; never invent quotes from it.",
  );
  return lines.join("\n");
}

function labelForSource(kind: SourceKind, title: string | null): string {
  const human =
    kind === "reader"
      ? "reader"
      : kind === "chapter"
        ? "textbook"
        : kind === "note"
          ? "note"
          : kind === "library"
            ? "library"
            : "chat";
  return title ? `${human}: ${title}` : human;
}

/**
 * Concat every chunk for a single source back into one string. Used by the
 * vocab extractor — we want to walk the whole document, not just whatever
 * chunks `searchKnowledge` happened to return for a query.
 *
 * Order is by `position` ascending so the result reads in the original
 * document order; chunk boundaries become double newlines.
 */
export async function getSourceContent(
  workspaceId: number,
  sourceKind: SourceKind,
  sourceId: number,
): Promise<string> {
  if (!isTauri()) return "";
  const db = await getDb();
  const rows = await db.select<{ content: string }[]>(
    `SELECT content FROM knowledge_chunks
       WHERE workspace_id = $1 AND source_kind = $2 AND source_id = $3
       ORDER BY position ASC`,
    [workspaceId, sourceKind, sourceId],
  );
  return rows.map((r) => r.content).join("\n\n");
}
