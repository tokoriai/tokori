/**
 * Cloud REST client. Imported by `db.ts` only inside `if (HOSTED)`
 * branches — terser dead-strips the entire module out of the desktop
 * bundle because HOSTED is a build-time constant.
 *
 * Auth: every workspace-scoped call carries the bearer token from
 * `cloudAuthToken()`. The token is set by the cloud-context after
 * sign-in; callers should never reach this module before auth has
 * resolved (the AuthGate gates the whole tree).
 *
 * Errors: the wrappers throw `CloudHttpError` on non-2xx responses
 * with the server's JSON `error` field as the message. db.ts catches
 * and decides whether to surface (most calls just rethrow), so we
 * don't paper over server-side problems silently.
 */

import type {
  Chat,
  Collection,
  CollectionSource,
  DictEntry,
  Goal,
  GoalKind,
  GoalSkill,
  JournalEntry,
  JournalState,
  LibraryChapter,
  LibraryItem,
  LibraryKind,
  LibraryStatus,
  Note,
  ReaderDocument,
  ReaderLevel,
  StoredMessage,
  StudySession,
  SystemPrompt,
  TranslateConfig,
  TranslateKind,
  VocabEntry,
  VocabKind,
  VocabReview,
  VocabStatus,
  Workspace,
} from "@/lib/db";
import type { Grade } from "@/lib/fsrs";
import type { LanguageCode } from "@/lib/languages";

// Cloud API base URL. Re-exported from build-flags so every cloud
// HTTP client in the app shares one resolved value.
import { CLOUD_API_BASE as API_BASE } from "./build-flags";

/** Origin to use as the `base` argument of `new URL(path, base)`.
 *  When `API_BASE` is `""` (same-origin / `app:build`), the URL
 *  constructor throws on an empty base — supply the current page's
 *  origin instead so the resulting URL is valid and resolves to the
 *  same host the SPA was loaded from. */
function urlBase(): string {
  return (
    API_BASE ||
    (typeof window !== "undefined" ? window.location.origin : "http://localhost")
  );
}

const TOKEN_STORAGE_KEY = "cloud.account";

/** Pull the bearer token from the persisted CloudAccount blob. We
 *  read from localStorage rather than wiring through React context
 *  so db.ts (a pure module) doesn't need a Provider in scope. */
export function cloudAuthToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string };
    return parsed.token ?? null;
  } catch {
    return null;
  }
}

export class CloudHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CloudHttpError";
    this.status = status;
  }
}

async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = cloudAuthToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

async function expectJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // Body was not JSON — keep the status code as the message.
    }
    throw new CloudHttpError(res.status, msg);
  }
  return (await res.json()) as T;
}

// ── Workspaces ──────────────────────────────────────────────────────

type WireWorkspace = {
  id: number;
  targetLang: string;
  nativeLang: string;
  name: string;
  createdAt: number | null;
};

function fromWireWorkspace(w: WireWorkspace): Workspace {
  return {
    id: w.id,
    targetLang: w.targetLang as LanguageCode,
    nativeLang: w.nativeLang as LanguageCode,
    name: w.name,
    createdAt: w.createdAt ?? 0,
  };
}

export async function cloudListWorkspaces(): Promise<Workspace[]> {
  const data = await expectJson<{ workspaces: WireWorkspace[] }>(
    await authedFetch("/api/v1/workspaces"),
  );
  return data.workspaces.map(fromWireWorkspace);
}

export async function cloudCreateWorkspace(input: {
  targetLang: LanguageCode;
  nativeLang: LanguageCode;
  name?: string;
}): Promise<Workspace> {
  const data = await expectJson<{ workspace: WireWorkspace }>(
    await authedFetch("/api/v1/workspaces", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return fromWireWorkspace(data.workspace);
}

export async function cloudDeleteWorkspace(id: number): Promise<void> {
  const res = await authedFetch(`/api/v1/workspaces/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete workspace ${id} failed`);
  }
}

// ── Vocab ───────────────────────────────────────────────────────────

type WireVocab = {
  id: number;
  workspaceId: number;
  word: string;
  reading: string | null;
  gloss: string | null;
  source: string;
  status: string;
  kind: string;
  stability: number;
  difficulty: number;
  learningStep: number;
  dueAt: number | null;
  lastReview: number | null;
  reviewCount: number;
  createdAt: number | null;
  hasImage: boolean;
  cardNotes: string | null;
  frontExtra: string | null;
  translation: string | null;
  layout: string | null;
  hasAudio: boolean;
  audioMime: string | null;
  isActive: boolean;
};

function fromWireVocab(v: WireVocab): VocabEntry {
  return {
    id: v.id,
    workspaceId: v.workspaceId,
    word: v.word,
    reading: v.reading,
    gloss: v.gloss,
    source: v.source,
    status: v.status as VocabStatus,
    kind: v.kind as VocabKind,
    stability: v.stability,
    difficulty: v.difficulty,
    learningStep: v.learningStep,
    dueAt: v.dueAt,
    lastReview: v.lastReview,
    reviewCount: v.reviewCount,
    createdAt: v.createdAt ?? 0,
    imageData: null,
    hasImage: v.hasImage,
    cardNotes: v.cardNotes,
    frontExtra: v.frontExtra,
    translation: v.translation ?? null,
    layout: v.layout ?? null,
    hasAudio: v.hasAudio,
    audioMime: v.audioMime,
    isActive: v.isActive,
  };
}

export async function cloudListVocab(workspaceId: number): Promise<VocabEntry[]> {
  const data = await expectJson<{ vocab: WireVocab[] }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/vocab`),
  );
  return data.vocab.map(fromWireVocab);
}

export async function cloudSaveVocab(input: {
  workspaceId: number;
  word: string;
  reading?: string | null;
  gloss?: string | null;
  source?: string;
  kind?: VocabKind;
  isActive?: boolean;
  srsState?: {
    status: VocabStatus;
    stability?: number;
    dueAt?: number;
    difficulty?: number;
    learningStep?: number;
    lastReview?: number | null;
    reviewCount?: number;
  };
}): Promise<VocabEntry> {
  const { workspaceId, ...body } = input;
  const data = await expectJson<{ vocab: WireVocab }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/vocab`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return fromWireVocab(data.vocab);
}

export async function cloudUpdateVocab(input: {
  workspaceId: number;
  vocabId: number;
  patch: Partial<{
    word: string;
    reading: string | null;
    gloss: string | null;
    status: VocabStatus;
    kind: VocabKind;
    stability: number;
    difficulty: number;
    learningStep: number;
    dueAt: number | null;
    lastReview: number | null;
    reviewCount: number;
    cardNotes: string | null;
    frontExtra: string | null;
    translation: string | null;
    layout: string | null;
    isActive: boolean;
  }>;
}): Promise<VocabEntry> {
  const data = await expectJson<{ vocab: WireVocab }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/vocab/${input.vocabId}`,
      {
        method: "PATCH",
        body: JSON.stringify(input.patch),
      },
    ),
  );
  return fromWireVocab(data.vocab);
}

export async function cloudDeleteVocab(
  workspaceId: number,
  vocabId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${workspaceId}/vocab/${vocabId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete vocab ${vocabId} failed`);
  }
}

// ── Collections ─────────────────────────────────────────────────────

type WireCollection = {
  id: number;
  workspaceId: number;
  name: string;
  description: string | null;
  isDefault: boolean;
  source: string;
  presetId: string | null;
  parentId: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  wordCount?: number;
};

function fromWireCollection(c: WireCollection): Collection {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    name: c.name,
    description: c.description,
    isDefault: c.isDefault,
    source: c.source as CollectionSource,
    presetId: c.presetId,
    parentId: c.parentId,
    createdAt: c.createdAt ?? 0,
    updatedAt: c.updatedAt ?? 0,
    wordCount: c.wordCount,
  };
}

export async function cloudListCollections(
  workspaceId: number,
): Promise<Collection[]> {
  const data = await expectJson<{ collections: WireCollection[] }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/collections`),
  );
  return data.collections.map(fromWireCollection);
}

export async function cloudCreateCollection(input: {
  workspaceId: number;
  name: string;
  description?: string | null;
  source?: CollectionSource;
  presetId?: string | null;
  parentId?: number | null;
}): Promise<Collection> {
  const { workspaceId, ...body } = input;
  const data = await expectJson<{ collection: WireCollection }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/collections`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return fromWireCollection(data.collection);
}

export async function cloudDeleteCollection(
  workspaceId: number,
  collectionId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${workspaceId}/collections/${collectionId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete collection ${collectionId} failed`);
  }
}

export async function cloudListCollectionWords(
  workspaceId: number,
  collectionId: number,
): Promise<VocabEntry[]> {
  const data = await expectJson<{ words: WireVocab[] }>(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/collections/${collectionId}/words`,
    ),
  );
  return data.words.map(fromWireVocab);
}

// ── Library ─────────────────────────────────────────────────────────

type WireLibraryItem = {
  id: number;
  workspaceId: number;
  kind: string;
  title: string;
  author: string | null;
  source: string | null;
  totalUnits: number | null;
  unitLabel: string;
  completedUnits: number;
  totalSeconds: number;
  status: string;
  coverUrl: string | null;
  notes: string | null;
  createdAt: number | null;
  updatedAt: number | null;
};

function fromWireLibraryItem(l: WireLibraryItem): LibraryItem {
  return {
    id: l.id,
    workspaceId: l.workspaceId,
    kind: l.kind as LibraryKind,
    title: l.title,
    author: l.author,
    source: l.source,
    totalUnits: l.totalUnits,
    unitLabel: l.unitLabel,
    completedUnits: l.completedUnits,
    totalSeconds: l.totalSeconds,
    status: l.status as LibraryStatus,
    coverUrl: l.coverUrl,
    notes: l.notes,
    createdAt: l.createdAt ?? 0,
    updatedAt: l.updatedAt ?? 0,
  };
}

export async function cloudListLibrary(
  workspaceId: number,
): Promise<LibraryItem[]> {
  const data = await expectJson<{ items: WireLibraryItem[] }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/library`),
  );
  return data.items.map(fromWireLibraryItem);
}

export async function cloudSaveLibraryItem(input: {
  workspaceId: number;
  kind: LibraryKind;
  title: string;
  author?: string | null;
  source?: string | null;
  totalUnits?: number | null;
  unitLabel?: string;
  completedUnits?: number;
  totalSeconds?: number;
  status?: LibraryStatus;
  coverUrl?: string | null;
  notes?: string | null;
}): Promise<LibraryItem> {
  const { workspaceId, ...body } = input;
  const data = await expectJson<{ item: WireLibraryItem }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/library`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return fromWireLibraryItem(data.item);
}

export async function cloudDeleteLibraryItem(
  workspaceId: number,
  itemId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${workspaceId}/library/${itemId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete library item ${itemId} failed`);
  }
}

// ── Chapters ────────────────────────────────────────────────────────

type WireChapter = {
  id: number;
  itemId: number;
  position: number;
  title: string;
  completedAt: number | null;
  notes: string | null;
  collectionId: number | null;
  createdAt: number | null;
};

function fromWireChapter(c: WireChapter): LibraryChapter {
  return {
    id: c.id,
    itemId: c.itemId,
    position: c.position,
    title: c.title,
    completedAt: c.completedAt,
    notes: c.notes,
    collectionId: c.collectionId,
    createdAt: c.createdAt ?? 0,
  };
}

export async function cloudListChapters(
  workspaceId: number,
  itemId: number,
): Promise<LibraryChapter[]> {
  const data = await expectJson<{ chapters: WireChapter[] }>(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/library/${itemId}/chapters`,
    ),
  );
  return data.chapters.map(fromWireChapter);
}

// ── Notes ───────────────────────────────────────────────────────────

type WireNote = {
  id: number;
  workspaceId: number;
  clientId: string | null;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: number | null;
  updatedAt: number | null;
};

function fromWireNote(n: WireNote): Note {
  return {
    id: n.id,
    workspaceId: n.workspaceId,
    clientId: n.clientId,
    title: n.title,
    body: n.body,
    pinned: n.pinned,
    createdAt: n.createdAt ?? 0,
    updatedAt: n.updatedAt ?? 0,
  };
}

export async function cloudListNotes(workspaceId: number): Promise<Note[]> {
  const data = await expectJson<{ notes: WireNote[] }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/notes`),
  );
  return data.notes.map(fromWireNote);
}

// ── Goals ───────────────────────────────────────────────────────────

type WireGoal = {
  id: number;
  workspaceId: number;
  clientId: string | null;
  title: string;
  kind: string;
  skill: string | null;
  target: number;
  deadline: number | null;
  createdAt: number | null;
  completedAt: number | null;
};

function fromWireGoal(g: WireGoal): Goal {
  return {
    id: g.id,
    workspaceId: g.workspaceId,
    clientId: g.clientId,
    title: g.title,
    kind: g.kind as GoalKind,
    skill: g.skill as GoalSkill,
    target: g.target,
    deadline: g.deadline,
    createdAt: g.createdAt ?? 0,
    completedAt: g.completedAt,
  };
}

export async function cloudListGoals(workspaceId: number): Promise<Goal[]> {
  const data = await expectJson<{ goals: WireGoal[] }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/goals`),
  );
  return data.goals.map(fromWireGoal);
}

// ── Sessions ────────────────────────────────────────────────────────

type WireSession = {
  id: number;
  workspaceId: number;
  clientId: string | null;
  kind: string;
  startedAt: number | null;
  endedAt: number | null;
  durationSecs: number | null;
  wordsSeen: number;
  wordsSaved: number;
  notes: string | null;
};

function fromWireSession(s: WireSession): StudySession {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    clientId: s.clientId,
    kind: s.kind,
    startedAt: s.startedAt ?? 0,
    endedAt: s.endedAt,
    durationSecs: s.durationSecs,
    wordsSeen: s.wordsSeen,
    wordsSaved: s.wordsSaved,
    notes: s.notes,
  };
}

export async function cloudListSessions(
  workspaceId: number,
): Promise<StudySession[]> {
  const data = await expectJson<{ sessions: WireSession[] }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/sessions`),
  );
  return data.sessions.map(fromWireSession);
}

// ── Vocab extras (reviews / admin / due) ────────────────────────────

type WireVocabReview = {
  id: number;
  vocabId: number;
  grade: string;
  newDueAt: number | null;
  newStability: number | null;
  reviewedAt: number | null;
};

function fromWireReview(r: WireVocabReview): VocabReview {
  // Desktop's VocabReview carries prev/new pairs; the cloud only
  // tracks the post-state because no surface today reads the
  // before-state. Fill prev* with the same value so consumers that
  // diff them silently get a no-op. `newStability` is optional in
  // the cloud payload — fall back to 0 to match the desktop's
  // non-null contract.
  const stability = r.newStability ?? 0;
  return {
    id: r.id,
    vocabId: r.vocabId,
    grade: r.grade as Grade,
    prevStatus: "review" as VocabStatus,
    newStatus: "review" as VocabStatus,
    prevStability: stability,
    newStability: stability,
    prevDueAt: r.newDueAt,
    newDueAt: r.newDueAt,
    reviewedAt: r.reviewedAt ?? 0,
  };
}

export async function cloudListWorkspaceReviews(
  workspaceId: number,
  since?: number,
): Promise<VocabReview[]> {
  const url = new URL(
    `/api/v1/workspaces/${workspaceId}/vocab/reviews`,
    urlBase(),
  );
  if (since != null) url.searchParams.set("since", String(since));
  const data = await expectJson<{ reviews: WireVocabReview[]; hasMore: boolean }>(
    await authedFetch(url.pathname + url.search),
  );
  return data.reviews.map(fromWireReview);
}

/** Fetch the single most-recent VocabReview's `reviewedAt`. Used by
 *  the desktop sync's incremental cursor — one tiny query lets us
 *  skip every local review older than the cloud's watermark. Returns
 *  0 when the cloud has no reviews for this workspace yet. */
export async function cloudLatestReviewedAt(
  workspaceId: number,
): Promise<number> {
  const url = new URL(
    `/api/v1/workspaces/${workspaceId}/vocab/reviews`,
    urlBase(),
  );
  url.searchParams.set("latest", "1");
  const data = await expectJson<{ reviews: WireVocabReview[] }>(
    await authedFetch(url.pathname + url.search),
  );
  const row = data.reviews[0];
  return row?.reviewedAt ?? 0;
}

export async function cloudBulkImportReviews(
  workspaceId: number,
  items: {
    word: string;
    grade: string;
    reviewedAt: number;
    newDueAt: number | null;
    stability: number | null;
    difficulty: number | null;
  }[],
): Promise<{ inserted: number; skipped: number }> {
  return expectJson(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/vocab/reviews`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  );
}

export async function cloudReviewVocab(input: {
  workspaceId: number;
  vocabId: number;
  status: VocabStatus;
  stability: number;
  difficulty: number;
  learningStep: number;
  dueAt: number | null;
  grade?: Grade;
  reviewedAt?: number;
}): Promise<void> {
  const { workspaceId, vocabId, ...body } = input;
  await expectJson(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/vocab/${vocabId}/reviews`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  );
}

export async function cloudActivateVocab(
  workspaceId: number,
  ids: number[],
): Promise<number> {
  const data = await expectJson<{ updated: number }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/vocab/activate`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  );
  return data.updated;
}

export async function cloudWipeWorkspaceVocab(workspaceId: number): Promise<number> {
  const data = await expectJson<{ deleted: number }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/vocab/wipe`, {
      method: "POST",
    }),
  );
  return data.deleted;
}

export async function cloudActivationSummary(workspaceId: number): Promise<{
  active: number;
  library: number;
  total: number;
}> {
  return expectJson(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/vocab/activation-summary`,
    ),
  );
}

export async function cloudListDueVocab(
  workspaceId: number,
  limit = 50,
): Promise<VocabEntry[]> {
  const data = await expectJson<{ vocab: WireVocab[] }>(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/vocab/due?limit=${limit}`,
    ),
  );
  return data.vocab.map(fromWireVocab);
}

// ── Sessions (writes) ───────────────────────────────────────────────

type WireSessionPatch = Partial<{
  kind: string;
  endedAt: number | null;
  durationSecs: number | null;
  wordsSeen: number;
  wordsSaved: number;
  notes: string | null;
  bump: { wordsSeen?: number; wordsSaved?: number };
}>;

export async function cloudCreateSession(input: {
  workspaceId: number;
  kind?: string;
  startedAt?: number;
  endedAt?: number | null;
  durationSecs?: number | null;
  wordsSeen?: number;
  wordsSaved?: number;
  notes?: string | null;
  /** Optional stable id from sync; cloud upserts on (userId, clientId). */
  clientId?: string | null;
}): Promise<StudySession> {
  const { workspaceId, ...body } = input;
  const data = await expectJson<{ session: WireSession }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/sessions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return fromWireSession(data.session);
}

export async function cloudUpdateSession(input: {
  workspaceId: number;
  sessionId: number;
  patch: WireSessionPatch;
}): Promise<StudySession> {
  const data = await expectJson<{ session: WireSession }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/sessions/${input.sessionId}`,
      { method: "PATCH", body: JSON.stringify(input.patch) },
    ),
  );
  return fromWireSession(data.session);
}

export async function cloudDeleteSession(
  workspaceId: number,
  sessionId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${workspaceId}/sessions/${sessionId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete session ${sessionId} failed`);
  }
}

// ── Notes (writes) ──────────────────────────────────────────────────

export async function cloudCreateNote(input: {
  workspaceId: number;
  title?: string;
  body?: string;
  pinned?: boolean;
  clientId?: string | null;
}): Promise<Note> {
  const { workspaceId, ...body } = input;
  const data = await expectJson<{ note: WireNote }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/notes`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return fromWireNote(data.note);
}

export async function cloudUpdateNote(input: {
  workspaceId: number;
  noteId: number;
  patch: Partial<{ title: string; body: string; pinned: boolean }>;
}): Promise<Note> {
  const data = await expectJson<{ note: WireNote }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/notes/${input.noteId}`,
      { method: "PATCH", body: JSON.stringify(input.patch) },
    ),
  );
  return fromWireNote(data.note);
}

export async function cloudDeleteNote(
  workspaceId: number,
  noteId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete note ${noteId} failed`);
  }
}

// ── Goals (writes) ──────────────────────────────────────────────────

export async function cloudCreateGoal(input: {
  workspaceId: number;
  title: string;
  kind: GoalKind;
  skill?: GoalSkill;
  target: number;
  deadline?: number | null;
  completedAt?: number | null;
  clientId?: string | null;
}): Promise<Goal> {
  const { workspaceId, ...body } = input;
  const data = await expectJson<{ goal: WireGoal }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/goals`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return fromWireGoal(data.goal);
}

export async function cloudUpdateGoal(input: {
  workspaceId: number;
  goalId: number;
  patch: Partial<{
    title: string;
    target: number;
    deadline: number | null;
    completed: boolean;
  }>;
}): Promise<Goal> {
  const data = await expectJson<{ goal: WireGoal }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/goals/${input.goalId}`,
      { method: "PATCH", body: JSON.stringify(input.patch) },
    ),
  );
  return fromWireGoal(data.goal);
}

export async function cloudDeleteGoal(
  workspaceId: number,
  goalId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${workspaceId}/goals/${goalId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete goal ${goalId} failed`);
  }
}

// ── Library bump + chapter writes ───────────────────────────────────

export async function cloudUpdateLibraryItem(input: {
  workspaceId: number;
  itemId: number;
  patch: Partial<{
    kind: LibraryKind;
    title: string;
    author: string | null;
    totalUnits: number | null;
    unitLabel: string;
    completedUnits: number;
    totalSeconds: number;
    status: LibraryStatus;
    coverUrl: string | null;
    notes: string | null;
    bump: { deltaUnits?: number; deltaSeconds?: number };
  }>;
}): Promise<LibraryItem> {
  const data = await expectJson<{ item: WireLibraryItem }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/library/${input.itemId}`,
      { method: "PATCH", body: JSON.stringify(input.patch) },
    ),
  );
  return fromWireLibraryItem(data.item);
}

export async function cloudCreateChapter(input: {
  workspaceId: number;
  itemId: number;
  title: string;
  position?: number;
}): Promise<LibraryChapter> {
  const { workspaceId, itemId, ...body } = input;
  const data = await expectJson<{ chapter: WireChapter }>(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/library/${itemId}/chapters`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  );
  return fromWireChapter(data.chapter);
}

export async function cloudUpdateChapter(input: {
  workspaceId: number;
  itemId: number;
  chapterId: number;
  patch: Partial<{
    title: string;
    completedAt: number | null;
    notes: string | null;
    collectionId: number | null;
    position: number;
  }>;
}): Promise<LibraryChapter> {
  const data = await expectJson<{ chapter: WireChapter }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/library/${input.itemId}/chapters/${input.chapterId}`,
      { method: "PATCH", body: JSON.stringify(input.patch) },
    ),
  );
  return fromWireChapter(data.chapter);
}

export async function cloudDeleteChapter(input: {
  workspaceId: number;
  itemId: number;
  chapterId: number;
}): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${input.workspaceId}/library/${input.itemId}/chapters/${input.chapterId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete chapter ${input.chapterId} failed`);
  }
}

/** PATCH by chapter id alone — used when the caller only has the id
 *  (desktop's `updateChapter(id, patch)`). Ownership resolves through
 *  the row's userId on the server. */
export async function cloudUpdateChapterById(
  chapterId: number,
  patch: Partial<{
    title: string;
    completedAt: number | null;
    notes: string | null;
    collectionId: number | null;
    position: number;
  }>,
): Promise<LibraryChapter> {
  const data = await expectJson<{ chapter: WireChapter }>(
    await authedFetch(`/api/v1/chapters/${chapterId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  );
  return fromWireChapter(data.chapter);
}

/** DELETE by chapter id alone. */
export async function cloudDeleteChapterById(chapterId: number): Promise<void> {
  const res = await authedFetch(`/api/v1/chapters/${chapterId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete chapter ${chapterId} failed`);
  }
}

// ── Collections (writes + completions) ──────────────────────────────

export async function cloudUpdateCollection(input: {
  workspaceId: number;
  collectionId: number;
  patch: Partial<{ name: string; description: string | null; parentId: number | null }>;
}): Promise<Collection> {
  const data = await expectJson<{ collection: WireCollection }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/collections/${input.collectionId}`,
      { method: "PATCH", body: JSON.stringify(input.patch) },
    ),
  );
  return fromWireCollection(data.collection);
}

export async function cloudGetOrCreateDefaultCollection(
  workspaceId: number,
): Promise<Collection> {
  const data = await expectJson<{ collection: WireCollection }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/collections/default`),
  );
  return fromWireCollection(data.collection);
}

export async function cloudAddWordToCollection(input: {
  workspaceId: number;
  collectionId: number;
  word: string;
  reading?: string | null;
  gloss?: string | null;
  isActive?: boolean;
}): Promise<{ id: number; word: string; reading: string | null; gloss: string | null }> {
  const { workspaceId, collectionId, ...body } = input;
  const data = await expectJson<{
    vocab: { id: number; word: string; reading: string | null; gloss: string | null };
  }>(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/collections/${collectionId}/words`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  );
  return data.vocab;
}

export async function cloudBulkAddToCollection(input: {
  workspaceId: number;
  collectionId: number;
  words: { word: string; reading?: string | null; gloss?: string | null }[];
  isActive?: boolean;
}): Promise<number> {
  const { workspaceId, collectionId, ...body } = input;
  const data = await expectJson<{ added: number }>(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/collections/${collectionId}/words/bulk`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  );
  return data.added;
}

export async function cloudRemoveWordFromCollection(input: {
  workspaceId: number;
  collectionId: number;
  vocabId: number;
}): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${input.workspaceId}/collections/${input.collectionId}/words?vocabId=${input.vocabId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `remove vocab ${input.vocabId} failed`);
  }
}

export async function cloudCollectionsForVocab(
  workspaceId: number,
  vocabId: number,
): Promise<Collection[]> {
  const data = await expectJson<{ collections: WireCollection[] }>(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/vocab/${vocabId}/collections`,
    ),
  );
  return data.collections.map(fromWireCollection);
}

// ── Chats + messages ────────────────────────────────────────────────

type WireChat = {
  id: number;
  workspaceId: number;
  clientId: string | null;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount?: number;
};

function fromWireChat(c: WireChat): Chat {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    clientId: c.clientId,
    title: c.title,
    createdAt: c.createdAt ?? 0,
    updatedAt: c.updatedAt ?? 0,
    messageCount: c.messageCount,
  };
}

export async function cloudListChats(workspaceId: number): Promise<Chat[]> {
  const data = await expectJson<{ chats: WireChat[] }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/chats`),
  );
  return data.chats.map(fromWireChat);
}

export async function cloudCreateChat(
  workspaceId: number,
  title?: string,
  clientId?: string | null,
): Promise<Chat> {
  const data = await expectJson<{ chat: WireChat }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/chats`, {
      method: "POST",
      body: JSON.stringify({ title, clientId }),
    }),
  );
  return fromWireChat(data.chat);
}

export async function cloudUpdateChat(input: {
  workspaceId: number;
  chatId: number;
  patch: { title?: string; touch?: boolean };
}): Promise<Chat> {
  const data = await expectJson<{ chat: WireChat }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/chats/${input.chatId}`,
      { method: "PATCH", body: JSON.stringify(input.patch) },
    ),
  );
  return fromWireChat(data.chat);
}

export async function cloudDeleteChat(
  workspaceId: number,
  chatId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${workspaceId}/chats/${chatId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete chat ${chatId} failed`);
  }
}

type WireMessage = {
  id: number;
  chatId: number;
  clientId: string | null;
  role: string;
  content: string;
  createdAt: number | null;
};

function fromWireMessage(m: WireMessage): StoredMessage {
  return {
    id: m.id,
    chatId: m.chatId,
    clientId: m.clientId,
    role: m.role as StoredMessage["role"],
    content: m.content,
    createdAt: m.createdAt ?? 0,
  };
}

export async function cloudListMessages(
  workspaceId: number,
  chatId: number,
): Promise<StoredMessage[]> {
  const data = await expectJson<{ messages: WireMessage[] }>(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/chats/${chatId}/messages`,
    ),
  );
  return data.messages.map(fromWireMessage);
}

export async function cloudAddMessage(input: {
  workspaceId: number;
  chatId: number;
  role: "user" | "assistant" | "system";
  content: string;
  clientId?: string | null;
}): Promise<StoredMessage> {
  const { workspaceId, chatId, ...body } = input;
  const data = await expectJson<{ message: WireMessage }>(
    await authedFetch(
      `/api/v1/workspaces/${workspaceId}/chats/${chatId}/messages`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  );
  return fromWireMessage(data.message);
}

export async function cloudUpdateMessage(input: {
  workspaceId: number;
  chatId: number;
  messageId: number;
  content: string;
}): Promise<StoredMessage> {
  const data = await expectJson<{ message: WireMessage }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/chats/${input.chatId}/messages/${input.messageId}`,
      { method: "PATCH", body: JSON.stringify({ content: input.content }) },
    ),
  );
  return fromWireMessage(data.message);
}

/** Update a message by id alone (no workspace/chat scope). Backs
 *  desktop's `updateMessageContent(id, content)` whose call sites
 *  don't carry the surrounding scope. The cloud route resolves
 *  ownership through `message.userId`. */
export async function cloudUpdateMessageById(
  messageId: number,
  content: string,
): Promise<StoredMessage> {
  const data = await expectJson<{ message: WireMessage }>(
    await authedFetch(`/api/v1/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }),
  );
  return fromWireMessage(data.message);
}

// ── Journals ────────────────────────────────────────────────────────

type WireJournal = {
  id: number;
  workspaceId: number;
  clientId: string | null;
  title: string;
  topic: string | null;
  body: string;
  state: string;
  corrections: string | null;
  source: string | null;
  createdAt: number | null;
  updatedAt: number | null;
};

function fromWireJournal(j: WireJournal): JournalEntry {
  // Desktop's JournalEntry decodes `corrections` and `source` from
  // their stored TEXT form on read. The cloud carries them as strings
  // too, so we parse once here for consumer convenience.
  let corrections: JournalEntry["corrections"] = null;
  if (j.corrections) {
    try {
      corrections = JSON.parse(j.corrections) as JournalEntry["corrections"];
    } catch {
      corrections = null;
    }
  }
  let source: JournalEntry["source"] = null;
  if (j.source) {
    try {
      source = JSON.parse(j.source) as JournalEntry["source"];
    } catch {
      source = j.source as JournalEntry["source"];
    }
  }
  return {
    id: j.id,
    workspaceId: j.workspaceId,
    clientId: j.clientId,
    title: j.title,
    topic: j.topic,
    body: j.body,
    state: j.state as JournalState,
    corrections,
    source,
    createdAt: j.createdAt ?? 0,
    updatedAt: j.updatedAt ?? 0,
  };
}

export async function cloudListJournals(
  workspaceId: number,
): Promise<JournalEntry[]> {
  const data = await expectJson<{ journals: WireJournal[] }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/journals`),
  );
  return data.journals.map(fromWireJournal);
}

export async function cloudGetJournal(
  workspaceId: number,
  journalId: number,
): Promise<JournalEntry | null> {
  const res = await authedFetch(
    `/api/v1/workspaces/${workspaceId}/journals/${journalId}`,
  );
  if (res.status === 404) return null;
  const data = await expectJson<{ journal: WireJournal }>(res);
  return fromWireJournal(data.journal);
}

export async function cloudCreateJournal(input: {
  workspaceId: number;
  title: string;
  topic?: string | null;
  body?: string;
  state?: JournalState;
  corrections?: string | null;
  source?: string | null;
  clientId?: string | null;
}): Promise<JournalEntry> {
  const { workspaceId, ...body } = input;
  const data = await expectJson<{ journal: WireJournal }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/journals`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return fromWireJournal(data.journal);
}

export async function cloudUpdateJournal(input: {
  workspaceId: number;
  journalId: number;
  patch: Partial<{
    title: string;
    topic: string | null;
    body: string;
    state: JournalState;
    corrections: string | null;
    source: string | null;
  }>;
}): Promise<JournalEntry> {
  const data = await expectJson<{ journal: WireJournal }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/journals/${input.journalId}`,
      { method: "PATCH", body: JSON.stringify(input.patch) },
    ),
  );
  return fromWireJournal(data.journal);
}

export async function cloudDeleteJournal(
  workspaceId: number,
  journalId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${workspaceId}/journals/${journalId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete journal ${journalId} failed`);
  }
}

// ── Reader docs ─────────────────────────────────────────────────────

type WireReaderDoc = {
  id: number;
  workspaceId: number;
  clientId: string | null;
  title: string;
  body: string;
  sourceUrl: string | null;
  parentId: number | null;
  level: string;
  libraryItemId: number | null;
  chapterPosition: number | null;
  hasAudio: boolean;
  audioMime: string | null;
  createdAt: number | null;
  updatedAt: number | null;
};

function fromWireReaderDoc(d: WireReaderDoc): ReaderDocument {
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    clientId: d.clientId,
    title: d.title,
    body: d.body,
    sourceUrl: d.sourceUrl,
    parentId: d.parentId,
    level: d.level as ReaderLevel,
    libraryItemId: d.libraryItemId,
    chapterPosition: d.chapterPosition,
    // The page-overlay reader is desktop-only; cloud reader docs are text.
    sourceDocumentId: null,
    pageStart: null,
    pageEnd: null,
    hasAudio: d.hasAudio,
    audioMime: d.audioMime,
    createdAt: d.createdAt ?? 0,
    updatedAt: d.updatedAt ?? 0,
  };
}

type ReaderListFilter = {
  parentId?: number | null;
  libraryItemId?: number;
};

export async function cloudListReaderDocs(
  workspaceId: number,
  filter: ReaderListFilter = {},
): Promise<ReaderDocument[]> {
  const url = new URL(`/api/v1/workspaces/${workspaceId}/reader-docs`, urlBase());
  if (filter.parentId != null) url.searchParams.set("parentId", String(filter.parentId));
  if (filter.libraryItemId != null) url.searchParams.set("libraryItemId", String(filter.libraryItemId));
  const data = await expectJson<{ docs: WireReaderDoc[] }>(
    await authedFetch(url.pathname + url.search),
  );
  return data.docs.map(fromWireReaderDoc);
}

export async function cloudSaveReaderDoc(input: {
  workspaceId: number;
  id?: number;
  title: string;
  body?: string;
  sourceUrl?: string | null;
  parentId?: number | null;
  level?: ReaderLevel;
  libraryItemId?: number | null;
  chapterPosition?: number | null;
  clientId?: string | null;
}): Promise<ReaderDocument> {
  const { workspaceId, id, ...body } = input;
  if (id) {
    const data = await expectJson<{ doc: WireReaderDoc }>(
      await authedFetch(
        `/api/v1/workspaces/${workspaceId}/reader-docs/${id}`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    );
    return fromWireReaderDoc(data.doc);
  }
  const data = await expectJson<{ doc: WireReaderDoc }>(
    await authedFetch(`/api/v1/workspaces/${workspaceId}/reader-docs`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return fromWireReaderDoc(data.doc);
}

export async function cloudDeleteReaderDoc(
  workspaceId: number,
  docId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/workspaces/${workspaceId}/reader-docs/${docId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete reader doc ${docId} failed`);
  }
}

// ── System prompts ──────────────────────────────────────────────────

type WireSystemPrompt = {
  id: number;
  clientId: string | null;
  name: string;
  body: string;
  isDefault: boolean;
  createdAt: number | null;
};

function fromWireSystemPrompt(p: WireSystemPrompt): SystemPrompt {
  return {
    id: p.id,
    clientId: p.clientId,
    name: p.name,
    body: p.body,
    isDefault: p.isDefault,
    createdAt: p.createdAt ?? 0,
  };
}

export async function cloudListSystemPrompts(): Promise<SystemPrompt[]> {
  const data = await expectJson<{ prompts: WireSystemPrompt[] }>(
    await authedFetch(`/api/v1/system-prompts`),
  );
  return data.prompts.map(fromWireSystemPrompt);
}

export async function cloudSaveSystemPrompt(input: {
  id?: number;
  name: string;
  body: string;
  isDefault?: boolean;
  clientId?: string | null;
}): Promise<SystemPrompt> {
  const data = await expectJson<{ prompt: WireSystemPrompt }>(
    await authedFetch(`/api/v1/system-prompts`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return fromWireSystemPrompt(data.prompt);
}

export async function cloudDeleteSystemPrompt(promptId: number): Promise<void> {
  const res = await authedFetch(`/api/v1/system-prompts/${promptId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete prompt ${promptId} failed`);
  }
}

// ── Translate configs ───────────────────────────────────────────────

type WireTranslateConfig = {
  id: number;
  clientId: string | null;
  kind: string;
  label: string;
  apiKey: string | null;
  secondaryKey: string | null;
  baseUrl: string | null;
  providerId: number | null;
  model: string | null;
  isDefault: boolean;
  createdAt: number | null;
};

function fromWireTranslateConfig(c: WireTranslateConfig): TranslateConfig {
  return {
    id: c.id,
    clientId: c.clientId,
    kind: c.kind as TranslateKind,
    label: c.label,
    apiKey: c.apiKey,
    secondaryKey: c.secondaryKey,
    baseUrl: c.baseUrl,
    providerId: c.providerId,
    model: c.model,
    isDefault: c.isDefault,
    createdAt: c.createdAt ?? 0,
  };
}

export async function cloudListTranslateConfigs(): Promise<TranslateConfig[]> {
  const data = await expectJson<{ configs: WireTranslateConfig[] }>(
    await authedFetch(`/api/v1/translate-configs`),
  );
  return data.configs.map(fromWireTranslateConfig);
}

export async function cloudSaveTranslateConfig(input: {
  id?: number;
  kind: TranslateKind;
  label: string;
  apiKey?: string | null;
  secondaryKey?: string | null;
  baseUrl?: string | null;
  providerId?: number | null;
  model?: string | null;
  isDefault?: boolean;
  clientId?: string | null;
}): Promise<TranslateConfig> {
  const data = await expectJson<{ config: WireTranslateConfig }>(
    await authedFetch(`/api/v1/translate-configs`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return fromWireTranslateConfig(data.config);
}

export async function cloudDeleteTranslateConfig(configId: number): Promise<void> {
  const res = await authedFetch(`/api/v1/translate-configs/${configId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete translate config ${configId} failed`);
  }
}

// ── Settings ────────────────────────────────────────────────────────
//
// A small set of "bootstrap" setting keys never leave the browser even
// in HOSTED mode. They have to live in localStorage because they're
// read BEFORE auth resolves — sending them to the cloud's
// `/api/v1/settings` would 401 since the token they encode hasn't
// landed yet. The cloud-context's account blob is the canonical
// example: storing it via setSetting → cloudSetSetting → POST would
// chicken-and-egg the very token the POST needs.
//
// Anything not in this list goes through the API as usual.
const LOCAL_BOOTSTRAP_KEYS: ReadonlySet<string> = new Set([
  "cloud.account",
  "cloud.tier",
]);

const LOCAL_BOOTSTRAP_LS_PREFIX = "tokori.setting.";

function localSettingKey(key: string): string {
  // localStorage has a flat namespace; prefix to avoid collisions
  // with whatever else the app stores. The cloud.account entry is the
  // exception — cloudAuthToken() already reads it from
  // `localStorage["cloud.account"]` directly, so we mirror that
  // key shape rather than prefix it.
  if (key === "cloud.account" || key === "cloud.tier") return key;
  return `${LOCAL_BOOTSTRAP_LS_PREFIX}${key}`;
}

export async function cloudGetSettings(
  keys?: string[],
): Promise<Record<string, string>> {
  // Split the keys into bootstrap (read from localStorage) and
  // server-side (one round-trip to /api/v1/settings).
  const wanted = keys && keys.length > 0 ? keys : null;
  const local: Record<string, string> = {};
  const remoteKeys: string[] | null = wanted ? [] : null;
  if (wanted) {
    for (const k of wanted) {
      if (LOCAL_BOOTSTRAP_KEYS.has(k)) {
        try {
          const v = localStorage.getItem(localSettingKey(k));
          if (v != null) local[k] = v;
        } catch {
          /* private mode / quota — skip */
        }
      } else {
        remoteKeys!.push(k);
      }
    }
    // If the caller only asked for bootstrap keys, don't even hit the
    // API — saves a round-trip on every page load.
    if (remoteKeys!.length === 0) return local;
  }

  const url = new URL(`/api/v1/settings`, urlBase());
  if (remoteKeys && remoteKeys.length > 0) {
    url.searchParams.set("keys", remoteKeys.join(","));
  }
  try {
    const data = await expectJson<{ settings: Record<string, string> }>(
      await authedFetch(url.pathname + url.search),
    );
    return { ...data.settings, ...local };
  } catch (err) {
    // 401 / 402 before auth resolves is expected — return whatever
    // bootstrap keys we managed to read locally. The caller treats
    // missing values as null.
    if (
      err instanceof CloudHttpError &&
      (err.status === 401 || err.status === 402)
    ) {
      return local;
    }
    throw err;
  }
}

export async function cloudSetSetting(key: string, value: string): Promise<void> {
  if (LOCAL_BOOTSTRAP_KEYS.has(key)) {
    // Bootstrap keys never hit the API — they're written to the
    // browser's localStorage so they survive a reload + are readable
    // by `cloudAuthToken()` synchronously on next module load.
    try {
      localStorage.setItem(localSettingKey(key), value);
    } catch {
      /* private mode / quota — silently swallow; the user will be
         asked to sign in again next session, which is the right
         degraded behaviour. */
    }
    return;
  }
  await expectJson(
    await authedFetch(`/api/v1/settings`, {
      method: "POST",
      body: JSON.stringify({ key, value }),
    }),
  );
}

// ── Personal dictionary ─────────────────────────────────────────────

type WirePersonalEntry = {
  id: number;
  word: string;
  altWord: string | null;
  reading: string | null;
  gloss: string;
};

export async function cloudListPersonalDictEntries(
  lang: string,
): Promise<(DictEntry & { id: number })[]> {
  const data = await expectJson<{ entries: WirePersonalEntry[] }>(
    await authedFetch(`/api/v1/personal-dict/${encodeURIComponent(lang)}/entries`),
  );
  // Carry the row id through — by-word edit/delete (the popover's
  // "Reset to original") resolves the id from this list before hitting
  // the by-id endpoints.
  return data.entries.map((e) => ({
    id: e.id,
    word: e.word,
    altWord: e.altWord,
    reading: e.reading,
    gloss: e.gloss,
  }));
}

export async function cloudAddPersonalDictEntry(input: {
  lang: string;
  word: string;
  altWord?: string | null;
  reading?: string | null;
  gloss: string;
}): Promise<DictEntry> {
  const { lang, ...body } = input;
  const data = await expectJson<{ entry: WirePersonalEntry }>(
    await authedFetch(
      `/api/v1/personal-dict/${encodeURIComponent(lang)}/entries`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  );
  return {
    word: data.entry.word,
    altWord: data.entry.altWord,
    reading: data.entry.reading,
    gloss: data.entry.gloss,
  };
}

export async function cloudUpdatePersonalDictEntry(input: {
  lang: string;
  entryId: number;
  patch: Partial<{ word: string; altWord: string | null; reading: string | null; gloss: string }>;
}): Promise<DictEntry> {
  const data = await expectJson<{ entry: WirePersonalEntry }>(
    await authedFetch(
      `/api/v1/personal-dict/${encodeURIComponent(input.lang)}/entries/${input.entryId}`,
      { method: "PATCH", body: JSON.stringify(input.patch) },
    ),
  );
  return {
    word: data.entry.word,
    altWord: data.entry.altWord,
    reading: data.entry.reading,
    gloss: data.entry.gloss,
  };
}

export async function cloudDeletePersonalDictEntry(
  lang: string,
  entryId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/personal-dict/${encodeURIComponent(lang)}/entries/${entryId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete personal entry ${entryId} failed`);
  }
}

/** PATCH a personal-dict entry by row id alone — used when the
 *  caller doesn't carry the lang (desktop's `updateDictEntry(id, …)`).
 *  Ownership is resolved through `userId` server-side. */
export async function cloudUpdatePersonalDictEntryById(
  entryId: number,
  patch: Partial<{ word: string; altWord: string | null; reading: string | null; gloss: string }>,
): Promise<DictEntry> {
  const data = await expectJson<{ entry: WirePersonalEntry }>(
    await authedFetch(`/api/v1/personal-dict-entries/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  );
  return {
    word: data.entry.word,
    altWord: data.entry.altWord,
    reading: data.entry.reading,
    gloss: data.entry.gloss,
  };
}

/** DELETE a personal-dict entry by row id alone. */
export async function cloudDeletePersonalDictEntryById(
  entryId: number,
): Promise<void> {
  const res = await authedFetch(
    `/api/v1/personal-dict-entries/${entryId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new CloudHttpError(res.status, `delete personal entry ${entryId} failed`);
  }
}

// ── Pack import (bulk) ───────────────────────────────────────────────
//
// Single-call replacement for the client-side import loop. The hosted
// build used to fire one POST per word (plus collection + chapter
// creates, plus repeated listCollections roundtrips); on HSK 1 that
// was ~1k requests for a 461-word pack. This endpoint accepts the
// whole pack JSON + activation prefs and runs the import server-side
// in a single Prisma transaction.

export async function cloudImportPack(input: {
  workspaceId: number;
  pack: unknown;
  textbookPrefs?: unknown;
  collectionPrefs?: unknown;
}): Promise<{
  collectionsCreated: number;
  collectionsSkipped: number;
  textbooksCreated: number;
  textbooksSkipped: number;
  chaptersCreated: number;
  wordsCreated: number;
  mediaCreated: number;
  mediaSkipped: number;
}> {
  const data = await expectJson<{
    collectionsCreated: number;
    collectionsSkipped: number;
    textbooksCreated: number;
    textbooksSkipped: number;
    chaptersCreated: number;
    wordsCreated: number;
    mediaCreated?: number;
    mediaSkipped?: number;
  }>(
    await authedFetch(
      `/api/v1/workspaces/${input.workspaceId}/pack-import`,
      {
        method: "POST",
        body: JSON.stringify({
          pack: input.pack,
          textbookPrefs: input.textbookPrefs,
          collectionPrefs: input.collectionPrefs,
        }),
      },
    ),
  );
  // Media counts default to 0 against a cloud that predates the media
  // stage — the import still succeeds, just without recommendations.
  return {
    ...data,
    mediaCreated: data.mediaCreated ?? 0,
    mediaSkipped: data.mediaSkipped ?? 0,
  };
}
