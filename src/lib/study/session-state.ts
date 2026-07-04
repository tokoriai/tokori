// Per-(workspace, mode) in-progress session snapshot stored in
// localStorage. Saves on every state change while a session is in
// flight; clears when the user finishes or explicitly ends. The
// shape is intentionally JSON-friendly — StageDef carries no
// functions, and we store card IDs (not full VocabEntry blobs) so a
// dictionary edit between save and resume doesn't ship stale data
// back into the runner. Rehydration re-fetches by ID from the
// caller's current vocab pool and silently drops any card the user
// has deleted in the meantime.

import type { VocabEntry } from "@/lib/study/api";

// JSON-storable mirror of the kaniwani plugin's StageDef. We keep
// this loose (Record<string, unknown> for unknown fields) so a
// schema bump in the plugin doesn't crash older snapshots — unknown
// fields ride through round-trip untouched.
export type SnapshotStage = {
  kind: string;
  answerField: string;
  label: string;
  placeholder: string;
  stripTones?: boolean;
  acceptReadingAlternate?: boolean;
};

export type SnapshotTaskRef = {
  cardId: number;
  stageInPlanIdx: number;
};

export type SessionSnapshot<S extends SnapshotStage = SnapshotStage> = {
  /** Schema version. Bump on incompatible structure changes; the
   *  loader throws away anything older than the current version. */
  version: 1;
  workspaceId: number;
  mode: string;
  /** Ordered queue at the time of save (just card IDs). */
  cardIds: number[];
  /** Per-card plan keyed by card id. */
  plans: Record<number, S[]>;
  /** Interleaved task list (card-id + stage-in-plan-idx). */
  tasks: SnapshotTaskRef[];
  /** Pointer into the task list. */
  taskIdx: number;
  /** Per-card mistake counts. */
  mistakesByCardId: Record<number, number>;
  /** Cards waiting on an in-session retest before grading. */
  pendingRegradeCardIds: number[];
  /** Cards already graded — guards against double-grading. */
  gradedCardIds: number[];
  /** Accumulated active session seconds at save time. */
  activeSecs: number;
  /** Wall-clock session start (for the eventual DB session row). */
  startedAt: number;
};

const SCHEMA_VERSION = 1 as const;

function keyFor(workspaceId: number, mode: string): string {
  return `tokori:study-session:${workspaceId}:${mode}`;
}

export function saveSnapshot<S extends SnapshotStage>(snap: SessionSnapshot<S>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      keyFor(snap.workspaceId, snap.mode),
      JSON.stringify(snap),
    );
  } catch {
    // Quota exceeded or storage disabled — recoverable, the live
    // state in memory is still authoritative.
  }
}

export function loadSnapshot<S extends SnapshotStage = SnapshotStage>(
  workspaceId: number,
  mode: string,
): SessionSnapshot<S> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(workspaceId, mode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionSnapshot<S>;
    if (parsed?.version !== SCHEMA_VERSION) return null;
    // Bare structural sanity check — anything weirder than that and we
    // fall back to a fresh session rather than hand the runner a
    // half-broken state.
    if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.cardIds)) return null;
    if (typeof parsed.taskIdx !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSnapshot(workspaceId: number, mode: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(keyFor(workspaceId, mode));
  } catch {
    /* noop */
  }
}

/** Filter a saved snapshot against the caller's current vocab pool.
 *  Returns the surviving cards (in the saved order), the original
 *  snapshot for everything else, and `shrank` so the caller can log
 *  that some cards were dropped. */
export function rehydrate<S extends SnapshotStage>(
  snap: SessionSnapshot<S>,
  vocabById: Map<number, VocabEntry>,
): {
  queue: VocabEntry[];
  snap: SessionSnapshot<S>;
  shrank: boolean;
} | null {
  const survivingIds = snap.cardIds.filter((id) => vocabById.has(id));
  if (survivingIds.length === 0) return null;
  const queue = survivingIds.map((id) => vocabById.get(id)!);
  // Drop tasks pointing at vanished cards. The taskIdx may need to be
  // walked back if the current task itself was dropped — clamp to the
  // first surviving task at/after the original index.
  const tasksKept: SnapshotTaskRef[] = [];
  let newIdx = snap.taskIdx;
  for (let i = 0; i < snap.tasks.length; i++) {
    const t = snap.tasks[i]!;
    if (!vocabById.has(t.cardId)) {
      if (i < snap.taskIdx) newIdx -= 1;
      continue;
    }
    tasksKept.push(t);
  }
  newIdx = Math.max(0, Math.min(tasksKept.length - 1, newIdx));
  const shrank =
    survivingIds.length !== snap.cardIds.length ||
    tasksKept.length !== snap.tasks.length;
  return {
    queue,
    snap: {
      ...snap,
      cardIds: survivingIds,
      tasks: tasksKept,
      taskIdx: newIdx,
    },
    shrank,
  };
}
