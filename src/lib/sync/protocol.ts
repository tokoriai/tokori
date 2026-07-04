/**
 * Sync v2 wire protocol — desktop copy.
 *
 * This file mirrors tokori-cloud/src/lib/sync-v2/protocol.ts. The two
 * repos can't share imports, so the contract lives twice; keep every
 * type and constant here byte-compatible with the cloud's copy when
 * evolving the protocol (bump SYNC_PROTOCOL_VERSION on breaking
 * changes — the server rejects mismatches with a 400).
 *
 * Model (AnkiWeb-style USN sync):
 *   - Every synced row carries a client-minted `gid` (stable identity),
 *     an epoch-ms `mtime` (last local edit, drives last-write-wins) and
 *     a server-side `usn` stamp (per-user monotonic counter).
 *   - A client remembers the last usn it saw. One exchange call pushes
 *     its dirty rows + graves and pulls every row/grave other devices
 *     stamped in between.
 *   - Natural-key adoption converges rows created independently on two
 *     devices onto one server row; `remaps` tell the client to rewrite
 *     its local gid.
 *
 * Timestamps: `mtime` is epoch **milliseconds**; every other time field
 * is epoch **seconds** (matching the local SQLite columns).
 */

export const SYNC_PROTOCOL_VERSION = 1;

/** Dependency-ordered kinds: parents strictly before children. */
export const KIND_ORDER = [
  "workspace",
  "collection",
  "vocab",
  "libraryItem",
  "chapter",
  "collectionWord",
  "review",
  "session",
  "note",
  "goal",
  "habit",
  "chat",
  "message",
  "journal",
  "readerDoc",
  "systemPrompt",
  "translateConfig",
  "setting",
  "pdictEntry",
] as const;

export type SyncKind = (typeof KIND_ORDER)[number];

export const REVIEW_SEP = "@";
export const COLLECTION_WORD_SEP = "~";
export const PDICT_SEP = "\u001f";

export function reviewGid(vocabGid: string, reviewedAt: number): string {
  return `${vocabGid}${REVIEW_SEP}${reviewedAt}`;
}

export function collectionWordGid(collectionGid: string, vocabGid: string): string {
  return `${collectionGid}${COLLECTION_WORD_SEP}${vocabGid}`;
}

export function parseCollectionWordGid(
  gid: string,
): { collectionGid: string; vocabGid: string } | null {
  const i = gid.indexOf(COLLECTION_WORD_SEP);
  if (i <= 0 || i === gid.length - 1) return null;
  return { collectionGid: gid.slice(0, i), vocabGid: gid.slice(i + 1) };
}

export function parseReviewGid(
  gid: string,
): { vocabGid: string; reviewedAt: number } | null {
  const i = gid.lastIndexOf(REVIEW_SEP);
  if (i <= 0) return null;
  const reviewedAt = Number(gid.slice(i + 1));
  if (!Number.isFinite(reviewedAt)) return null;
  return { vocabGid: gid.slice(0, i), reviewedAt };
}

export function pdictGid(lang: string, word: string): string {
  return `${lang}${PDICT_SEP}${word}`;
}

export function parsePdictGid(
  gid: string,
): { lang: string; word: string } | null {
  const i = gid.indexOf(PDICT_SEP);
  if (i <= 0 || i === gid.length - 1) return null;
  return { lang: gid.slice(0, i), word: gid.slice(i + 1) };
}

// ── Wire rows ─────────────────────────────────────────────────────────

export type WireWorkspace = {
  gid: string;
  mtime: number;
  targetLang: string;
  nativeLang: string;
  name: string;
  createdAt: number | null;
};

export type WireCollection = {
  gid: string;
  mtime: number;
  workspaceGid: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  source: string;
  presetId: string | null;
  parentGid: string | null;
  createdAt: number | null;
};

export type WireVocab = {
  gid: string;
  mtime: number;
  workspaceGid: string;
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
  cardNotes: string | null;
  frontExtra: string | null;
  translation: string | null;
  layout: string | null;
  isActive: boolean;
  createdAt: number | null;
};

export type WireReview = {
  vocabGid: string;
  grade: string;
  reviewedAt: number;
  newDueAt: number | null;
  newStatus: string | null;
  stability: number | null;
  difficulty: number | null;
};

export type WireCollectionWord = {
  collectionGid: string;
  vocabGid: string;
  position: number;
  addedAt: number | null;
  mtime: number;
};

export type WireLibraryItem = {
  gid: string;
  mtime: number;
  workspaceGid: string;
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
};

export type WireChapter = {
  gid: string;
  mtime: number;
  itemGid: string;
  position: number;
  title: string;
  completedAt: number | null;
  notes: string | null;
  collectionGid: string | null;
  createdAt: number | null;
};

export type WireSession = {
  gid: string;
  mtime: number;
  workspaceGid: string;
  kind: string;
  startedAt: number;
  endedAt: number | null;
  durationSecs: number | null;
  wordsSeen: number;
  wordsSaved: number;
  notes: string | null;
};

export type WireNote = {
  gid: string;
  mtime: number;
  workspaceGid: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: number | null;
};

export type WireGoal = {
  gid: string;
  mtime: number;
  workspaceGid: string;
  title: string;
  kind: string;
  skill: string | null;
  target: number;
  deadline: number | null;
  completedAt: number | null;
  createdAt: number | null;
};

export type WireHabit = {
  gid: string;
  mtime: number;
  workspaceGid: string;
  name: string;
  activityKind: string | null;
  targetSecs: number;
  frequency: string;
  glyph: string | null;
  archivedAt: number | null;
  createdAt: number | null;
};

export type WireChat = {
  gid: string;
  mtime: number;
  workspaceGid: string;
  title: string;
  createdAt: number | null;
};

export type WireMessage = {
  gid: string;
  mtime: number;
  chatGid: string;
  role: string;
  content: string;
  createdAt: number | null;
};

export type WireJournal = {
  gid: string;
  mtime: number;
  workspaceGid: string;
  title: string;
  topic: string | null;
  body: string;
  state: string;
  corrections: string | null;
  source: string | null;
  createdAt: number | null;
};

export type WireReaderDoc = {
  gid: string;
  mtime: number;
  workspaceGid: string;
  title: string;
  body: string;
  sourceUrl: string | null;
  parentGid: string | null;
  level: string;
  libraryItemGid: string | null;
  chapterPosition: number | null;
  createdAt: number | null;
};

export type WireSystemPrompt = {
  gid: string;
  mtime: number;
  name: string;
  body: string;
  isDefault: boolean;
  createdAt: number | null;
};

export type WireTranslateConfig = {
  gid: string;
  mtime: number;
  kind: string;
  label: string;
  apiKey: string | null;
  secondaryKey: string | null;
  baseUrl: string | null;
  model: string | null;
  isDefault: boolean;
  createdAt: number | null;
};

export type WireSetting = {
  key: string;
  value: string;
  mtime: number;
};

export type WirePdictEntry = {
  lang: string;
  word: string;
  altWord: string | null;
  reading: string | null;
  gloss: string;
  mtime: number;
};

export type ChangeSet = Partial<{
  workspace: WireWorkspace[];
  collection: WireCollection[];
  vocab: WireVocab[];
  review: WireReview[];
  collectionWord: WireCollectionWord[];
  libraryItem: WireLibraryItem[];
  chapter: WireChapter[];
  session: WireSession[];
  note: WireNote[];
  goal: WireGoal[];
  habit: WireHabit[];
  chat: WireChat[];
  message: WireMessage[];
  journal: WireJournal[];
  readerDoc: WireReaderDoc[];
  systemPrompt: WireSystemPrompt[];
  translateConfig: WireTranslateConfig[];
  setting: WireSetting[];
  pdictEntry: WirePdictEntry[];
}>;

export type Grave = { kind: SyncKind; gid: string };
export type Remap = { kind: SyncKind; from: string; to: string };
export type Rejected = { kind: SyncKind; gid: string; reason: string };

export type PullCursor = {
  ceiling: number;
  excludeUsn: number;
  afterKind: number;
  afterId: string;
};

export type ExchangeRequest = {
  protocol: number;
  lastUsn: number;
  changes?: ChangeSet;
  graves?: Grave[];
  pull?: PullCursor;
  mode?: "normal" | "skip-pull";
};

export type ExchangeResponse = {
  newUsn: number;
  epoch: number;
  remaps: Remap[];
  rejected: Rejected[];
  changes: ChangeSet;
  graves: Grave[];
  next: PullCursor | null;
};

export type SyncMeta = {
  userId: number;
  usn: number;
  epoch: number;
  hasData: boolean;
};
