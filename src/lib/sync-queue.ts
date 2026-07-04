/**
 * Hosted-variant incremental sync.
 *
 * The desktop app's data lives in SQLite; the hosted variant runs in
 * a browser with an in-memory `fb` store (see db.ts) that can't
 * survive a page refresh. Bridge: every mutation in db.ts marks the
 * changed row dirty here; this module debounces ~1.5s and POSTs the
 * dirty rows to /api/v1/sync/push, which the cloud writes to
 * Postgres. The opposite direction is on-demand: HOSTED reads go
 * straight to the cloud REST API, so there's nothing to seed.
 * (Desktop uses the sync v2 engine in src/lib/sync/ instead — see
 * docs/sync-protocol.md.)
 *
 * Pure no-op in the desktop build — `HOSTED` is constant-folded by
 * Vite (terser drops the dead branches), so this module compiles to
 * empty exports for the desktop binary.
 *
 * Scope: vocab + personal-dict entries + a curated set of settings.
 * Tombstones (deletes) need a server-side delete API and aren't
 * wired yet — deletes still happen locally but won't propagate to
 * cloud. Acceptable for MVP because the hosted variant is browser-
 * only: a full restore on next sign-in re-creates anything that was
 * deleted on the device, so the user notices and can fix it.
 */

import { HOSTED } from "./build-flags";
import type { VocabEntry, VocabStatus } from "./db";

export type SyncAuth = { apiBase: string; token: string };

type VocabPushItem = {
  clientId: string;
  payload: {
    workspaceId: number;
    word: string;
    reading: string | null;
    gloss: string | null;
    status: VocabStatus;
    stability: number;
    difficulty: number;
    dueAt: number | null;
    source: string;
    createdAt: number;
  };
  updatedAt: number;
};

type DictPushItem = {
  clientId: string;
  payload: {
    lang: string;
    word: string;
    altWord: string | null;
    reading: string | null;
    gloss: string;
  };
  updatedAt: number;
};

type SettingPushItem = {
  key: string;
  value: string;
  updatedAt: number;
};

// Debounce: wait 1.5s after the last mutation before flushing. Cap
// the total wait at 5s so a steadily-typing user still gets pushed
// regularly. Retries use exponential backoff capped at 60s.
const DEBOUNCE_MS = 1500;
const MAX_DELAY_MS = 5000;
const RETRY_BASE_MS = 4000;
const RETRY_MAX_MS = 60_000;

// Settings we're willing to sync. A whitelist (not the whole table)
// because settings can also hold device-local state (window position,
// session tokens) that has no business going to the cloud.
const SYNCED_SETTING_KEYS: ReadonlySet<string> = new Set([
  "display.showRuby",
  "display.theme",
  "display.fontSize",
  "study.fsrsWeights",
  "study.lastFocus",
  "tts.config",
  "reader.lastLevel",
  "cloud.lastBackupAt",
  "cloud.lastRestoreAt",
]);

let auth: SyncAuth | null = null;
const pendingVocab = new Map<string, VocabPushItem>();
const pendingDict = new Map<string, DictPushItem>();
const pendingSetting = new Map<string, SettingPushItem>();

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let firstDirtyAt = 0;
let inflight = false;
let consecutiveFailures = 0;
let suspended = false;

/** Tell the queue what cloud to push to. Pass `null` on sign-out to
 *  pause sync (keeps the in-memory dirty set so a re-sign-in resumes). */
export function setSyncAuth(a: SyncAuth | null): void {
  if (!HOSTED) return;
  auth = a;
  if (a) {
    suspended = false;
    consecutiveFailures = 0;
    if (pendingVocab.size + pendingDict.size + pendingSetting.size > 0) {
      scheduleFlush();
    }
  }
}

/** Fully drop pending state. Used by the AuthGate when the account
 *  switches users — we don't want one user's dirty rows pushed under
 *  another user's token. */
export function resetSyncQueue(): void {
  if (!HOSTED) return;
  pendingVocab.clear();
  pendingDict.clear();
  pendingSetting.clear();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  firstDirtyAt = 0;
  consecutiveFailures = 0;
  suspended = false;
}

/** Hook called from db.ts after a successful saveVocab / reviewVocab. */
export function markVocabDirty(v: VocabEntry): void {
  if (!HOSTED) return;
  const clientId = `vocab:${v.workspaceId}:${v.word}`;
  pendingVocab.set(clientId, {
    clientId,
    payload: {
      workspaceId: v.workspaceId,
      word: v.word,
      reading: v.reading ?? null,
      gloss: v.gloss ?? null,
      status: v.status,
      stability: v.stability,
      difficulty: v.difficulty,
      dueAt: v.dueAt ?? null,
      source: v.source,
      createdAt: v.createdAt,
    },
    updatedAt: Date.now(),
  });
  scheduleFlush();
}

/** Hook called from db.ts after a successful addDictEntry. */
export function markDictDirty(input: {
  lang: string;
  word: string;
  altWord?: string | null;
  reading?: string | null;
  gloss: string;
}): void {
  if (!HOSTED) return;
  const clientId = `dict:${input.lang}:${input.word}:${input.altWord ?? ""}`;
  pendingDict.set(clientId, {
    clientId,
    payload: {
      lang: input.lang,
      word: input.word,
      altWord: input.altWord ?? null,
      reading: input.reading ?? null,
      gloss: input.gloss,
    },
    updatedAt: Date.now(),
  });
  scheduleFlush();
}

/** Hook called from db.ts after a successful setSetting. Silently
 *  drops keys not in the whitelist — the caller doesn't need to know. */
export function markSettingDirty(key: string, value: string): void {
  if (!HOSTED) return;
  if (!SYNCED_SETTING_KEYS.has(key)) return;
  pendingSetting.set(key, { key, value, updatedAt: Date.now() });
  scheduleFlush();
}

/** Force a flush right now (UI: "back up now" button). */
export async function flushNow(): Promise<void> {
  if (!HOSTED) return;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  await flush();
}

function scheduleFlush(): void {
  if (suspended || !auth) return;
  if (firstDirtyAt === 0) firstDirtyAt = Date.now();
  if (debounceTimer) clearTimeout(debounceTimer);
  const elapsed = Date.now() - firstDirtyAt;
  const wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_DELAY_MS - elapsed));
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flush();
  }, wait);
}

async function flush(): Promise<void> {
  if (inflight) return;
  if (!auth || suspended) return;
  if (
    pendingVocab.size === 0 &&
    pendingDict.size === 0 &&
    pendingSetting.size === 0
  ) {
    firstDirtyAt = 0;
    return;
  }

  // Snapshot. Mutations during the request stay in the live maps so
  // the next flush picks them up; we only clear snapshotted entries
  // on success and only when their updatedAt still matches (a re-
  // dirty during the request bumped updatedAt, so we'd KEEP that one).
  const vocab = Array.from(pendingVocab.values());
  const dict = Array.from(pendingDict.values());
  const setting = Array.from(pendingSetting.values());

  inflight = true;
  try {
    const res = await fetch(`${auth.apiBase}/api/v1/sync/push`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ vocab, dict, setting }),
    });
    if (!res.ok) {
      consecutiveFailures += 1;
      if (res.status === 401) {
        // Token invalid — pause until setSyncAuth gets called again
        // with a fresh token. Keep the queue contents so they push
        // once we're back online with a valid auth.
        console.warn("sync-queue: 401, suspending until re-auth");
        suspended = true;
        return;
      }
      if (res.status === 402) {
        // Pro required. Hosted is a Pro-only product so this should
        // never happen in normal flows, but if it does we suspend
        // rather than spin.
        console.warn("sync-queue: 402 Pro required, suspending");
        suspended = true;
        return;
      }
      const wait = Math.min(
        RETRY_MAX_MS,
        RETRY_BASE_MS * 2 ** Math.min(consecutiveFailures, 4),
      );
      console.warn(
        `sync-queue: push failed (${res.status}), retrying in ${wait}ms`,
      );
      setTimeout(() => scheduleFlush(), wait);
      return;
    }
    consecutiveFailures = 0;
    for (const v of vocab) {
      const cur = pendingVocab.get(v.clientId);
      if (cur && cur.updatedAt === v.updatedAt) pendingVocab.delete(v.clientId);
    }
    for (const d of dict) {
      const cur = pendingDict.get(d.clientId);
      if (cur && cur.updatedAt === d.updatedAt) pendingDict.delete(d.clientId);
    }
    for (const s of setting) {
      const cur = pendingSetting.get(s.key);
      if (cur && cur.updatedAt === s.updatedAt) pendingSetting.delete(s.key);
    }
    firstDirtyAt = 0;
    if (
      pendingVocab.size + pendingDict.size + pendingSetting.size >
      0
    ) {
      scheduleFlush();
    }
  } catch (err) {
    consecutiveFailures += 1;
    const wait = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * 2 ** Math.min(consecutiveFailures, 4),
    );
    console.warn("sync-queue: push errored, retrying", err);
    setTimeout(() => scheduleFlush(), wait);
  } finally {
    inflight = false;
  }
}

/** Test/debug introspection. Don't rely on this in app code. */
export function getQueueStats(): {
  vocab: number;
  dict: number;
  setting: number;
  inflight: boolean;
  suspended: boolean;
  failures: number;
} {
  return {
    vocab: pendingVocab.size,
    dict: pendingDict.size,
    setting: pendingSetting.size,
    inflight,
    suspended,
    failures: consecutiveFailures,
  };
}
