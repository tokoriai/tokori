/**
 * Desktop sync engine — drives the AnkiWeb-style exchange protocol
 * against the cloud (see docs/sync-protocol.md and ./protocol.ts).
 *
 * One `syncNow()` call:
 *   1. GET /sync/v2/meta — account identity, usn counter, epoch.
 *   2. Push loop: scan dirty rows kind-by-kind (chunked), POST them
 *      with the local tombstones; apply remaps, park rejections, clear
 *      dirty flags. All but the last chunk use mode "skip-pull".
 *   3. Pull loop: the last push response carries the first page of
 *      other devices' changes + graves; keep exchanging while `next`.
 *   4. Complete deferred self-links, recount personal dicts, save the
 *      cursor. Only then — a crash anywhere earlier re-runs safely
 *      because every apply is idempotent and dirty flags survive.
 *
 * Desktop-only: HOSTED builds are cloud-resident (db.ts already reads
 * and writes the cloud), and the browser dev fallback has no SQLite.
 * `syncNow` throws SyncUnavailableError in both.
 */

import { isTauri } from "@tauri-apps/api/core";
import { HOSTED } from "../build-flags";
import { getRawDb } from "../db";
import { triggerCloudRefresh } from "../cloud-refresh";
import {
  KIND_ORDER,
  SYNC_PROTOCOL_VERSION,
  type ChangeSet,
  type ExchangeRequest,
  type ExchangeResponse,
  type Grave,
  type SyncKind,
  type SyncMeta,
} from "./protocol";
import {
  FORCE_MARK_ALL_DIRTY_SQL,
  FORCE_WIPE_SQL,
  KIND_SPECS,
  LocalIds,
  localHasSyncableData,
  recountPersonalDicts,
  type ApplyCtx,
  type Db,
  type ScannedRow,
} from "./kinds";

export type SyncAuth = { apiBase: string; token: string };

export type SyncSummary = {
  pushed: number;
  pulled: number;
  deleted: number;
  rejected: number;
};

export type SyncOutcome =
  | { kind: "ok"; summary: SyncSummary }
  /** Both this device and the cloud hold data and they've never synced
   *  — the user must pick Merge / Upload / Download (Anki's first-sync
   *  question). Re-run with `acceptMerge: true` after "Merge". */
  | { kind: "first-sync-choice" }
  /** Another device force-uploaded since our last sync; local un-pushed
   *  changes are stale. The user confirms, then `forceDownload()`. */
  | { kind: "epoch-mismatch" };

export class SyncAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "SyncAuthError";
  }
}

export class SyncProRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncProRequiredError";
  }
}

export class SyncUnavailableError extends Error {
  constructor() {
    super("Sync runs on the desktop build only.");
    this.name = "SyncUnavailableError";
  }
}

const STATE_KEY = "sync.v2.state";
const LAST_SYNC_KEY = "cloud.lastSyncAt";
const PUSH_CHUNK = 800;
const MAX_GRAVES_PER_PUSH = 10_000;

type SyncState = { userId: number; epoch: number; usn: number };

// ── HTTP ──────────────────────────────────────────────────────────────

async function call<T>(
  auth: SyncAuth,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${auth.apiBase}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${auth.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      // non-JSON error body — keep the status text
    }
    if (res.status === 401) throw new SyncAuthError(401, msg);
    if (res.status === 402) throw new SyncProRequiredError(msg);
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const exchange = (auth: SyncAuth, req: ExchangeRequest) =>
  call<ExchangeResponse>(auth, "/api/v1/sync/v2/exchange", req);

// ── Cursor state ──────────────────────────────────────────────────────

async function readState(db: Db): Promise<SyncState | null> {
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1",
    [STATE_KEY],
  );
  if (rows.length === 0) return null;
  try {
    const parsed = JSON.parse(rows[0].value) as Partial<SyncState>;
    if (
      typeof parsed.userId === "number" &&
      typeof parsed.epoch === "number" &&
      typeof parsed.usn === "number"
    ) {
      return { userId: parsed.userId, epoch: parsed.epoch, usn: parsed.usn };
    }
  } catch {
    // corrupt state row → treat as never-synced
  }
  return null;
}

async function writeSetting(db: Db, key: string, value: string): Promise<void> {
  await db.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

async function clearState(db: Db): Promise<void> {
  await db.execute("DELETE FROM settings WHERE key = $1", [STATE_KEY]);
}

/** Last successful sync (epoch ms), or null. */
export async function getLastSyncAt(): Promise<number | null> {
  if (HOSTED || !isTauri()) return null;
  const db = await getRawDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1",
    [LAST_SYNC_KEY],
  );
  const n = rows.length > 0 ? Number(rows[0].value) : NaN;
  return Number.isFinite(n) ? n : null;
}

// ── The sync ──────────────────────────────────────────────────────────

let inFlight: Promise<SyncOutcome> | null = null;

/** Run one full exchange. Concurrent callers (the 5-minute auto-sync
 *  tick racing a manual "Sync now") share the in-flight run instead of
 *  interleaving two scans over the same dirty flags. */
export function syncNow(
  auth: SyncAuth,
  opts: { acceptMerge?: boolean } = {},
): Promise<SyncOutcome> {
  if (inFlight) return inFlight;
  inFlight = doSync(auth, opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSync(
  auth: SyncAuth,
  opts: { acceptMerge?: boolean },
): Promise<SyncOutcome> {
  if (HOSTED || !isTauri()) throw new SyncUnavailableError();
  const db = await getRawDb();

  const meta = await call<SyncMeta>(auth, "/api/v1/sync/v2/meta");
  let state = await readState(db);
  if (state && state.userId !== meta.userId) state = null; // account switch
  if (state && state.epoch !== meta.epoch) return { kind: "epoch-mismatch" };
  const lastUsn = state?.usn ?? 0;
  if (
    !state &&
    meta.hasData &&
    !opts.acceptMerge &&
    (await localHasSyncableData(db))
  ) {
    return { kind: "first-sync-choice" };
  }

  const summary: SyncSummary = { pushed: 0, pulled: 0, deleted: 0, rejected: 0 };
  const ctx: ApplyCtx = { ids: new LocalIds(db), deferred: [] };

  // ── Push ────────────────────────────────────────────────────────────
  let gravesSent = false;
  let firstPullResponse: ExchangeResponse;
  // 50 chunks × 800 rows bounds one sync at 40k pushed rows — far above
  // any real dataset, but a hard stop if a row somehow never clears.
  let chunkGuard = 50;
  for (;;) {
    if (--chunkGuard < 0) throw new Error("sync: push did not converge");
    const changes: ChangeSet = {};
    const sentRows = new Map<SyncKind, Map<string, ScannedRow>>();
    let collected = 0;
    for (const kind of KIND_ORDER) {
      if (collected >= PUSH_CHUNK) break;
      const rows = await KIND_SPECS[kind].scanDirty(db, PUSH_CHUNK - collected);
      if (rows.length === 0) continue;
      (changes as Record<string, unknown[]>)[kind] = rows.map((r) => r.wire);
      sentRows.set(kind, new Map(rows.map((r) => [r.gid, r])));
      collected += rows.length;
    }
    let graves: { id: number; kind: SyncKind; gid: string }[] = [];
    if (!gravesSent) {
      graves = await db.select<{ id: number; kind: SyncKind; gid: string }[]>(
        "SELECT id, kind, gid FROM sync_graves ORDER BY id LIMIT $1",
        [MAX_GRAVES_PER_PUSH],
      );
      gravesSent = true;
    }

    // A full chunk means more may be waiting — hold the pull until the
    // final chunk so pagination sees one frozen window.
    const isLastChunk = collected < PUSH_CHUNK;
    const resp = await exchange(auth, {
      protocol: SYNC_PROTOCOL_VERSION,
      lastUsn,
      changes,
      graves: graves.map((g): Grave => ({ kind: g.kind, gid: g.gid })),
      mode: isLastChunk ? "normal" : "skip-pull",
    });

    // Remaps first, so cleared/parked bookkeeping and later chunks all
    // see the canonical gids.
    for (const rm of resp.remaps) {
      await KIND_SPECS[rm.kind].remapGid(db, rm.from, rm.to, ctx);
    }
    for (const rj of resp.rejected) {
      const row = sentRows.get(rj.kind)?.get(rj.gid);
      if (row) {
        await row.park(db);
        sentRows.get(rj.kind)?.delete(rj.gid);
        summary.rejected += 1;
      }
    }
    for (const [, rows] of sentRows) {
      for (const [, row] of rows) {
        await row.clear(db);
        summary.pushed += 1;
      }
    }
    for (const g of graves) {
      await db.execute("DELETE FROM sync_graves WHERE id = $1", [g.id]);
    }
    summary.pushed += graves.length;

    if (isLastChunk) {
      firstPullResponse = resp;
      break;
    }
  }

  // ── Pull ────────────────────────────────────────────────────────────
  const ceiling = firstPullResponse.newUsn;
  for (const g of firstPullResponse.graves) {
    await KIND_SPECS[g.kind].applyGrave(db, g.gid, ctx);
    summary.deleted += 1;
  }
  let resp = firstPullResponse;
  for (;;) {
    summary.pulled += await applyChangeSet(db, resp.changes, ctx);
    if (!resp.next) break;
    resp = await exchange(auth, {
      protocol: SYNC_PROTOCOL_VERSION,
      lastUsn,
      pull: resp.next,
    });
  }
  for (const link of ctx.deferred) {
    await KIND_SPECS[link.kind].applyDeferred?.(db, link, ctx);
  }
  await recountPersonalDicts(db);

  await writeSetting(
    db,
    STATE_KEY,
    JSON.stringify({ userId: meta.userId, epoch: meta.epoch, usn: ceiling }),
  );
  await writeSetting(db, LAST_SYNC_KEY, String(Date.now()));

  // Mounted views that subscribe to cloud refreshes re-fetch; the rest
  // pick the new rows up on their next query.
  triggerCloudRefresh();
  return { kind: "ok", summary };
}

async function applyChangeSet(
  db: Db,
  changes: ChangeSet,
  ctx: ApplyCtx,
): Promise<number> {
  let applied = 0;
  for (const kind of KIND_ORDER) {
    const rows = changes[kind];
    if (!rows) continue;
    for (const row of rows) {
      const outcome = await KIND_SPECS[kind].applyChange(
        db,
        row as Record<string, unknown>,
        ctx,
      );
      if (outcome === "inserted" || outcome === "updated") applied += 1;
    }
  }
  return applied;
}

// ── Force modes ───────────────────────────────────────────────────────

/** Replace the cloud with this device: wipe the account's synced rows
 *  server-side (bumping the epoch — other devices are forced into a
 *  full download), then push everything. */
export async function forceUpload(auth: SyncAuth): Promise<SyncOutcome> {
  if (HOSTED || !isTauri()) throw new SyncUnavailableError();
  const db = await getRawDb();
  const meta = await call<SyncMeta>(auth, "/api/v1/sync/v2/meta");
  const wiped = await call<{ usn: number; epoch: number }>(
    auth,
    "/api/v1/sync/v2/wipe",
    {},
  );
  for (const sql of FORCE_MARK_ALL_DIRTY_SQL) await db.execute(sql);
  await writeSetting(
    db,
    STATE_KEY,
    JSON.stringify({ userId: meta.userId, epoch: wiped.epoch, usn: wiped.usn }),
  );
  return syncNow(auth, { acceptMerge: true });
}

/** Replace this device with the cloud: wipe local synced tables (no
 *  graves — these deletions are not user intent) and pull everything. */
export async function forceDownload(auth: SyncAuth): Promise<SyncOutcome> {
  if (HOSTED || !isTauri()) throw new SyncUnavailableError();
  const db = await getRawDb();
  // Never wipe this device against an empty account — a download that
  // has nothing to deliver must not destroy the only copy of the data.
  // (Meta is also the auth/Pro pre-flight, so a bad token fails here
  // before any local write.)
  const meta = await call<SyncMeta>(auth, "/api/v1/sync/v2/meta");
  if (!meta.hasData) {
    throw new Error(
      "This cloud account has no synced data yet — download would only erase this device. Use Upload (or a normal sync) first.",
    );
  }
  for (const sql of FORCE_WIPE_SQL) await db.execute(sql);
  await recountPersonalDicts(db);
  await clearState(db);
  return syncNow(auth, { acceptMerge: true });
}
