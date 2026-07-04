# Sync v2 — AnkiWeb-style incremental sync

Desktop ↔ cloud synchronization for all user data. Replaces the legacy
full-snapshot backup/restore (`/api/v1/sync/{push,pull}`, kept for old
clients) with per-row incremental push/pull, tombstoned deletes, and
last-write-wins conflict resolution — the same shape AnkiWeb uses.

**Code map**

| Piece | Where |
| --- | --- |
| Wire contract (types, kinds, gid helpers) | `src/lib/sync/protocol.ts` and its byte-compatible twin `tokori-cloud/src/lib/sync-v2/protocol.ts` |
| Desktop change tracking (SQLite triggers) | migration v32 in `src-tauri/src/lib.rs` |
| Desktop per-kind SQL manifest | `src/lib/sync/kinds.ts` |
| Desktop engine (`syncNow`, force modes) | `src/lib/sync/engine.ts` |
| Server apply/pull engine | `tokori-cloud/src/lib/sync-v2/exchange.ts` |
| Endpoints | `POST /api/v1/sync/v2/exchange`, `GET /api/v1/sync/v2/meta`, `POST /api/v1/sync/v2/wipe` (all `requireAuthedPro`) |

## Core concepts

- **gid** — client-minted stable identity per row (`guid` column locally,
  `client_id` on the cloud). Random 16-byte hex for new rows; the v32
  backfill reuses the legacy backup's `installUuid:tag:localId` format
  where the old sync pushed one, so first v2 syncs adopt existing cloud
  rows instead of duplicating them. Three kinds compose their gid from
  natural keys instead of storing one: reviews (`vocabGid@reviewedAt`),
  collection words (`collectionGid~vocabGid`), personal-dict entries
  (`lang\x1fword`).
- **mtime** — epoch-ms of the last local edit, maintained by triggers.
  Drives last-write-wins. All other timestamps on the wire are epoch
  seconds.
- **dirty** — `0` clean · `1` needs push · `2` engine-delete marker
  (suppresses the grave trigger) · `-1` parked (server rejected the row;
  any app edit re-dirties it via the update trigger).
- **usn** — per-user monotonic counter on the server (`users.sync_usn`).
  Every exchange stamps the rows it writes with `syncUsn + 1`. A client
  stores the last usn it saw; `usn > lastUsn` is exactly "changed by
  another device since".
- **graves** — tombstones. Local deletes append `(kind, gid)` to
  `sync_graves` (via delete triggers); pushes apply them server-side and
  record them with the new usn so other devices pull the deletions.
- **epoch** — `users.sync_epoch`, bumped by `/wipe` (force-upload).
  A client whose stored epoch mismatches must full-download before it
  can sync again — Anki's "full upload forces full download elsewhere".

## Change tracking (desktop)

SQLite **triggers**, not db.ts instrumentation, maintain gid/mtime/dirty
and graves — so every writer (db.ts, the Rust `api_server` used by MCP,
future code) is tracked automatically:

- `AFTER INSERT WHEN NEW.guid IS NULL` → mint guid, stamp mtime, dirty=1.
- `AFTER UPDATE WHEN mtime, dirty AND guid all unchanged` → stamp mtime,
  dirty=1. Engine writes always change at least one of the three, so
  they never re-dirty; the one exception (re-linking a deferred parent)
  bounces through `dirty=2`.
- `AFTER DELETE WHEN OLD.dirty IS NOT 2` → insert a grave.

`dict_entries` triggers are gated on the owning dictionary being the
"Personal" one, so packaged/custom dictionary installs (100k+ rows) stay
untracked. Settings sync as an allowlist (`SYNCED_SETTING_KEYS`) plus
per-workspace study keys, which travel as `ws:<workspaceGid>|study.<field>`
so local workspace ids never leak across devices.

## The exchange

```
POST /api/v1/sync/v2/exchange
{ protocol: 1, lastUsn, changes: { <kind>: [rows] }, graves: [{kind, gid}],
  mode?: "skip-pull" }            // all but the last push chunk
→ { newUsn, epoch, remaps, rejected, changes, graves, next }

POST /api/v1/sync/v2/exchange     // pull continuation pages
{ protocol: 1, lastUsn, pull: <next cursor from previous response> }
```

Server-side, one interactive transaction per call: apply graves → apply
changes in dependency order (workspaces → collections → vocab → … ) →
stamp `syncUsn = newUsn` → serve the first pull page over the frozen
window `(lastUsn, newUsn]`, excluding `newUsn` itself (what the caller
just pushed). Pagination cursors freeze the window so rows stamped
mid-pagination wait for the next sync.

**Conflicts** are per-row LWW: the server copy wins only when it changed
since the pusher's snapshot (`usn > lastUsn`) *and* its recorded client
edit time is strictly newer. A losing push isn't an error — the winning
row is inside the puller's window and overwrites the client copy in the
same exchange. Re-pushing an identical row (crash retry) is detected by
equal mtime and skipped without usn churn.

**Adoption**: when a pushed gid is unknown but a natural key matches —
workspace `(userId, targetLang)`, vocab `(workspaceId, word)`, collection
`presetId` / the per-workspace default flag / the legacy `client:<gid>`
synthetic preset tag, library `source`, chapter `(itemId, position)`,
personal-dict `(userId, lang, word)`, settings `key` — the row converges
onto the existing one. A row with no clientId claims the incoming gid;
otherwise the pusher receives `remaps: [{kind, from, to}]` and rewrites
its local guid. The desktop applies the same adoption rules on pull, so
independently-created rows never duplicate in either direction.

## Client flow (`syncNow`)

1. `GET /meta` → `{userId, usn, epoch, hasData}`. A userId change resets
   the cursor; an epoch change returns `epoch-mismatch` (UI: confirm →
   `forceDownload`).
2. First sync with data on **both** sides returns `first-sync-choice`
   (UI: Merge / Upload / Download — the Anki question). Merge re-runs
   with `acceptMerge`.
3. Push loop: scan dirty rows kind-by-kind, ≤800 rows per exchange call
   (`skip-pull` until the last chunk), plus all graves on the first call.
   Apply remaps, park rejected rows (`dirty=-1`), clear dirty flags
   (guarded on mtime so mid-flight edits stay dirty), delete pushed
   graves.
4. Pull loop: apply graves, then changes in kind order; follow `next`
   cursors. Missing self-referential parents (collection trees, reader
   simplification variants) are deferred and re-linked at the end.
5. Recount personal-dict `entry_count`, store
   `sync.v2.state = {userId, epoch, usn: ceiling}` and `cloud.lastSyncAt`.

Crash safety: every apply is idempotent and the cursor is saved last, so
a re-run after any failure re-exchanges at most one window.

**Force modes** — `forceUpload` = `/wipe` (bumps epoch) + mark all local
rows dirty + normal sync; `forceDownload` = wipe local synced tables
(marking `dirty=2` first so no graves are recorded) + cursor reset +
pure pull.

## What syncs

All 19 kinds: workspaces, collections, vocab (sans image/audio bytes),
reviews, collection words, library items + chapters, sessions, notes,
goals, habits, chats + messages, journals, reader docs (sans audio/PDF
links), system prompts, translate configs (sans local `provider_id`),
curated + per-workspace-study settings, and personal-dictionary entries
for **every** language (the legacy path hardcoded 7).

Deliberately not synced: packaged/custom dictionary packs
(re-downloadable / bulk data), vocab + reader media bytes (needs media
endpoints — same gap as before), knowledge chunks/embeddings
(desktop-only by design), provider configs (device-local secrets).

## Evolving the protocol

- New column on a synced kind → add to both protocol.ts twins, the kind
  spec (desktop), apply/pull (server). Old clients simply don't send or
  apply it.
- New kind → new entry in `KIND_ORDER` (append; order = FK dependencies),
  a v33+ migration with the trigger trio, a kind spec, server apply/pull
  arms, and Prisma columns (`clientId?`, `clientMtime`, `usn`).
- Breaking change → bump `SYNC_PROTOCOL_VERSION`; the server 400s old
  clients, which prompts an app update.
