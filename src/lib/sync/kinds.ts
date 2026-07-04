/**
 * Client-side sync manifest: one spec per synced kind, wrapping the
 * local SQLite shape (tables, columns, FK joins) behind a uniform
 * interface the engine drives. All SQL for scanning dirty rows,
 * applying pulled rows, applying graves, remapping gids and clearing
 * dirty flags lives HERE — the engine (`./engine.ts`) never mentions a
 * table name.
 *
 * Trigger discipline (see the v32 migration in src-tauri/src/lib.rs):
 * the change-tracking triggers treat "mtime, dirty and guid all
 * unchanged" as an app write and re-dirty the row. Engine writes
 * therefore always change at least one of the three; the one write
 * that can't (re-linking a deferred parent) bounces through dirty=2
 * (`quietly`).
 *
 * dirty states: 0 clean · 1 needs push · 2 engine-delete marker ·
 * -1 parked (server rejected; any app edit re-dirties it to 1 via the
 * update trigger, so parked rows self-heal on touch).
 */

import type Database from "@tauri-apps/plugin-sql";
import {
  collectionWordGid,
  parseCollectionWordGid,
  parsePdictGid,
  parseReviewGid,
  pdictGid,
  reviewGid,
  type SyncKind,
  type WireCollectionWord,
  type WirePdictEntry,
  type WireReview,
  type WireSetting,
} from "./protocol";

export type Db = Database;

/** Personal-dictionary marker name — must match db.ts and the v32
 *  trigger SQL, which both hardcode it. */
const PERSONAL_DICT_NAME = "Personal";

// ── Wire row plumbing ─────────────────────────────────────────────────

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null ? null : String(v));
const sReq = (v: unknown): string => String(v ?? "");
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const numReq = (v: unknown): number => Number(v ?? 0);
const bool = (v: unknown): boolean => Number(v ?? 0) !== 0;

export type ScannedRow = {
  /** Wire row as sent to the server. */
  wire: Row;
  /** Wire gid — the key the server's `rejected` list refers to. */
  gid: string;
  /** Local identity for clearing dirty / parking, immune to remaps. */
  clear: (db: Db) => Promise<void>;
  park: (db: Db) => Promise<void>;
};

export type ApplyOutcome = "inserted" | "updated" | "skipped" | "deferred";

/** Cross-kind gid → local id resolver, cached per sync run. */
export class LocalIds {
  private cache = new Map<string, number | null>();
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private static TABLE: Partial<Record<SyncKind, string>> = {
    workspace: "workspaces",
    collection: "collections",
    vocab: "vocab_entries",
    libraryItem: "library_items",
    chat: "chats",
  };

  async localId(kind: SyncKind, gid: string): Promise<number | null> {
    const key = `${kind}\n${gid}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const table = LocalIds.TABLE[kind];
    if (!table) throw new Error(`localId: ${kind} is not a parent kind`);
    const rows = await this.db.select<{ id: number }[]>(
      `SELECT id FROM ${table} WHERE guid = $1`,
      [gid],
    );
    const id = rows.length > 0 ? rows[0].id : null;
    this.cache.set(key, id);
    return id;
  }

  learn(kind: SyncKind, gid: string, id: number): void {
    this.cache.set(`${kind}\n${gid}`, id);
  }

  forget(kind: SyncKind, gid: string): void {
    this.cache.delete(`${kind}\n${gid}`);
  }
}

/** A parent link deferred because the referenced row hadn't arrived
 *  yet (self-referential kinds pull in id order, not tree order). */
export type DeferredLink = {
  kind: SyncKind;
  gid: string;
  parentGid: string;
};

export type ApplyCtx = {
  ids: LocalIds;
  deferred: DeferredLink[];
};

export type KindSpec = {
  kind: SyncKind;
  countDirty(db: Db): Promise<number>;
  scanDirty(db: Db, limit: number): Promise<ScannedRow[]>;
  applyChange(db: Db, wire: Row, ctx: ApplyCtx): Promise<ApplyOutcome>;
  applyGrave(db: Db, gid: string, ctx: ApplyCtx): Promise<void>;
  remapGid(db: Db, from: string, to: string, ctx: ApplyCtx): Promise<void>;
  /** Complete a link deferred during apply (self-referential kinds). */
  applyDeferred?(db: Db, link: DeferredLink, ctx: ApplyCtx): Promise<void>;
};

/** Engine write that changes neither mtime, dirty nor guid — bounce
 *  through dirty=2 so the update trigger doesn't re-dirty the row. */
async function quietly(
  db: Db,
  table: string,
  setSql: string,
  whereSql: string,
  params: unknown[],
): Promise<void> {
  await db.execute(`UPDATE ${table} SET dirty = 2 WHERE ${whereSql}`, params);
  await db.execute(
    `UPDATE ${table} SET ${setSql}, dirty = 0 WHERE ${whereSql}`,
    params,
  );
}

// ── Factory for guid-carrying kinds ───────────────────────────────────

type ColSpec = {
  col: string;
  wire: string;
  t: "text" | "num" | "bool";
  /** Part of the row's identity — written on INSERT, never UPDATEd. */
  insertOnly?: boolean;
};

type ParentRef = { kind: SyncKind; col: string; wire: string; table: string };

type GuidKindCfg = {
  kind: SyncKind;
  table: string;
  cols: ColSpec[];
  /** Table has a created_at column (default true). */
  hasCreatedAt?: boolean;
  /** Set this column to mtime-in-seconds on apply, so list orderings
   *  (updated_at DESC) reflect the other device's edit time. */
  updatedAtCol?: string;
  /** Required parent resolved through LocalIds. */
  parent?: ParentRef;
  /** Optional nullable link resolved through LocalIds (missing → null). */
  link?: ParentRef;
  /** Self-referential nullable parent within the same table. */
  selfParent?: { col: string; wire: string };
  /** Client-side natural-key adoption for rows created independently
   *  on this device. Returns a WHERE fragment + params, or null when
   *  the wire row carries no adoptable key. */
  adoptWhere?: (
    wire: Row,
    parentLocalId: number | null,
  ) => { where: string; params: unknown[] } | null;
};

function wireValue(c: ColSpec, v: unknown): unknown {
  if (c.t === "bool") return bool(v);
  if (c.t === "num") return num(v);
  return s(v);
}

function localValue(c: ColSpec, v: unknown): unknown {
  if (c.t === "bool") return v ? 1 : 0;
  return v ?? null;
}

function guidKind(cfg: GuidKindCfg): KindSpec {
  const hasCreatedAt = cfg.hasCreatedAt ?? true;
  const { table } = cfg;

  const scanSelect = [
    "t.id AS __id",
    "t.guid AS __guid",
    "t.mtime AS __mtime",
    ...(hasCreatedAt ? ["t.created_at AS __created"] : []),
    ...cfg.cols.map((c) => `t.${c.col}`),
    ...(cfg.parent ? [`__p.guid AS __parent_guid`] : []),
    ...(cfg.link ? [`__l.guid AS __link_guid`] : []),
    ...(cfg.selfParent ? [`__sp.guid AS __self_guid`] : []),
  ].join(", ");
  const scanJoins = [
    cfg.parent ? `JOIN ${cfg.parent.table} __p ON __p.id = t.${cfg.parent.col}` : "",
    cfg.link ? `LEFT JOIN ${cfg.link.table} __l ON __l.id = t.${cfg.link.col}` : "",
    cfg.selfParent
      ? `LEFT JOIN ${table} __sp ON __sp.id = t.${cfg.selfParent.col}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    kind: cfg.kind,

    async countDirty(db) {
      const r = await db.select<{ n: number }[]>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE dirty = 1`,
      );
      return r[0]?.n ?? 0;
    },

    async scanDirty(db, limit) {
      const rows = await db.select<Row[]>(
        `SELECT ${scanSelect} FROM ${table} t ${scanJoins}
         WHERE t.dirty = 1 AND t.guid IS NOT NULL LIMIT $1`,
        [limit],
      );
      return rows.map((r): ScannedRow => {
        const wire: Row = {
          gid: sReq(r.__guid),
          mtime: numReq(r.__mtime),
        };
        if (hasCreatedAt) wire.createdAt = num(r.__created);
        if (cfg.parent) wire[cfg.parent.wire] = sReq(r.__parent_guid);
        if (cfg.link) wire[cfg.link.wire] = s(r.__link_guid);
        if (cfg.selfParent) wire[cfg.selfParent.wire] = s(r.__self_guid);
        for (const c of cfg.cols) wire[c.wire] = wireValue(c, r[c.col]);
        const id = numReq(r.__id);
        const mtime = numReq(r.__mtime);
        return {
          wire,
          gid: sReq(r.__guid),
          clear: async (d) => {
            await d.execute(
              `UPDATE ${table} SET dirty = 0 WHERE id = $1 AND dirty = 1 AND mtime = $2`,
              [id, mtime],
            );
          },
          park: async (d) => {
            await d.execute(`UPDATE ${table} SET dirty = -1 WHERE id = $1`, [id]);
          },
        };
      });
    },

    async applyChange(db, wire, ctx) {
      const gid = sReq(wire.gid);
      const mtime = numReq(wire.mtime);

      let parentId: number | null = null;
      if (cfg.parent) {
        parentId = await ctx.ids.localId(cfg.parent.kind, sReq(wire[cfg.parent.wire]));
        if (parentId == null) return "skipped"; // parent grave raced ahead
      }
      let linkId: number | null = null;
      if (cfg.link && wire[cfg.link.wire] != null) {
        linkId = await ctx.ids.localId(cfg.link.kind, sReq(wire[cfg.link.wire]));
      }
      let selfId: number | null = null;
      let deferSelf = false;
      if (cfg.selfParent && wire[cfg.selfParent.wire] != null) {
        const rows = await db.select<{ id: number }[]>(
          `SELECT id FROM ${table} WHERE guid = $1`,
          [sReq(wire[cfg.selfParent.wire])],
        );
        if (rows.length > 0) selfId = rows[0].id;
        else deferSelf = true;
      }

      let existing = (
        await db.select<{ id: number; dirty: number; mtime: number | null }[]>(
          `SELECT id, dirty, mtime FROM ${table} WHERE guid = $1`,
          [gid],
        )
      )[0];

      if (!existing && cfg.adoptWhere) {
        const adopt = cfg.adoptWhere(wire, parentId);
        if (adopt) {
          const found = (
            await db.select<{ id: number; dirty: number; mtime: number | null }[]>(
              `SELECT id, dirty, mtime FROM ${table} WHERE ${adopt.where} LIMIT 1`,
              adopt.params,
            )
          )[0];
          if (found) {
            // Converge the independently-created local row onto the
            // server identity. Changing guid alone doesn't re-dirty
            // (the trigger's guid clause), and the row keeps its dirty
            // state so a locally-newer version still pushes next.
            await db.execute(`UPDATE ${table} SET guid = $1 WHERE id = $2`, [
              gid,
              found.id,
            ]);
            existing = found;
          }
        }
      }

      const dataCols = cfg.cols.filter((c) => !c.insertOnly);
      if (existing) {
        const sets: string[] = [];
        const params: unknown[] = [];
        let p = 0;
        for (const c of dataCols) {
          sets.push(`${c.col} = $${++p}`);
          params.push(localValue(c, wire[c.wire]));
        }
        if (cfg.link) {
          sets.push(`${cfg.link.col} = $${++p}`);
          params.push(linkId);
        }
        if (cfg.selfParent && !deferSelf) {
          sets.push(`${cfg.selfParent.col} = $${++p}`);
          params.push(selfId);
        }
        if (cfg.updatedAtCol) {
          sets.push(`${cfg.updatedAtCol} = $${++p}`);
          params.push(Math.floor(mtime / 1000));
        }
        sets.push(`mtime = $${++p}`);
        params.push(mtime);
        sets.push("dirty = 0");
        const res = await db.execute(
          `UPDATE ${table} SET ${sets.join(", ")}
           WHERE id = $${++p} AND (dirty = 0 OR mtime <= $${++p}) AND mtime IS NOT $${++p}`,
          [...params, existing.id, mtime, mtime],
        );
        if (deferSelf && cfg.selfParent) {
          ctx.deferred.push({
            kind: cfg.kind,
            gid,
            parentGid: sReq(wire[cfg.selfParent.wire]),
          });
        }
        return res.rowsAffected > 0 ? "updated" : "skipped";
      }

      const insertCols: string[] = ["guid", "mtime", "dirty"];
      const insertVals: unknown[] = [gid, mtime, 0];
      for (const c of cfg.cols) {
        insertCols.push(c.col);
        insertVals.push(localValue(c, wire[c.wire]));
      }
      if (cfg.parent) {
        insertCols.push(cfg.parent.col);
        insertVals.push(parentId);
      }
      if (cfg.link) {
        insertCols.push(cfg.link.col);
        insertVals.push(linkId);
      }
      if (cfg.selfParent) {
        insertCols.push(cfg.selfParent.col);
        insertVals.push(selfId);
      }
      if (hasCreatedAt && wire.createdAt != null) {
        insertCols.push("created_at");
        insertVals.push(numReq(wire.createdAt));
      }
      if (cfg.updatedAtCol) {
        insertCols.push(cfg.updatedAtCol);
        insertVals.push(Math.floor(mtime / 1000));
      }
      const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(", ");
      try {
        await db.execute(
          `INSERT INTO ${table} (${insertCols.join(", ")}) VALUES (${placeholders})`,
          insertVals,
        );
      } catch {
        // Unique-constraint race (e.g. two defaults per workspace);
        // leave it — the next sync re-delivers after the user resolves.
        return "skipped";
      }
      if (deferSelf && cfg.selfParent) {
        ctx.deferred.push({
          kind: cfg.kind,
          gid,
          parentGid: sReq(wire[cfg.selfParent.wire]),
        });
      }
      const kind = cfg.kind;
      if (kind === "workspace" || kind === "collection" || kind === "vocab" || kind === "libraryItem" || kind === "chat") {
        const made = await db.select<{ id: number }[]>(
          `SELECT id FROM ${table} WHERE guid = $1`,
          [gid],
        );
        if (made.length > 0) ctx.ids.learn(kind, gid, made[0].id);
      }
      return "inserted";
    },

    async applyGrave(db, gid, ctx) {
      await db.execute(`UPDATE ${table} SET dirty = 2 WHERE guid = $1`, [gid]);
      await db.execute(`DELETE FROM ${table} WHERE guid = $1`, [gid]);
      ctx.ids.forget(cfg.kind, gid);
    },

    async remapGid(db, from, to, ctx) {
      try {
        await db.execute(`UPDATE ${table} SET guid = $1 WHERE guid = $2`, [to, from]);
      } catch {
        // A row already answers to the target gid — the local `from`
        // row is a duplicate of it; drop it in favour of the canonical
        // one (its content arrives in the same pull if newer).
        await db.execute(`UPDATE ${table} SET dirty = 2 WHERE guid = $1`, [from]);
        await db.execute(`DELETE FROM ${table} WHERE guid = $1`, [from]);
      }
      ctx.ids.forget(cfg.kind, from);
      ctx.ids.forget(cfg.kind, to);
    },

    ...(cfg.selfParent
      ? {
          async applyDeferred(db: Db, link: DeferredLink) {
            const parent = await db.select<{ id: number }[]>(
              `SELECT id FROM ${table} WHERE guid = $1`,
              [link.parentGid],
            );
            if (parent.length === 0) return; // still missing → next sync
            await quietly(
              db,
              table,
              `${cfg.selfParent!.col} = ${parent[0].id}`,
              "guid = $1",
              [link.gid],
            );
          },
        }
      : {}),
  };
}

// ── The kinds ─────────────────────────────────────────────────────────

const WORKSPACES: ParentRef = {
  kind: "workspace",
  col: "workspace_id",
  wire: "workspaceGid",
  table: "workspaces",
};

const workspaceKind = guidKind({
  kind: "workspace",
  table: "workspaces",
  cols: [
    { col: "target_lang", wire: "targetLang", t: "text", insertOnly: true },
    { col: "native_lang", wire: "nativeLang", t: "text" },
    { col: "name", wire: "name", t: "text" },
  ],
  adoptWhere: (w) => ({ where: "target_lang = $1", params: [sReq(w.targetLang)] }),
});

const collectionKind = guidKind({
  kind: "collection",
  table: "collections",
  parent: WORKSPACES,
  selfParent: { col: "parent_collection_id", wire: "parentGid" },
  updatedAtCol: "updated_at",
  cols: [
    { col: "name", wire: "name", t: "text" },
    { col: "description", wire: "description", t: "text" },
    { col: "is_default", wire: "isDefault", t: "bool" },
    { col: "source", wire: "source", t: "text" },
    { col: "preset_id", wire: "presetId", t: "text" },
  ],
  adoptWhere: (w, wsId) => {
    if (wsId == null) return null;
    if (w.presetId != null) {
      return {
        where: "workspace_id = $1 AND preset_id = $2",
        params: [wsId, sReq(w.presetId)],
      };
    }
    if (bool(w.isDefault)) {
      return { where: "workspace_id = $1 AND is_default = 1", params: [wsId] };
    }
    return null;
  },
});

const vocabKind = guidKind({
  kind: "vocab",
  table: "vocab_entries",
  parent: WORKSPACES,
  cols: [
    { col: "word", wire: "word", t: "text", insertOnly: true },
    { col: "reading", wire: "reading", t: "text" },
    { col: "gloss", wire: "gloss", t: "text" },
    { col: "source", wire: "source", t: "text" },
    { col: "status", wire: "status", t: "text" },
    { col: "kind", wire: "kind", t: "text" },
    { col: "stability", wire: "stability", t: "num" },
    { col: "difficulty", wire: "difficulty", t: "num" },
    { col: "learning_step", wire: "learningStep", t: "num" },
    { col: "due_at", wire: "dueAt", t: "num" },
    { col: "last_review", wire: "lastReview", t: "num" },
    { col: "review_count", wire: "reviewCount", t: "num" },
    { col: "card_notes", wire: "cardNotes", t: "text" },
    { col: "front_extra", wire: "frontExtra", t: "text" },
    { col: "translation", wire: "translation", t: "text" },
    { col: "layout", wire: "layout", t: "text" },
    { col: "is_active", wire: "isActive", t: "bool" },
  ],
  adoptWhere: (w, wsId) =>
    wsId == null
      ? null
      : { where: "workspace_id = $1 AND word = $2", params: [wsId, sReq(w.word)] },
});

const libraryItemKind = guidKind({
  kind: "libraryItem",
  table: "library_items",
  parent: WORKSPACES,
  updatedAtCol: "updated_at",
  cols: [
    { col: "kind", wire: "kind", t: "text" },
    { col: "title", wire: "title", t: "text" },
    { col: "author", wire: "author", t: "text" },
    { col: "source", wire: "source", t: "text" },
    { col: "total_units", wire: "totalUnits", t: "num" },
    { col: "unit_label", wire: "unitLabel", t: "text" },
    { col: "completed_units", wire: "completedUnits", t: "num" },
    { col: "total_seconds", wire: "totalSeconds", t: "num" },
    { col: "status", wire: "status", t: "text" },
    { col: "cover_url", wire: "coverUrl", t: "text" },
    { col: "notes", wire: "notes", t: "text" },
  ],
  adoptWhere: (w, wsId) =>
    wsId == null || w.source == null
      ? null
      : { where: "workspace_id = $1 AND source = $2", params: [wsId, sReq(w.source)] },
});

const chapterKind = guidKind({
  kind: "chapter",
  table: "library_chapters",
  parent: { kind: "libraryItem", col: "item_id", wire: "itemGid", table: "library_items" },
  link: { kind: "collection", col: "collection_id", wire: "collectionGid", table: "collections" },
  cols: [
    { col: "position", wire: "position", t: "num" },
    { col: "title", wire: "title", t: "text" },
    { col: "completed_at", wire: "completedAt", t: "num" },
    { col: "notes", wire: "notes", t: "text" },
  ],
  adoptWhere: (w, itemId) =>
    itemId == null
      ? null
      : { where: "item_id = $1 AND position = $2", params: [itemId, numReq(w.position)] },
});

const sessionKind = guidKind({
  kind: "session",
  table: "study_sessions",
  parent: WORKSPACES,
  hasCreatedAt: false,
  cols: [
    { col: "kind", wire: "kind", t: "text" },
    { col: "started_at", wire: "startedAt", t: "num" },
    { col: "ended_at", wire: "endedAt", t: "num" },
    { col: "duration_secs", wire: "durationSecs", t: "num" },
    { col: "words_seen", wire: "wordsSeen", t: "num" },
    { col: "words_saved", wire: "wordsSaved", t: "num" },
    { col: "notes", wire: "notes", t: "text" },
  ],
});

const noteKind = guidKind({
  kind: "note",
  table: "notes",
  parent: WORKSPACES,
  updatedAtCol: "updated_at",
  cols: [
    { col: "title", wire: "title", t: "text" },
    { col: "body", wire: "body", t: "text" },
    { col: "pinned", wire: "pinned", t: "bool" },
  ],
});

const goalKind = guidKind({
  kind: "goal",
  table: "goals",
  parent: WORKSPACES,
  cols: [
    { col: "title", wire: "title", t: "text" },
    { col: "kind", wire: "kind", t: "text" },
    { col: "skill", wire: "skill", t: "text" },
    { col: "target", wire: "target", t: "num" },
    { col: "deadline", wire: "deadline", t: "num" },
    { col: "completed_at", wire: "completedAt", t: "num" },
  ],
});

const habitKind = guidKind({
  kind: "habit",
  table: "habits",
  parent: WORKSPACES,
  updatedAtCol: "updated_at",
  cols: [
    { col: "name", wire: "name", t: "text" },
    { col: "activity_kind", wire: "activityKind", t: "text" },
    { col: "target_secs", wire: "targetSecs", t: "num" },
    { col: "frequency", wire: "frequency", t: "text" },
    { col: "glyph", wire: "glyph", t: "text" },
    { col: "archived_at", wire: "archivedAt", t: "num" },
  ],
});

const chatKind = guidKind({
  kind: "chat",
  table: "chats",
  parent: WORKSPACES,
  updatedAtCol: "updated_at",
  cols: [{ col: "title", wire: "title", t: "text" }],
});

const messageKind = guidKind({
  kind: "message",
  table: "messages",
  parent: { kind: "chat", col: "chat_id", wire: "chatGid", table: "chats" },
  cols: [
    { col: "role", wire: "role", t: "text", insertOnly: true },
    { col: "content", wire: "content", t: "text" },
  ],
});

const journalKind = guidKind({
  kind: "journal",
  table: "journal_entries",
  parent: WORKSPACES,
  updatedAtCol: "updated_at",
  cols: [
    { col: "title", wire: "title", t: "text" },
    { col: "topic", wire: "topic", t: "text" },
    { col: "body", wire: "body", t: "text" },
    { col: "state", wire: "state", t: "text" },
    { col: "corrections", wire: "corrections", t: "text" },
    { col: "source", wire: "source", t: "text" },
  ],
});

const readerDocKind = guidKind({
  kind: "readerDoc",
  table: "reader_documents",
  parent: WORKSPACES,
  link: {
    kind: "libraryItem",
    col: "library_item_id",
    wire: "libraryItemGid",
    table: "library_items",
  },
  selfParent: { col: "parent_id", wire: "parentGid" },
  updatedAtCol: "updated_at",
  cols: [
    { col: "title", wire: "title", t: "text" },
    { col: "body", wire: "body", t: "text" },
    { col: "source_url", wire: "sourceUrl", t: "text" },
    { col: "level", wire: "level", t: "text" },
    { col: "chapter_position", wire: "chapterPosition", t: "num" },
  ],
});

const systemPromptKind = guidKind({
  kind: "systemPrompt",
  table: "system_prompts",
  cols: [
    { col: "name", wire: "name", t: "text" },
    { col: "body", wire: "body", t: "text" },
    { col: "is_default", wire: "isDefault", t: "bool" },
  ],
});

const translateConfigKind = guidKind({
  kind: "translateConfig",
  table: "translate_configs",
  cols: [
    { col: "kind", wire: "kind", t: "text" },
    { col: "label", wire: "label", t: "text" },
    { col: "api_key", wire: "apiKey", t: "text" },
    { col: "secondary_key", wire: "secondaryKey", t: "text" },
    { col: "base_url", wire: "baseUrl", t: "text" },
    { col: "model", wire: "model", t: "text" },
    { col: "is_default", wire: "isDefault", t: "bool" },
  ],
});

// ── review — append-only, identity (vocabGid, reviewedAt) ─────────────

const reviewKind: KindSpec = {
  kind: "review",

  async countDirty(db) {
    const r = await db.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM vocab_reviews WHERE dirty = 1",
    );
    return r[0]?.n ?? 0;
  },

  async scanDirty(db, limit) {
    const rows = await db.select<Row[]>(
      `SELECT r.id AS __id, r.grade, r.reviewed_at, r.new_due_at, r.new_status,
              r.new_stability, v.guid AS __vguid
       FROM vocab_reviews r JOIN vocab_entries v ON v.id = r.vocab_id
       WHERE r.dirty = 1 AND v.guid IS NOT NULL LIMIT $1`,
      [limit],
    );
    return rows.map((r): ScannedRow => {
      const wire: WireReview = {
        vocabGid: sReq(r.__vguid),
        grade: sReq(r.grade),
        reviewedAt: numReq(r.reviewed_at),
        newDueAt: num(r.new_due_at),
        newStatus: s(r.new_status),
        stability: num(r.new_stability),
        difficulty: null,
      };
      const id = numReq(r.__id);
      return {
        wire: wire as unknown as Row,
        gid: reviewGid(wire.vocabGid, wire.reviewedAt),
        clear: async (d) => {
          await d.execute(
            "UPDATE vocab_reviews SET dirty = 0 WHERE id = $1 AND dirty = 1",
            [id],
          );
        },
        park: async (d) => {
          await d.execute("UPDATE vocab_reviews SET dirty = -1 WHERE id = $1", [id]);
        },
      };
    });
  },

  async applyChange(db, wire, ctx) {
    const w = wire as unknown as WireReview;
    const vocabId = await ctx.ids.localId("vocab", w.vocabGid);
    if (vocabId == null) return "skipped";
    const exists = await db.select<{ id: number }[]>(
      "SELECT id FROM vocab_reviews WHERE vocab_id = $1 AND reviewed_at = $2 LIMIT 1",
      [vocabId, w.reviewedAt],
    );
    if (exists.length > 0) return "skipped";
    await db.execute(
      `INSERT INTO vocab_reviews
         (vocab_id, grade, new_status, new_stability, new_due_at, reviewed_at, dirty)
       VALUES ($1, $2, $3, $4, $5, $6, 0)`,
      [
        vocabId,
        w.grade,
        w.newStatus ?? "review",
        w.stability ?? 0,
        w.newDueAt,
        w.reviewedAt,
      ],
    );
    return "inserted";
  },

  async applyGrave(db, gid, ctx) {
    const parsed = parseReviewGid(gid);
    if (!parsed) return;
    const vocabId = await ctx.ids.localId("vocab", parsed.vocabGid);
    if (vocabId == null) return;
    await db.execute(
      "UPDATE vocab_reviews SET dirty = 2 WHERE vocab_id = $1 AND reviewed_at = $2",
      [vocabId, parsed.reviewedAt],
    );
    await db.execute(
      "DELETE FROM vocab_reviews WHERE vocab_id = $1 AND reviewed_at = $2",
      [vocabId, parsed.reviewedAt],
    );
  },

  async remapGid() {
    // Reviews are identified by their vocab's gid — vocab remaps
    // already move the whole history; nothing to rewrite here.
  },
};

// ── collectionWord — identity (collectionGid, vocabGid) ───────────────

const collectionWordKind: KindSpec = {
  kind: "collectionWord",

  async countDirty(db) {
    const r = await db.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM collection_words WHERE dirty = 1",
    );
    return r[0]?.n ?? 0;
  },

  async scanDirty(db, limit) {
    const rows = await db.select<Row[]>(
      `SELECT cw.collection_id AS __cid, cw.vocab_id AS __vid, cw.position,
              cw.added_at, COALESCE(cw.mtime, cw.added_at * 1000) AS __mtime,
              c.guid AS __cguid, v.guid AS __vguid
       FROM collection_words cw
       JOIN collections c ON c.id = cw.collection_id
       JOIN vocab_entries v ON v.id = cw.vocab_id
       WHERE cw.dirty = 1 AND c.guid IS NOT NULL AND v.guid IS NOT NULL
       LIMIT $1`,
      [limit],
    );
    return rows.map((r): ScannedRow => {
      const wire: WireCollectionWord = {
        collectionGid: sReq(r.__cguid),
        vocabGid: sReq(r.__vguid),
        position: numReq(r.position),
        addedAt: num(r.added_at),
        mtime: numReq(r.__mtime),
      };
      const cid = numReq(r.__cid);
      const vid = numReq(r.__vid);
      const mtime = numReq(r.__mtime);
      return {
        wire: wire as unknown as Row,
        gid: collectionWordGid(wire.collectionGid, wire.vocabGid),
        clear: async (d) => {
          await d.execute(
            `UPDATE collection_words SET dirty = 0
             WHERE collection_id = $1 AND vocab_id = $2 AND dirty = 1
               AND COALESCE(mtime, added_at * 1000) = $3`,
            [cid, vid, mtime],
          );
        },
        park: async (d) => {
          await d.execute(
            "UPDATE collection_words SET dirty = -1 WHERE collection_id = $1 AND vocab_id = $2",
            [cid, vid],
          );
        },
      };
    });
  },

  async applyChange(db, wire, ctx) {
    const w = wire as unknown as WireCollectionWord;
    const collectionId = await ctx.ids.localId("collection", w.collectionGid);
    const vocabId = await ctx.ids.localId("vocab", w.vocabGid);
    if (collectionId == null || vocabId == null) return "skipped";
    const res = await db.execute(
      `INSERT INTO collection_words (collection_id, vocab_id, position, added_at, mtime, dirty)
       VALUES ($1, $2, $3, COALESCE($4, strftime('%s','now')), $5, 0)
       ON CONFLICT(collection_id, vocab_id) DO UPDATE SET
         position = excluded.position, mtime = excluded.mtime, dirty = 0
       WHERE (collection_words.dirty = 0 OR COALESCE(collection_words.mtime, 0) <= excluded.mtime)
         AND collection_words.mtime IS NOT excluded.mtime`,
      [collectionId, vocabId, w.position, w.addedAt, w.mtime],
    );
    return res.rowsAffected > 0 ? "updated" : "skipped";
  },

  async applyGrave(db, gid, ctx) {
    const parsed = parseCollectionWordGid(gid);
    if (!parsed) return;
    const collectionId = await ctx.ids.localId("collection", parsed.collectionGid);
    const vocabId = await ctx.ids.localId("vocab", parsed.vocabGid);
    if (collectionId == null || vocabId == null) return;
    await db.execute(
      "UPDATE collection_words SET dirty = 2 WHERE collection_id = $1 AND vocab_id = $2",
      [collectionId, vocabId],
    );
    await db.execute(
      "DELETE FROM collection_words WHERE collection_id = $1 AND vocab_id = $2",
      [collectionId, vocabId],
    );
  },

  async remapGid() {
    // Composed of parent gids; parent remaps cover it.
  },
};

// ── setting — identity key, curated allowlist + per-workspace study ───

/** Global settings worth syncing. Union of the two legacy lists
 *  (sync.ts + sync-queue.ts) minus device-local boot state. */
export const SYNCED_SETTING_KEYS: ReadonlySet<string> = new Set([
  "profile.name",
  "profile.defaultNativeLang",
  "profile.levelScale",
  "study.config",
  "study.fsrsWeights",
  "study.lastFocus",
  "ui.theme",
  "display.showRuby",
  "display.theme",
  "display.fontSize",
  "tts.config",
  "reader.lastLevel",
]);

/** Per-workspace study config keys: `workspace.<localId>.study.<field>`.
 *  Local workspace ids differ per device, so the wire key embeds the
 *  workspace GID instead: `ws:<gid>|study.<field>` ('|' never appears
 *  in a gid). */
const WS_SETTING_RE = /^workspace\.(\d+)\.(study\..+)$/;
const WIRE_WS_SETTING_RE = /^ws:(.+)\|(study\..+)$/;

export function isSyncableSettingKey(key: string): boolean {
  return SYNCED_SETTING_KEYS.has(key) || WS_SETTING_RE.test(key);
}

export function settingKeyToWire(
  key: string,
  wsGidById: (id: number) => string | null,
): string | null {
  const m = WS_SETTING_RE.exec(key);
  if (!m) return SYNCED_SETTING_KEYS.has(key) ? key : null;
  const gid = wsGidById(Number(m[1]));
  return gid ? `ws:${gid}|${m[2]}` : null;
}

export function settingKeyFromWire(
  wireKey: string,
  wsIdByGid: (gid: string) => number | null,
): string | null {
  const m = WIRE_WS_SETTING_RE.exec(wireKey);
  if (!m) return SYNCED_SETTING_KEYS.has(wireKey) ? wireKey : null;
  const id = wsIdByGid(m[1]);
  return id != null ? `workspace.${id}.${m[2]}` : null;
}

const settingKind: KindSpec = {
  kind: "setting",

  async countDirty(db) {
    // Cheap upper bound; the scan itself filters non-syncable keys
    // (and clears their dirty flag so they stop showing up here).
    const r = await db.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM settings WHERE dirty = 1",
    );
    return r[0]?.n ?? 0;
  },

  async scanDirty(db, limit) {
    const rows = await db.select<Row[]>(
      "SELECT key, value, COALESCE(mtime, 0) AS mtime FROM settings WHERE dirty = 1 LIMIT $1",
      [limit],
    );
    if (rows.length === 0) return [];
    const workspaces = await db.select<{ id: number; guid: string | null }[]>(
      "SELECT id, guid FROM workspaces",
    );
    const gidById = new Map(workspaces.map((w) => [w.id, w.guid]));
    const out: ScannedRow[] = [];
    for (const r of rows) {
      const key = sReq(r.key);
      const wireKey = settingKeyToWire(key, (id) => gidById.get(id) ?? null);
      if (!wireKey) {
        // Not a synced key — clear its flag so it stops rescanning.
        // (dirty 1→0 with mtime untouched doesn't re-trigger.)
        await db.execute(
          "UPDATE settings SET dirty = 0 WHERE key = $1 AND dirty = 1",
          [key],
        );
        continue;
      }
      const wire: WireSetting = {
        key: wireKey,
        value: sReq(r.value),
        mtime: numReq(r.mtime),
      };
      const mtime = numReq(r.mtime);
      out.push({
        wire: wire as unknown as Row,
        gid: wireKey,
        clear: async (d) => {
          await d.execute(
            "UPDATE settings SET dirty = 0 WHERE key = $1 AND dirty = 1 AND COALESCE(mtime, 0) = $2",
            [key, mtime],
          );
        },
        park: async (d) => {
          await d.execute("UPDATE settings SET dirty = -1 WHERE key = $1", [key]);
        },
      });
    }
    return out;
  },

  async applyChange(db, wire, ctx) {
    const w = wire as unknown as WireSetting;
    // Resolve ws-scoped wire keys to this device's workspace ids.
    let finalKey: string | null = null;
    const m = WIRE_WS_SETTING_RE.exec(w.key);
    if (m) {
      const wsId = await ctx.ids.localId("workspace", m[1]);
      if (wsId == null) return "skipped";
      finalKey = `workspace.${wsId}.${m[2]}`;
    } else if (SYNCED_SETTING_KEYS.has(w.key)) {
      finalKey = w.key;
    }
    if (!finalKey) return "skipped";
    const res = await db.execute(
      `INSERT INTO settings (key, value, mtime, dirty) VALUES ($1, $2, $3, 0)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, mtime = excluded.mtime, dirty = 0
       WHERE (settings.dirty = 0 OR COALESCE(settings.mtime, 0) <= excluded.mtime)
         AND settings.mtime IS NOT excluded.mtime`,
      [finalKey, w.value, w.mtime],
    );
    return res.rowsAffected > 0 ? "updated" : "skipped";
  },

  async applyGrave(db, gid, ctx) {
    const m = WIRE_WS_SETTING_RE.exec(gid);
    let key: string | null = gid;
    if (m) {
      const wsId = await ctx.ids.localId("workspace", m[1]);
      key = wsId != null ? `workspace.${wsId}.${m[2]}` : null;
    }
    if (key) await db.execute("DELETE FROM settings WHERE key = $1", [key]);
  },

  async remapGid() {
    // Settings are keyed by name; nothing to remap.
  },
};

// ── pdictEntry — Personal dictionary, identity (lang, word) ───────────

const pdictKind: KindSpec = {
  kind: "pdictEntry",

  async countDirty(db) {
    const r = await db.select<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM dict_entries e
       JOIN dictionaries d ON d.id = e.dict_id
       WHERE e.dirty = 1 AND d.name = $1`,
      [PERSONAL_DICT_NAME],
    );
    return r[0]?.n ?? 0;
  },

  async scanDirty(db, limit) {
    const rows = await db.select<Row[]>(
      `SELECT e.id AS __id, e.word, e.alt_word, e.reading, e.gloss,
              COALESCE(e.mtime, 0) AS __mtime, d.lang AS __lang
       FROM dict_entries e JOIN dictionaries d ON d.id = e.dict_id
       WHERE e.dirty = 1 AND d.name = $1 LIMIT $2`,
      [PERSONAL_DICT_NAME, limit],
    );
    return rows.map((r): ScannedRow => {
      const wire: WirePdictEntry = {
        lang: sReq(r.__lang),
        word: sReq(r.word),
        altWord: s(r.alt_word),
        reading: s(r.reading),
        gloss: sReq(r.gloss),
        mtime: numReq(r.__mtime),
      };
      const id = numReq(r.__id);
      const mtime = numReq(r.__mtime);
      return {
        wire: wire as unknown as Row,
        gid: pdictGid(wire.lang, wire.word),
        clear: async (d) => {
          await d.execute(
            "UPDATE dict_entries SET dirty = 0 WHERE id = $1 AND dirty = 1 AND COALESCE(mtime, 0) = $2",
            [id, mtime],
          );
        },
        park: async (d) => {
          await d.execute("UPDATE dict_entries SET dirty = -1 WHERE id = $1", [id]);
        },
      };
    });
  },

  async applyChange(db, wire) {
    const w = wire as unknown as WirePdictEntry;
    const dictId = await personalDictId(db, w.lang);
    const existing = await db.select<
      { id: number; dirty: number; mtime: number | null }[]
    >(
      "SELECT id, dirty, mtime FROM dict_entries WHERE dict_id = $1 AND word = $2 LIMIT 1",
      [dictId, w.word],
    );
    if (existing.length === 0) {
      await db.execute(
        `INSERT INTO dict_entries (dict_id, word, alt_word, reading, gloss, mtime, dirty)
         VALUES ($1, $2, $3, $4, $5, $6, 0)`,
        [dictId, w.word, w.altWord, w.reading, w.gloss, w.mtime],
      );
      return "inserted";
    }
    const res = await db.execute(
      `UPDATE dict_entries SET alt_word = $1, reading = $2, gloss = $3, mtime = $4, dirty = 0
       WHERE id = $5 AND (dirty = 0 OR COALESCE(mtime, 0) <= $6) AND mtime IS NOT $7`,
      [w.altWord, w.reading, w.gloss, w.mtime, existing[0].id, w.mtime, w.mtime],
    );
    return res.rowsAffected > 0 ? "updated" : "skipped";
  },

  async applyGrave(db, gid) {
    const parsed = parsePdictGid(gid);
    if (!parsed) return;
    const dict = await db.select<{ id: number }[]>(
      "SELECT id FROM dictionaries WHERE lang = $1 AND name = $2",
      [parsed.lang, PERSONAL_DICT_NAME],
    );
    if (dict.length === 0) return;
    await db.execute(
      "UPDATE dict_entries SET dirty = 2 WHERE dict_id = $1 AND word = $2",
      [dict[0].id, parsed.word],
    );
    await db.execute("DELETE FROM dict_entries WHERE dict_id = $1 AND word = $2", [
      dict[0].id,
      parsed.word,
    ]);
  },

  async remapGid() {
    // Natural identity; nothing to remap.
  },
};

async function personalDictId(db: Db, lang: string): Promise<number> {
  const found = await db.select<{ id: number }[]>(
    "SELECT id FROM dictionaries WHERE lang = $1 AND name = $2",
    [lang, PERSONAL_DICT_NAME],
  );
  if (found.length > 0) return found[0].id;
  await db.execute("INSERT INTO dictionaries (lang, name) VALUES ($1, $2)", [
    lang,
    PERSONAL_DICT_NAME,
  ]);
  const made = await db.select<{ id: number }[]>(
    "SELECT id FROM dictionaries WHERE lang = $1 AND name = $2",
    [lang, PERSONAL_DICT_NAME],
  );
  return made[0].id;
}

/** Keep the Personal dictionaries' entry_count truthful after a pull —
 *  click-to-define availability (`useHasDictionary`) reads it. */
export async function recountPersonalDicts(db: Db): Promise<void> {
  await db.execute(
    `UPDATE dictionaries SET entry_count =
       (SELECT COUNT(*) FROM dict_entries e WHERE e.dict_id = dictionaries.id)
     WHERE name = $1`,
    [PERSONAL_DICT_NAME],
  );
}

// ── Registry ──────────────────────────────────────────────────────────

export const KIND_SPECS: Record<SyncKind, KindSpec> = {
  workspace: workspaceKind,
  collection: collectionKind,
  vocab: vocabKind,
  libraryItem: libraryItemKind,
  chapter: chapterKind,
  collectionWord: collectionWordKind,
  review: reviewKind,
  session: sessionKind,
  note: noteKind,
  goal: goalKind,
  habit: habitKind,
  chat: chatKind,
  message: messageKind,
  journal: journalKind,
  readerDoc: readerDocKind,
  systemPrompt: systemPromptKind,
  translateConfig: translateConfigKind,
  setting: settingKind,
  pdictEntry: pdictKind,
};

/** Tables whose rows the engine wipes on force-download, children
 *  before parents so FK cascades never surprise us. Settings are
 *  deliberately absent — they hold device-local boot state (tokens,
 *  install uuid) and the pull overwrites the synced subset anyway. */
export const FORCE_WIPE_SQL: readonly string[] = [
  // Mark everything as engine-deleted first so cascade-fired delete
  // triggers don't write graves for rows the server told us to drop.
  "UPDATE vocab_reviews SET dirty = 2",
  "UPDATE collection_words SET dirty = 2",
  "UPDATE messages SET dirty = 2",
  "UPDATE chats SET dirty = 2",
  "UPDATE library_chapters SET dirty = 2",
  "UPDATE reader_documents SET dirty = 2",
  "UPDATE library_items SET dirty = 2",
  "UPDATE collections SET dirty = 2",
  "UPDATE vocab_entries SET dirty = 2",
  "UPDATE study_sessions SET dirty = 2",
  "UPDATE notes SET dirty = 2",
  "UPDATE goals SET dirty = 2",
  "UPDATE habits SET dirty = 2",
  "UPDATE journal_entries SET dirty = 2",
  "UPDATE system_prompts SET dirty = 2",
  "UPDATE translate_configs SET dirty = 2",
  `UPDATE dict_entries SET dirty = 2 WHERE dict_id IN
     (SELECT id FROM dictionaries WHERE name = '${PERSONAL_DICT_NAME}')`,
  "DELETE FROM workspaces",
  "DELETE FROM system_prompts",
  "DELETE FROM translate_configs",
  `DELETE FROM dict_entries WHERE dict_id IN
     (SELECT id FROM dictionaries WHERE name = '${PERSONAL_DICT_NAME}')`,
  "DELETE FROM sync_graves",
];

/** Mark every synced row dirty for a force-upload (mtime untouched, so
 *  LWW ordering across devices stays honest). */
export const FORCE_MARK_ALL_DIRTY_SQL: readonly string[] = [
  "UPDATE workspaces SET dirty = 1 WHERE dirty = 0",
  "UPDATE collections SET dirty = 1 WHERE dirty = 0",
  "UPDATE vocab_entries SET dirty = 1 WHERE dirty = 0",
  "UPDATE library_items SET dirty = 1 WHERE dirty = 0",
  "UPDATE library_chapters SET dirty = 1 WHERE dirty = 0",
  "UPDATE collection_words SET dirty = 1 WHERE dirty = 0",
  "UPDATE vocab_reviews SET dirty = 1 WHERE dirty = 0",
  "UPDATE study_sessions SET dirty = 1 WHERE dirty = 0",
  "UPDATE notes SET dirty = 1 WHERE dirty = 0",
  "UPDATE goals SET dirty = 1 WHERE dirty = 0",
  "UPDATE habits SET dirty = 1 WHERE dirty = 0",
  "UPDATE chats SET dirty = 1 WHERE dirty = 0",
  "UPDATE messages SET dirty = 1 WHERE dirty = 0",
  "UPDATE journal_entries SET dirty = 1 WHERE dirty = 0",
  "UPDATE reader_documents SET dirty = 1 WHERE dirty = 0",
  "UPDATE system_prompts SET dirty = 1 WHERE dirty = 0",
  "UPDATE translate_configs SET dirty = 1 WHERE dirty = 0",
  "UPDATE settings SET dirty = 1 WHERE dirty = 0",
  `UPDATE dict_entries SET dirty = 1 WHERE dirty = 0 AND dict_id IN
     (SELECT id FROM dictionaries WHERE name = '${PERSONAL_DICT_NAME}')`,
  "DELETE FROM sync_graves",
];

/** Rows the engine treats as "this device has data" for the
 *  first-sync merge/upload/download decision. */
export async function localHasSyncableData(db: Db): Promise<boolean> {
  const ws = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM workspaces",
  );
  if ((ws[0]?.n ?? 0) > 0) return true;
  const pd = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM dict_entries e JOIN dictionaries d ON d.id = e.dict_id
     WHERE d.name = $1`,
    [PERSONAL_DICT_NAME],
  );
  return (pd[0]?.n ?? 0) > 0;
}
