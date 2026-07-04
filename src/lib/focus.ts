/**
 * Workspace focus — tracks what the student is currently working
 * through (library item / textbook chapter / reader doc) so the chat
 * can proactively reference it.
 *
 * Concretely: when you've been reading chapter 4 of 标准教程, the
 * chat tutor can open with "想聊聊餐馆吗？" because it knows that
 * chapter is about restaurants. Without this signal the tutor has no
 * idea what the student is studying right now and falls back to
 * generic conversation.
 *
 * Storage is in the existing settings table, keyed per workspace, so
 * no schema migration is needed and the focus persists across
 * restarts. The "touched_at" timestamp lets us decay focus relevance
 * — focus from three weeks ago is probably stale.
 */

import { getSettings, setSetting } from "./db";
import { isTauri } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";

const DB_URL = "sqlite:tokori.db";
let dbPromise: Promise<Database> | null = null;
async function getDb() {
  if (!dbPromise) dbPromise = Database.load(DB_URL);
  return dbPromise;
}

function key(workspaceId: number, suffix: string): string {
  return `focus.${workspaceId}.${suffix}`;
}

export type WorkspaceFocus = {
  /** Title of the currently-active library item (book / textbook /
   *  podcast / etc.). Null when nothing is set. */
  libraryItemTitle: string | null;
  /** Kind label so we can render "textbook" vs "podcast" naturally. */
  libraryItemKind: string | null;
  /** Title of the currently-active chapter or reader doc within that
   *  item. Null when the user is in the library overview but hasn't
   *  picked a chapter. */
  chapterTitle: string | null;
  /** Position (1-indexed for display) within the parent item. */
  chapterPosition: number | null;
  /** Unix-seconds when focus was last touched. UI / prompt builder
   *  can use this to decay or hide stale focus. */
  touchedAt: number | null;
};

const EMPTY_FOCUS: WorkspaceFocus = {
  libraryItemTitle: null,
  libraryItemKind: null,
  chapterTitle: null,
  chapterPosition: null,
  touchedAt: null,
};

/**
 * Record the student's current attention. Pass any non-null id to
 * update that slot; pass `null` to clear it. The "touched_at" field
 * always advances when this is called.
 *
 * Designed to be cheap enough to call on every reader-doc switch /
 * library-item open without thinking about it.
 */
export async function setWorkspaceFocus(input: {
  workspaceId: number;
  libraryItemId?: number | null;
  chapterId?: number | null;
  readerDocId?: number | null;
}): Promise<void> {
  if (!isTauri()) return;
  const ws = input.workspaceId;
  const writes: Array<Promise<void>> = [];
  if (input.libraryItemId !== undefined) {
    writes.push(
      setSetting(
        key(ws, "libraryItemId"),
        input.libraryItemId == null ? "" : String(input.libraryItemId),
      ),
    );
  }
  if (input.chapterId !== undefined) {
    writes.push(
      setSetting(
        key(ws, "chapterId"),
        input.chapterId == null ? "" : String(input.chapterId),
      ),
    );
  }
  if (input.readerDocId !== undefined) {
    writes.push(
      setSetting(
        key(ws, "readerDocId"),
        input.readerDocId == null ? "" : String(input.readerDocId),
      ),
    );
  }
  writes.push(
    setSetting(key(ws, "touchedAt"), String(Math.floor(Date.now() / 1000))),
  );
  await Promise.all(writes);
}

/**
 * Resolve the focus into human-readable titles by joining against
 * library_items / library_chapters / reader_documents. Returns an
 * EMPTY_FOCUS when nothing is set (or when called outside Tauri).
 *
 * Resolution order for the "chapter title" field:
 *   1. An explicit reader_doc id (the student is reading something
 *      specific — that title wins, since reader docs are the leaf the
 *      user actually clicked).
 *   2. A library_chapter id (textbook chapter row — title comes from
 *      the chapter's own row).
 *   3. None — chapter title stays null and we just show the library
 *      item title alone.
 */
export async function getWorkspaceFocus(
  workspaceId: number,
): Promise<WorkspaceFocus> {
  if (!isTauri()) return EMPTY_FOCUS;
  const settings = await getSettings([
    key(workspaceId, "libraryItemId"),
    key(workspaceId, "chapterId"),
    key(workspaceId, "readerDocId"),
    key(workspaceId, "touchedAt"),
  ]);

  const libraryItemId = parseIdSetting(settings[key(workspaceId, "libraryItemId")]);
  const chapterId = parseIdSetting(settings[key(workspaceId, "chapterId")]);
  const readerDocId = parseIdSetting(settings[key(workspaceId, "readerDocId")]);
  const touchedAt = parseIdSetting(settings[key(workspaceId, "touchedAt")]);

  if (libraryItemId == null && chapterId == null && readerDocId == null) {
    return EMPTY_FOCUS;
  }

  const db = await getDb();
  let libraryItemTitle: string | null = null;
  let libraryItemKind: string | null = null;
  let chapterTitle: string | null = null;
  let chapterPosition: number | null = null;

  // Resolve library_item — either the one explicitly stored, or the
  // parent of the reader_doc when only a doc id is set.
  let resolvedItemId = libraryItemId;
  if (resolvedItemId == null && readerDocId != null) {
    const rd = await db.select<{ library_item_id: number | null }[]>(
      "SELECT library_item_id FROM reader_documents WHERE id = $1",
      [readerDocId],
    );
    resolvedItemId = rd[0]?.library_item_id ?? null;
  }
  if (resolvedItemId != null) {
    const li = await db.select<{ title: string; kind: string }[]>(
      "SELECT title, kind FROM library_items WHERE id = $1",
      [resolvedItemId],
    );
    libraryItemTitle = li[0]?.title ?? null;
    libraryItemKind = li[0]?.kind ?? null;
  }

  // Chapter / reader-doc title — reader doc wins when present.
  if (readerDocId != null) {
    const rd = await db.select<{ title: string; chapter_position: number | null }[]>(
      "SELECT title, chapter_position FROM reader_documents WHERE id = $1",
      [readerDocId],
    );
    chapterTitle = rd[0]?.title ?? null;
    chapterPosition =
      rd[0]?.chapter_position == null ? null : rd[0].chapter_position + 1;
  } else if (chapterId != null) {
    const ch = await db.select<{ title: string; position: number }[]>(
      "SELECT title, position FROM library_chapters WHERE id = $1",
      [chapterId],
    );
    chapterTitle = ch[0]?.title ?? null;
    chapterPosition = ch[0]?.position == null ? null : ch[0].position + 1;
  }

  return {
    libraryItemTitle,
    libraryItemKind,
    chapterTitle,
    chapterPosition,
    touchedAt,
  };
}

/** Clear the workspace's focus. Used when the user closes the active
 *  reader / leaves library mode entirely. */
export async function clearWorkspaceFocus(workspaceId: number): Promise<void> {
  await setWorkspaceFocus({
    workspaceId,
    libraryItemId: null,
    chapterId: null,
    readerDocId: null,
  });
}

function parseIdSetting(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
