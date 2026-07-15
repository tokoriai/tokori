import Database from "@tauri-apps/plugin-sql";
import { isTauri } from "@tauri-apps/api/core";
import { HOSTED } from "./build-flags";
import type { WordBox } from "./word-boxing";
// Pure dict-search ranking (no Tauri/DB deps) — shared by the SQLite,
// in-memory, and HOSTED paths so all three rank identically.
import { normaliseReading, rankSearchHits } from "./dict-search-rank";
// Cloud dict client. Pulled in only when HOSTED — every call site
// guards with `if (HOSTED)` so terser drops this import from the
// desktop bundle entirely. Do not move call sites outside those
// guards; the desktop must never reach the cloud for lookups.
import {
  cloudDictBatchLookup,
  cloudDictLanguages,
  cloudDictSearch,
} from "./cloud-dict";
// Cloud REST client for workspace data. Same dead-strip contract:
// every consumer of this module is inside an `if (HOSTED)` block, so
// the desktop bundle never imports any of these.
import {
  cloudActivateVocab,
  cloudActivationSummary,
  cloudAddMessage,
  cloudAddPersonalDictEntry,
  cloudAddWordToCollection,
  cloudBulkAddToCollection,
  cloudCollectionsForVocab,
  cloudCreateChapter,
  cloudCreateChat,
  cloudCreateCollection,
  cloudCreateGoal,
  cloudCreateJournal,
  cloudCreateNote,
  cloudCreateSession,
  cloudCreateWorkspace,
  cloudDeleteChat,
  cloudDeleteCollection,
  cloudDeleteGoal,
  cloudDeleteJournal,
  cloudDeleteLibraryItem,
  cloudDeleteNote,
  cloudDeleteReaderDoc,
  cloudDeleteSession,
  cloudDeleteSystemPrompt,
  cloudDeleteTranslateConfig,
  cloudDeleteVocab,
  cloudDeleteWorkspace,
  cloudGetJournal,
  cloudGetOrCreateDefaultCollection,
  cloudGetSettings,
  cloudListChapters,
  cloudListChats,
  cloudListCollections,
  cloudListCollectionWords,
  cloudListDueVocab,
  cloudListGoals,
  cloudListJournals,
  cloudListLibrary,
  cloudListMessages,
  cloudListNotes,
  cloudListPersonalDictEntries,
  cloudListReaderDocs,
  cloudListSessions,
  cloudListSystemPrompts,
  cloudListTranslateConfigs,
  cloudListVocab,
  cloudListWorkspaceReviews,
  cloudListWorkspaces,
  cloudRemoveWordFromCollection,
  cloudReviewVocab,
  cloudSaveLibraryItem,
  cloudSaveReaderDoc,
  cloudSaveSystemPrompt,
  cloudSaveTranslateConfig,
  cloudSaveVocab,
  cloudSetSetting,
  cloudUpdateChapterById,
  cloudDeleteChapterById,
  cloudUpdateChat,
  cloudUpdateCollection,
  cloudUpdateGoal,
  cloudUpdateJournal,
  cloudUpdateLibraryItem,
  cloudUpdateMessageById,
  cloudUpdateNote,
  cloudUpdatePersonalDictEntryById,
  cloudDeletePersonalDictEntryById,
  cloudUpdateSession,
  cloudUpdateVocab,
  cloudWipeWorkspaceVocab,
} from "./cloud-client";
import type { LanguageCode } from "./languages";
import { languageName } from "./languages";
import { lemmaCandidates } from "./dictionaries/lemmatizer";
import type { Grade } from "./fsrs";
// Knowledge-base indexing — reader docs, notes, chapters, and assistant chat
// replies get reindexed in here so search "just works" without callers having
// to know about FTS. Failures are swallowed: indexing is best-effort.
import {
  deleteSource as deleteKnowledgeSource,
  reindexSource as reindexKnowledgeSource,
} from "./knowledge";
// Hosted-variant incremental sync. The `mark*Dirty` calls are no-ops
// in desktop builds (HOSTED is constant-folded out of sync-queue), so
// the SQLite paths below pay nothing for them.
import {
  markDictDirty,
  markSettingDirty,
  markVocabDirty,
} from "./sync-queue";

// ── HOSTED probe helper ──────────────────────────────────────────────
//
// Many desktop functions take only an entity id (e.g. `deleteChat(id)`)
// because local SQLite doesn't need the workspace to look up the
// owner — the row's FK does. The cloud routes are workspace-scoped
// for security, so when wiring those functions we have to figure out
// the workspace id ourselves. The probe walks the user's workspaces
// and tries each one until the cloud call succeeds (or every workspace
// 404s, in which case we give up).
//
// Performance: O(W) where W is the user's workspace count. The
// typical user has 1–3 workspaces, so this is fine. A future
// optimisation could memoise `id → workspaceId` lookups on list calls;
// it isn't urgent.
//
// Lives under `if (HOSTED)` at every call site so terser dead-strips
// it from the desktop bundle along with cloudListWorkspaces.
async function probeWorkspace<T>(
  attempt: (workspaceId: number) => Promise<T>,
): Promise<T | null> {
  const all = await cloudListWorkspaces();
  for (const ws of all) {
    try {
      return await attempt(ws.id);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("not found")) {
        throw err;
      }
    }
  }
  return null;
}

export type Workspace = {
  id: number;
  targetLang: LanguageCode;
  nativeLang: LanguageCode;
  name: string;
  createdAt: number;
};

export type Chat = {
  id: number;
  workspaceId: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  // User + assistant messages only; system rows (TOKORI_VOICE_SESSION etc.)
  // are excluded. Set by `listChats`; absent on chats returned from
  // `createChat`/`renameChat`. Treat `undefined` as "unknown".
  messageCount?: number;
  /** Set when the row was read from the cloud. Sync-push uses it to
   *  skip rows already on the cloud. Null otherwise. */
  clientId?: string | null;
};

export type StoredMessage = {
  id: number;
  chatId: number;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  /** Sync-only — see Chat.clientId. */
  clientId?: string | null;
};

// "unseen" sits before "new" in the lifecycle: imported textbook /
// pack vocabulary that the user has never opted into studying yet.
// Cards in this state are inactive (is_active = 0), do not enter the
// SRS queue, and don't count toward the "new" stat on the dashboard.
// Chapter activation (and any manual "add to study queue" action)
// flips them to "new" — only then does the SRS clock start ticking.
export type VocabStatus =
  | "unseen"
  | "new"
  | "learning"
  | "review"
  | "mastered";

// 'vocab' = word/phrase; 'sentence' = full sentence with translation in
// `gloss`; 'writing' = writing prompt or single hanzi to draw.
export type VocabKind = "vocab" | "sentence" | "writing";

export type VocabEntry = {
  id: number;
  workspaceId: number;
  word: string;
  reading: string | null;
  gloss: string | null;
  source: string;
  status: VocabStatus;
  kind: VocabKind;
  stability: number;
  difficulty: number;
  // Position in the learning/relearning ladder. Only meaningful while status
  // is 'new' or 'learning'. Resets to 0 on every Again.
  learningStep: number;
  dueAt: number | null;
  lastReview: number | null;
  reviewCount: number;
  createdAt: number;
  // List queries leave imageData null and surface only `hasImage`. Fetch the
  // bytes via getVocabImage(id).
  imageData: string | null;
  hasImage: boolean;
  cardNotes: string | null;
  // Cloze sentence using {{c1::word}} syntax.
  frontExtra: string | null;
  // Natural / native translation, kept separate from `gloss` (which is
  // the dictionary-style definition). A card may carry both.
  translation: string | null;
  // Per-card front/back override (`{ front: FieldId[], back: FieldId[] }`
  // as JSON). Null = use the per-kind default. Parsed by
  // `src/lib/card-layout.ts:resolveLayout`.
  layout: string | null;
  // hasAudio / audioMime are surfaced in list queries; fetch the bytes via
  // getVocabAudio(id).
  hasAudio: boolean;
  audioMime: string | null;
  // When false the card is reference-only (imported from a pack) and doesn't
  // enter the SRS due queue. Activation is explicit.
  isActive: boolean;
};

export type StudySession = {
  id: number;
  workspaceId: number;
  kind: string;
  startedAt: number;
  endedAt: number | null;
  durationSecs: number | null;
  wordsSeen: number;
  wordsSaved: number;
  // NULL for in-app sessions; non-null for sessions created via logSession
  // from the activity logger. listManualSessions filters on this.
  notes: string | null;
  // Set when the row was read from the cloud (sync). Null on the
  // desktop's own SQLite reads. Used by the sync push path to skip
  // rows already on the cloud.
  clientId?: string | null;
};

export type ProviderKind =
  | "ollama"
  | "openai"
  | "anthropic"
  | "gemini"
  | "minimax"
  // Alibaba DashScope (Qwen). Chat rides the Rust OpenAI provider
  // against DashScope's OpenAI-compatible endpoint; live voice opens
  // its own realtime WebSocket. First-class kind (not an "openai"
  // preset) so the live mode can find the user's Qwen key by kind.
  | "qwen"
  // Hosted provider proxied through the tokori-cloud backend. The config
  // row is synthesized in `provider-context.tsx` and doesn't live in the
  // `providers` table.
  | "tokori-cloud";
export type ProviderConfig = {
  id: number;
  kind: ProviderKind;
  label: string;
  model: string;
  host: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  isDefault: boolean;
  createdAt: number;
};

export type Dictionary = {
  id: number;
  lang: string;
  name: string;
  sourceUrl: string | null;
  installedAt: number;
  entryCount: number;
};

export type DictEntry = {
  word: string;
  altWord: string | null;
  reading: string | null;
  gloss: string;
  /** Japanese pitch accent: the *drop* position over the reading's
   *  mora. 0 = heiban (flat), 1 = atamadaka (drop after first mora),
   *  N >= 2 = nakadaka / odaka. Null when no accent data is known
   *  for the word (kanjium's coverage is partial) and for non-JA
   *  dictionaries. Renderer side: see `src/lib/pitch.ts`. */
  pitchAccent?: number | null;
  /** Set by `lookupDict` when the exact-form lookup missed and a
   *  lemmatizer candidate hit instead — holds the lemma (the dict's
   *  headword that matched), so a click on "geht" returns the "gehen"
   *  row with `inflectionOf: "gehen"`. Callers (popover, card editor)
   *  surface this as "inflected form of {lemma}". Never persisted to
   *  the DB. */
  inflectionOf?: string;
};

export type Note = {
  id: number;
  workspaceId: number;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Sync-only — see Chat.clientId. */
  clientId?: string | null;
};

export type LibraryKind =
  | "book"
  | "ebook"
  | "textbook"
  | "video"
  // A show/season with episodes — rendered by the Immersion view, not
  // Library (see src/lib/media/kinds.ts for the kind split).
  | "series"
  | "article"
  | "podcast"
  | "other";

// "planned" = the backlog ("want to watch/read") — items queued before
// any progress exists. The DB column is free text, so older rows are
// unaffected; the sync wire carries it as-is.
export type LibraryStatus = "planned" | "active" | "paused" | "finished" | "dropped";

export type LibraryItem = {
  id: number;
  workspaceId: number;
  kind: LibraryKind;
  title: string;
  author: string | null;
  source: string | null;
  totalUnits: number | null;
  unitLabel: string;
  completedUnits: number;
  totalSeconds: number;
  status: LibraryStatus;
  coverUrl: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SystemPrompt = {
  id: number;
  name: string;
  body: string;
  isDefault: boolean;
  createdAt: number;
  /** Sync-only — see Chat.clientId. */
  clientId?: string | null;
};

export type ReaderLevel = "original" | "intermediate" | "beginner";

export type ReaderDocument = {
  id: number;
  workspaceId: number;
  title: string;
  body: string;
  sourceUrl: string | null;
  createdAt: number;
  updatedAt: number;
  // When set, this row is a simplified variant of the original doc.
  parentId: number | null;
  level: ReaderLevel;
  libraryItemId: number | null;
  chapterPosition: number | null;
  // When set, this reader doc is backed by a stored PDF/image (see
  // source_documents) and renders as an interactive page overlay over
  // pages [pageStart, pageEnd]. Null for plain text docs (today's default).
  sourceDocumentId: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  // Fetch audio bytes via getReaderAudio(id); list queries skip the BLOB.
  hasAudio: boolean;
  audioMime: string | null;
  /** Sync-only — see Chat.clientId. */
  clientId?: string | null;
};

export type SourceDocKind = "pdf" | "image";

/** A stored original document (PDF or image). The bytes live in SQLite;
 *  list queries omit them. Per-page word geometry lives in PageLayout. */
export type SourceDocument = {
  id: number;
  workspaceId: number;
  kind: SourceDocKind;
  fileName: string;
  mime: string;
  numPages: number;
  createdAt: number;
};

/** One page's interactive word boxes (page-relative [0..1]) + its intrinsic
 *  size (for aspect ratio). `ocrDone` flags lazily-OCR'd scanned pages. */
export type PageLayout = {
  id: number;
  sourceDocumentId: number;
  pageIndex: number;
  width: number;
  height: number;
  words: WordBox[];
  ocrDone: boolean;
};

export type NoteAttachment = {
  id: number;
  noteId: number;
  sourceDocumentId: number;
  createdAt: number;
};

export type LibraryChapter = {
  id: number;
  itemId: number;
  position: number;
  title: string;
  completedAt: number | null;
  notes: string | null;
  createdAt: number;
  // When set, marking the chapter complete flips every word in this
  // collection to status='learning' with due_at=now.
  collectionId: number | null;
};

// "ok" = already correct (kept for reference); "minor" = small tweak;
// "major" = meaning-bearing fix.
export type JournalCorrection = {
  original: string;
  corrected: string;
  explanation: string;
  severity: "ok" | "minor" | "major";
};

export type JournalState = "draft" | "corrected";

export type JournalSource =
  | "manual"
  | "ai"
  | "vocab"
  | { kind: "chapter"; chapterId: number };

export type JournalEntry = {
  id: number;
  workspaceId: number;
  title: string;
  topic: string | null;
  body: string;
  state: JournalState;
  // Null while in draft state.
  corrections: JournalCorrection[] | null;
  source: JournalSource | null;
  createdAt: number;
  updatedAt: number;
  /** Sync-only — see Chat.clientId. */
  clientId?: string | null;
};

export type CollectionSource = "user" | "preset" | "imported";

export type Collection = {
  id: number;
  workspaceId: number;
  name: string;
  description: string | null;
  isDefault: boolean;
  source: CollectionSource;
  presetId: string | null;
  parentId: number | null;
  createdAt: number;
  updatedAt: number;
  // Computed at fetch time.
  wordCount?: number;
};

export type GoalKind = "vocab" | "minutes" | "sessions";
export type GoalSkill = "reading" | "writing" | "speaking" | "listening" | null;

export type Goal = {
  id: number;
  workspaceId: number;
  title: string;
  kind: GoalKind;
  skill: GoalSkill;
  target: number;
  deadline: number | null;
  createdAt: number;
  completedAt: number | null;
  /** Sync-only — see Chat.clientId. */
  clientId?: string | null;
};

const DB_URL = "sqlite:tokori.db";

let dbPromise: Promise<Database> | null = null;
function getDb() {
  if (!dbPromise) {
    // Connection-tuning PRAGMAs:
    //   journal_mode=WAL    — readers proceed alongside one writer (the
    //     default DELETE journal serialises readers behind any active writer
    //     and exhausts the SQLx pool under parallel SELECTs).
    //   busy_timeout=5000   — retry briefly held locks instead of throwing
    //     SQLITE_BUSY.
    //   synchronous=NORMAL  — half the fsync cost of FULL with the same
    //     durability under WAL.
    //   temp_store=MEMORY   — avoid temp files for SORT/DISTINCT.
    dbPromise = (async () => {
      const db = await Database.load(DB_URL);
      // PRAGMAs that return a result row (`journal_mode`, `busy_timeout`,
      // `synchronous`, `temp_store`) must go through `select` — the plugin's
      // `execute` path rejects them as "queries that produce rows".
      // Wrapped individually so one failing PRAGMA doesn't take the others
      // down with it.
      const tryPragma = async (sql: string) => {
        try {
          await db.select(sql);
        } catch (err) {
          console.warn(`[db] PRAGMA failed: ${sql}`, err);
        }
      };
      await tryPragma("PRAGMA journal_mode=WAL");
      await tryPragma("PRAGMA busy_timeout=5000");
      await tryPragma("PRAGMA synchronous=NORMAL");
      await tryPragma("PRAGMA temp_store=MEMORY");
      return db;
    })();
  }
  return dbPromise;
}

export function isPersistent(): boolean {
  return isTauri();
}

/** Raw database handle for the sync engine (`src/lib/sync/`), which
 *  manages its own change-tracking SQL. Everything else goes through
 *  the typed functions in this file. Desktop-only. */
export async function getRawDb(): Promise<Database> {
  if (!isTauri()) throw new Error("getRawDb is desktop-only");
  return getDb();
}

// In-memory fallback for `npm run dev` (no Tauri IPC).
type FallbackStore = {
  workspaces: Workspace[];
  chats: Chat[];
  messages: StoredMessage[];
  vocab: VocabEntry[];
  reviews: VocabReview[];
  sessions: StudySession[];
  providers: ProviderConfig[];
  settings: Record<string, string>;
  dicts: Dictionary[];
  dictEntries: Map<number, DictEntry[]>;
  notes: Note[];
  library: LibraryItem[];
  chapters: LibraryChapter[];
  journals: JournalEntry[];
  prompts: SystemPrompt[];
  readerDocs: ReaderDocument[];
  goals: Goal[];
  collections: Collection[];
  collectionWords: Array<{
    collectionId: number;
    vocabId: number;
    position: number;
    addedAt: number;
  }>;
  translateConfigs: TranslateConfig[];
  sourceDocuments: Array<SourceDocument & { bytes: Uint8Array }>;
  pageLayouts: PageLayout[];
  noteAttachments: NoteAttachment[];
  nextId: number;
};

// Translation engines — see `lib/translate/api.ts`. One row per
// (engine kind, account) pair, optional default flag.
export type TranslateKind =
  | "google-free"
  | "google-cloud"
  | "deepl"
  | "baidu"
  | "ai";

export type TranslateConfig = {
  id: number;
  kind: TranslateKind;
  label: string;
  apiKey: string | null;
  secondaryKey: string | null;
  baseUrl: string | null;
  providerId: number | null;
  model: string | null;
  isDefault: boolean;
  createdAt: number;
  /** Sync-only — see Chat.clientId. */
  clientId?: string | null;
};

function freshFallbackStore(): FallbackStore {
  return {
    workspaces: [],
    chats: [],
    messages: [],
    vocab: [],
    reviews: [],
    sessions: [],
    providers: [],
    settings: {},
    dicts: [],
    dictEntries: new Map(),
    notes: [],
    library: [],
    chapters: [],
    journals: [],
    prompts: [],
    readerDocs: [],
    goals: [],
    collections: [],
    collectionWords: [],
    translateConfigs: [
      {
        id: 1,
        kind: "google-free",
        label: "Google (free)",
        apiKey: null,
        secondaryKey: null,
        baseUrl: null,
        providerId: null,
        model: null,
        isDefault: true,
        createdAt: 0,
      },
    ],
    sourceDocuments: [],
    pageLayouts: [],
    noteAttachments: [],
    nextId: 1,
  };
}

/** Wipe every entry in the hosted in-memory fallback store. Called
 *  on cloud sign-out and on the next sign-in (covers the case where
 *  user B authenticates without user A explicitly signing out first).
 *  No-op on the desktop build — SQLite is the canonical store there
 *  and the per-user data lives on disk under the OS app-data dir. */
export function resetFallbackStore() {
  const next = freshFallbackStore();
  // Mutate in place rather than reassigning the const — the same `fb`
  // reference is captured by every closure that touches the store, so
  // a re-bind wouldn't reach them.
  (Object.keys(fb) as Array<keyof FallbackStore>).forEach((k) => {
    delete (fb as Record<string, unknown>)[k as string];
  });
  Object.assign(fb, next);
}

const fb: FallbackStore = {
  workspaces: [],
  chats: [],
  messages: [],
  vocab: [],
  reviews: [],
  sessions: [],
  providers: [],
  settings: {},
  dicts: [],
  dictEntries: new Map(),
  notes: [],
  library: [],
  chapters: [],
  journals: [],
  prompts: [],
  readerDocs: [],
  goals: [],
  collections: [],
  collectionWords: [],
  translateConfigs: [
    // Mirror the Rust seed so the dev/browser fallback also has the
    // zero-config Google fallback available out of the box.
    {
      id: 1,
      kind: "google-free",
      label: "Google (free)",
      apiKey: null,
      secondaryKey: null,
      baseUrl: null,
      providerId: null,
      model: null,
      isDefault: true,
      createdAt: 0,
    },
  ],
  sourceDocuments: [],
  pageLayouts: [],
  noteAttachments: [],
  nextId: 1,
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

type WorkspaceRow = {
  id: number;
  target_lang: string;
  native_lang: string;
  name: string;
  created_at: number;
};

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    targetLang: row.target_lang as LanguageCode,
    nativeLang: row.native_lang as LanguageCode,
    name: row.name,
    createdAt: row.created_at,
  };
}

export async function listWorkspaces(): Promise<Workspace[]> {
  // HOSTED: workspaces live server-side, keyed on the authed user.
  // The desktop branch below is untouched — same local SQLite read.
  if (HOSTED) return cloudListWorkspaces();
  if (!isTauri()) return [...fb.workspaces];
  const db = await getDb();
  const rows = await db.select<WorkspaceRow[]>(
    "SELECT id, target_lang, native_lang, name, created_at FROM workspaces ORDER BY created_at ASC",
  );
  return rows.map(rowToWorkspace);
}

export async function createWorkspace(input: {
  targetLang: LanguageCode;
  nativeLang: LanguageCode;
  name?: string;
}): Promise<Workspace> {
  const name = input.name?.trim() || `Learning ${languageName(input.targetLang)}`;
  if (HOSTED) {
    return cloudCreateWorkspace({
      targetLang: input.targetLang,
      nativeLang: input.nativeLang,
      name,
    });
  }
  if (!isTauri()) {
    const ws: Workspace = {
      id: fb.nextId++,
      targetLang: input.targetLang,
      nativeLang: input.nativeLang,
      name,
      createdAt: nowSec(),
    };
    fb.workspaces.push(ws);
    return ws;
  }
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO workspaces (target_lang, native_lang, name) VALUES ($1, $2, $3)",
    [input.targetLang, input.nativeLang, name],
  );
  const id = Number(result.lastInsertId ?? 0);
  const rows = await db.select<WorkspaceRow[]>(
    "SELECT id, target_lang, native_lang, name, created_at FROM workspaces WHERE id = $1",
    [id],
  );
  return rowToWorkspace(rows[0]);
}

// The schema has ON DELETE CASCADE on every workspace_id FK, so deleting the
// workspace row also drops its vocab, sessions, chats, etc.
export async function deleteWorkspace(id: number): Promise<void> {
  if (HOSTED) return cloudDeleteWorkspace(id);
  if (!isTauri()) {
    fb.workspaces = fb.workspaces.filter((w) => w.id !== id);
    fb.vocab = fb.vocab.filter((v) => v.workspaceId !== id);
    fb.readerDocs = fb.readerDocs.filter((r) => r.workspaceId !== id);
    fb.sessions = fb.sessions.filter((s) => s.workspaceId !== id);
    fb.library = fb.library.filter((l) => l.workspaceId !== id);
    fb.notes = fb.notes.filter((n) => n.workspaceId !== id);
    if (fb.collections) {
      const removedCollIds = new Set(
        fb.collections.filter((c) => c.workspaceId === id).map((c) => c.id),
      );
      fb.collections = fb.collections.filter((c) => c.workspaceId !== id);
      if (fb.collectionWords) {
        fb.collectionWords = fb.collectionWords.filter(
          (cw) => !removedCollIds.has(cw.collectionId),
        );
      }
    }
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM workspaces WHERE id = $1", [id]);
}

export async function getSetting(key: string): Promise<string | null> {
  if (HOSTED) {
    const map = await cloudGetSettings([key]);
    return map[key] ?? null;
  }
  if (!isTauri()) return fb.settings[key] ?? null;
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1",
    [key],
  );
  return rows[0]?.value ?? null;
}

// One SQL with `IN (?, ?, …)` instead of N IPC round-trips per key.
export async function getSettings(
  keys: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (keys.length === 0) return out;
  for (const k of keys) out[k] = null;
  if (HOSTED) {
    const map = await cloudGetSettings(keys);
    for (const k of keys) out[k] = map[k] ?? null;
    return out;
  }
  if (!isTauri()) {
    for (const k of keys) out[k] = fb.settings[k] ?? null;
    return out;
  }
  const db = await getDb();
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await db.select<{ key: string; value: string }[]>(
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
    keys,
  );
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  if (HOSTED) {
    await cloudSetSetting(key, value);
    return;
  }
  if (!isTauri()) {
    fb.settings[key] = value;
    markSettingDirty(key, value);
    return;
  }
  const db = await getDb();
  await db.execute(
    "INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

type ProviderRow = {
  id: number;
  kind: string;
  label: string;
  model: string;
  host: string | null;
  api_key: string | null;
  base_url: string | null;
  is_default: number;
  created_at: number;
};

function rowToProvider(r: ProviderRow): ProviderConfig {
  return {
    id: r.id,
    kind: r.kind as ProviderKind,
    label: r.label,
    model: r.model,
    host: r.host,
    apiKey: r.api_key,
    baseUrl: r.base_url,
    isDefault: !!r.is_default,
    createdAt: r.created_at,
  };
}

export async function listProviders(): Promise<ProviderConfig[]> {
  if (!isTauri())
    return [...fb.providers].sort((a, b) => a.createdAt - b.createdAt);
  const db = await getDb();
  const rows = await db.select<ProviderRow[]>(
    "SELECT id, kind, label, model, host, api_key, base_url, is_default, created_at FROM provider_configs ORDER BY created_at ASC",
  );
  return rows.map(rowToProvider);
}

export async function saveProvider(input: {
  id?: number;
  kind: ProviderKind;
  label: string;
  model: string;
  host?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  isDefault?: boolean;
}): Promise<ProviderConfig> {
  if (!isTauri()) {
    let id = input.id ?? 0;
    if (id) {
      const idx = fb.providers.findIndex((p) => p.id === id);
      if (idx >= 0) {
        fb.providers[idx] = {
          ...fb.providers[idx],
          kind: input.kind,
          label: input.label,
          model: input.model,
          host: input.host ?? null,
          apiKey: input.apiKey ?? null,
          baseUrl: input.baseUrl ?? null,
          isDefault: !!input.isDefault,
        };
      }
    } else {
      id = fb.nextId++;
      fb.providers.push({
        id,
        kind: input.kind,
        label: input.label,
        model: input.model,
        host: input.host ?? null,
        apiKey: input.apiKey ?? null,
        baseUrl: input.baseUrl ?? null,
        isDefault: !!input.isDefault,
        createdAt: nowSec(),
      });
    }
    if (input.isDefault) {
      fb.providers = fb.providers.map((p) => ({
        ...p,
        isDefault: p.id === id,
      }));
    }
    return fb.providers.find((p) => p.id === id)!;
  }

  const db = await getDb();
  let id = input.id ?? 0;
  if (id) {
    await db.execute(
      "UPDATE provider_configs SET kind=$1, label=$2, model=$3, host=$4, api_key=$5, base_url=$6 WHERE id=$7",
      [input.kind, input.label, input.model, input.host ?? null, input.apiKey ?? null, input.baseUrl ?? null, id],
    );
  } else {
    const r = await db.execute(
      "INSERT INTO provider_configs (kind, label, model, host, api_key, base_url) VALUES ($1, $2, $3, $4, $5, $6)",
      [input.kind, input.label, input.model, input.host ?? null, input.apiKey ?? null, input.baseUrl ?? null],
    );
    id = Number(r.lastInsertId ?? 0);
  }
  if (input.isDefault) {
    await db.execute("UPDATE provider_configs SET is_default = 0");
    await db.execute("UPDATE provider_configs SET is_default = 1 WHERE id = $1", [id]);
  }
  const rows = await db.select<ProviderRow[]>(
    "SELECT id, kind, label, model, host, api_key, base_url, is_default, created_at FROM provider_configs WHERE id = $1",
    [id],
  );
  return rowToProvider(rows[0]);
}

export async function deleteProvider(id: number): Promise<void> {
  if (!isTauri()) {
    fb.providers = fb.providers.filter((p) => p.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM provider_configs WHERE id = $1", [id]);
}

// One row per (engine, account) pair, with one row marked `is_default`. The
// zero-config google-free row is seeded by the v14 migration.
type TranslateRow = {
  id: number;
  kind: string;
  label: string;
  api_key: string | null;
  secondary_key: string | null;
  base_url: string | null;
  provider_id: number | null;
  model: string | null;
  is_default: number;
  created_at: number;
};

function rowToTranslate(r: TranslateRow): TranslateConfig {
  return {
    id: r.id,
    kind: r.kind as TranslateKind,
    label: r.label,
    apiKey: r.api_key,
    secondaryKey: r.secondary_key,
    baseUrl: r.base_url,
    providerId: r.provider_id,
    model: r.model,
    isDefault: !!r.is_default,
    createdAt: r.created_at,
  };
}

export async function listTranslateConfigs(): Promise<TranslateConfig[]> {
  if (HOSTED) return cloudListTranslateConfigs();
  if (!isTauri())
    return [...fb.translateConfigs].sort((a, b) => a.createdAt - b.createdAt);
  const db = await getDb();
  const rows = await db.select<TranslateRow[]>(
    "SELECT id, kind, label, api_key, secondary_key, base_url, provider_id, model, is_default, created_at FROM translate_configs ORDER BY created_at ASC",
  );
  return rows.map(rowToTranslate);
}

export async function saveTranslateConfig(input: {
  id?: number;
  kind: TranslateKind;
  label: string;
  apiKey?: string | null;
  secondaryKey?: string | null;
  baseUrl?: string | null;
  providerId?: number | null;
  model?: string | null;
  isDefault?: boolean;
}): Promise<TranslateConfig> {
  if (HOSTED) return cloudSaveTranslateConfig(input);
  if (!isTauri()) {
    let id = input.id ?? 0;
    if (id) {
      const idx = fb.translateConfigs.findIndex((p) => p.id === id);
      if (idx >= 0) {
        fb.translateConfigs[idx] = {
          ...fb.translateConfigs[idx],
          kind: input.kind,
          label: input.label,
          apiKey: input.apiKey ?? null,
          secondaryKey: input.secondaryKey ?? null,
          baseUrl: input.baseUrl ?? null,
          providerId: input.providerId ?? null,
          model: input.model ?? null,
          isDefault: !!input.isDefault,
        };
      }
    } else {
      id = fb.nextId++;
      fb.translateConfigs.push({
        id,
        kind: input.kind,
        label: input.label,
        apiKey: input.apiKey ?? null,
        secondaryKey: input.secondaryKey ?? null,
        baseUrl: input.baseUrl ?? null,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        isDefault: !!input.isDefault,
        createdAt: nowSec(),
      });
    }
    if (input.isDefault) {
      fb.translateConfigs = fb.translateConfigs.map((p) => ({
        ...p,
        isDefault: p.id === id,
      }));
    }
    return fb.translateConfigs.find((p) => p.id === id)!;
  }

  const db = await getDb();
  let id = input.id ?? 0;
  if (id) {
    await db.execute(
      "UPDATE translate_configs SET kind=$1, label=$2, api_key=$3, secondary_key=$4, base_url=$5, provider_id=$6, model=$7 WHERE id=$8",
      [
        input.kind,
        input.label,
        input.apiKey ?? null,
        input.secondaryKey ?? null,
        input.baseUrl ?? null,
        input.providerId ?? null,
        input.model ?? null,
        id,
      ],
    );
  } else {
    const r = await db.execute(
      "INSERT INTO translate_configs (kind, label, api_key, secondary_key, base_url, provider_id, model) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        input.kind,
        input.label,
        input.apiKey ?? null,
        input.secondaryKey ?? null,
        input.baseUrl ?? null,
        input.providerId ?? null,
        input.model ?? null,
      ],
    );
    id = Number(r.lastInsertId ?? 0);
  }
  if (input.isDefault) {
    await db.execute("UPDATE translate_configs SET is_default = 0");
    await db.execute("UPDATE translate_configs SET is_default = 1 WHERE id = $1", [id]);
  }
  const rows = await db.select<TranslateRow[]>(
    "SELECT id, kind, label, api_key, secondary_key, base_url, provider_id, model, is_default, created_at FROM translate_configs WHERE id = $1",
    [id],
  );
  return rowToTranslate(rows[0]);
}

export async function deleteTranslateConfig(id: number): Promise<void> {
  if (HOSTED) {
    await cloudDeleteTranslateConfig(id);
    return;
  }
  if (!isTauri()) {
    fb.translateConfigs = fb.translateConfigs.filter((p) => p.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM translate_configs WHERE id = $1", [id]);
}

type ChatRow = {
  id: number;
  workspace_id: number;
  title: string;
  created_at: number;
  updated_at: number;
};

function rowToChat(r: ChatRow): Chat {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listChats(workspaceId: number): Promise<Chat[]> {
  if (HOSTED) return cloudListChats(workspaceId);
  if (!isTauri()) {
    return fb.chats
      .filter((c) => c.workspaceId === workspaceId)
      .map((c) => ({
        ...c,
        messageCount: fb.messages.filter(
          (m) =>
            m.chatId === c.id && (m.role === "user" || m.role === "assistant"),
        ).length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const db = await getDb();
  // Bring `messageCount` along on the same query so callers can
  // filter empty conversations without an N+1 round-trip per chat.
  // We only count user/assistant rows — system messages (e.g. the
  // TOKORI_VOICE_SESSION marker we stamp on persisted live sessions)
  // aren't user-visible interaction and shouldn't make a chat look
  // "active" in the recent list.
  type ChatWithCountRow = ChatRow & { message_count: number };
  const rows = await db.select<ChatWithCountRow[]>(
    `SELECT c.id, c.workspace_id, c.title, c.created_at, c.updated_at,
            COALESCE(SUM(
              CASE WHEN m.role IN ('user','assistant') THEN 1 ELSE 0 END
            ), 0) AS message_count
       FROM chats c
       LEFT JOIN messages m ON m.chat_id = c.id
      WHERE c.workspace_id = $1
      GROUP BY c.id
      ORDER BY c.updated_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    ...rowToChat(r),
    messageCount: Number(r.message_count) || 0,
  }));
}

export async function createChat(workspaceId: number, title = "New chat"): Promise<Chat> {
  if (HOSTED) return cloudCreateChat(workspaceId, title);
  if (!isTauri()) {
    const c: Chat = {
      id: fb.nextId++,
      workspaceId,
      title,
      createdAt: nowSec(),
      updatedAt: nowSec(),
    };
    fb.chats.push(c);
    return c;
  }
  const db = await getDb();
  const r = await db.execute(
    "INSERT INTO chats (workspace_id, title) VALUES ($1, $2)",
    [workspaceId, title],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<ChatRow[]>(
    "SELECT id, workspace_id, title, created_at, updated_at FROM chats WHERE id = $1",
    [id],
  );
  return rowToChat(rows[0]);
}

export async function renameChat(id: number, title: string): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudUpdateChat({ workspaceId, chatId: id, patch: { title } }),
    );
    return;
  }
  if (!isTauri()) {
    const chat = fb.chats.find((c) => c.id === id);
    if (chat) {
      chat.title = title;
      chat.updatedAt = nowSec();
    }
    return;
  }
  const db = await getDb();
  await db.execute(
    "UPDATE chats SET title = $1, updated_at = strftime('%s','now') WHERE id = $2",
    [title, id],
  );
}

export async function deleteChat(id: number): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudDeleteChat(workspaceId, id).then(() => true),
    );
    return;
  }
  if (!isTauri()) {
    fb.chats = fb.chats.filter((c) => c.id !== id);
    fb.messages = fb.messages.filter((m) => m.chatId !== id);
    return;
  }
  const db = await getDb();
  // Remove any indexed chunks for this chat's messages first; otherwise the
  // FTS index would keep stale rows pointing at deleted assistant messages.
  await db.execute(
    `DELETE FROM knowledge_chunks WHERE source_kind = 'chat' AND source_id IN
       (SELECT id FROM messages WHERE chat_id = $1)`,
    [id],
  );
  await db.execute("DELETE FROM messages WHERE chat_id = $1", [id]);
  await db.execute("DELETE FROM chats WHERE id = $1", [id]);
}

export async function touchChat(id: number): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudUpdateChat({ workspaceId, chatId: id, patch: { touch: true } }),
    );
    return;
  }
  if (!isTauri()) {
    const chat = fb.chats.find((c) => c.id === id);
    if (chat) chat.updatedAt = nowSec();
    return;
  }
  const db = await getDb();
  await db.execute("UPDATE chats SET updated_at = strftime('%s','now') WHERE id = $1", [id]);
}

type MessageRow = {
  id: number;
  chat_id: number;
  role: string;
  content: string;
  created_at: number;
};

function rowToMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    chatId: r.chat_id,
    role: r.role as StoredMessage["role"],
    content: r.content,
    createdAt: r.created_at,
  };
}

export async function listMessages(chatId: number): Promise<StoredMessage[]> {
  if (HOSTED) {
    const result = await probeWorkspace((workspaceId) =>
      cloudListMessages(workspaceId, chatId),
    );
    return result ?? [];
  }
  if (!isTauri())
    return fb.messages
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const db = await getDb();
  const rows = await db.select<MessageRow[]>(
    "SELECT id, chat_id, role, content, created_at FROM messages WHERE chat_id = $1 ORDER BY id ASC",
    [chatId],
  );
  return rows.map(rowToMessage);
}

export async function addMessage(input: {
  chatId: number;
  role: StoredMessage["role"];
  content: string;
}): Promise<StoredMessage> {
  if (HOSTED) {
    const result = await probeWorkspace((workspaceId) =>
      cloudAddMessage({
        workspaceId,
        chatId: input.chatId,
        role: input.role,
        content: input.content,
      }),
    );
    if (!result) throw new Error("chat not found");
    return result;
  }
  if (!isTauri()) {
    const m: StoredMessage = {
      id: fb.nextId++,
      chatId: input.chatId,
      role: input.role,
      content: input.content,
      createdAt: nowSec(),
    };
    fb.messages.push(m);
    return m;
  }
  const db = await getDb();
  const r = await db.execute(
    "INSERT INTO messages (chat_id, role, content) VALUES ($1, $2, $3)",
    [input.chatId, input.role, input.content],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<MessageRow[]>(
    "SELECT id, chat_id, role, content, created_at FROM messages WHERE id = $1",
    [id],
  );
  const msg = rowToMessage(rows[0]);
  // Index assistant replies so the tutor can recall its own past explanations
  // in later turns. User messages are usually too short / noisy to be useful.
  if (msg.role === "assistant" && msg.content.trim().length > 50) {
    void (async () => {
      try {
        const owner = await db.select<{ workspace_id: number; title: string }[]>(
          "SELECT workspace_id, title FROM chats WHERE id = $1",
          [msg.chatId],
        );
        if (!owner[0]) return;
        await reindexKnowledgeSource({
          workspaceId: owner[0].workspace_id,
          sourceKind: "chat",
          sourceId: msg.id,
          sourceTitle: owner[0].title || "chat",
          content: msg.content,
        });
      } catch {
        /* best-effort */
      }
    })();
  }
  return msg;
}

export async function updateMessageContent(
  id: number,
  content: string,
): Promise<void> {
  if (HOSTED) {
    await cloudUpdateMessageById(id, content);
    return;
  }
  if (!isTauri()) {
    const m = fb.messages.find((x) => x.id === id);
    if (m) m.content = content;
    return;
  }
  const db = await getDb();
  await db.execute("UPDATE messages SET content = $1 WHERE id = $2", [content, id]);
}

type VocabRow = {
  id: number;
  workspace_id: number;
  word: string;
  reading: string | null;
  gloss: string | null;
  source: string;
  status: string;
  kind?: string | null;
  stability: number;
  difficulty: number;
  learning_step?: number;
  due_at: number | null;
  last_review: number | null;
  review_count: number;
  created_at: number;
  image_data?: string | null;
  has_image?: number;
  card_notes: string | null;
  front_extra: string | null;
  translation?: string | null;
  layout?: string | null;
  has_audio?: number;
  audio_mime?: string | null;
  is_active?: number;
};

function rowToVocab(r: VocabRow): VocabEntry {
  // List queries provide `has_image` (cheap), single-card queries provide
  // `image_data` (potentially large base64). Reconcile both into the
  // public shape so callers don't have to care which path produced the
  // row.
  const imageData = r.image_data ?? null;
  const hasImage = imageData != null ? imageData.length > 0 : (r.has_image ?? 0) > 0;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    word: r.word,
    reading: r.reading,
    gloss: r.gloss,
    source: r.source,
    status: r.status as VocabStatus,
    kind: (r.kind ?? "vocab") as VocabKind,
    stability: r.stability,
    difficulty: r.difficulty,
    learningStep: r.learning_step ?? 0,
    dueAt: r.due_at,
    lastReview: r.last_review,
    reviewCount: r.review_count,
    createdAt: r.created_at,
    imageData,
    hasImage,
    cardNotes: r.card_notes,
    frontExtra: r.front_extra,
    translation: r.translation ?? null,
    layout: r.layout ?? null,
    hasAudio: (r.has_audio ?? 0) > 0,
    audioMime: r.audio_mime ?? null,
    // Default true so legacy rows / non-Tauri fallback show up in
    // study sessions like they always did.
    isActive: r.is_active == null ? true : r.is_active > 0,
  };
}

// Excludes `image_data` because base64 blobs across 500 rows can overflow
// Tauri's Win32 PostMessage queue. `has_image` carries the boolean badge;
// fetch the bytes on demand via getVocabImage.
const VOCAB_LIST_COLS =
  "id, workspace_id, word, reading, gloss, source, status, kind, stability, difficulty, learning_step, due_at, last_review, review_count, created_at, CASE WHEN image_data IS NOT NULL AND image_data != '' THEN 1 ELSE 0 END AS has_image, card_notes, front_extra, translation, layout, CASE WHEN audio_data IS NOT NULL THEN 1 ELSE 0 END AS has_audio, audio_mime, is_active";

// Includes the full base64 `image_data`. Never use this in a list query —
// even 100 rows can cross the IPC payload threshold.
const VOCAB_COLS =
  "id, workspace_id, word, reading, gloss, source, status, kind, stability, difficulty, learning_step, due_at, last_review, review_count, created_at, image_data, card_notes, front_extra, translation, layout, CASE WHEN audio_data IS NOT NULL THEN 1 ELSE 0 END AS has_audio, audio_mime, is_active";

// `limit` caps the IPC payload — a 3MB JSON across Tauri's webview bridge
// can overflow Win32's PostMessage queue under load.
export async function listVocab(
  workspaceId: number,
  limit?: number,
): Promise<VocabEntry[]> {
  if (HOSTED) {
    const rows = await cloudListVocab(workspaceId);
    return limit != null ? rows.slice(0, limit) : rows;
  }
  if (!isTauri()) {
    const rows = fb.vocab
      .filter((v) => v.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return limit != null ? rows.slice(0, limit) : rows;
  }
  const db = await getDb();
  const rows = limit != null
    ? await db.select<VocabRow[]>(
        `SELECT ${VOCAB_LIST_COLS} FROM vocab_entries WHERE workspace_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [workspaceId, limit],
      )
    : await db.select<VocabRow[]>(
        `SELECT ${VOCAB_LIST_COLS} FROM vocab_entries WHERE workspace_id = $1
         ORDER BY created_at DESC`,
        [workspaceId],
      );
  return rows.map(rowToVocab);
}

export async function saveVocab(input: {
  workspaceId: number;
  word: string;
  reading?: string | null;
  gloss?: string | null;
  source?: string;
  kind?: VocabKind;
  // Default true (enters SRS). Pack importer passes false so words land as
  // reference material until the user opts in.
  isActive?: boolean;
  // FSRS seed from importers that already track SRS state (HackChinese,
  // Anki, pack "previous-known"). Applied on INSERT, and adopted by an
  // existing row that has never been reviewed; a row with real review
  // history keeps its schedule.
  srsState?: {
    status: VocabStatus;
    stability?: number;
    // Unix seconds. If omitted but stability is set, compute now + stability days.
    dueAt?: number;
    difficulty?: number;
  };
}): Promise<VocabEntry> {
  const seed = input.srsState;
  const seedStability = seed?.stability ?? 0;
  const seedDifficulty = seed?.difficulty ?? 5;
  const seedDueAt =
    seed?.dueAt ??
    (seed && seedStability > 0
      ? nowSec() + Math.round(seedStability * 24 * 60 * 60)
      : null);
  // A seeded card with non-zero stability is the user telling us
  // "I already know this" (Anki / HackChinese / pack import's
  // previous-known mode). Stamp `lastReview = now` so it shows up in
  // the dashboard's vocab growth chart, which replays reviews forward
  // and skips vocab with no review history. Without this, mastered
  // seeds would be invisible to the chart and the panel would render
  // empty even after importing a chapter the user has already learned.
  const seedLastReview =
    seed && seedStability > 0 ? nowSec() : null;

  if (HOSTED) {
    const saved = await cloudSaveVocab({
      workspaceId: input.workspaceId,
      word: input.word,
      reading: input.reading,
      gloss: input.gloss,
      source: input.source,
      kind: input.kind,
      isActive: input.isActive,
      srsState: seed
        ? {
            status: seed.status,
            stability: seedStability,
            dueAt: seedDueAt ?? undefined,
            difficulty: seedDifficulty,
            // Mirror the desktop seed: a previously-known card is one
            // the user is telling us they already studied, so stamp
            // lastReview to drive the dashboard chart.
            lastReview: seedLastReview,
          }
        : undefined,
    });
    hostedInvalidateVocabCache(input.workspaceId);
    return saved;
  }

  if (!isTauri()) {
    const existing = fb.vocab.find(
      (v) => v.workspaceId === input.workspaceId && v.word === input.word,
    );
    if (existing) {
      // Mirror the SQLite ON CONFLICT: a pristine (never-reviewed) row
      // adopts the seed so pack "previous-known" seeding isn't lost when
      // the flat collection inserted the row first.
      if (seed && existing.lastReview == null) {
        existing.status = seed.status;
        existing.stability = seedStability;
        existing.difficulty = seedDifficulty;
        existing.dueAt = seedDueAt;
        existing.lastReview = seedLastReview;
        if (input.isActive !== false) existing.isActive = true;
        if (existing.reading == null) existing.reading = input.reading ?? null;
        if (existing.gloss == null) existing.gloss = input.gloss ?? null;
        markVocabDirty(existing);
      }
      return existing;
    }
    const v: VocabEntry = {
      id: fb.nextId++,
      workspaceId: input.workspaceId,
      word: input.word,
      reading: input.reading ?? null,
      gloss: input.gloss ?? null,
      source: input.source ?? "manual",
      status: seed?.status ?? "new",
      kind: input.kind ?? "vocab",
      stability: seedStability,
      difficulty: seedDifficulty,
      learningStep: 0,
      dueAt: seedDueAt,
      lastReview: seedLastReview,
      reviewCount: 0,
      createdAt: nowSec(),
      imageData: null,
      hasImage: false,
      cardNotes: null,
      frontExtra: null,
      translation: null,
      layout: null,
      hasAudio: false,
      audioMime: null,
      isActive: true,
    };
    fb.vocab.push(v);
    markVocabDirty(v);
    return v;
  }
  const db = await getDb();
  const cardKind: VocabKind = input.kind ?? "vocab";
  // Default true so manual saves and click-to-define enter the SRS queue
  // immediately. Pack importer overrides to false. UPSERT promotes
  // inactive → active when a manual save touches a pack-imported row.
  const isActive = input.isActive === false ? 0 : 1;
  if (seed) {
    // Upsert with seeded SRS columns. The seed applies on INSERT, and
    // also adopts an existing row that has never been reviewed
    // (last_review IS NULL). That "pristine" case is the common one for
    // pack imports: a pack that ships both a flat "all words" collection
    // AND a textbook inserts the word (inactive, unseen) during the
    // collection pass, so by the time "previous-known" seeding runs the
    // row already exists. Without adopting it, the mastered/known seed
    // was silently dropped and "I know chapter N" marked almost nothing.
    // A row with real review history keeps its schedule untouched —
    // imports never overwrite genuine progress.
    await db.execute(
      `INSERT INTO vocab_entries (workspace_id, word, reading, gloss, source, kind, status, stability, difficulty, due_at, last_review, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT(workspace_id, word) DO UPDATE SET
         reading = COALESCE(excluded.reading, vocab_entries.reading),
         gloss   = COALESCE(excluded.gloss,   vocab_entries.gloss),
         is_active = MAX(vocab_entries.is_active, excluded.is_active),
         status      = CASE WHEN vocab_entries.last_review IS NULL THEN excluded.status      ELSE vocab_entries.status      END,
         stability   = CASE WHEN vocab_entries.last_review IS NULL THEN excluded.stability   ELSE vocab_entries.stability   END,
         difficulty  = CASE WHEN vocab_entries.last_review IS NULL THEN excluded.difficulty  ELSE vocab_entries.difficulty  END,
         due_at      = CASE WHEN vocab_entries.last_review IS NULL THEN excluded.due_at       ELSE vocab_entries.due_at      END,
         last_review = CASE WHEN vocab_entries.last_review IS NULL THEN excluded.last_review  ELSE vocab_entries.last_review END`,
      [
        input.workspaceId,
        input.word,
        input.reading ?? null,
        input.gloss ?? null,
        input.source ?? "manual",
        cardKind,
        seed.status,
        seedStability,
        seedDifficulty,
        seedDueAt,
        seedLastReview,
        isActive,
      ],
    );
  } else {
    // No SRS seed → inactive rows land as "unseen" (library content
    // the user hasn't opted into studying), active rows land as
    // "new" (fresh SRS-queue item). The UPSERT branch deliberately
    // does NOT update status — a re-import shouldn't demote a card
    // that's already further along (e.g., re-importing a textbook
    // after the user has been studying it for a week).
    const defaultStatus = isActive ? "new" : "unseen";
    await db.execute(
      `INSERT INTO vocab_entries (workspace_id, word, reading, gloss, source, kind, status, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(workspace_id, word) DO UPDATE SET
         reading = COALESCE(excluded.reading, vocab_entries.reading),
         gloss   = COALESCE(excluded.gloss,   vocab_entries.gloss),
         is_active = MAX(vocab_entries.is_active, excluded.is_active),
         -- Promote unseen → new when activation lights up. Other
         -- statuses (learning / review / mastered) are sticky so a
         -- re-import doesn't demote a card the user has been
         -- studying.
         status = CASE
           WHEN vocab_entries.status = 'unseen'
            AND MAX(vocab_entries.is_active, excluded.is_active) = 1
           THEN 'new'
           ELSE vocab_entries.status
         END`,
      [
        input.workspaceId,
        input.word,
        input.reading ?? null,
        input.gloss ?? null,
        input.source ?? "manual",
        cardKind,
        defaultStatus,
        isActive,
      ],
    );
  }
  const rows = await db.select<VocabRow[]>(
    `SELECT ${VOCAB_COLS} FROM vocab_entries WHERE workspace_id = $1 AND word = $2`,
    [input.workspaceId, input.word],
  );
  return rowToVocab(rows[0]);
}

/** Pull-side counterpart to `saveVocab`: applies a vocab row from the
 *  cloud to local SQLite, with full SRS state and pull-semantics.
 *
 *  `saveVocab` deliberately leaves an existing row's schedule alone
 *  ("imports never overwrite progress") — that's the right rule for
 *  Anki / HackChinese imports but the *wrong* rule for sync pull. When
 *  the cloud is the canonical multi-device store, a row that's been
 *  reviewed on another device must overwrite a stale local copy or
 *  cloud→local convergence never happens.
 *
 *  Resolution rule: if the row doesn't exist locally, INSERT the full
 *  cloud snapshot (status / stability / difficulty / learningStep /
 *  dueAt / lastReview / reviewCount). If it does exist, compare
 *  (lastReview, dueAt) watermarks — only overwrite the SRS columns
 *  when the cloud is at-or-ahead of local. Reading / gloss are merged
 *  unconditionally (text fields don't have a meaningful watermark).
 *
 *  Returns whether the row was inserted, updated, or skipped so the
 *  pull caller can report accurate counts.
 */
export async function applyCloudVocab(input: {
  workspaceId: number;
  word: string;
  reading: string | null;
  gloss: string | null;
  source: string;
  kind: VocabKind;
  isActive: boolean;
  status: VocabStatus;
  stability: number;
  difficulty: number;
  learningStep: number;
  dueAt: number | null;
  lastReview: number | null;
  reviewCount: number;
}): Promise<"inserted" | "updated" | "skipped"> {
  // Pull is desktop-only. HOSTED has no local store to converge into
  // (its canonical store *is* the cloud), so this is a programming
  // error if someone calls it from a HOSTED code path.
  if (HOSTED) {
    throw new Error(
      "applyCloudVocab called in HOSTED mode — pull only applies to the desktop's local store.",
    );
  }

  if (!isTauri()) {
    // Browser-only dev path — mirror the SQLite path against `fb`.
    const existing = fb.vocab.find(
      (v) => v.workspaceId === input.workspaceId && v.word === input.word,
    );
    if (!existing) {
      fb.vocab.push({
        id: fb.nextId++,
        workspaceId: input.workspaceId,
        word: input.word,
        reading: input.reading,
        gloss: input.gloss,
        source: input.source,
        kind: input.kind,
        status: input.status,
        stability: input.stability,
        difficulty: input.difficulty,
        learningStep: input.learningStep,
        dueAt: input.dueAt,
        lastReview: input.lastReview,
        reviewCount: input.reviewCount,
        createdAt: nowSec(),
        imageData: null,
        hasImage: false,
        cardNotes: null,
        frontExtra: null,
        translation: null,
        layout: null,
        hasAudio: false,
        audioMime: null,
        isActive: input.isActive,
      });
      return "inserted";
    }
    if (input.reading != null) existing.reading = input.reading;
    if (input.gloss != null) existing.gloss = input.gloss;
    if (cloudVocabWins(existing, input)) {
      // Adopt the cloud's activation too (not MAX) so an active→unseen
      // deactivation on the cloud actually converges down.
      existing.isActive = input.isActive;
      existing.status = input.status;
      existing.stability = input.stability;
      existing.difficulty = input.difficulty;
      existing.learningStep = input.learningStep;
      existing.dueAt = input.dueAt;
      existing.lastReview = input.lastReview;
      existing.reviewCount = input.reviewCount;
      return "updated";
    }
    return "skipped";
  }

  const db = await getDb();
  const rows = await db.select<
    { last_review: number | null; due_at: number | null }[]
  >(
    `SELECT last_review, due_at FROM vocab_entries WHERE workspace_id = $1 AND word = $2`,
    [input.workspaceId, input.word],
  );
  const existing = rows[0];
  const isActive01 = input.isActive ? 1 : 0;

  if (!existing) {
    await db.execute(
      `INSERT INTO vocab_entries
         (workspace_id, word, reading, gloss, source, kind, status,
          stability, difficulty, learning_step, due_at, last_review,
          review_count, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        input.workspaceId,
        input.word,
        input.reading,
        input.gloss,
        input.source,
        input.kind,
        input.status,
        input.stability,
        input.difficulty,
        input.learningStep,
        input.dueAt,
        input.lastReview,
        input.reviewCount,
        isActive01,
      ],
    );
    return "inserted";
  }

  const adopt = cloudVocabWins(
    { lastReview: existing.last_review, dueAt: existing.due_at },
    { lastReview: input.lastReview, dueAt: input.dueAt },
  );

  if (adopt) {
    await db.execute(
      `UPDATE vocab_entries SET
         reading       = COALESCE($1, reading),
         gloss         = COALESCE($2, gloss),
         is_active     = $3,
         status        = $4,
         stability     = $5,
         difficulty    = $6,
         learning_step = $7,
         due_at        = $8,
         last_review   = $9,
         review_count  = $10
       WHERE workspace_id = $11 AND word = $12`,
      [
        input.reading,
        input.gloss,
        isActive01,
        input.status,
        input.stability,
        input.difficulty,
        input.learningStep,
        input.dueAt,
        input.lastReview,
        input.reviewCount,
        input.workspaceId,
        input.word,
      ],
    );
    return "updated";
  }

  // Local row is the authority (it has fresher review activity than the
  // cloud) — merge only the text fields and leave SRS state + activation
  // alone, so a stale cloud row can't deactivate a card you're studying.
  await db.execute(
    `UPDATE vocab_entries SET
       reading = COALESCE($1, reading),
       gloss   = COALESCE($2, gloss)
     WHERE workspace_id = $3 AND word = $4`,
    [input.reading, input.gloss, input.workspaceId, input.word],
  );
  return "skipped";
}

/** Cloud row is at-or-ahead of local when its (lastReview, dueAt)
 *  watermark dominates. A NULL on either side is treated as 0 (never
 *  reviewed / never scheduled) — strictly weaker than any concrete
 *  timestamp, so a freshly-reviewed cloud row wins over a never-touched
 *  local one, and a never-touched cloud row never overwrites a real
 *  local schedule. Exported for unit tests. */
export function cloudIsFresher(
  local: { lastReview: number | null; dueAt: number | null },
  cloud: { lastReview: number | null; dueAt: number | null },
): boolean {
  const localLast = local.lastReview ?? 0;
  const cloudLast = cloud.lastReview ?? 0;
  if (cloudLast > localLast) return true;
  if (cloudLast < localLast) return false;
  // Same lastReview — defer to dueAt as a tie-breaker so a reschedule
  // (which moves dueAt without touching lastReview) still propagates.
  const localDue = local.dueAt ?? 0;
  const cloudDue = cloud.dueAt ?? 0;
  return cloudDue >= localDue;
}

/** Whether a pull should overwrite the local row's status + activation +
 *  SRS state with the cloud's. The cloud wins when:
 *
 *   1. it carries fresher review activity (`cloudIsFresher`), OR
 *   2. the local card has **never been reviewed** (`lastReview == null`).
 *
 *  Clause 2 is the fix for the sync mismatch where cloud-`unseen` words came
 *  down as locally `new` + active + due. Deactivation (active → unseen) and
 *  the never-studied `unseen` state carry no review activity, so the
 *  `cloudIsFresher` watermark can't see them — and `applyCloudVocab` used to
 *  MAX `is_active` (never deactivating) and skip the status. When the local
 *  card has no review history there's no SRS progress to protect, so the
 *  cloud's activation/status must converge down. A locally-reviewed card
 *  (clause 1 only) is still protected from a stale cloud deactivation.
 *
 *  Exported for unit tests. */
export function cloudVocabWins(
  local: { lastReview: number | null; dueAt: number | null },
  cloud: { lastReview: number | null; dueAt: number | null },
): boolean {
  if (local.lastReview == null) return true;
  return cloudIsFresher(local, cloud);
}

// On-demand fetch — list queries drop image_data to keep IPC payloads small.
export async function getVocabImage(vocabId: number): Promise<string | null> {
  if (!isTauri()) {
    const v = fb.vocab.find((x) => x.id === vocabId);
    return v?.imageData ?? null;
  }
  const db = await getDb();
  const rows = await db.select<{ image_data: string | null }[]>(
    `SELECT image_data FROM vocab_entries WHERE id = $1`,
    [vocabId],
  );
  return rows[0]?.image_data ?? null;
}

// HOSTED-only: per-workspace vocab cache so the popover doesn't fire
// a full list fetch on every chat-message render. Lifetime = page
// session; invalidated by any write that mutates vocab via the
// helper below. Promise-valued so concurrent callers share one
// in-flight request.
const hostedVocabCache = new Map<number, Promise<VocabEntry[]>>();

function hostedInvalidateVocabCache(workspaceId?: number): void {
  if (workspaceId == null) hostedVocabCache.clear();
  else hostedVocabCache.delete(workspaceId);
}

async function hostedGetVocab(workspaceId: number): Promise<VocabEntry[]> {
  let p = hostedVocabCache.get(workspaceId);
  if (!p) {
    p = cloudListVocab(workspaceId).catch((err) => {
      // Don't poison the cache — a one-off failure shouldn't lock
      // the popover into "no vocab forever". Drop and rethrow so
      // the next caller retries.
      hostedVocabCache.delete(workspaceId);
      throw err;
    });
    hostedVocabCache.set(workspaceId, p);
  }
  return p;
}

export async function lookupVocabBatch(
  workspaceId: number,
  words: string[],
): Promise<Map<string, VocabEntry>> {
  const out = new Map<string, VocabEntry>();
  if (words.length === 0) return out;
  if (HOSTED) {
    // Was missing — desktop's local SQLite path has a fast IN-list
    // query; HOSTED needs to round-trip. We list the workspace's
    // full vocab once (cached) and filter in memory. Without this
    // branch, status colors / known-learning highlights never light
    // up in HOSTED because the popover never finds the saved row.
    try {
      const wanted = new Set(words);
      const all = await hostedGetVocab(workspaceId);
      for (const v of all) {
        if (wanted.has(v.word)) out.set(v.word, v);
      }
    } catch (err) {
      console.warn("cloud vocab lookup failed", err);
    }
    return out;
  }
  if (!isTauri()) {
    for (const w of fb.vocab) {
      if (w.workspaceId === workspaceId && words.includes(w.word)) {
        out.set(w.word, w);
      }
    }
    return out;
  }
  const db = await getDb();
  const placeholders = words.map((_, i) => `$${i + 2}`).join(", ");
  const rows = await db.select<VocabRow[]>(
    `SELECT ${VOCAB_COLS} FROM vocab_entries WHERE workspace_id = $1 AND word IN (${placeholders})`,
    [workspaceId, ...words],
  );
  for (const r of rows) out.set(r.word, rowToVocab(r));
  return out;
}

export async function reviewVocab(input: {
  id: number;
  status: VocabStatus;
  stability: number;
  difficulty: number;
  // Pass 0 for review-phase grades.
  learningStep: number;
  dueAt: number | null;
  // Some auto-status flips don't have a grade; the row is logged with
  // grade='good' as a placeholder so the history stays complete.
  grade?: Grade;
  reviewedAt?: number;
  /** HOSTED only — the workspace the card belongs to. Pass it when
   *  the caller knows it (Flashcards view, hover popover) so we go
   *  straight to the right endpoint. Omit for internal callers
   *  (auto-status flips from random surfaces) and we'll fall back to
   *  the probe-every-workspace walk. Desktop ignores this field —
   *  vocab ids are globally unique in local SQLite. */
  workspaceId?: number;
}): Promise<void> {
  if (HOSTED) {
    if (input.workspaceId != null) {
      // Fast path. Single round-trip when the caller knows where
      // the card lives. Eliminates the listWorkspaces + N-try
      // probe walk that used to fire on every grade.
      await cloudReviewVocab({
        workspaceId: input.workspaceId,
        vocabId: input.id,
        status: input.status,
        stability: input.stability,
        difficulty: input.difficulty,
        learningStep: input.learningStep,
        dueAt: input.dueAt,
        grade: input.grade,
        reviewedAt: input.reviewedAt,
      });
    } else {
      // Legacy fallback — used by call sites without a workspace
      // in scope (some demo/seed paths). Walks workspaces, catches
      // the "vocab not found" 404 on the wrong ones.
      await probeWorkspace((workspaceId) =>
        cloudReviewVocab({
          workspaceId,
          vocabId: input.id,
          status: input.status,
          stability: input.stability,
          difficulty: input.difficulty,
          learningStep: input.learningStep,
          dueAt: input.dueAt,
          grade: input.grade,
          reviewedAt: input.reviewedAt,
        }).then(() => true),
      );
    }
    // The review updated SRS state — drop the cached vocab list so
    // the next popover read picks up the new lastReview / dueAt.
    hostedInvalidateVocabCache();
    return;
  }
  if (!isTauri()) {
    const v = fb.vocab.find((x) => x.id === input.id);
    if (!v) return;
    const prevStatus = v.status;
    const prevStability = v.stability;
    const prevDueAt = v.dueAt;
    const reviewedAt = input.reviewedAt ?? nowSec();
    v.status = input.status;
    v.stability = input.stability;
    v.difficulty = input.difficulty;
    v.learningStep = input.learningStep;
    v.dueAt = input.dueAt;
    v.lastReview = reviewedAt;
    v.reviewCount += 1;
    // Log the review row so the dashboard's growth chart has data even in
    // the in-memory fallback.
    fb.reviews.push({
      id: fb.nextId++,
      vocabId: input.id,
      grade: (input.grade ?? "good") as Grade,
      prevStatus,
      newStatus: input.status,
      prevStability,
      newStability: input.stability,
      prevDueAt,
      newDueAt: input.dueAt,
      reviewedAt,
    });
    markVocabDirty(v);
    return;
  }
  const db = await getDb();
  // Read the previous SRS snapshot first so the review log captures
  // the before/after diff. Same-transaction would be nicer but
  // tauri-plugin-sql doesn't expose a TX API — two writes is still
  // O(1) per review and the worst case (write succeeds, log fails)
  // is missing a single audit row, not corrupted data.
  const prevRows = await db.select<{
    status: string;
    stability: number;
    due_at: number | null;
  }[]>("SELECT status, stability, due_at FROM vocab_entries WHERE id = $1", [
    input.id,
  ]);
  const prev = prevRows[0];

  await db.execute(
    `UPDATE vocab_entries SET status=$1, stability=$2, difficulty=$3, learning_step=$4, due_at=$5,
       last_review=strftime('%s','now'), review_count=review_count+1 WHERE id=$6`,
    [
      input.status,
      input.stability,
      input.difficulty,
      input.learningStep,
      input.dueAt,
      input.id,
    ],
  );

  await db.execute(
    `INSERT INTO vocab_reviews
        (vocab_id, grade, prev_status, new_status, prev_stability, new_stability, prev_due_at, new_due_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.grade ?? "good",
      prev?.status ?? null,
      input.status,
      prev?.stability ?? null,
      input.stability,
      prev?.due_at ?? null,
      input.dueAt,
    ],
  );
}

// Promote cards from "library" (imported from a pack but not in active SRS)
// to active learning. Idempotent.
export async function activateVocab(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  if (HOSTED) {
    // Same probe pattern as elsewhere — try each workspace; the
    // cloud's `updateMany` only matches ids that belong to the
    // (userId, workspaceId) pair, so a wrong workspace returns
    // `updated=0` which we keep looping past.
    const all = await cloudListWorkspaces();
    for (const ws of all) {
      const n = await cloudActivateVocab(ws.id, ids);
      if (n > 0) {
        hostedInvalidateVocabCache(ws.id);
        return;
      }
    }
    return;
  }
  if (!isTauri()) {
    for (const id of ids) {
      const v = fb.vocab.find((x) => x.id === id);
      if (v) {
        v.isActive = true;
        // Mirror the SQL update below: promote unseen → new on
        // activation so the card stops being library-only.
        if (v.status === "unseen") v.status = "new";
      }
    }
    return;
  }
  const db = await getDb();
  // Build the IN-list dynamically; tauri-plugin-sql doesn't expand
  // arrays, so we have to spell out each placeholder.
  //
  // Promote status `unseen` → `new` when activating. Other statuses
  // are sticky: a re-activate shouldn't reset a card that's already
  // in the learning ladder.
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  await db.execute(
    `UPDATE vocab_entries
        SET is_active = 1,
            status = CASE WHEN status = 'unseen' THEN 'new' ELSE status END
      WHERE id IN (${placeholders})`,
    ids,
  );
}

export async function getActivationSummary(workspaceId: number): Promise<{
  active: number;
  library: number;
}> {
  if (HOSTED) {
    const { active, library } = await cloudActivationSummary(workspaceId);
    return { active, library };
  }
  if (!isTauri()) {
    let active = 0;
    let library = 0;
    for (const v of fb.vocab) {
      if (v.workspaceId !== workspaceId) continue;
      if (v.isActive === false) library++;
      else active++;
    }
    return { active, library };
  }
  const db = await getDb();
  const rows = await db.select<{ is_active: number; n: number }[]>(
    `SELECT is_active, COUNT(*) AS n FROM vocab_entries
        WHERE workspace_id = $1
        GROUP BY is_active`,
    [workspaceId],
  );
  const out = { active: 0, library: 0 };
  for (const r of rows) {
    if (r.is_active > 0) out.active = r.n;
    else out.library = r.n;
  }
  return out;
}

export type VocabReview = {
  id: number;
  vocabId: number;
  grade: Grade;
  prevStatus: VocabStatus | null;
  newStatus: VocabStatus;
  prevStability: number | null;
  newStability: number;
  prevDueAt: number | null;
  newDueAt: number | null;
  reviewedAt: number;
};

export type VocabReviewStats = {
  totalReviews: number;
  byGrade: Record<Grade, number>;
  // Number of times status moved back to 'learning' from review/mastered.
  lapses: number;
  firstReviewedAt: number | null;
  lastReviewedAt: number | null;
};

// Sorted ascending by reviewedAt so consumers can replay forward.
/** Unix-seconds timestamp at the user's local midnight today. Exported
 *  so the test suite can call it without monkey-patching `Date`. */
export function startOfLocalDayUnix(now: Date = new Date()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Math.floor(start.getTime() / 1000);
}

/** Has any FSRS grade landed for this workspace since local midnight?
 *
 *  Used by the flashcards host to decide whether to pre-flip drill mode
 *  on the prestart screen — the design is "first study mode of the day
 *  anchors the SRS; everything after auto-drills so intervals don't
 *  double-step." A read-only check; no schema additions.
 *
 *  Storage paths:
 *   - HOSTED   : reuse `cloudListWorkspaceReviews(workspaceId, since)`
 *                and check non-empty. Avoids adding a new endpoint.
 *   - Desktop  : single SQL with a JOIN through `vocab_entries` to
 *                resolve the workspace filter (`vocab_reviews` has no
 *                workspace_id column).
 *   - In-mem fb: filter `fb.reviews` by `reviewedAt >= since` and the
 *                workspace's vocab id set — same shape as the SQL but
 *                in JS so the browser-only build (no Tauri) still works. */
export async function hasReviewedToday(workspaceId: number): Promise<boolean> {
  const since = startOfLocalDayUnix();
  if (HOSTED) {
    try {
      const recent = await cloudListWorkspaceReviews(workspaceId, since);
      return recent.length > 0;
    } catch (err) {
      // Failing closed (treat as "not anchored yet") means a flaky
      // network gives the user a fresh SRS pass instead of silently
      // auto-drilling them — the safer wrong answer.
      console.warn("[hasReviewedToday] cloud lookup failed", err);
      return false;
    }
  }
  if (!isTauri()) {
    const wsVocabIds = new Set(
      fb.vocab.filter((v) => v.workspaceId === workspaceId).map((v) => v.id),
    );
    return fb.reviews.some(
      (r) => wsVocabIds.has(r.vocabId) && r.reviewedAt >= since,
    );
  }
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    `SELECT 1 AS n FROM vocab_reviews r
       JOIN vocab_entries v ON v.id = r.vocab_id
      WHERE v.workspace_id = $1 AND r.reviewed_at >= $2
      LIMIT 1`,
    [workspaceId, since],
  );
  return rows.length > 0;
}

export async function listWorkspaceReviews(
  workspaceId: number,
  limit = 100_000,
): Promise<VocabReview[]> {
  if (HOSTED) {
    // The cloud endpoint paginates via a `since` cursor — we keep
    // pulling until we've collected `limit` rows or the page is
    // short. Typical workspaces have under 5k reviews, so this
    // usually terminates in 1–2 hops.
    const out: VocabReview[] = [];
    let since: number | undefined;
    while (out.length < limit) {
      const page = await cloudListWorkspaceReviews(workspaceId, since);
      out.push(...page);
      if (page.length === 0 || page.length < 5000) break;
      const last = page[page.length - 1];
      since = last.reviewedAt;
    }
    return out.slice(-limit);
  }
  if (!isTauri()) {
    const wsVocabIds = new Set(
      fb.vocab.filter((v) => v.workspaceId === workspaceId).map((v) => v.id),
    );
    return fb.reviews
      .filter((r) => wsVocabIds.has(r.vocabId))
      .slice()
      .sort((a, b) => a.reviewedAt - b.reviewedAt)
      .slice(-limit);
  }
  const db = await getDb();
  type Row = {
    id: number;
    vocab_id: number;
    grade: string;
    prev_status: string | null;
    new_status: string;
    prev_stability: number | null;
    new_stability: number;
    prev_due_at: number | null;
    new_due_at: number | null;
    reviewed_at: number;
  };
  const rows = await db.select<Row[]>(
    `SELECT r.id, r.vocab_id, r.grade, r.prev_status, r.new_status,
            r.prev_stability, r.new_stability, r.prev_due_at, r.new_due_at,
            r.reviewed_at
       FROM vocab_reviews r
       JOIN vocab_entries v ON v.id = r.vocab_id
      WHERE v.workspace_id = $1
      ORDER BY r.reviewed_at ASC
      LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    vocabId: r.vocab_id,
    grade: r.grade as Grade,
    prevStatus: r.prev_status as VocabStatus | null,
    newStatus: r.new_status as VocabStatus,
    prevStability: r.prev_stability,
    newStability: r.new_stability,
    prevDueAt: r.prev_due_at,
    newDueAt: r.new_due_at,
    reviewedAt: r.reviewed_at,
  }));
}

/** Distinct vocab entries reviewed since local midnight, ordered by when
 *  each was first studied today — the pool for "study today's cards
 *  again" after the daily SRS pass is done. Storage paths mirror
 *  `hasReviewedToday`; the entry fetch reuses `listVocabByIds`, which
 *  already branches per backend. */
export async function listVocabReviewedToday(
  workspaceId: number,
): Promise<VocabEntry[]> {
  const since = startOfLocalDayUnix();
  let reviews: { vocabId: number; reviewedAt: number }[];
  if (HOSTED) {
    reviews = await cloudListWorkspaceReviews(workspaceId, since);
  } else if (!isTauri()) {
    const wsVocabIds = new Set(
      fb.vocab.filter((v) => v.workspaceId === workspaceId).map((v) => v.id),
    );
    reviews = fb.reviews.filter(
      (r) => wsVocabIds.has(r.vocabId) && r.reviewedAt >= since,
    );
  } else {
    const db = await getDb();
    const rows = await db.select<{ vocab_id: number; reviewed_at: number }[]>(
      `SELECT r.vocab_id, r.reviewed_at
         FROM vocab_reviews r
         JOIN vocab_entries v ON v.id = r.vocab_id
        WHERE v.workspace_id = $1 AND r.reviewed_at >= $2`,
      [workspaceId, since],
    );
    reviews = rows.map((r) => ({
      vocabId: r.vocab_id,
      reviewedAt: r.reviewed_at,
    }));
  }
  const order: number[] = [];
  const seen = new Set<number>();
  for (const r of [...reviews].sort((a, b) => a.reviewedAt - b.reviewedAt)) {
    if (seen.has(r.vocabId)) continue;
    seen.add(r.vocabId);
    order.push(r.vocabId);
  }
  if (order.length === 0) return [];
  const entries = await listVocabByIds(workspaceId, seen);
  const byId = new Map(entries.map((v) => [v.id, v]));
  // A card reviewed today then deleted has a review row but no entry —
  // the lookup is sparse on purpose.
  return order.flatMap((id) => byId.get(id) ?? []);
}

export async function listVocabReviews(
  vocabId: number,
  limit = 100,
): Promise<VocabReview[]> {
  if (!isTauri()) return [];
  const db = await getDb();
  type Row = {
    id: number;
    vocab_id: number;
    grade: string;
    prev_status: string | null;
    new_status: string;
    prev_stability: number | null;
    new_stability: number;
    prev_due_at: number | null;
    new_due_at: number | null;
    reviewed_at: number;
  };
  const rows = await db.select<Row[]>(
    `SELECT id, vocab_id, grade, prev_status, new_status,
            prev_stability, new_stability, prev_due_at, new_due_at, reviewed_at
       FROM vocab_reviews
      WHERE vocab_id = $1
      ORDER BY reviewed_at DESC
      LIMIT $2`,
    [vocabId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    vocabId: r.vocab_id,
    grade: r.grade as Grade,
    prevStatus: r.prev_status as VocabStatus | null,
    newStatus: r.new_status as VocabStatus,
    prevStability: r.prev_stability,
    newStability: r.new_stability,
    prevDueAt: r.prev_due_at,
    newDueAt: r.new_due_at,
    reviewedAt: r.reviewed_at,
  }));
}

export async function getVocabReviewStats(
  vocabId: number,
): Promise<VocabReviewStats> {
  const empty: VocabReviewStats = {
    totalReviews: 0,
    byGrade: { again: 0, hard: 0, good: 0, easy: 0 },
    lapses: 0,
    firstReviewedAt: null,
    lastReviewedAt: null,
  };
  if (!isTauri()) return empty;
  const db = await getDb();
  const counts = await db.select<{ grade: string; n: number }[]>(
    "SELECT grade, COUNT(*) AS n FROM vocab_reviews WHERE vocab_id = $1 GROUP BY grade",
    [vocabId],
  );
  const range = await db.select<{ first_at: number | null; last_at: number | null }[]>(
    "SELECT MIN(reviewed_at) AS first_at, MAX(reviewed_at) AS last_at FROM vocab_reviews WHERE vocab_id = $1",
    [vocabId],
  );
  // Lapses = reviews that knocked the card back into 'learning' from
  // a stronger status. Captures FSRS-style relapse counts without
  // needing a separate column on vocab_entries.
  const lapseRows = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM vocab_reviews
        WHERE vocab_id = $1 AND new_status = 'learning'
          AND prev_status IN ('review','mastered')`,
    [vocabId],
  );
  const out: VocabReviewStats = {
    totalReviews: 0,
    byGrade: { again: 0, hard: 0, good: 0, easy: 0 },
    lapses: lapseRows[0]?.n ?? 0,
    firstReviewedAt: range[0]?.first_at ?? null,
    lastReviewedAt: range[0]?.last_at ?? null,
  };
  for (const r of counts) {
    const g = r.grade as Grade;
    if (g in out.byGrade) {
      out.byGrade[g] = r.n;
      out.totalReviews += r.n;
    }
  }
  return out;
}

// For `audioData`, pass raw bytes to set, null to clear, omit to leave
// unchanged. Set/clear `audioMime` alongside so the row stays consistent.
export async function updateVocabFields(input: {
  id: number;
  reading?: string | null;
  gloss?: string | null;
  imageData?: string | null;
  cardNotes?: string | null;
  frontExtra?: string | null;
  translation?: string | null;
  /** Per-card front/back layout, JSON-stringified
   *  ({@link import("./card-layout").CardLayout}). `null` clears the
   *  override and reverts to the per-kind default. */
  layout?: string | null;
  audioData?: Uint8Array | null;
  audioMime?: string | null;
}): Promise<void> {
  if (HOSTED) {
    // The HOSTED PATCH covers reading / gloss / cardNotes / frontExtra
    // (and a handful of FSRS fields). Image + audio bytes aren't
    // exposed via the workspace vocab PATCH yet — those routes still
    // need a dedicated /audio + /image endpoint. Document the gap
    // here and only send the text fields. Surface the dropped bytes
    // as a console.warn so callers can notice; this matches the
    // desktop's read/write semantics on the text columns.
    if (input.imageData !== undefined || input.audioData !== undefined) {
      console.warn(
        "updateVocabFields(HOSTED): image/audio bytes are not wired to the cloud yet — only text fields will persist.",
      );
    }
    await probeWorkspace((workspaceId) =>
      cloudUpdateVocab({
        workspaceId,
        vocabId: input.id,
        patch: {
          reading: input.reading,
          gloss: input.gloss,
          cardNotes: input.cardNotes,
          frontExtra: input.frontExtra,
          translation: input.translation,
          layout: input.layout,
        },
      }).then(() => true),
    );
    hostedInvalidateVocabCache();
    return;
  }
  if (!isTauri()) {
    const v = fb.vocab.find((x) => x.id === input.id);
    if (!v) return;
    if (input.reading !== undefined) v.reading = input.reading;
    if (input.gloss !== undefined) v.gloss = input.gloss;
    if (input.imageData !== undefined) v.imageData = input.imageData;
    if (input.cardNotes !== undefined) v.cardNotes = input.cardNotes;
    if (input.frontExtra !== undefined) v.frontExtra = input.frontExtra;
    if (input.translation !== undefined) v.translation = input.translation;
    if (input.layout !== undefined) v.layout = input.layout;
    if (input.audioData !== undefined) {
      v.hasAudio = input.audioData != null && input.audioData.byteLength > 0;
    }
    if (input.audioMime !== undefined) v.audioMime = input.audioMime;
    return;
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.reading !== undefined) {
    sets.push(`reading = $${sets.length + 1}`);
    values.push(input.reading);
  }
  if (input.gloss !== undefined) {
    sets.push(`gloss = $${sets.length + 1}`);
    values.push(input.gloss);
  }
  if (input.imageData !== undefined) {
    sets.push(`image_data = $${sets.length + 1}`);
    values.push(input.imageData);
  }
  if (input.cardNotes !== undefined) {
    sets.push(`card_notes = $${sets.length + 1}`);
    values.push(input.cardNotes);
  }
  if (input.frontExtra !== undefined) {
    sets.push(`front_extra = $${sets.length + 1}`);
    values.push(input.frontExtra);
  }
  if (input.translation !== undefined) {
    sets.push(`translation = $${sets.length + 1}`);
    values.push(input.translation);
  }
  if (input.layout !== undefined) {
    sets.push(`layout = $${sets.length + 1}`);
    values.push(input.layout);
  }
  if (input.audioData !== undefined) {
    sets.push(`audio_data = $${sets.length + 1}`);
    // tauri-plugin-sql accepts BLOBs as `number[]` of byte values. Pass
    // null straight through to clear the column.
    values.push(input.audioData == null ? null : Array.from(input.audioData));
  }
  if (input.audioMime !== undefined) {
    sets.push(`audio_mime = $${sets.length + 1}`);
    values.push(input.audioMime);
  }
  if (sets.length === 0) return;
  values.push(input.id);
  const db = await getDb();
  await db.execute(
    `UPDATE vocab_entries SET ${sets.join(", ")} WHERE id = $${sets.length + 1}`,
    values,
  );
}

// List queries skip the BLOB to keep IPC payloads small; callers that need
// the bytes hit this on demand.
export async function getVocabAudio(
  id: number,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!isTauri()) {
    const v = fb.vocab.find((x) => x.id === id);
    if (!v?.hasAudio) return null;
    // Empty buffer in fallback mode — exists() checks work without surprises.
    return { bytes: new Uint8Array(), mime: v.audioMime ?? "audio/mpeg" };
  }
  const db = await getDb();
  const rows = await db.select<{
    audio_data: number[] | null;
    audio_mime: string | null;
  }[]>(
    "SELECT audio_data, audio_mime FROM vocab_entries WHERE id = $1",
    [id],
  );
  const r = rows[0];
  if (!r || r.audio_data == null) return null;
  return {
    bytes: Uint8Array.from(r.audio_data),
    mime: r.audio_mime ?? "audio/mpeg",
  };
}

// Auto-creates the row if missing. `createdAt` is honoured only by the
// in-memory fallback (for the marketing seed); SQLite uses the column DEFAULT.
export async function setVocabStatus(input: {
  workspaceId: number;
  word: string;
  reading?: string | null;
  gloss?: string | null;
  status: VocabStatus;
  createdAt?: number;
}): Promise<VocabEntry> {
  const v = await saveVocab({
    workspaceId: input.workspaceId,
    word: input.word,
    reading: input.reading,
    gloss: input.gloss,
    source: "manual",
  });
  // Setting a card (back) to "new" means "I haven't studied this yet":
  // wipe any prior SRS history so it schedules fresh AND Vocab recall
  // greets it with the first-time "study this word first" intro (which
  // keys on last_review IS NULL). Every other status is the user
  // marking the word as engaged-with, so we stamp last_review = now —
  // that's what surfaces it on the dashboard's vocab-growth chart, which
  // skips rows that have never been reviewed.
  const resetToNew = input.status === "new";
  if (HOSTED) {
    const updated = await cloudUpdateVocab({
      workspaceId: input.workspaceId,
      vocabId: v.id,
      patch: resetToNew
        ? {
            status: "new",
            lastReview: null,
            reviewCount: 0,
            stability: 0,
            difficulty: 5,
            learningStep: 0,
            dueAt: null,
          }
        : { status: input.status, lastReview: nowSec() },
    });
    hostedInvalidateVocabCache(input.workspaceId);
    return updated;
  }
  if (!isTauri()) {
    const found = fb.vocab.find((x) => x.id === v.id);
    if (found) {
      found.status = input.status;
      if (resetToNew) {
        found.lastReview = null;
        found.reviewCount = 0;
        found.stability = 0;
        found.difficulty = 5;
        found.learningStep = 0;
        found.dueAt = null;
      } else {
        found.lastReview = nowSec();
      }
      if (typeof input.createdAt === "number") found.createdAt = input.createdAt;
    }
    return found ?? v;
  }
  const db = await getDb();
  if (resetToNew) {
    await db.execute(
      `UPDATE vocab_entries
         SET status = 'new', last_review = NULL, review_count = 0,
             stability = 0, difficulty = 5, learning_step = 0, due_at = NULL
       WHERE id = $1`,
      [v.id],
    );
    return {
      ...v,
      status: "new",
      lastReview: null,
      reviewCount: 0,
      stability: 0,
      difficulty: 5,
      learningStep: 0,
      dueAt: null,
    };
  }
  await db.execute(
    "UPDATE vocab_entries SET status = $1, last_review = strftime('%s','now') WHERE id = $2",
    [input.status, v.id],
  );
  return { ...v, status: input.status, lastReview: nowSec() };
}

export async function deleteVocab(id: number): Promise<void> {
  if (HOSTED) {
    // The cloud route is scoped under /workspaces/:id/vocab/:vocabId,
    // so we need a workspaceId. Look it up first from the cloud
    // list — desktop callers pass just an id today, and we want to
    // preserve that contract from the call sites.
    const all = await cloudListWorkspaces();
    for (const ws of all) {
      // Best-effort: probe each workspace until one accepts the
      // delete. A non-match is a 404 we swallow.
      try {
        await cloudDeleteVocab(ws.id, id);
        hostedInvalidateVocabCache(ws.id);
        return;
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("not found")) {
          throw err;
        }
      }
    }
    return;
  }
  if (!isTauri()) {
    fb.vocab = fb.vocab.filter((v) => v.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM vocab_entries WHERE id = $1", [id]);
}

// Settings → Storage → "Reset vocabulary". Returns the number of rows
// deleted so the UI can show feedback.
export async function wipeWorkspaceVocab(workspaceId: number): Promise<number> {
  if (HOSTED) {
    const n = await cloudWipeWorkspaceVocab(workspaceId);
    hostedInvalidateVocabCache(workspaceId);
    return n;
  }
  if (!isTauri()) {
    const before = fb.vocab.length;
    fb.vocab = fb.vocab.filter((v) => v.workspaceId !== workspaceId);
    fb.collections = (fb.collections ?? []).filter(
      (c) => c.workspaceId !== workspaceId,
    );
    fb.collectionWords = [];
    return before - fb.vocab.length;
  }
  const db = await getDb();
  // Delete collection_words → collections → vocab in order. Explicit even
  // though ON DELETE CASCADE on vocab_entries → collection_words covers it.
  const before = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM vocab_entries WHERE workspace_id = $1",
    [workspaceId],
  );
  await db.execute(
    `DELETE FROM collection_words
     WHERE collection_id IN (SELECT id FROM collections WHERE workspace_id = $1)`,
    [workspaceId],
  );
  await db.execute("DELETE FROM collections WHERE workspace_id = $1", [
    workspaceId,
  ]);
  await db.execute("DELETE FROM vocab_entries WHERE workspace_id = $1", [
    workspaceId,
  ]);
  // Reclaim freed pages so the file shrinks after a large wipe.
  try {
    await db.execute("VACUUM");
  } catch {
    /* VACUUM fails inside a transaction; ignore. */
  }
  return before[0]?.n ?? 0;
}

type SessionRow = {
  id: number;
  workspace_id: number;
  kind: string;
  started_at: number;
  ended_at: number | null;
  duration_secs: number | null;
  words_seen: number;
  words_saved: number;
  notes?: string | null;
};

const SESSION_COLS =
  "id, workspace_id, kind, started_at, ended_at, duration_secs, words_seen, words_saved, notes";

function rowToSession(r: SessionRow): StudySession {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSecs: r.duration_secs,
    wordsSeen: r.words_seen,
    wordsSaved: r.words_saved,
    notes: r.notes ?? null,
  };
}

export async function startSession(input: {
  workspaceId: number;
  kind?: string;
}): Promise<StudySession> {
  if (HOSTED) {
    return cloudCreateSession({
      workspaceId: input.workspaceId,
      kind: input.kind,
      startedAt: nowSec(),
    });
  }
  if (!isTauri()) {
    const s: StudySession = {
      id: fb.nextId++,
      workspaceId: input.workspaceId,
      kind: input.kind ?? "chat",
      startedAt: nowSec(),
      endedAt: null,
      durationSecs: null,
      wordsSeen: 0,
      wordsSaved: 0,
      notes: null,
    };
    fb.sessions.push(s);
    return s;
  }
  const db = await getDb();
  const r = await db.execute(
    "INSERT INTO study_sessions (workspace_id, kind, started_at) VALUES ($1, $2, strftime('%s','now'))",
    [input.workspaceId, input.kind ?? "chat"],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<SessionRow[]>(
    `SELECT ${SESSION_COLS} FROM study_sessions WHERE id = $1`,
    [id],
  );
  return rowToSession(rows[0]);
}

export async function endSession(id: number): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudUpdateSession({
        workspaceId,
        sessionId: id,
        patch: { endedAt: nowSec() },
      }),
    );
    return;
  }
  if (!isTauri()) {
    const s = fb.sessions.find((x) => x.id === id);
    if (!s) return;
    s.endedAt = nowSec();
    s.durationSecs = s.endedAt - s.startedAt;
    return;
  }
  const db = await getDb();
  await db.execute(
    `UPDATE study_sessions
     SET ended_at = strftime('%s','now'),
         duration_secs = strftime('%s','now') - started_at
     WHERE id = $1`,
    [id],
  );
}

/**
 * Close any study_sessions rows that were started but never finalized
 * — typically because an earlier app version (or a hard quit) didn't
 * fire endSession on unmount. Without this backfill the Skills Radar
 * shows zero hours for kinds whose recent sessions are all stuck open
 * (durationSecs=null), even though the user clearly worked. We cap
 * the inferred duration at `maxDurationSecs` so a session that was
 * started days ago doesn't suddenly claim 72 hours of study; 60
 * minutes is the median realistic upper bound for an unsupervised
 * close. Idempotent — re-running finds nothing on a clean store.
 */
export async function finalizeStaleSessions(
  workspaceId: number,
  maxDurationSecs = 60 * 60,
): Promise<void> {
  if (HOSTED) return; // server-side cleanup TBD; not blocking the desktop fix
  const now = nowSec();
  if (!isTauri()) {
    for (const s of fb.sessions) {
      if (s.workspaceId !== workspaceId) continue;
      if (s.endedAt != null && s.durationSecs != null) continue;
      const elapsed = now - s.startedAt;
      if (elapsed <= 0) continue;
      const dur = Math.min(elapsed, maxDurationSecs);
      s.endedAt = s.startedAt + dur;
      s.durationSecs = dur;
    }
    return;
  }
  const db = await getDb();
  await db.execute(
    `UPDATE study_sessions
     SET ended_at      = started_at + MIN(strftime('%s','now') - started_at, $1),
         duration_secs = MIN(strftime('%s','now') - started_at, $1)
     WHERE workspace_id = $2
       AND (ended_at IS NULL OR duration_secs IS NULL)
       AND strftime('%s','now') - started_at > 0`,
    [maxDurationSecs, workspaceId],
  );
}

export async function bumpSession(id: number, field: "words_seen" | "words_saved", by = 1): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudUpdateSession({
        workspaceId,
        sessionId: id,
        patch:
          field === "words_seen"
            ? { bump: { wordsSeen: by } }
            : { bump: { wordsSaved: by } },
      }),
    );
    return;
  }
  if (!isTauri()) {
    const s = fb.sessions.find((x) => x.id === id);
    if (!s) return;
    if (field === "words_seen") s.wordsSeen += by;
    else s.wordsSaved += by;
    return;
  }
  const db = await getDb();
  await db.execute(
    `UPDATE study_sessions SET ${field} = ${field} + $1 WHERE id = $2`,
    [by, id],
  );
}

// One-shot logger for a completed activity (italki lesson, tutor session,
// etc.). `when` is the END time — started_at = when - durationSecs so the
// session lands in the right heatmap / streak slot.
export async function logSession(input: {
  workspaceId: number;
  kind: string;
  durationSecs: number;
  when?: number;
  notes?: string | null;
}): Promise<StudySession> {
  const endedAt = input.when ?? nowSec();
  const startedAt = endedAt - Math.max(0, input.durationSecs);
  // Non-null `notes` is the marker `listManualSessions` uses to distinguish
  // manual logs from in-app startSession rows (which leave notes NULL).
  const notes = input.notes ?? "";
  if (HOSTED) {
    return cloudCreateSession({
      workspaceId: input.workspaceId,
      kind: input.kind,
      startedAt,
      endedAt,
      durationSecs: input.durationSecs,
      notes,
    });
  }
  if (!isTauri()) {
    const s: StudySession = {
      id: fb.nextId++,
      workspaceId: input.workspaceId,
      kind: input.kind,
      startedAt,
      endedAt,
      durationSecs: input.durationSecs,
      wordsSeen: 0,
      wordsSaved: 0,
      notes,
    };
    fb.sessions.push(s);
    return s;
  }
  const db = await getDb();
  const r = await db.execute(
    `INSERT INTO study_sessions
       (workspace_id, kind, started_at, ended_at, duration_secs, notes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.workspaceId,
      input.kind,
      startedAt,
      endedAt,
      input.durationSecs,
      notes,
    ],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<SessionRow[]>(
    `SELECT ${SESSION_COLS} FROM study_sessions WHERE id = $1`,
    [id],
  );
  return rowToSession(rows[0]);
}

export async function listSessions(workspaceId: number): Promise<StudySession[]> {
  if (HOSTED) return cloudListSessions(workspaceId);
  if (!isTauri())
    return fb.sessions
      .filter((s) => s.workspaceId === workspaceId)
      .sort((a, b) => b.startedAt - a.startedAt);
  const db = await getDb();
  const rows = await db.select<SessionRow[]>(
    `SELECT ${SESSION_COLS} FROM study_sessions WHERE workspace_id = $1 ORDER BY started_at DESC`,
    [workspaceId],
  );
  return rows.map(rowToSession);
}

// Sessions created via logSession. Discriminator is `notes IS NOT NULL`.
// Excludes in-flight sessions (ended_at IS NULL).
export async function listManualSessions(
  workspaceId: number,
  limit = 25,
): Promise<StudySession[]> {
  if (HOSTED) {
    // The cloud list returns ALL sessions; filter to manual ones
    // (notes set + ended) here. Cheap because typical users log <100
    // sessions and we cap at `limit` anyway.
    const all = await cloudListSessions(workspaceId);
    return all
      .filter((s) => s.notes != null && s.endedAt != null)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.id - a.id)
      .slice(0, limit);
  }
  if (!isTauri()) {
    return fb.sessions
      .filter((s) => s.workspaceId === workspaceId && s.notes !== null && s.endedAt != null)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.id - a.id)
      .slice(0, limit);
  }
  const db = await getDb();
  const rows = await db.select<SessionRow[]>(
    `SELECT ${SESSION_COLS} FROM study_sessions
       WHERE workspace_id = $1 AND notes IS NOT NULL AND ended_at IS NOT NULL
     ORDER BY ended_at DESC, id DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map(rowToSession);
}

export async function deleteSession(id: number): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudDeleteSession(workspaceId, id).then(() => true),
    );
    return;
  }
  if (!isTauri()) {
    fb.sessions = fb.sessions.filter((s) => s.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM study_sessions WHERE id = $1", [id]);
}

/** Edit a previously-logged session — kind, duration, notes. Used
 *  by the Activities view and the Timer page's today-list "edit
 *  session" affordance. Writes through the same row the rest of
 *  the app reads, so the dashboard / journey / goals / habits all
 *  reflect the change instantly. */
export async function updateSession(input: {
  id: number;
  kind?: string;
  durationSecs?: number;
  notes?: string | null;
}): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudUpdateSession({
        workspaceId,
        sessionId: input.id,
        patch: {
          kind: input.kind,
          durationSecs: input.durationSecs,
          notes: input.notes,
        },
      }).then(() => true),
    );
    return;
  }
  if (!isTauri()) {
    const s = fb.sessions.find((x) => x.id === input.id);
    if (!s) return;
    if (input.kind !== undefined) s.kind = input.kind;
    if (input.durationSecs !== undefined) {
      s.durationSecs = input.durationSecs;
      // Keep endedAt consistent with the new duration so per-day
      // bucketing (which reads `startedAt`) doesn't drift.
      if (s.startedAt != null) {
        s.endedAt = s.startedAt + input.durationSecs;
      }
    }
    if (input.notes !== undefined) s.notes = input.notes;
    return;
  }
  // SQLite path — patch the fields the user actually supplied. We
  // also re-derive `ended_at` when `duration_secs` changes so the
  // dashboard's "logged at HH:MM" stays consistent with the new
  // length.
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.kind !== undefined) {
    sets.push(`kind = $${sets.length + 1}`);
    values.push(input.kind);
  }
  if (input.durationSecs !== undefined) {
    sets.push(`duration_secs = $${sets.length + 1}`);
    values.push(input.durationSecs);
    // started_at + duration → ended_at. We can't read the row in
    // the same statement (sqlx-style) so use COALESCE in SQL.
    sets.push(`ended_at = started_at + $${sets.length + 1}`);
    values.push(input.durationSecs);
  }
  if (input.notes !== undefined) {
    sets.push(`notes = $${sets.length + 1}`);
    values.push(input.notes);
  }
  if (sets.length === 0) return;
  values.push(input.id);
  const db = await getDb();
  await db.execute(
    `UPDATE study_sessions SET ${sets.join(", ")} WHERE id = $${sets.length + 1}`,
    values,
  );
}

type DictRow = {
  id: number;
  lang: string;
  name: string;
  source_url: string | null;
  installed_at: number;
  entry_count: number;
};

function rowToDict(r: DictRow): Dictionary {
  return {
    id: r.id,
    lang: r.lang,
    name: r.name,
    sourceUrl: r.source_url,
    installedAt: r.installed_at,
    entryCount: r.entry_count,
  };
}

export async function listDictionaries(): Promise<Dictionary[]> {
  if (HOSTED) {
    // Cloud dicts are global static data — no per-user `dictionaries`
    // table. We synthesise a `Dictionary[]` from the public
    // `/dict/languages` payload so call-sites that enumerate
    // installed packs (mostly the Settings page) keep working. The
    // Settings UI in HOSTED already short-circuits to the
    // HostedDictionariesNotice, so this is mostly defensive.
    const langs = [...(await cloudDictLanguages())];
    return langs.map((lang, idx) => ({
      id: -1000 - idx,
      lang,
      name: "Server",
      sourceUrl: null,
      installedAt: 0,
      entryCount: 1, // Non-zero so the availability check counts it.
    }));
  }
  if (!isTauri())
    return [...fb.dicts].sort((a, b) => b.installedAt - a.installedAt);
  const db = await getDb();
  const rows = await db.select<DictRow[]>(
    "SELECT id, lang, name, source_url, installed_at, entry_count FROM dictionaries ORDER BY installed_at DESC",
  );
  return rows.map(rowToDict);
}

export async function installDictionary(input: {
  lang: string;
  name: string;
  sourceUrl?: string | null;
  entries: DictEntry[];
  onProgress?: (inserted: number, total: number) => void;
}): Promise<Dictionary> {
  if (HOSTED) {
    // Pack-style dict install is operator-side in HOSTED — the
    // cloud's `dicts:seed` script handles bulk inserts. Callers
    // ending up here in HOSTED are usually the personal-dict path
    // (where DictionariesSection's settings UI is short-circuited).
    // Throw rather than silently no-op so the UX doesn't hide the
    // gap; callers can catch and route to the personal-dict APIs.
    throw new Error(
      "installDictionary is desktop-only. In HOSTED, dictionaries are " +
        "server-installed; use addDictEntry for the personal dictionary.",
    );
  }
  if (!isTauri()) {
    const d: Dictionary = {
      id: fb.nextId++,
      lang: input.lang,
      name: input.name,
      sourceUrl: input.sourceUrl ?? null,
      installedAt: nowSec(),
      entryCount: input.entries.length,
    };
    fb.dicts = fb.dicts.filter((x) => !(x.lang === input.lang && x.name === input.name));
    fb.dicts.push(d);
    fb.dictEntries.set(d.id, [...input.entries]);
    invalidateDictIdCache();
    input.onProgress?.(input.entries.length, input.entries.length);
    return d;
  }

  const db = await getDb();
  // Upsert dictionary row (UNIQUE lang+name).
  await db.execute(
    `INSERT INTO dictionaries (lang, name, source_url, entry_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(lang, name) DO UPDATE SET
       source_url = excluded.source_url,
       installed_at = strftime('%s','now'),
       entry_count = excluded.entry_count`,
    [input.lang, input.name, input.sourceUrl ?? null, input.entries.length],
  );
  const dictRow = (
    await db.select<DictRow[]>(
      "SELECT id, lang, name, source_url, installed_at, entry_count FROM dictionaries WHERE lang = $1 AND name = $2",
      [input.lang, input.name],
    )
  )[0];
  const dictId = dictRow.id;

  await db.execute("DELETE FROM dict_entries WHERE dict_id = $1", [dictId]);

  const total = input.entries.length;
  const CHUNK = 500;
  for (let i = 0; i < total; i += CHUNK) {
    const slice = input.entries.slice(i, i + CHUNK);
    const placeholders: string[] = [];
    const params: unknown[] = [];
    slice.forEach((e, j) => {
      const base = j * 6;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
      );
      params.push(
        dictId,
        e.word,
        e.altWord ?? null,
        e.reading ?? null,
        e.gloss,
        e.pitchAccent ?? null,
      );
    });
    await db.execute(
      `INSERT INTO dict_entries (dict_id, word, alt_word, reading, gloss, pitch_accent) VALUES ${placeholders.join(", ")}`,
      params,
    );
    input.onProgress?.(Math.min(i + CHUNK, total), total);
  }

  // Invalidate the lang→ids cache used by lookupDictBatch — a brand
  // new dict_id has just appeared for this language, and the cached
  // list wouldn't include it until the next module load otherwise.
  invalidateDictIdCache();
  return rowToDict(dictRow);
}

export async function deleteDictionary(id: number): Promise<void> {
  if (HOSTED) {
    // Operator-side in HOSTED — shared dicts are managed via the
    // cloud's seed scripts, not the client. Throw for visibility.
    throw new Error(
      "deleteDictionary is desktop-only. In HOSTED, shared dictionaries " +
        "are managed via the cloud's dicts:seed script.",
    );
  }
  if (!isTauri()) {
    fb.dicts = fb.dicts.filter((d) => d.id !== id);
    fb.dictEntries.delete(id);
    invalidateDictIdCache();
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM dictionaries WHERE id = $1", [id]);
  invalidateDictIdCache();
}

const PERSONAL_DICT_NAME = "Personal";

/** Stable-sort a language's dictionaries so the user's "Personal" dict
 *  comes first. Lookups build their hit index first-wins, so ordering
 *  Personal ahead of the packaged packs is what lets an edited entry
 *  shadow CC-CEDICT / JMdict for the same word. */
function personalFirst<T extends { name: string }>(dicts: T[]): T[] {
  return [...dicts].sort(
    (a, b) =>
      Number(b.name === PERSONAL_DICT_NAME) -
      Number(a.name === PERSONAL_DICT_NAME),
  );
}

// HOSTED-only: tiny bidirectional map so the synthetic Dictionary ids
// we hand back from `getOrCreatePersonalDict` can be reversed to the
// lang they were minted for. Desktop callers pass `dict.id` around
// freely (e.g. `addDictEntry({ dictId: dict.id, ... })`); the HOSTED
// branches of those functions look the lang back up here so they can
// hit `/api/v1/personal-dict/:lang/entries`. Synthetic ids are
// negative so they never clash with desktop's autoincrement ids.
const hostedPersonalDictByLang = new Map<string, number>();
const hostedPersonalDictById = new Map<number, string>();
let hostedNextSyntheticId = -1;

function hostedSyntheticDictForLang(lang: string): Dictionary {
  let id = hostedPersonalDictByLang.get(lang);
  if (id == null) {
    id = hostedNextSyntheticId;
    hostedNextSyntheticId -= 1;
    hostedPersonalDictByLang.set(lang, id);
    hostedPersonalDictById.set(id, lang);
  }
  return {
    id,
    lang,
    name: PERSONAL_DICT_NAME,
    sourceUrl: null,
    installedAt: 0,
    entryCount: 0,
  };
}

/** Reverse-lookup the lang from a synthetic dict id minted above.
 *  HOSTED-only — never called from desktop paths. */
function hostedLangForDictId(id: number): string | null {
  return hostedPersonalDictById.get(id) ?? null;
}

export async function getOrCreatePersonalDict(lang: string): Promise<Dictionary> {
  if (HOSTED) {
    // The cloud lazily creates the per-(user, lang) PersonalDictionary
    // row on the first write. We don't expose its id over the wire —
    // every personal-dict endpoint takes `:lang` instead. Mint (or
    // reuse) a synthetic id keyed on the lang so call-sites that
    // ferry `dict.id` around keep working.
    return hostedSyntheticDictForLang(lang);
  }
  if (!isTauri()) {
    const found = fb.dicts.find((d) => d.lang === lang && d.name === PERSONAL_DICT_NAME);
    if (found) return found;
    const d: Dictionary = {
      id: fb.nextId++,
      lang,
      name: PERSONAL_DICT_NAME,
      sourceUrl: null,
      installedAt: nowSec(),
      entryCount: 0,
    };
    fb.dicts.push(d);
    fb.dictEntries.set(d.id, []);
    invalidateDictIdCache();
    return d;
  }
  const db = await getDb();
  const created = await db.execute(
    `INSERT INTO dictionaries (lang, name, source_url, entry_count)
     VALUES ($1, $2, NULL, 0)
     ON CONFLICT(lang, name) DO NOTHING`,
    [lang, PERSONAL_DICT_NAME],
  );
  // A brand-new Personal dict must show up in the cached lang→dict_ids
  // list, or searchDict / lookupDictBatch won't see its entries until
  // the next app start.
  if (created.rowsAffected > 0) invalidateDictIdCache();
  const rows = await db.select<DictRow[]>(
    "SELECT id, lang, name, source_url, installed_at, entry_count FROM dictionaries WHERE lang = $1 AND name = $2",
    [lang, PERSONAL_DICT_NAME],
  );
  return rowToDict(rows[0]);
}

export type DictEntryRow = DictEntry & { id: number };

export async function listDictEntries(
  dictId: number,
  query: string,
  limit = 50,
  offset = 0,
): Promise<DictEntryRow[]> {
  if (HOSTED) {
    // Only the per-user Personal dict is exposed to client CRUD in
    // HOSTED. Resolve the lang from the synthetic id minted in
    // getOrCreatePersonalDict; if the caller hands us an unknown id
    // we return empty (matches the "no entries for unknown dict"
    // semantics the desktop has).
    const lang = hostedLangForDictId(dictId);
    if (!lang) return [];
    const all = await cloudListPersonalDictEntries(lang);
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (e) =>
            e.word.toLowerCase().includes(q) ||
            (e.altWord?.toLowerCase().includes(q) ?? false) ||
            (e.reading?.toLowerCase().includes(q) ?? false) ||
            e.gloss.toLowerCase().includes(q),
        )
      : all;
    return filtered
      .slice(offset, offset + limit)
      .map((e, i) => ({ ...e, id: offset + i }));
  }
  if (!isTauri()) {
    const all = fb.dictEntries.get(dictId) ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (e) =>
            e.word.toLowerCase().includes(q) ||
            (e.altWord?.toLowerCase().includes(q) ?? false) ||
            (e.reading?.toLowerCase().includes(q) ?? false) ||
            e.gloss.toLowerCase().includes(q),
        )
      : all;
    return filtered
      .slice(offset, offset + limit)
      .map((e, i) => ({ ...e, id: offset + i }));
  }
  const db = await getDb();
  const params: unknown[] = [dictId];
  let where = "dict_id = $1";
  if (query.trim()) {
    const like = `%${query.trim()}%`;
    where += " AND (word LIKE $2 OR alt_word LIKE $2 OR reading LIKE $2 OR gloss LIKE $2)";
    params.push(like);
  }
  params.push(limit);
  params.push(offset);
  const rows = await db.select<{
    id: number;
    word: string;
    alt_word: string | null;
    reading: string | null;
    gloss: string;
    pitch_accent: number | null;
  }[]>(
    `SELECT id, word, alt_word, reading, gloss, pitch_accent FROM dict_entries
       WHERE ${where}
       ORDER BY word ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    word: r.word,
    altWord: r.alt_word,
    reading: r.reading,
    gloss: r.gloss,
    pitchAccent: r.pitch_accent,
  }));
}

export async function addDictEntry(input: {
  dictId: number;
  word: string;
  altWord?: string | null;
  reading?: string | null;
  gloss: string;
}): Promise<void> {
  if (HOSTED) {
    const lang = hostedLangForDictId(input.dictId);
    if (!lang) {
      throw new Error(
        "addDictEntry(HOSTED): unknown dictId. Call getOrCreatePersonalDict(lang) first.",
      );
    }
    await cloudAddPersonalDictEntry({
      lang,
      word: input.word,
      altWord: input.altWord,
      reading: input.reading,
      gloss: input.gloss,
    });
    return;
  }
  if (!isTauri()) {
    const arr = fb.dictEntries.get(input.dictId) ?? [];
    arr.push({
      word: input.word,
      altWord: input.altWord ?? null,
      reading: input.reading ?? null,
      gloss: input.gloss,
    });
    fb.dictEntries.set(input.dictId, arr);
    const d = fb.dicts.find((x) => x.id === input.dictId);
    if (d) d.entryCount = arr.length;
    if (d) {
      markDictDirty({
        lang: d.lang,
        word: input.word,
        altWord: input.altWord,
        reading: input.reading,
        gloss: input.gloss,
      });
    }
    return;
  }
  const db = await getDb();
  await db.execute(
    `INSERT INTO dict_entries (dict_id, word, alt_word, reading, gloss)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.dictId,
      input.word,
      input.altWord ?? null,
      input.reading ?? null,
      input.gloss,
    ],
  );
  await db.execute(
    "UPDATE dictionaries SET entry_count = (SELECT COUNT(*) FROM dict_entries WHERE dict_id = $1) WHERE id = $1",
    [input.dictId],
  );
}

export async function updateDictEntry(input: {
  id: number;
  word?: string;
  altWord?: string | null;
  reading?: string | null;
  gloss?: string;
}): Promise<void> {
  if (HOSTED) {
    const patch: Record<string, unknown> = {};
    if (input.word !== undefined) patch.word = input.word;
    if (input.altWord !== undefined) patch.altWord = input.altWord;
    if (input.reading !== undefined) patch.reading = input.reading;
    if (input.gloss !== undefined) patch.gloss = input.gloss;
    if (Object.keys(patch).length === 0) return;
    await cloudUpdatePersonalDictEntryById(input.id, patch);
    return;
  }
  if (!isTauri()) return; // fb mode uses array indices; skip for dev
  const fields: string[] = [];
  const params: unknown[] = [];
  if (input.word !== undefined) {
    fields.push(`word = $${fields.length + 1}`);
    params.push(input.word);
  }
  if (input.altWord !== undefined) {
    fields.push(`alt_word = $${fields.length + 1}`);
    params.push(input.altWord);
  }
  if (input.reading !== undefined) {
    fields.push(`reading = $${fields.length + 1}`);
    params.push(input.reading);
  }
  if (input.gloss !== undefined) {
    fields.push(`gloss = $${fields.length + 1}`);
    params.push(input.gloss);
  }
  if (fields.length === 0) return;
  params.push(input.id);
  const db = await getDb();
  await db.execute(
    `UPDATE dict_entries SET ${fields.join(", ")} WHERE id = $${params.length}`,
    params,
  );
}

export async function deleteDictEntry(id: number, dictId: number): Promise<void> {
  if (HOSTED) {
    await cloudDeletePersonalDictEntryById(id);
    return;
  }
  if (!isTauri()) return;
  const db = await getDb();
  await db.execute("DELETE FROM dict_entries WHERE id = $1", [id]);
  await db.execute(
    "UPDATE dictionaries SET entry_count = (SELECT COUNT(*) FROM dict_entries WHERE dict_id = $1) WHERE id = $1",
    [dictId],
  );
}

/** Insert-or-update a Personal-dict override for `word` in `lang`.
 *
 *  Personal entries shadow the packaged dictionaries in every lookup
 *  (see `lookupDict` / `lookupDictBatch`, which order the Personal dict
 *  first), so this is the codepath behind "edit this dictionary entry":
 *  the change is stored as a personal override that wins over CC-CEDICT
 *  / JMdict without mutating the shipped pack — which a re-install would
 *  otherwise overwrite.
 *
 *  Upsert keyed on (Personal dict, word): editing the same word twice
 *  updates the one row instead of piling up duplicates. Callers must
 *  invalidate the lookup + availability caches afterwards so the next
 *  render reflects the edit (the popover does). */
export async function upsertPersonalDictEntry(input: {
  lang: string;
  word: string;
  reading?: string | null;
  gloss: string;
  altWord?: string | null;
}): Promise<void> {
  const word = input.word.trim();
  if (!word) throw new Error("upsertPersonalDictEntry: empty word");
  const gloss = input.gloss.trim();
  if (!gloss) throw new Error("upsertPersonalDictEntry: empty gloss");
  const reading = input.reading?.trim() ? input.reading.trim() : null;
  const altWord = input.altWord?.trim() ? input.altWord.trim() : null;

  if (HOSTED) {
    // The cloud's POST /personal-dict/:lang/entries upserts on
    // (userId, lang, word) — the same natural key sync v2 uses — so a
    // plain add doubles as the update. No id round-trip needed.
    await cloudAddPersonalDictEntry({ lang: input.lang, word, reading, gloss, altWord });
    return;
  }
  const dict = await getOrCreatePersonalDict(input.lang);
  if (!isTauri()) {
    const arr = fb.dictEntries.get(dict.id) ?? [];
    const existing = arr.find((e) => e.word === word);
    if (existing) {
      existing.reading = reading;
      existing.gloss = gloss;
      existing.altWord = altWord;
    } else {
      arr.push({ word, altWord, reading, gloss });
    }
    fb.dictEntries.set(dict.id, arr);
    const d = fb.dicts.find((x) => x.id === dict.id);
    if (d) d.entryCount = arr.length;
    return;
  }
  const db = await getDb();
  const existing = await db.select<{ id: number }[]>(
    "SELECT id FROM dict_entries WHERE dict_id = $1 AND word = $2 LIMIT 1",
    [dict.id, word],
  );
  if (existing.length > 0) {
    await db.execute(
      "UPDATE dict_entries SET alt_word = $1, reading = $2, gloss = $3 WHERE id = $4",
      [altWord, reading, gloss, existing[0].id],
    );
  } else {
    await db.execute(
      `INSERT INTO dict_entries (dict_id, word, alt_word, reading, gloss)
       VALUES ($1, $2, $3, $4, $5)`,
      [dict.id, word, altWord, reading, gloss],
    );
    await db.execute(
      "UPDATE dictionaries SET entry_count = (SELECT COUNT(*) FROM dict_entries WHERE dict_id = $1) WHERE id = $1",
      [dict.id],
    );
  }
}

/** Whether the user has a Personal-dict override for `word` in `lang`.
 *  Drives the popover editor's "Reset to original" affordance — shown
 *  only when a personal entry is shadowing the packaged dictionaries. */
export async function hasPersonalDictOverride(
  lang: string,
  word: string,
): Promise<boolean> {
  const w = word.trim();
  if (!w) return false;
  if (HOSTED) {
    try {
      return (await cloudListPersonalDictEntries(lang)).some((e) => e.word === w);
    } catch {
      return false;
    }
  }
  const id = await personalDictIdForLang(lang);
  if (id == null) return false;
  if (!isTauri()) {
    return (fb.dictEntries.get(id) ?? []).some((e) => e.word === w);
  }
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM dict_entries WHERE dict_id = $1 AND word = $2 LIMIT 1",
    [id, w],
  );
  return rows.length > 0;
}

/** Remove the Personal-dict override for `word` in `lang`, restoring the
 *  packaged dictionary's definition (if any) on the next lookup. Deletes
 *  by word — the inverse of `upsertPersonalDictEntry`. Callers invalidate
 *  the lookup cache afterwards. */
export async function deletePersonalDictOverride(
  lang: string,
  word: string,
): Promise<void> {
  const w = word.trim();
  if (!w) return;
  if (HOSTED) {
    const match = (await cloudListPersonalDictEntries(lang)).find(
      (e) => e.word === w,
    );
    if (match?.id != null) await cloudDeletePersonalDictEntryById(match.id);
    return;
  }
  const id = await personalDictIdForLang(lang);
  if (id == null) return;
  if (!isTauri()) {
    const arr = (fb.dictEntries.get(id) ?? []).filter((e) => e.word !== w);
    fb.dictEntries.set(id, arr);
    const d = fb.dicts.find((x) => x.id === id);
    if (d) d.entryCount = arr.length;
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM dict_entries WHERE dict_id = $1 AND word = $2", [id, w]);
  await db.execute(
    "UPDATE dictionaries SET entry_count = (SELECT COUNT(*) FROM dict_entries WHERE dict_id = $1) WHERE id = $1",
    [id],
  );
}

export async function searchDict(
  lang: string,
  query: string,
  limit = 50,
): Promise<DictEntry[]> {
  const q = query.trim();
  if (!q) return [];
  // What the user typed, stripped of accents/tones — used for "did this
  // entry's reading match" checks downstream.
  const normQ = normaliseReading(q);
  // Whether the query looks like Latin text (pinyin, romaji, lemma) vs.
  // CJK script. Drives whether we widen the candidate net.
  const isLatinQuery = /^[a-zA-Z0-9'\-\s]+$/.test(q);

  // HOSTED: hand off to the cloud's /api/v1/dict/search, then re-rank the
  // returned rows through the same scorer the desktop uses so meaning
  // searches ("eye" → 眼睛) order identically in both builds. Returning
  // early here keeps the in-memory `fb` fallback and SQLite paths cleanly
  // separated — and terser strips this whole branch out of the desktop
  // bundle because HOSTED is a build-time constant.
  if (HOSTED) {
    try {
      const rows = await cloudDictSearch(lang, q, limit);
      return rankSearchHits(rows, q, normQ, isLatinQuery, limit);
    } catch (err) {
      console.warn("cloud dict search failed", err);
      return [];
    }
  }

  if (!isTauri()) {
    const results: DictEntry[] = [];
    const seen = new Set<string>();
    // Gather a comfortable candidate window before ranking — stopping at
    // exactly `limit` here, in arbitrary dict order, could truncate the
    // best meaning match (眼睛) before `rankSearchHits` ever sees it. The
    // in-memory dicts are small (browser session), so over-collecting is
    // cheap; the ranker slices back down to `limit`.
    const cap = Math.max(limit * 5, 200);
    outer: for (const d of fb.dicts.filter((x) => x.lang === lang)) {
      const entries = fb.dictEntries.get(d.id) ?? [];
      for (const e of entries) {
        const readingNorm = normaliseReading(e.reading);
        const matches =
          e.word.includes(q) ||
          (e.altWord?.includes(q) ?? false) ||
          (e.reading?.toLowerCase().includes(q.toLowerCase()) ?? false) ||
          e.gloss.toLowerCase().includes(q.toLowerCase()) ||
          (isLatinQuery && readingNorm.includes(normQ));
        if (!matches || seen.has(e.word)) continue;
        seen.add(e.word);
        results.push(e);
        if (results.length >= cap) break outer;
      }
    }
    return rankSearchHits(results, q, normQ, isLatinQuery, limit);
  }

  const db = await getDb();
  const like = `%${q}%`;

  // Resolve the language's dict ids once (cached) — same trick as
  // lookupDictBatch. With the JOIN gone, every arm below filters on
  // dict_id directly and the candidate id-set probes dict_entries by
  // primary key.
  const dictIds = await dictIdsForLang(lang);
  if (dictIds.length === 0) return [];
  const dictPh = dictIds.map((_, i) => `$${i + 1}`).join(", ");
  const p = (n: number) => `$${dictIds.length + n}`;

  // `reading_norm` is a stored virtual column (migration V24) baking the
  // same strip JS does, so `nihao` matches `ni3 hao3` through an index
  // instead of a per-row REPLACE chain that forces a table scan.
  //
  // Candidate matching goes through the trigram FTS shadow table
  // (migration V31) whenever the query is long enough for trigrams
  // (≥3 codepoints): each UNION arm is an indexed substring probe, so
  // even a zero-hit query costs milliseconds instead of a 1s+ scan of
  // the whole dictionary. Shorter queries — single hanzi/kana, 1–2
  // latin letters — can't form a trigram, so instead of the old
  // substring `OR` across columns (which the planner can't index — an
  // `OR` over word/alt/reading defeats the composite indexes and falls
  // back to a full table scan of the language's ~150k rows: the
  // slow-statement warnings), they gather candidates by PREFIX through
  // the per-column composite indexes — a *covering-index* probe per
  // column that never reads a table row (so the big `gloss` text is
  // never touched), unioned together. Trade-off: a lone leading hanzi
  // now matches words *beginning* with it (一 → 一定, 一样…) rather than
  // every word containing it; the ≥3-char FTS path keeps full substring
  // search. Gloss matching stays ≥3-only in both worlds: short latin
  // queries hit nearly every row's gloss in a big dict and the matches
  // aren't useful.
  const ftsable = [...q].length >= 3;
  const candidateWhere = ftsable
    ? `e.id IN (
         SELECT rowid FROM dict_fts WHERE word LIKE ${p(1)}
         UNION SELECT rowid FROM dict_fts WHERE alt_word LIKE ${p(1)}
         UNION SELECT rowid FROM dict_fts WHERE reading LIKE ${p(1)}
         UNION SELECT rowid FROM dict_fts WHERE reading_norm LIKE ${p(2)}
         UNION SELECT rowid FROM dict_fts WHERE gloss LIKE ${p(1)}
       )`
    : `e.id IN (
         SELECT id FROM dict_entries WHERE dict_id IN (${dictPh}) AND word LIKE ${p(4)}
         UNION SELECT id FROM dict_entries WHERE dict_id IN (${dictPh}) AND alt_word LIKE ${p(4)}
         UNION SELECT id FROM dict_entries WHERE dict_id IN (${dictPh}) AND reading_norm LIKE ${p(6)}
       )`;
  const rows = await db.select<{
    word: string;
    alt_word: string | null;
    reading: string | null;
    gloss: string;
    pitch_accent: number | null;
  }[]>(
    `SELECT e.word, e.alt_word, e.reading, e.gloss, e.pitch_accent
     FROM dict_entries e
     WHERE e.dict_id IN (${dictPh})
       AND ${candidateWhere}
     ORDER BY
       CASE
         WHEN e.word = ${p(3)} THEN 0
         WHEN e.word LIKE ${p(4)} THEN 1
         WHEN e.reading_norm = ${p(5)} THEN 2           -- exact pinyin-stripped match
         WHEN e.reading_norm LIKE ${p(6)} THEN 3        -- pinyin-stripped prefix
         WHEN e.reading LIKE ${p(4)} THEN 4             -- raw reading prefix
         ELSE 5
       END,
       -- Within the meaning bucket, keep exact-sense gloss matches (the
       -- query is a whole "; "-delimited sense, e.g. "eye" in 眼睛's
       -- "eye; CL:…") inside the LIMIT window ahead of substring-only
       -- hits ("eyebrow"). The JS ranker does the fine ordering; this
       -- just stops the best rows being truncated when a common word
       -- like "eye" matches thousands of glosses.
       CASE
         WHEN e.gloss = ${p(7)}
           OR e.gloss LIKE ${p(8)}
           OR e.gloss LIKE ${p(9)}
           OR e.gloss LIKE ${p(10)} THEN 0
         ELSE 1
       END,
       length(e.word) ASC,
       length(e.reading) ASC
     LIMIT ${p(11)}`,
    [
      ...dictIds,
      like,                // p1  word/alt/reading/gloss substring
      `%${normQ}%`,        // p2  stripped reading substring
      q,                   // p3  exact word
      `${q}%`,             // p4  word/reading prefix
      normQ,               // p5  stripped reading exact
      `${normQ}%`,         // p6  stripped reading prefix
      q,                   // p7  gloss is exactly the query (single sense)
      `${q}; %`,           // p8  query is the first sense
      `%; ${q}; %`,        // p9  query is a middle sense
      `%; ${q}`,           // p10 query is the last sense
      Math.max(limit, 50), // p11
    ],
  );
  let mapped: DictEntry[] = rows.map((r) => ({
    word: r.word,
    altWord: r.alt_word,
    reading: r.reading,
    gloss: r.gloss,
    pitchAccent: r.pitch_accent,
  }));

  // Fallback for Latin queries that miss when readings carry diacritics
  // (`nǐ`) on a UDF-less SQLite. Pull entries whose reading shares the
  // first letter, then JS-filter with full diacritic stripping.
  if (mapped.length === 0 && isLatinQuery && normQ.length > 0) {
    const first = normQ.charAt(0);
    const broad = await db.select<{
      word: string;
      alt_word: string | null;
      reading: string | null;
      gloss: string;
      pitch_accent: number | null;
    }[]>(
      `SELECT e.word, e.alt_word, e.reading, e.gloss, e.pitch_accent
       FROM dict_entries e
       JOIN dictionaries d ON d.id = e.dict_id
       WHERE d.lang = $1 AND lower(e.reading) LIKE $2
       LIMIT $3`,
      [lang, `${first}%`, 5000],
    );
    const filtered: DictEntry[] = [];
    for (const r of broad) {
      const norm = normaliseReading(r.reading);
      if (norm.includes(normQ)) {
        filtered.push({
          word: r.word,
          altWord: r.alt_word,
          reading: r.reading,
          gloss: r.gloss,
          pitchAccent: r.pitch_accent,
        });
        if (filtered.length >= 200) break;
      }
    }
    mapped = filtered;
  }
  return rankSearchHits(mapped, q, normQ, isLatinQuery, limit);
}

export async function lookupDict(lang: string, word: string): Promise<DictEntry | null> {
  // Three-stage lookup:
  //   1. Exact (lang, word) index hit — what almost all CJK / mid-
  //      sentence Latin words land on.
  //   2. Case-insensitive — bilingual dicts store lemmas lowercased
  //      but text often capitalises sentence-initial words.
  //   3. Lemmatizer fallback — for inflected forms in languages where
  //      the dict lists infinitives only (German "geht" → "gehen",
  //      Spanish "voy" → "ir"). Per-language rules in
  //      `dictionaries/lemmatizer.ts`. Returns the lemma's entry with
  //      `inflectionOf` populated so the UI can label it.
  // Stages 2 and 3 each run only when the previous stage missed.
  const trimmed = word.trim();
  if (!trimmed) return null;

  if (!isTauri()) {
    const dicts = personalFirst(fb.dicts.filter((x) => x.lang === lang));
    for (const d of dicts) {
      const entries = fb.dictEntries.get(d.id) ?? [];
      const hit = entries.find(
        (e) => e.word === trimmed || e.altWord === trimmed,
      );
      if (hit) return hit;
    }
    const lower = trimmed.toLowerCase();
    if (lower !== trimmed) {
      for (const d of dicts) {
        const entries = fb.dictEntries.get(d.id) ?? [];
        const hit = entries.find(
          (e) =>
            e.word.toLowerCase() === lower ||
            (e.altWord?.toLowerCase() ?? "") === lower,
        );
        if (hit) return hit;
      }
    }
    for (const cand of lemmaCandidates(lang as LanguageCode, trimmed)) {
      const candLower = cand.toLowerCase();
      for (const d of dicts) {
        const entries = fb.dictEntries.get(d.id) ?? [];
        const hit = entries.find(
          (e) =>
            e.word === cand ||
            e.altWord === cand ||
            e.word.toLowerCase() === candLower ||
            (e.altWord?.toLowerCase() ?? "") === candLower,
        );
        if (hit) return { ...hit, inflectionOf: hit.word };
      }
    }
    return null;
  }

  const db = await getDb();
  const exact = await db.select<{
    word: string;
    alt_word: string | null;
    reading: string | null;
    gloss: string;
    pitch_accent: number | null;
  }[]>(
    `SELECT e.word, e.alt_word, e.reading, e.gloss, e.pitch_accent
     FROM dict_entries e
     JOIN dictionaries d ON d.id = e.dict_id
     WHERE d.lang = $1 AND (e.word = $2 OR e.alt_word = $2)
     ORDER BY CASE WHEN d.name = $3 THEN 0 ELSE 1 END
     LIMIT 1`,
    [lang, trimmed, PERSONAL_DICT_NAME],
  );
  if (exact.length > 0) {
    const r = exact[0];
    return {
      word: r.word,
      altWord: r.alt_word,
      reading: r.reading,
      gloss: r.gloss,
      pitchAccent: r.pitch_accent,
    };
  }

  const lower = trimmed.toLowerCase();
  if (lower !== trimmed) {
    const ci = await db.select<{
      word: string;
      alt_word: string | null;
      reading: string | null;
      gloss: string;
      pitch_accent: number | null;
    }[]>(
      `SELECT e.word, e.alt_word, e.reading, e.gloss, e.pitch_accent
       FROM dict_entries e
       JOIN dictionaries d ON d.id = e.dict_id
       WHERE d.lang = $1
         AND (LOWER(e.word) = $2 OR LOWER(e.alt_word) = $2)
       ORDER BY CASE WHEN d.name = $3 THEN 0 ELSE 1 END
       LIMIT 1`,
      [lang, lower, PERSONAL_DICT_NAME],
    );
    if (ci.length > 0) {
      const r = ci[0];
      return {
        word: r.word,
        altWord: r.alt_word,
        reading: r.reading,
        gloss: r.gloss,
        pitchAccent: r.pitch_accent,
      };
    }
  }

  // Stage 3: lemmatizer candidates. One SELECT per candidate; the
  // per-language rules return at most ~10 forms so worst case is
  // bounded and only fires after both cheap stages missed.
  for (const cand of lemmaCandidates(lang as LanguageCode, trimmed)) {
    const candLower = cand.toLowerCase();
    const lem = await db.select<{
      word: string;
      alt_word: string | null;
      reading: string | null;
      gloss: string;
      pitch_accent: number | null;
    }[]>(
      `SELECT e.word, e.alt_word, e.reading, e.gloss, e.pitch_accent
       FROM dict_entries e
       JOIN dictionaries d ON d.id = e.dict_id
       WHERE d.lang = $1
         AND (e.word = $2 OR e.alt_word = $2
              OR LOWER(e.word) = $3 OR LOWER(e.alt_word) = $3)
       ORDER BY CASE WHEN d.name = $4 THEN 0 ELSE 1 END
       LIMIT 1`,
      [lang, cand, candLower, PERSONAL_DICT_NAME],
    );
    if (lem.length > 0) {
      const r = lem[0];
      return {
        word: r.word,
        altWord: r.alt_word,
        reading: r.reading,
        gloss: r.gloss,
        pitchAccent: r.pitch_accent,
        inflectionOf: r.word,
      };
    }
  }

  return null;
}

// Batch dictionary lookup. Issues two SELECTs total (exact match, then
// case-insensitive fallback) instead of N. Returns a Map keyed on the
// *original* input word so callers can do `entries.get("Sein")` and get
// the row stored as "sein".

// dict_id list per language, cached for the module lifetime. Busted by
// install/delete via invalidateDictIdCache().
const dictIdCache = new Map<string, number[]>();
// The per-language Personal dictionary's id, cached for the module
// lifetime and busted alongside dictIdCache. The lookups below order
// this dict first so an edited entry wins over the packaged pack.
// `null` = no Personal dict for this language yet.
const personalDictIdCache = new Map<string, number | null>();
async function dictIdsForLang(lang: string): Promise<number[]> {
  const cached = dictIdCache.get(lang);
  if (cached) return cached;
  if (!isTauri()) {
    const ids = fb.dicts.filter((d) => d.lang === lang).map((d) => d.id);
    dictIdCache.set(lang, ids);
    return ids;
  }
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM dictionaries WHERE lang = $1",
    [lang],
  );
  const ids = rows.map((r) => r.id);
  dictIdCache.set(lang, ids);
  return ids;
}
function invalidateDictIdCache(): void {
  dictIdCache.clear();
  personalDictIdCache.clear();
}

/** Resolve (and cache) the Personal dict's id for a language. Used by
 *  the lookups to give a personal override precedence over packaged
 *  packs. Returns null when the user has no Personal dict for the
 *  language yet. */
async function personalDictIdForLang(lang: string): Promise<number | null> {
  const cached = personalDictIdCache.get(lang);
  if (cached !== undefined) return cached;
  let id: number | null = null;
  if (!isTauri()) {
    const d = fb.dicts.find(
      (x) => x.lang === lang && x.name === PERSONAL_DICT_NAME,
    );
    id = d ? d.id : null;
  } else {
    const db = await getDb();
    const rows = await db.select<{ id: number }[]>(
      "SELECT id FROM dictionaries WHERE lang = $1 AND name = $2",
      [lang, PERSONAL_DICT_NAME],
    );
    id = rows.length > 0 ? rows[0].id : null;
  }
  personalDictIdCache.set(lang, id);
  return id;
}

export async function lookupDictBatch(
  lang: string,
  words: string[],
): Promise<Map<string, DictEntry>> {
  const out = new Map<string, DictEntry>();
  if (words.length === 0) return out;

  // Dedupe + trim, preserving the original strings as the lookup keys.
  const uniqueByTrim = new Map<string, string>(); // trimmed → original
  for (const w of words) {
    const t = w.trim();
    if (!t) continue;
    if (!uniqueByTrim.has(t)) uniqueByTrim.set(t, w);
  }
  const trimmed = Array.from(uniqueByTrim.keys());
  if (trimmed.length === 0) return out;

  // HOSTED: defer to the cloud's POST /api/v1/dict/batch-lookup. The
  // server returns Map<word, entry | null>; we filter to non-null hits
  // and key the result map by the caller's *original* (untrimmed)
  // string so call sites don't have to re-canonicalise.
  if (HOSTED) {
    try {
      const cloud = await cloudDictBatchLookup(lang, trimmed);
      for (const [t, hit] of cloud) {
        if (hit && uniqueByTrim.has(t)) {
          out.set(uniqueByTrim.get(t)!, hit);
        }
      }
    } catch (err) {
      console.warn("cloud dict batch lookup failed", err);
    }
    return out;
  }

  if (!isTauri()) {
    // Personal dict first so its entries win the first-wins index below.
    const dicts = personalFirst(fb.dicts.filter((x) => x.lang === lang));
    const allEntries = dicts.flatMap(
      (d) => fb.dictEntries.get(d.id) ?? [],
    );
    const exactIndex = new Map<string, DictEntry>();
    const altIndex = new Map<string, DictEntry>();
    for (const e of allEntries) {
      if (!exactIndex.has(e.word)) exactIndex.set(e.word, e);
      if (e.altWord && !altIndex.has(e.altWord)) altIndex.set(e.altWord, e);
    }
    const remaining: string[] = [];
    for (const t of trimmed) {
      const hit = exactIndex.get(t) ?? altIndex.get(t);
      if (hit) out.set(uniqueByTrim.get(t)!, hit);
      else remaining.push(t);
    }
    if (remaining.length > 0) {
      const lowerExact = new Map<string, DictEntry>();
      const lowerAlt = new Map<string, DictEntry>();
      for (const e of allEntries) {
        const lw = e.word.toLowerCase();
        if (!lowerExact.has(lw)) lowerExact.set(lw, e);
        if (e.altWord) {
          const la = e.altWord.toLowerCase();
          if (!lowerAlt.has(la)) lowerAlt.set(la, e);
        }
      }
      for (const t of remaining) {
        const lw = t.toLowerCase();
        if (lw === t) continue;
        const hit = lowerExact.get(lw) ?? lowerAlt.get(lw);
        if (hit) out.set(uniqueByTrim.get(t)!, hit);
      }
    }
    return out;
  }

  const db = await getDb();

  // Resolve dict_ids for the language once. The previous shape did
  // a `JOIN dictionaries d ON d.id = e.dict_id WHERE d.lang = $1`
  // alongside an OR-combined IN(word) IN(alt_word) — SQLite's
  // planner can't use the composite (dict_id, word) / (dict_id,
  // alt_word) indexes for an OR across two columns, so it fell
  // back to a 150k-row table scan. Telemetry: ≥1s per chat bubble,
  // multiple bubbles per render → SQLx pool starvation.
  //
  // Replacing it with a UNION ALL of two indexed queries, each
  // keyed on a single column, lets the planner pick the right
  // composite index per side. Pre-resolving the dict_ids removes
  // the JOIN entirely. Net: ~1000x — the bubble-flood drops to
  // a few ms.
  const dictIds = await dictIdsForLang(lang);
  if (dictIds.length === 0) return out;
  // The Personal dict (if any) wins ties: when both it and a packaged
  // pack hold the clicked word, the user's edited entry is the hit.
  const personalId = await personalDictIdForLang(lang);

  // SQLite's bound-parameter ceiling is 999. We have at most
  // dictIds.length + 2*words params per query side; words is
  // already capped to 950 above and dict counts per workspace are
  // tiny (1–4), so we stay well below the limit.
  const params = trimmed.slice(0, 950);
  const dictPh = dictIds.map((_, i) => `$${i + 1}`).join(",");
  const wordPh = params.map((_, i) => `$${i + 1 + dictIds.length}`).join(",");
  const exactRows = await db.select<{
    dict_id: number;
    word: string;
    alt_word: string | null;
    reading: string | null;
    gloss: string;
    pitch_accent: number | null;
  }[]>(
    `SELECT e.dict_id, e.word, e.alt_word, e.reading, e.gloss, e.pitch_accent
       FROM dict_entries e
      WHERE e.dict_id IN (${dictPh})
        AND e.word IN (${wordPh})
     UNION ALL
     SELECT e.dict_id, e.word, e.alt_word, e.reading, e.gloss, e.pitch_accent
       FROM dict_entries e
      WHERE e.dict_id IN (${dictPh})
        AND e.alt_word IN (${wordPh})`,
    [...dictIds, ...params, ...dictIds, ...params],
  );

  // Index the exact-match rows by both word and alt_word so callers
  // looking up an alt-form get the right row. A Personal-dict row
  // overwrites a packaged one for the same key (the edit wins);
  // otherwise it's first-wins.
  const exactIndex = new Map<string, DictEntry>();
  for (const r of exactRows) {
    const entry: DictEntry = {
      word: r.word,
      altWord: r.alt_word,
      reading: r.reading,
      gloss: r.gloss,
      pitchAccent: r.pitch_accent,
    };
    const isPersonal = personalId != null && r.dict_id === personalId;
    if (isPersonal || !exactIndex.has(r.word)) exactIndex.set(r.word, entry);
    if (r.alt_word && (isPersonal || !exactIndex.has(r.alt_word)))
      exactIndex.set(r.alt_word, entry);
  }

  const remaining: string[] = [];
  for (const t of trimmed) {
    const hit = exactIndex.get(t);
    if (hit) out.set(uniqueByTrim.get(t)!, hit);
    else if (t.toLowerCase() !== t) remaining.push(t);
  }

  // Single case-insensitive scan for the leftovers, only if any
  // uppercase-containing words missed. Always one full scan, never N.
  // Same UNION ALL split as the exact path above so each side can
  // hit the matching `idx_dict_entries_lower_*` index instead of
  // the planner falling back to a full scan on the OR.
  if (remaining.length > 0) {
    const lowers = remaining.map((t) => t.toLowerCase());
    const ciDictPh = dictIds.map((_, i) => `$${i + 1}`).join(",");
    const ciWordPh = lowers
      .map((_, i) => `$${i + 1 + dictIds.length}`)
      .join(",");
    const ciRows = await db.select<{
      dict_id: number;
      word: string;
      alt_word: string | null;
      reading: string | null;
      gloss: string;
      pitch_accent: number | null;
    }[]>(
      `SELECT e.dict_id, e.word, e.alt_word, e.reading, e.gloss, e.pitch_accent
         FROM dict_entries e
        WHERE e.dict_id IN (${ciDictPh})
          AND LOWER(e.word) IN (${ciWordPh})
       UNION ALL
       SELECT e.dict_id, e.word, e.alt_word, e.reading, e.gloss, e.pitch_accent
         FROM dict_entries e
        WHERE e.dict_id IN (${ciDictPh})
          AND LOWER(e.alt_word) IN (${ciWordPh})`,
      [...dictIds, ...lowers, ...dictIds, ...lowers],
    );
    const ciIndex = new Map<string, DictEntry>();
    for (const r of ciRows) {
      const entry: DictEntry = {
        word: r.word,
        altWord: r.alt_word,
        reading: r.reading,
        gloss: r.gloss,
        pitchAccent: r.pitch_accent,
      };
      const isPersonal = personalId != null && r.dict_id === personalId;
      const lw = r.word.toLowerCase();
      if (isPersonal || !ciIndex.has(lw)) ciIndex.set(lw, entry);
      if (r.alt_word) {
        const la = r.alt_word.toLowerCase();
        if (isPersonal || !ciIndex.has(la)) ciIndex.set(la, entry);
      }
    }
    for (let i = 0; i < remaining.length; i++) {
      const hit = ciIndex.get(lowers[i]);
      if (hit) out.set(uniqueByTrim.get(remaining[i])!, hit);
    }
  }

  return out;
}

export async function listDueVocab(
  workspaceId: number,
  limit = 50,
  /** Optional set of vocab ids the result must be inside. Pushed into
   *  the SQL `WHERE id IN (…)` so the LIMIT applies *after* the
   *  constraint, not before — otherwise a workspace with hundreds of
   *  unrelated due cards starves a "custom study this collection"
   *  hand-off, because the freshly-nudged words share `due_at = now`
   *  and sort to the bottom of the global queue. */
  restrictToIds?: ReadonlySet<number> | null,
): Promise<VocabEntry[]> {
  const now = nowSec();
  const restrict = restrictToIds && restrictToIds.size > 0 ? restrictToIds : null;
  if (HOSTED) {
    // Without `restrict`, the dedicated due endpoint is much cheaper than
    // listing+filtering, so prefer it. With `restrict`, the server endpoint
    // has no way to scope the result — fall back to the same client-side
    // filter `listStudyVocab` uses so a "custom study this collection"
    // hand-off doesn't get starved by the rest of the workspace's due
    // queue (every freshly-nudged card shares due_at = now).
    if (!restrict) return cloudListDueVocab(workspaceId, limit);
    const all = await cloudListVocab(workspaceId);
    return all
      .filter(
        (v) =>
          v.isActive !== false &&
          v.status !== "mastered" &&
          (v.dueAt == null || v.dueAt <= now) &&
          restrict.has(v.id),
      )
      .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
      .slice(0, limit);
  }
  if (!isTauri()) {
    return fb.vocab
      .filter(
        (v) =>
          v.workspaceId === workspaceId &&
          v.isActive !== false &&
          v.status !== "mastered" &&
          (v.dueAt == null || v.dueAt <= now) &&
          (!restrict || restrict.has(v.id)),
      )
      .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
      .slice(0, limit);
  }
  const db = await getDb();
  // is_active = 1 keeps "library" cards (imported from packs but not
  // promoted by the user) out of the due queue. Manual-saved cards
  // default to active so the click-to-define flow still works.
  if (restrict) {
    const ids = [...restrict];
    const placeholders = ids.map((_, i) => `$${i + 3}`).join(", ");
    const rows = await db.select<VocabRow[]>(
      `SELECT ${VOCAB_LIST_COLS} FROM vocab_entries
       WHERE workspace_id = $1
         AND is_active = 1
         AND status != 'mastered'
         AND (due_at IS NULL OR due_at <= $2)
         AND id IN (${placeholders})
       ORDER BY (due_at IS NULL) DESC, due_at ASC, created_at ASC
       LIMIT ${ids.length}`,
      [workspaceId, now, ...ids],
    );
    return rows.map(rowToVocab);
  }
  const rows = await db.select<VocabRow[]>(
    `SELECT ${VOCAB_LIST_COLS} FROM vocab_entries
     WHERE workspace_id = $1
       AND is_active = 1
       AND status != 'mastered'
       AND (due_at IS NULL OR due_at <= $2)
     ORDER BY (due_at IS NULL) DESC, due_at ASC, created_at ASC
     LIMIT $3`,
    [workspaceId, now, limit],
  );
  return rows.map(rowToVocab);
}

// Tight study-queue fetch: due cards plus a capped slice of new cards. One
// query, indexed on (workspace_id, due_at).
export async function listStudyVocab(
  workspaceId: number,
  limit = 250,
  /** See `listDueVocab` — same rationale. When set, the LIMIT applies
   *  *after* the id filter so custom-collection study hand-offs see
   *  every freshly-nudged card. */
  restrictToIds?: ReadonlySet<number> | null,
): Promise<VocabEntry[]> {
  const now = nowSec();
  const restrict = restrictToIds && restrictToIds.size > 0 ? restrictToIds : null;
  if (HOSTED) {
    // The cloud doesn't have a dedicated study-pool endpoint yet —
    // fall back to listing the full workspace and applying the same
    // predicate the desktop SQL uses. Without this branch, HOSTED
    // returned `fb.vocab` (the demo-only in-memory store, empty in
    // production hosted), which made `vocab` empty in the Flashcards
    // ctx → `vocab.find(c => c.id === id)` always returned undefined
    // in `ctx.reviewVocab` → every grade silently no-op'd and the
    // user could click the same card forever.
    //
    // Filtering 10k+ rows client-side is acceptable: it's a single
    // already-cached cloud call (re-uses `cloudListVocab`), and the
    // user typically opens Flashcards once per session. If the pack
    // catalog grows past ~50k words per workspace we'd want a real
    // server-side endpoint with a SQL `LIMIT`.
    const all = await cloudListVocab(workspaceId);
    return all
      .filter(
        (v) =>
          v.isActive !== false &&
          v.status !== "mastered" &&
          (v.status === "new" || v.dueAt == null || v.dueAt <= now) &&
          (!restrict || restrict.has(v.id)),
      )
      .sort((a, b) => {
        // due first (review/learning that's due), then new in
        // insertion order — matches the SQL's ORDER BY below.
        const aDue = a.status !== "new" ? 0 : 1;
        const bDue = b.status !== "new" ? 0 : 1;
        if (aDue !== bDue) return aDue - bDue;
        return (a.dueAt ?? a.createdAt) - (b.dueAt ?? b.createdAt);
      })
      .slice(0, limit);
  }
  if (!isTauri()) {
    return fb.vocab
      .filter(
        (v) =>
          v.workspaceId === workspaceId &&
          v.isActive !== false &&
          v.status !== "mastered" &&
          (v.status === "new" || v.dueAt == null || v.dueAt <= now) &&
          (!restrict || restrict.has(v.id)),
      )
      .sort((a, b) => {
        // due first (review/learning that's due), then new in insertion order
        const aDue = a.status !== "new" ? 0 : 1;
        const bDue = b.status !== "new" ? 0 : 1;
        if (aDue !== bDue) return aDue - bDue;
        return (a.dueAt ?? a.createdAt) - (b.dueAt ?? b.createdAt);
      })
      .slice(0, limit);
  }
  const db = await getDb();
  if (restrict) {
    const ids = [...restrict];
    const placeholders = ids.map((_, i) => `$${i + 3}`).join(", ");
    const rows = await db.select<VocabRow[]>(
      `SELECT ${VOCAB_LIST_COLS} FROM vocab_entries
       WHERE workspace_id = $1
         AND is_active = 1
         AND status != 'mastered'
         AND (
           status = 'new'
           OR due_at IS NULL
           OR due_at <= $2
         )
         AND id IN (${placeholders})
       ORDER BY
         CASE WHEN status = 'new' THEN 1 ELSE 0 END,
         (due_at IS NULL) DESC,
         due_at ASC,
         created_at ASC
       LIMIT ${ids.length}`,
      [workspaceId, now, ...ids],
    );
    return rows.map(rowToVocab);
  }
  const rows = await db.select<VocabRow[]>(
    `SELECT ${VOCAB_LIST_COLS} FROM vocab_entries
     WHERE workspace_id = $1
       AND is_active = 1
       AND status != 'mastered'
       AND (
         status = 'new'
         OR due_at IS NULL
         OR due_at <= $2
       )
     ORDER BY
       CASE WHEN status = 'new' THEN 1 ELSE 0 END,
       (due_at IS NULL) DESC,
       due_at ASC,
       created_at ASC
     LIMIT $3`,
    [workspaceId, now, limit],
  );
  return rows.map(rowToVocab);
}

// Full rows for an explicit id set — every status, active or library.
// Custom-study (chapter cram) sessions need the *whole* scope: a
// not-yet-pushed chapter is all `unseen` + inactive rows, and a chapter
// studied yesterday is all future-due — both invisible to the
// due/study-queue fetches above.
export async function listVocabByIds(
  workspaceId: number,
  ids: ReadonlySet<number>,
): Promise<VocabEntry[]> {
  if (ids.size === 0) return [];
  if (HOSTED) {
    // No by-ids endpoint yet — same single cached list call + client
    // filter `listStudyVocab` already leans on in HOSTED.
    const all = await cloudListVocab(workspaceId);
    return all.filter((v) => ids.has(v.id));
  }
  if (!isTauri()) {
    return fb.vocab.filter(
      (v) => v.workspaceId === workspaceId && ids.has(v.id),
    );
  }
  const db = await getDb();
  const arr = [...ids];
  const placeholders = arr.map((_, i) => `$${i + 2}`).join(", ");
  const rows = await db.select<VocabRow[]>(
    `SELECT ${VOCAB_LIST_COLS} FROM vocab_entries
     WHERE workspace_id = $1
       AND id IN (${placeholders})`,
    [workspaceId, ...arr],
  );
  return rows.map(rowToVocab);
}

type NoteRow = {
  id: number;
  workspace_id: number;
  title: string;
  body: string;
  pinned: number;
  created_at: number;
  updated_at: number;
};

function rowToNote(r: NoteRow): Note {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    body: r.body,
    pinned: !!r.pinned,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listNotes(workspaceId: number): Promise<Note[]> {
  if (HOSTED) return cloudListNotes(workspaceId);
  if (!isTauri()) {
    return fb.notes
      .filter((n) => n.workspaceId === workspaceId)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }
  const db = await getDb();
  const rows = await db.select<NoteRow[]>(
    "SELECT id, workspace_id, title, body, pinned, created_at, updated_at FROM notes WHERE workspace_id = $1 ORDER BY pinned DESC, updated_at DESC",
    [workspaceId],
  );
  return rows.map(rowToNote);
}

export async function createNote(input: { workspaceId: number; title?: string; body?: string }): Promise<Note> {
  const title = input.title ?? "Untitled";
  const body = input.body ?? "";
  if (HOSTED) {
    return cloudCreateNote({ workspaceId: input.workspaceId, title, body });
  }
  if (!isTauri()) {
    const n: Note = {
      id: fb.nextId++,
      workspaceId: input.workspaceId,
      title,
      body,
      pinned: false,
      createdAt: nowSec(),
      updatedAt: nowSec(),
    };
    fb.notes.push(n);
    return n;
  }
  const db = await getDb();
  const r = await db.execute(
    "INSERT INTO notes (workspace_id, title, body) VALUES ($1, $2, $3)",
    [input.workspaceId, title, body],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<NoteRow[]>(
    "SELECT id, workspace_id, title, body, pinned, created_at, updated_at FROM notes WHERE id = $1",
    [id],
  );
  const saved = rowToNote(rows[0]);
  await reindexKnowledgeSource({
    workspaceId: saved.workspaceId,
    sourceKind: "note",
    sourceId: saved.id,
    sourceTitle: saved.title,
    content: `${saved.title}\n\n${saved.body}`,
  }).catch(() => {});
  return saved;
}

export async function updateNote(id: number, patch: Partial<Pick<Note, "title" | "body" | "pinned">>): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudUpdateNote({ workspaceId, noteId: id, patch }),
    );
    return;
  }
  if (!isTauri()) {
    const n = fb.notes.find((x) => x.id === id);
    if (!n) return;
    if (patch.title != null) n.title = patch.title;
    if (patch.body != null) n.body = patch.body;
    if (patch.pinned != null) n.pinned = patch.pinned;
    n.updatedAt = nowSec();
    return;
  }
  const db = await getDb();
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) { fields.push(`title = $${fields.length + 1}`); params.push(patch.title); }
  if (patch.body !== undefined) { fields.push(`body = $${fields.length + 1}`); params.push(patch.body); }
  if (patch.pinned !== undefined) { fields.push(`pinned = $${fields.length + 1}`); params.push(patch.pinned ? 1 : 0); }
  if (fields.length === 0) return;
  fields.push(`updated_at = strftime('%s','now')`);
  params.push(id);
  await db.execute(
    `UPDATE notes SET ${fields.join(", ")} WHERE id = $${params.length}`,
    params,
  );
  // Re-pull the row so we can reindex with the latest title + body.
  const fresh = await db.select<NoteRow[]>(
    "SELECT id, workspace_id, title, body, pinned, created_at, updated_at FROM notes WHERE id = $1",
    [id],
  );
  if (fresh[0]) {
    const n = rowToNote(fresh[0]);
    await reindexKnowledgeSource({
      workspaceId: n.workspaceId,
      sourceKind: "note",
      sourceId: n.id,
      sourceTitle: n.title,
      content: `${n.title}\n\n${n.body}`,
    }).catch(() => {});
  }
}

export async function deleteNote(id: number): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudDeleteNote(workspaceId, id).then(() => true),
    );
    return;
  }
  if (!isTauri()) {
    fb.notes = fb.notes.filter((n) => n.id !== id);
    return;
  }
  const db = await getDb();
  const owner = await db.select<{ workspace_id: number }[]>(
    "SELECT workspace_id FROM notes WHERE id = $1",
    [id],
  );
  await db.execute("DELETE FROM notes WHERE id = $1", [id]);
  if (owner[0]) {
    await deleteKnowledgeSource(owner[0].workspace_id, "note", id).catch(() => {});
  }
}

type LibraryRow = {
  id: number;
  workspace_id: number;
  kind: string;
  title: string;
  author: string | null;
  source: string | null;
  total_units: number | null;
  unit_label: string;
  completed_units: number;
  total_seconds: number;
  status: string;
  cover_url: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

function rowToLibrary(r: LibraryRow): LibraryItem {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind as LibraryKind,
    title: r.title,
    author: r.author,
    source: r.source,
    totalUnits: r.total_units,
    unitLabel: r.unit_label,
    completedUnits: r.completed_units,
    totalSeconds: r.total_seconds,
    status: r.status as LibraryStatus,
    coverUrl: r.cover_url,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const LIB_COLS =
  "id, workspace_id, kind, title, author, source, total_units, unit_label, completed_units, total_seconds, status, cover_url, notes, created_at, updated_at";

// Pause every other active textbook in the workspace so the "what to study
// next" prompt has one obvious target. Non-textbook items are unaffected.
async function enforceSingleActiveTextbook(
  workspaceId: number,
  exceptItemId: number,
): Promise<void> {
  if (!isTauri()) {
    for (const it of fb.library) {
      if (
        it.workspaceId === workspaceId &&
        it.kind === "textbook" &&
        it.id !== exceptItemId &&
        it.status === "active"
      ) {
        it.status = "paused";
        it.updatedAt = nowSec();
      }
    }
    return;
  }
  const db = await getDb();
  await db.execute(
    `UPDATE library_items
       SET status = 'paused', updated_at = strftime('%s','now')
     WHERE workspace_id = $1
       AND kind = 'textbook'
       AND status = 'active'
       AND id != $2`,
    [workspaceId, exceptItemId],
  );
}

export async function listLibrary(workspaceId: number): Promise<LibraryItem[]> {
  if (HOSTED) return cloudListLibrary(workspaceId);
  if (!isTauri()) {
    return fb.library
      .filter((l) => l.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const db = await getDb();
  const rows = await db.select<LibraryRow[]>(
    `SELECT ${LIB_COLS} FROM library_items WHERE workspace_id = $1 ORDER BY updated_at DESC`,
    [workspaceId],
  );
  return rows.map(rowToLibrary);
}

export async function saveLibraryItem(input: {
  id?: number;
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
  if (HOSTED) {
    // Cloud POST is upsert-by-source for pack imports + plain
    // create otherwise. The id branch (in-place update without a
    // source tag) is desktop-only — Phase 2 will add a PATCH route
    // and wire it in here. For now an update without a source falls
    // back to a POST, which will create a duplicate. Document this
    // limitation rather than silently failing.
    return cloudSaveLibraryItem({
      workspaceId: input.workspaceId,
      kind: input.kind,
      title: input.title,
      author: input.author,
      source: input.source,
      totalUnits: input.totalUnits,
      unitLabel: input.unitLabel,
      completedUnits: input.completedUnits,
      totalSeconds: input.totalSeconds,
      status: input.status,
      coverUrl: input.coverUrl,
      notes: input.notes,
    });
  }
  if (!isTauri()) {
    let saved: LibraryItem;
    if (input.id) {
      const idx = fb.library.findIndex((l) => l.id === input.id);
      if (idx >= 0) {
        fb.library[idx] = {
          ...fb.library[idx],
          ...{
            kind: input.kind,
            title: input.title,
            author: input.author ?? null,
            source: input.source ?? null,
            totalUnits: input.totalUnits ?? null,
            unitLabel: input.unitLabel ?? fb.library[idx].unitLabel,
            completedUnits: input.completedUnits ?? fb.library[idx].completedUnits,
            totalSeconds: input.totalSeconds ?? fb.library[idx].totalSeconds,
            status: input.status ?? fb.library[idx].status,
            coverUrl: input.coverUrl ?? null,
            notes: input.notes ?? null,
            updatedAt: nowSec(),
          },
        };
        saved = fb.library[idx];
      } else {
        // id provided but not found — fall through to insert path below
        saved = null as unknown as LibraryItem;
      }
    } else {
      saved = null as unknown as LibraryItem;
    }
    if (!saved) {
      const item: LibraryItem = {
        id: fb.nextId++,
        workspaceId: input.workspaceId,
        kind: input.kind,
        title: input.title,
        author: input.author ?? null,
        source: input.source ?? null,
        totalUnits: input.totalUnits ?? null,
        unitLabel: input.unitLabel ?? "pages",
        completedUnits: input.completedUnits ?? 0,
        totalSeconds: input.totalSeconds ?? 0,
        status: input.status ?? "active",
        coverUrl: input.coverUrl ?? null,
        notes: input.notes ?? null,
        createdAt: nowSec(),
        updatedAt: nowSec(),
      };
      fb.library.push(item);
      saved = item;
    }
    if (saved.kind === "textbook" && saved.status === "active") {
      await enforceSingleActiveTextbook(saved.workspaceId, saved.id);
    }
    return saved;
  }
  const db = await getDb();
  let id = input.id ?? 0;
  if (id) {
    await db.execute(
      `UPDATE library_items SET
         kind=$1, title=$2, author=$3, source=$4,
         total_units=$5, unit_label=$6, completed_units=$7, total_seconds=$8,
         status=$9, cover_url=$10, notes=$11, updated_at=strftime('%s','now')
       WHERE id=$12`,
      [
        input.kind, input.title, input.author ?? null, input.source ?? null,
        input.totalUnits ?? null, input.unitLabel ?? "pages",
        input.completedUnits ?? 0, input.totalSeconds ?? 0,
        input.status ?? "active", input.coverUrl ?? null, input.notes ?? null,
        id,
      ],
    );
  } else {
    const r = await db.execute(
      `INSERT INTO library_items
         (workspace_id, kind, title, author, source, total_units, unit_label,
          completed_units, total_seconds, status, cover_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.workspaceId, input.kind, input.title, input.author ?? null,
        input.source ?? null, input.totalUnits ?? null, input.unitLabel ?? "pages",
        input.completedUnits ?? 0, input.totalSeconds ?? 0,
        input.status ?? "active", input.coverUrl ?? null, input.notes ?? null,
      ],
    );
    id = Number(r.lastInsertId ?? 0);
  }
  const rows = await db.select<LibraryRow[]>(
    `SELECT ${LIB_COLS} FROM library_items WHERE id = $1`,
    [id],
  );
  const saved = rowToLibrary(rows[0]);
  // Single-active-textbook constraint: if the saved item is a textbook
  // marked active, pause every other active textbook in the workspace.
  // Done after the upsert so the new row exists when we exempt it.
  if (saved.kind === "textbook" && saved.status === "active") {
    await enforceSingleActiveTextbook(saved.workspaceId, saved.id);
  }
  return saved;
}

/**
 * Targeted status flip — the safe path for "Make active" / "Pause"
 * buttons. Unlike saveLibraryItem (a full-row replace whose omitted
 * fields fall back to defaults), this touches ONLY `status`, so a
 * quick action can never wipe author / progress / notes. Activating a
 * textbook pauses every other active textbook in the workspace (the
 * single-active constraint), same as the saveLibraryItem path.
 */
export async function setLibraryStatus(
  id: number,
  status: LibraryStatus,
): Promise<void> {
  if (HOSTED) {
    // The cloud PATCH route applies the single-active constraint
    // server-side in the same transaction.
    await probeWorkspace((workspaceId) =>
      cloudUpdateLibraryItem({ workspaceId, itemId: id, patch: { status } }),
    );
    return;
  }
  if (!isTauri()) {
    const it = fb.library.find((x) => x.id === id);
    if (!it) return;
    it.status = status;
    it.updatedAt = nowSec();
    if (it.kind === "textbook" && status === "active") {
      await enforceSingleActiveTextbook(it.workspaceId, it.id);
    }
    return;
  }
  const db = await getDb();
  const rows = await db.select<{ workspace_id: number; kind: string }[]>(
    "SELECT workspace_id, kind FROM library_items WHERE id = $1",
    [id],
  );
  if (!rows.length) return;
  await db.execute(
    "UPDATE library_items SET status = $1, updated_at = strftime('%s','now') WHERE id = $2",
    [status, id],
  );
  if (rows[0].kind === "textbook" && status === "active") {
    await enforceSingleActiveTextbook(Number(rows[0].workspace_id), id);
  }
}

export async function bumpLibrary(id: number, deltaUnits = 0, deltaSeconds = 0): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudUpdateLibraryItem({
        workspaceId,
        itemId: id,
        patch: { bump: { deltaUnits, deltaSeconds } },
      }),
    );
    return;
  }
  if (!isTauri()) {
    const it = fb.library.find((x) => x.id === id);
    if (!it) return;
    it.completedUnits = Math.max(0, it.completedUnits + deltaUnits);
    it.totalSeconds = Math.max(0, it.totalSeconds + deltaSeconds);
    it.updatedAt = nowSec();
    return;
  }
  const db = await getDb();
  // MAX(0, …) mirrors the cloud PATCH route's clamp — a stray minus
  // click can't drive either counter negative.
  await db.execute(
    `UPDATE library_items
     SET completed_units = MAX(0, completed_units + $1),
         total_seconds   = MAX(0, total_seconds + $2),
         updated_at      = strftime('%s','now')
     WHERE id = $3`,
    [deltaUnits, deltaSeconds, id],
  );
}

export async function deleteLibraryItem(id: number): Promise<void> {
  if (HOSTED) {
    // Same workspace-probe pattern as deleteVocab — desktop callers
    // identify items by id alone, so we walk workspaces until the
    // delete succeeds. Cheap because the user typically has <5
    // workspaces.
    const all = await cloudListWorkspaces();
    for (const ws of all) {
      try {
        await cloudDeleteLibraryItem(ws.id, id);
        return;
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("not found")) {
          throw err;
        }
      }
    }
    return;
  }
  if (!isTauri()) {
    fb.library = fb.library.filter((l) => l.id !== id);
    fb.chapters = fb.chapters.filter((c) => c.itemId !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM library_items WHERE id = $1", [id]);
}

type ChapterRow = {
  id: number;
  item_id: number;
  position: number;
  title: string;
  completed_at: number | null;
  notes: string | null;
  created_at: number;
  collection_id: number | null;
};

function rowToChapter(r: ChapterRow): LibraryChapter {
  return {
    id: r.id,
    itemId: r.item_id,
    position: r.position,
    title: r.title,
    completedAt: r.completed_at,
    notes: r.notes,
    createdAt: r.created_at,
    collectionId: r.collection_id ?? null,
  };
}

const CHAPTER_COLS =
  "id, item_id, position, title, completed_at, notes, created_at, collection_id";

export async function listChapters(itemId: number): Promise<LibraryChapter[]> {
  if (HOSTED) {
    // Walk workspaces and try each — cheap because <5 workspaces is
    // the common case. A future refactor could cache itemId→wsId on
    // listLibrary, but the probe is honest about not knowing.
    const all = await cloudListWorkspaces();
    for (const ws of all) {
      try {
        return await cloudListChapters(ws.id, itemId);
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("not found")) {
          throw err;
        }
      }
    }
    return [];
  }
  if (!isTauri())
    return fb.chapters
      .filter((c) => c.itemId === itemId)
      .sort((a, b) => a.position - b.position);
  const db = await getDb();
  const rows = await db.select<ChapterRow[]>(
    `SELECT ${CHAPTER_COLS} FROM library_chapters WHERE item_id = $1 ORDER BY position ASC`,
    [itemId],
  );
  return rows.map(rowToChapter);
}

export async function createChapter(input: {
  itemId: number;
  title: string;
  position?: number;
}): Promise<LibraryChapter> {
  if (HOSTED) {
    const result = await probeWorkspace((workspaceId) =>
      cloudCreateChapter({
        workspaceId,
        itemId: input.itemId,
        title: input.title,
        position: input.position,
      }),
    );
    if (!result) throw new Error("library item not found");
    return result;
  }
  if (!isTauri()) {
    const existing = fb.chapters.filter((c) => c.itemId === input.itemId);
    const position = input.position ?? existing.length;
    const c: LibraryChapter = {
      id: fb.nextId++,
      itemId: input.itemId,
      position,
      title: input.title,
      completedAt: null,
      notes: null,
      createdAt: nowSec(),
      collectionId: null,
    };
    fb.chapters.push(c);
    return c;
  }
  const db = await getDb();
  let pos = input.position;
  if (pos == null) {
    const rows = await db.select<{ p: number | null }[]>(
      "SELECT MAX(position) AS p FROM library_chapters WHERE item_id = $1",
      [input.itemId],
    );
    pos = (rows[0]?.p ?? -1) + 1;
  }
  const r = await db.execute(
    "INSERT INTO library_chapters (item_id, position, title) VALUES ($1, $2, $3)",
    [input.itemId, pos, input.title],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<ChapterRow[]>(
    `SELECT ${CHAPTER_COLS} FROM library_chapters WHERE id = $1`,
    [id],
  );
  const ch = rowToChapter(rows[0]);
  await indexChapter(ch).catch(() => {});
  return ch;
}

async function indexChapter(ch: LibraryChapter): Promise<void> {
  if (!isTauri()) return;
  const content = `${ch.title}\n\n${ch.notes ?? ""}`.trim();
  if (!content) return;
  const db = await getDb();
  const owner = await db.select<{ workspace_id: number }[]>(
    "SELECT workspace_id FROM library_items WHERE id = $1",
    [ch.itemId],
  );
  if (!owner[0]) return;
  await reindexKnowledgeSource({
    workspaceId: owner[0].workspace_id,
    sourceKind: "chapter",
    sourceId: ch.id,
    sourceTitle: ch.title,
    content,
  });
}

export async function updateChapter(
  id: number,
  patch: Partial<Pick<LibraryChapter, "title" | "completedAt" | "notes" | "position">>,
): Promise<void> {
  if (HOSTED) {
    await cloudUpdateChapterById(id, patch);
    return;
  }
  if (!isTauri()) {
    const c = fb.chapters.find((x) => x.id === id);
    if (!c) return;
    if (patch.title !== undefined) c.title = patch.title;
    if (patch.completedAt !== undefined) c.completedAt = patch.completedAt;
    if (patch.notes !== undefined) c.notes = patch.notes;
    if (patch.position !== undefined) c.position = patch.position;
    return;
  }
  const db = await getDb();
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    fields.push(`title = $${fields.length + 1}`);
    params.push(patch.title);
  }
  if (patch.completedAt !== undefined) {
    fields.push(`completed_at = $${fields.length + 1}`);
    params.push(patch.completedAt);
  }
  if (patch.notes !== undefined) {
    fields.push(`notes = $${fields.length + 1}`);
    params.push(patch.notes);
  }
  if (patch.position !== undefined) {
    fields.push(`position = $${fields.length + 1}`);
    params.push(patch.position);
  }
  if (fields.length === 0) return;
  params.push(id);
  await db.execute(
    `UPDATE library_chapters SET ${fields.join(", ")} WHERE id = $${params.length}`,
    params,
  );
  // Reindex if the chapter's text content (title or notes) changed.
  if (patch.title !== undefined || patch.notes !== undefined) {
    const fresh = await db.select<ChapterRow[]>(
      `SELECT ${CHAPTER_COLS} FROM library_chapters WHERE id = $1`,
      [id],
    );
    if (fresh[0]) await indexChapter(rowToChapter(fresh[0])).catch(() => {});
  }
}

export async function setChapterCollection(
  chapterId: number,
  collectionId: number | null,
): Promise<void> {
  if (HOSTED) {
    await cloudUpdateChapterById(chapterId, { collectionId });
    return;
  }
  if (!isTauri()) {
    const c = fb.chapters.find((x) => x.id === chapterId);
    if (c) c.collectionId = collectionId;
    return;
  }
  const db = await getDb();
  await db.execute(
    "UPDATE library_chapters SET collection_id = $1 WHERE id = $2",
    [collectionId, chapterId],
  );
}

// Push every non-mastered word in a collection into active rotation.
// Flips status='learning', due_at=now, is_active=1 so pack-imported words
// surface in the due queue. Returns the number of rows touched.
export async function pushCollectionToDue(
  collectionId: number,
): Promise<{ vocabNudged: number }> {
  if (HOSTED) {
    // Hand-roll the bulk activation via the existing cloud routes:
    // list the collection's words, then call activateVocab on the
    // ids. A dedicated server endpoint would be slightly tidier,
    // but two round-trips is acceptable since this fires on user
    // intent ("push to flashcards"), not on hot paths.
    const probeResult = await probeWorkspace(async (workspaceId) => {
      const words = await cloudListCollectionWords(workspaceId, collectionId);
      if (words.length === 0) return { vocabNudged: 0 };
      const ids = words.filter((w) => w.status !== "mastered").map((w) => w.id);
      if (ids.length === 0) return { vocabNudged: 0 };
      const n = await cloudActivateVocab(workspaceId, ids);
      return { vocabNudged: n };
    });
    return probeResult ?? { vocabNudged: 0 };
  }
  if (!isTauri()) {
    const ids = (fb.collectionWords ?? [])
      .filter((cw) => cw.collectionId === collectionId)
      .map((cw) => cw.vocabId);
    let n = 0;
    for (const v of fb.vocab) {
      if (!ids.includes(v.id)) continue;
      if (v.status === "mastered") continue;
      v.status = "learning";
      v.dueAt = nowSec();
      v.isActive = true;
      n++;
    }
    return { vocabNudged: n };
  }
  const db = await getDb();
  const r = await db.execute(
    `UPDATE vocab_entries
       SET status = 'learning',
           due_at = $1,
           is_active = 1
     WHERE id IN (SELECT vocab_id FROM collection_words WHERE collection_id = $2)
       AND status != 'mastered'`,
    [nowSec(), collectionId],
  );
  return { vocabNudged: Number(r.rowsAffected ?? 0) };
}

// When `due=true` and the chapter has a linked collection, every non-mastered
// word in that collection is pushed to status='learning' with due_at=now.
export async function setChapterCompleted(
  chapterId: number,
  completed: boolean,
  options: { dueVocab?: boolean } = {},
): Promise<{ vocabNudged: number }> {
  const due = options.dueVocab ?? completed;
  if (HOSTED) {
    // The PATCH response includes the chapter's collectionId, which is
    // the link we need to fan the nudge out across the collection's
    // members without a second round-trip. pushCollectionToDue then
    // activates them via /vocab/activate, mirroring the desktop UPDATE
    // a few branches down.
    const chapter = await cloudUpdateChapterById(chapterId, {
      completedAt: completed ? nowSec() : null,
    });
    if (!due || chapter.collectionId == null) return { vocabNudged: 0 };
    return pushCollectionToDue(chapter.collectionId);
  }
  if (!isTauri()) {
    const c = fb.chapters.find((x) => x.id === chapterId);
    if (!c) return { vocabNudged: 0 };
    c.completedAt = completed ? nowSec() : null;
    if (!due || c.collectionId == null) return { vocabNudged: 0 };
    const ids = (fb.collectionWords ?? [])
      .filter((cw) => cw.collectionId === c.collectionId)
      .map((cw) => cw.vocabId);
    let n = 0;
    for (const v of fb.vocab) {
      if (!ids.includes(v.id)) continue;
      if (v.status === "mastered") continue;
      v.status = "learning";
      v.dueAt = nowSec();
      v.isActive = true;
      n++;
    }
    return { vocabNudged: n };
  }
  const db = await getDb();
  const now = nowSec();
  await db.execute(
    "UPDATE library_chapters SET completed_at = $1 WHERE id = $2",
    [completed ? now : null, chapterId],
  );
  if (!due) return { vocabNudged: 0 };
  // Look up the chapter's linked collection.
  const link = await db.select<{ collection_id: number | null }[]>(
    "SELECT collection_id FROM library_chapters WHERE id = $1",
    [chapterId],
  );
  const cid = link[0]?.collection_id ?? null;
  if (cid == null) return { vocabNudged: 0 };
  // is_active=1 is critical: pack-imported words start inactive and
  // listDueVocab would otherwise filter them out.
  const r = await db.execute(
    `UPDATE vocab_entries
       SET status = 'learning',
           due_at = $1,
           is_active = 1
     WHERE id IN (SELECT vocab_id FROM collection_words WHERE collection_id = $2)
       AND status != 'mastered'`,
    [now, cid],
  );
  return { vocabNudged: Number(r.rowsAffected ?? 0) };
}

export async function deleteChapter(id: number): Promise<void> {
  if (HOSTED) {
    await cloudDeleteChapterById(id);
    return;
  }
  if (!isTauri()) {
    fb.chapters = fb.chapters.filter((c) => c.id !== id);
    return;
  }
  const db = await getDb();
  // Resolve workspace via parent item before delete.
  const owner = await db.select<{ workspace_id: number }[]>(
    `SELECT li.workspace_id AS workspace_id
       FROM library_chapters c
       JOIN library_items li ON li.id = c.item_id
      WHERE c.id = $1`,
    [id],
  );
  await db.execute("DELETE FROM library_chapters WHERE id = $1", [id]);
  if (owner[0]) {
    await deleteKnowledgeSource(owner[0].workspace_id, "chapter", id).catch(() => {});
  }
}

// Guided writing practice. The user writes a paragraph, then submits for
// sentence-by-sentence LLM correction. Corrections persist on the row.
type JournalRow = {
  id: number;
  workspace_id: number;
  title: string;
  topic: string | null;
  body: string;
  state: string;
  corrections: string | null;
  source: string | null;
  created_at: number;
  updated_at: number;
};

const JOURNAL_COLS =
  "id, workspace_id, title, topic, body, state, corrections, source, created_at, updated_at";

function rowToJournal(r: JournalRow): JournalEntry {
  let corrections: JournalCorrection[] | null = null;
  if (r.corrections) {
    try {
      const parsed = JSON.parse(r.corrections);
      if (Array.isArray(parsed)) corrections = parsed as JournalCorrection[];
    } catch {
      /* corrupt JSON — leave null. The user can resubmit. */
    }
  }
  let source: JournalSource | null = null;
  if (r.source) {
    if (r.source === "manual" || r.source === "ai" || r.source === "vocab") {
      source = r.source;
    } else if (r.source.startsWith("chapter:")) {
      const cid = Number(r.source.slice("chapter:".length));
      if (Number.isFinite(cid)) source = { kind: "chapter", chapterId: cid };
    }
  }
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    topic: r.topic,
    body: r.body,
    state: (r.state === "corrected" ? "corrected" : "draft") as JournalState,
    corrections,
    source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function sourceToString(source: JournalSource | null): string | null {
  if (!source) return null;
  if (typeof source === "string") return source;
  return `chapter:${source.chapterId}`;
}

export async function listJournals(workspaceId: number): Promise<JournalEntry[]> {
  if (HOSTED) return cloudListJournals(workspaceId);
  if (!isTauri()) {
    return fb.journals
      .filter((j) => j.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const db = await getDb();
  const rows = await db.select<JournalRow[]>(
    `SELECT ${JOURNAL_COLS} FROM journal_entries WHERE workspace_id = $1 ORDER BY updated_at DESC`,
    [workspaceId],
  );
  return rows.map(rowToJournal);
}

export async function getJournal(id: number): Promise<JournalEntry | null> {
  if (HOSTED) {
    const result = await probeWorkspace((workspaceId) =>
      cloudGetJournal(workspaceId, id),
    );
    return result;
  }
  if (!isTauri()) {
    return fb.journals.find((j) => j.id === id) ?? null;
  }
  const db = await getDb();
  const rows = await db.select<JournalRow[]>(
    `SELECT ${JOURNAL_COLS} FROM journal_entries WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToJournal(rows[0]) : null;
}

export async function createJournal(input: {
  workspaceId: number;
  title?: string;
  topic?: string | null;
  body?: string;
  source?: JournalSource | null;
}): Promise<JournalEntry> {
  const title =
    (input.title?.trim() || input.topic?.trim() || "Untitled entry").slice(0, 200);
  if (HOSTED) {
    return cloudCreateJournal({
      workspaceId: input.workspaceId,
      title,
      topic: input.topic ?? null,
      body: input.body ?? "",
      source: input.source != null ? sourceToString(input.source) : null,
    });
  }
  if (!isTauri()) {
    const j: JournalEntry = {
      id: fb.nextId++,
      workspaceId: input.workspaceId,
      title,
      topic: input.topic ?? null,
      body: input.body ?? "",
      state: "draft",
      corrections: null,
      source: input.source ?? null,
      createdAt: nowSec(),
      updatedAt: nowSec(),
    };
    fb.journals.push(j);
    return j;
  }
  const db = await getDb();
  const r = await db.execute(
    `INSERT INTO journal_entries (workspace_id, title, topic, body, state, source)
     VALUES ($1, $2, $3, $4, 'draft', $5)`,
    [
      input.workspaceId,
      title,
      input.topic ?? null,
      input.body ?? "",
      sourceToString(input.source ?? null),
    ],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<JournalRow[]>(
    `SELECT ${JOURNAL_COLS} FROM journal_entries WHERE id = $1`,
    [id],
  );
  return rowToJournal(rows[0]);
}

export async function updateJournal(
  id: number,
  patch: Partial<{
    title: string;
    topic: string | null;
    body: string;
    state: JournalState;
    corrections: JournalCorrection[] | null;
    source: JournalSource | null;
  }>,
): Promise<void> {
  if (HOSTED) {
    // Encode the JSON-ish fields the way the cloud expects (strings,
    // matching the desktop's stored TEXT shape). Skip undefined keys
    // so the PATCH only touches what the caller supplied.
    const cloudPatch: Record<string, unknown> = {};
    if (patch.title !== undefined) cloudPatch.title = patch.title;
    if (patch.topic !== undefined) cloudPatch.topic = patch.topic;
    if (patch.body !== undefined) cloudPatch.body = patch.body;
    if (patch.state !== undefined) cloudPatch.state = patch.state;
    if (patch.corrections !== undefined) {
      cloudPatch.corrections = patch.corrections
        ? JSON.stringify(patch.corrections)
        : null;
    }
    if (patch.source !== undefined) {
      cloudPatch.source = sourceToString(patch.source);
    }
    await probeWorkspace((workspaceId) =>
      cloudUpdateJournal({ workspaceId, journalId: id, patch: cloudPatch }),
    );
    return;
  }
  if (!isTauri()) {
    const j = fb.journals.find((x) => x.id === id);
    if (!j) return;
    if (patch.title !== undefined) j.title = patch.title;
    if (patch.topic !== undefined) j.topic = patch.topic;
    if (patch.body !== undefined) j.body = patch.body;
    if (patch.state !== undefined) j.state = patch.state;
    if (patch.corrections !== undefined) j.corrections = patch.corrections;
    if (patch.source !== undefined) j.source = patch.source;
    j.updatedAt = nowSec();
    return;
  }
  const db = await getDb();
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    fields.push(`title = $${fields.length + 1}`);
    params.push(patch.title);
  }
  if (patch.topic !== undefined) {
    fields.push(`topic = $${fields.length + 1}`);
    params.push(patch.topic);
  }
  if (patch.body !== undefined) {
    fields.push(`body = $${fields.length + 1}`);
    params.push(patch.body);
  }
  if (patch.state !== undefined) {
    fields.push(`state = $${fields.length + 1}`);
    params.push(patch.state);
  }
  if (patch.corrections !== undefined) {
    fields.push(`corrections = $${fields.length + 1}`);
    params.push(
      patch.corrections ? JSON.stringify(patch.corrections) : null,
    );
  }
  if (patch.source !== undefined) {
    fields.push(`source = $${fields.length + 1}`);
    params.push(sourceToString(patch.source));
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = strftime('%s','now')`);
  params.push(id);
  await db.execute(
    `UPDATE journal_entries SET ${fields.join(", ")} WHERE id = $${params.length}`,
    params,
  );
}

export async function deleteJournal(id: number): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudDeleteJournal(workspaceId, id).then(() => true),
    );
    return;
  }
  if (!isTauri()) {
    fb.journals = fb.journals.filter((j) => j.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM journal_entries WHERE id = $1", [id]);
}

type PromptRow = {
  id: number;
  name: string;
  body: string;
  is_default: number;
  created_at: number;
};

function rowToPrompt(r: PromptRow): SystemPrompt {
  return {
    id: r.id,
    name: r.name,
    body: r.body,
    isDefault: !!r.is_default,
    createdAt: r.created_at,
  };
}

export async function listSystemPrompts(): Promise<SystemPrompt[]> {
  if (HOSTED) return cloudListSystemPrompts();
  if (!isTauri())
    return [...fb.prompts].sort((a, b) => a.createdAt - b.createdAt);
  const db = await getDb();
  const rows = await db.select<PromptRow[]>(
    "SELECT id, name, body, is_default, created_at FROM system_prompts ORDER BY created_at ASC",
  );
  return rows.map(rowToPrompt);
}

export async function saveSystemPrompt(input: {
  id?: number;
  name: string;
  body: string;
  isDefault?: boolean;
}): Promise<SystemPrompt> {
  if (HOSTED) return cloudSaveSystemPrompt(input);
  if (!isTauri()) {
    let id = input.id ?? 0;
    if (id) {
      const idx = fb.prompts.findIndex((p) => p.id === id);
      if (idx >= 0) fb.prompts[idx] = { ...fb.prompts[idx], name: input.name, body: input.body };
    } else {
      id = fb.nextId++;
      fb.prompts.push({ id, name: input.name, body: input.body, isDefault: false, createdAt: nowSec() });
    }
    if (input.isDefault) fb.prompts = fb.prompts.map((p) => ({ ...p, isDefault: p.id === id }));
    return fb.prompts.find((p) => p.id === id)!;
  }
  const db = await getDb();
  let id = input.id ?? 0;
  if (id) {
    await db.execute("UPDATE system_prompts SET name = $1, body = $2 WHERE id = $3", [input.name, input.body, id]);
  } else {
    const r = await db.execute("INSERT INTO system_prompts (name, body) VALUES ($1, $2)", [input.name, input.body]);
    id = Number(r.lastInsertId ?? 0);
  }
  if (input.isDefault) {
    await db.execute("UPDATE system_prompts SET is_default = 0");
    await db.execute("UPDATE system_prompts SET is_default = 1 WHERE id = $1", [id]);
  }
  const rows = await db.select<PromptRow[]>(
    "SELECT id, name, body, is_default, created_at FROM system_prompts WHERE id = $1",
    [id],
  );
  return rowToPrompt(rows[0]);
}

export async function deleteSystemPrompt(id: number): Promise<void> {
  if (HOSTED) {
    await cloudDeleteSystemPrompt(id);
    return;
  }
  if (!isTauri()) {
    fb.prompts = fb.prompts.filter((p) => p.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM system_prompts WHERE id = $1", [id]);
}

type ReaderRow = {
  id: number;
  workspace_id: number;
  title: string;
  body: string;
  source_url: string | null;
  created_at: number;
  updated_at: number;
  parent_id: number | null;
  level: string;
  library_item_id: number | null;
  chapter_position: number | null;
  source_document_id?: number | null;
  page_start?: number | null;
  page_end?: number | null;
  has_audio?: number;
  audio_mime?: string | null;
};

const READER_COLS =
  "id, workspace_id, title, body, source_url, created_at, updated_at, parent_id, level, library_item_id, chapter_position, source_document_id, page_start, page_end, CASE WHEN audio_data IS NOT NULL THEN 1 ELSE 0 END AS has_audio, audio_mime";

function rowToReader(r: ReaderRow): ReaderDocument {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    body: r.body,
    sourceUrl: r.source_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    parentId: r.parent_id ?? null,
    level: ((r.level as ReaderLevel) ?? "original"),
    libraryItemId: r.library_item_id ?? null,
    chapterPosition: r.chapter_position ?? null,
    sourceDocumentId: r.source_document_id ?? null,
    pageStart: r.page_start ?? null,
    pageEnd: r.page_end ?? null,
    hasAudio: (r.has_audio ?? 0) > 0,
    audioMime: r.audio_mime ?? null,
  };
}

export async function listReaderDocs(workspaceId: number): Promise<ReaderDocument[]> {
  if (HOSTED) return cloudListReaderDocs(workspaceId);
  // Top-level docs only — variants stay attached to their parent.
  if (!isTauri())
    return fb.readerDocs
      .filter((d) => d.workspaceId === workspaceId && d.parentId == null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  const db = await getDb();
  const rows = await db.select<ReaderRow[]>(
    `SELECT ${READER_COLS} FROM reader_documents WHERE workspace_id = $1 AND parent_id IS NULL ORDER BY updated_at DESC`,
    [workspaceId],
  );
  return rows.map(rowToReader);
}

export async function listReaderVariants(parentId: number): Promise<ReaderDocument[]> {
  if (HOSTED) {
    // Variants live under their parent — list with `parentId=`.
    // We also include the parent itself to match desktop semantics
    // (which returns the parent first, then children).
    const result = await probeWorkspace(async (workspaceId) => {
      const children = await cloudListReaderDocs(workspaceId, { parentId });
      const parentDocs = await cloudListReaderDocs(workspaceId);
      const parent = parentDocs.find((d) => d.id === parentId);
      return parent ? [parent, ...children] : children;
    });
    return result ?? [];
  }
  if (!isTauri()) {
    const parent = fb.readerDocs.find((d) => d.id === parentId);
    if (!parent) return [];
    const children = fb.readerDocs.filter((d) => d.parentId === parentId);
    return [parent, ...children];
  }
  const db = await getDb();
  const rows = await db.select<ReaderRow[]>(
    `SELECT ${READER_COLS} FROM reader_documents WHERE id = $1 OR parent_id = $1 ORDER BY level`,
    [parentId],
  );
  return rows.map(rowToReader);
}

export async function listBookChapters(libraryItemId: number): Promise<ReaderDocument[]> {
  if (HOSTED) {
    const result = await probeWorkspace((workspaceId) =>
      cloudListReaderDocs(workspaceId, { libraryItemId }),
    );
    return result ?? [];
  }
  if (!isTauri())
    return fb.readerDocs
      .filter(
        (d) =>
          d.libraryItemId === libraryItemId &&
          d.parentId == null,
      )
      .sort((a, b) => (a.chapterPosition ?? 0) - (b.chapterPosition ?? 0));
  const db = await getDb();
  const rows = await db.select<ReaderRow[]>(
    `SELECT ${READER_COLS} FROM reader_documents WHERE library_item_id = $1 AND parent_id IS NULL ORDER BY chapter_position ASC, id ASC`,
    [libraryItemId],
  );
  return rows.map(rowToReader);
}

export async function saveReaderDoc(input: {
  id?: number;
  workspaceId: number;
  title: string;
  body: string;
  sourceUrl?: string | null;
  parentId?: number | null;
  level?: ReaderLevel;
  libraryItemId?: number | null;
  chapterPosition?: number | null;
  sourceDocumentId?: number | null;
  pageStart?: number | null;
  pageEnd?: number | null;
}): Promise<ReaderDocument> {
  const sourceUrlProvided = input.sourceUrl !== undefined;
  const parentIdProvided = input.parentId !== undefined;
  const levelProvided = input.level !== undefined;
  const libraryItemIdProvided = input.libraryItemId !== undefined;
  const chapterPositionProvided = input.chapterPosition !== undefined;
  const sourceDocumentIdProvided = input.sourceDocumentId !== undefined;
  const pageStartProvided = input.pageStart !== undefined;
  const pageEndProvided = input.pageEnd !== undefined;

  if (HOSTED) {
    return cloudSaveReaderDoc({
      workspaceId: input.workspaceId,
      id: input.id,
      title: input.title,
      body: input.body,
      sourceUrl: sourceUrlProvided ? input.sourceUrl : undefined,
      parentId: parentIdProvided ? input.parentId : undefined,
      level: levelProvided ? input.level : undefined,
      libraryItemId: libraryItemIdProvided ? input.libraryItemId : undefined,
      chapterPosition: chapterPositionProvided ? input.chapterPosition : undefined,
    });
  }
  if (!isTauri()) {
    if (input.id) {
      const idx = fb.readerDocs.findIndex((d) => d.id === input.id);
      if (idx >= 0) {
        const prev = fb.readerDocs[idx];
        const bodyChanged = prev.body !== input.body;
        fb.readerDocs[idx] = {
          ...prev,
          title: input.title,
          body: input.body,
          sourceUrl: sourceUrlProvided
            ? (input.sourceUrl ?? null)
            : prev.sourceUrl,
          parentId: parentIdProvided ? (input.parentId ?? null) : prev.parentId,
          level: levelProvided ? (input.level ?? "original") : prev.level,
          libraryItemId: libraryItemIdProvided
            ? (input.libraryItemId ?? null)
            : prev.libraryItemId,
          chapterPosition: chapterPositionProvided
            ? (input.chapterPosition ?? null)
            : prev.chapterPosition,
          sourceDocumentId: sourceDocumentIdProvided
            ? (input.sourceDocumentId ?? null)
            : prev.sourceDocumentId,
          pageStart: pageStartProvided ? (input.pageStart ?? null) : prev.pageStart,
          pageEnd: pageEndProvided ? (input.pageEnd ?? null) : prev.pageEnd,
          // A body edit invalidates any cached audio — the bytes no
          // longer reflect the prose.
          hasAudio: bodyChanged ? false : prev.hasAudio,
          audioMime: bodyChanged ? null : prev.audioMime,
          updatedAt: nowSec(),
        };
        return fb.readerDocs[idx];
      }
    }
    const d: ReaderDocument = {
      id: fb.nextId++,
      workspaceId: input.workspaceId,
      title: input.title,
      body: input.body,
      sourceUrl: input.sourceUrl ?? null,
      createdAt: nowSec(),
      updatedAt: nowSec(),
      parentId: input.parentId ?? null,
      level: input.level ?? "original",
      libraryItemId: input.libraryItemId ?? null,
      chapterPosition: input.chapterPosition ?? null,
      sourceDocumentId: input.sourceDocumentId ?? null,
      pageStart: input.pageStart ?? null,
      pageEnd: input.pageEnd ?? null,
      hasAudio: false,
      audioMime: null,
    };
    fb.readerDocs.push(d);
    return d;
  }
  const db = await getDb();
  let id = input.id ?? 0;
  if (id) {
    // Build a partial UPDATE that only touches columns the caller actually
    // passed. Keeps existing values otherwise.
    const sets: string[] = ["title = $1", "body = $2"];
    const params: unknown[] = [input.title, input.body];
    if (sourceUrlProvided) {
      sets.push(`source_url = $${sets.length + 1}`);
      params.push(input.sourceUrl ?? null);
    }
    if (parentIdProvided) {
      sets.push(`parent_id = $${sets.length + 1}`);
      params.push(input.parentId ?? null);
    }
    if (levelProvided) {
      sets.push(`level = $${sets.length + 1}`);
      params.push(input.level ?? "original");
    }
    if (libraryItemIdProvided) {
      sets.push(`library_item_id = $${sets.length + 1}`);
      params.push(input.libraryItemId ?? null);
    }
    if (chapterPositionProvided) {
      sets.push(`chapter_position = $${sets.length + 1}`);
      params.push(input.chapterPosition ?? null);
    }
    if (sourceDocumentIdProvided) {
      sets.push(`source_document_id = $${sets.length + 1}`);
      params.push(input.sourceDocumentId ?? null);
    }
    if (pageStartProvided) {
      sets.push(`page_start = $${sets.length + 1}`);
      params.push(input.pageStart ?? null);
    }
    if (pageEndProvided) {
      sets.push(`page_end = $${sets.length + 1}`);
      params.push(input.pageEnd ?? null);
    }
    // If the body actually changed, drop any cached TTS audio — the
    // bytes no longer match the prose. Cheap to check before
    // committing the UPDATE.
    const prev = await db.select<{ body: string }[]>(
      "SELECT body FROM reader_documents WHERE id = $1",
      [id],
    );
    if (prev[0] && prev[0].body !== input.body) {
      sets.push("audio_data = NULL", "audio_mime = NULL");
    }
    sets.push("updated_at = strftime('%s','now')");
    params.push(id);
    await db.execute(
      `UPDATE reader_documents SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params,
    );
  } else {
    const r = await db.execute(
      `INSERT INTO reader_documents (workspace_id, title, body, source_url, parent_id, level, library_item_id, chapter_position, source_document_id, page_start, page_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.workspaceId,
        input.title,
        input.body,
        input.sourceUrl ?? null,
        input.parentId ?? null,
        input.level ?? "original",
        input.libraryItemId ?? null,
        input.chapterPosition ?? null,
        input.sourceDocumentId ?? null,
        input.pageStart ?? null,
        input.pageEnd ?? null,
      ],
    );
    id = Number(r.lastInsertId ?? 0);
  }
  const rows = await db.select<ReaderRow[]>(
    `SELECT ${READER_COLS} FROM reader_documents WHERE id = $1`,
    [id],
  );
  const saved = rowToReader(rows[0]);
  await reindexKnowledgeSource({
    workspaceId: saved.workspaceId,
    sourceKind: "reader",
    sourceId: saved.id,
    sourceTitle: saved.title,
    content: `${saved.title}\n\n${saved.body}`,
  }).catch(() => {});
  return saved;
}

export async function deleteReaderDoc(id: number): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudDeleteReaderDoc(workspaceId, id).then(() => true),
    );
    return;
  }
  if (!isTauri()) {
    fb.readerDocs = fb.readerDocs.filter((d) => d.id !== id);
    return;
  }
  const db = await getDb();
  // Look up workspace_id BEFORE the delete so we can drop chunks too.
  const owner = await db.select<{ workspace_id: number }[]>(
    "SELECT workspace_id FROM reader_documents WHERE id = $1",
    [id],
  );
  await db.execute("DELETE FROM reader_documents WHERE id = $1", [id]);
  if (owner[0]) {
    await deleteKnowledgeSource(owner[0].workspace_id, "reader", id).catch(() => {});
  }
}

// Lives here so the DB layer doesn't have to import the TTS module.
export type ReaderWordBoundary = {
  offsetMs: number;
  durationMs: number;
  text: string;
};

// Returns null when no audio is attached. `boundaries` is populated when the
// audio was synthesised through Edge TTS (word-timed backend).
export async function getReaderAudio(
  id: number,
): Promise<{
  bytes: Uint8Array;
  mime: string;
  boundaries: ReaderWordBoundary[] | null;
} | null> {
  if (!isTauri()) {
    const d = fb.readerDocs.find((x) => x.id === id);
    if (!d?.hasAudio) return null;
    return {
      bytes: new Uint8Array(),
      mime: d.audioMime ?? "audio/mpeg",
      boundaries: null,
    };
  }
  const db = await getDb();
  const rows = await db.select<{
    audio_data: number[] | null;
    audio_mime: string | null;
    audio_boundaries: string | null;
  }[]>(
    "SELECT audio_data, audio_mime, audio_boundaries FROM reader_documents WHERE id = $1",
    [id],
  );
  const r = rows[0];
  if (!r || r.audio_data == null) return null;
  let boundaries: ReaderWordBoundary[] | null = null;
  if (r.audio_boundaries) {
    try {
      const parsed = JSON.parse(r.audio_boundaries);
      if (Array.isArray(parsed)) boundaries = parsed as ReaderWordBoundary[];
    } catch {
      // Corrupt JSON — ignore, fall back to no-highlight playback.
    }
  }
  return {
    bytes: Uint8Array.from(r.audio_data),
    mime: r.audio_mime ?? "audio/mpeg",
    boundaries,
  };
}

// Pass null bytes to drop the cache.
export async function saveReaderAudio(input: {
  id: number;
  bytes: Uint8Array | null;
  mime?: string | null;
  boundaries?: ReaderWordBoundary[] | null;
}): Promise<void> {
  if (!isTauri()) {
    const d = fb.readerDocs.find((x) => x.id === input.id);
    if (d) {
      d.hasAudio = input.bytes != null && input.bytes.byteLength > 0;
      d.audioMime = input.bytes != null ? (input.mime ?? "audio/mpeg") : null;
    }
    return;
  }
  const db = await getDb();
  const boundariesJson =
    input.bytes == null || input.boundaries == null || input.boundaries.length === 0
      ? null
      : JSON.stringify(input.boundaries);
  await db.execute(
    "UPDATE reader_documents SET audio_data = $1, audio_mime = $2, audio_boundaries = $3 WHERE id = $4",
    [
      input.bytes == null ? null : Array.from(input.bytes),
      input.bytes == null ? null : (input.mime ?? "audio/mpeg"),
      boundariesJson,
      input.id,
    ],
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Source documents (PDF / image blobs) + per-page word layouts + note
// attachments. Backing store for the interactive page-overlay reader and the
// notes "keep the source image" feature. Desktop-only: HOSTED has no per-user
// blob store yet (same deferred gap as vocab image/audio bytes), so these
// no-op / return empty in the cloud build and the reader falls back to text.
// ───────────────────────────────────────────────────────────────────────────

type SourceDocRow = {
  id: number;
  workspace_id: number;
  kind: string;
  file_name: string;
  mime: string;
  num_pages: number;
  created_at: number;
};

const SOURCE_DOC_COLS =
  "id, workspace_id, kind, file_name, mime, num_pages, created_at";

function rowToSourceDoc(r: SourceDocRow): SourceDocument {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: (r.kind as SourceDocKind) ?? "image",
    fileName: r.file_name,
    mime: r.mime,
    numPages: r.num_pages,
    createdAt: r.created_at,
  };
}

const stripDocBytes = (
  d: SourceDocument & { bytes: Uint8Array },
): SourceDocument => ({
  id: d.id,
  workspaceId: d.workspaceId,
  kind: d.kind,
  fileName: d.fileName,
  mime: d.mime,
  numPages: d.numPages,
  createdAt: d.createdAt,
});

export async function saveSourceDocument(input: {
  workspaceId: number;
  kind: SourceDocKind;
  fileName: string;
  mime: string;
  bytes: Uint8Array;
  numPages?: number;
}): Promise<SourceDocument | null> {
  // HOSTED has no per-user blob store — the overlay reader is desktop-only.
  if (HOSTED) return null;
  const numPages = input.numPages ?? 1;
  if (!isTauri()) {
    const doc: SourceDocument = {
      id: fb.nextId++,
      workspaceId: input.workspaceId,
      kind: input.kind,
      fileName: input.fileName,
      mime: input.mime,
      numPages,
      createdAt: nowSec(),
    };
    fb.sourceDocuments.push({ ...doc, bytes: input.bytes });
    return doc;
  }
  const db = await getDb();
  const r = await db.execute(
    `INSERT INTO source_documents (workspace_id, kind, file_name, mime, bytes, num_pages)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.workspaceId,
      input.kind,
      input.fileName,
      input.mime,
      Array.from(input.bytes),
      numPages,
    ],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<SourceDocRow[]>(
    `SELECT ${SOURCE_DOC_COLS} FROM source_documents WHERE id = $1`,
    [id],
  );
  return rowToSourceDoc(rows[0]);
}

export async function getSourceDocumentBytes(
  id: number,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (HOSTED) return null;
  if (!isTauri()) {
    const d = fb.sourceDocuments.find((x) => x.id === id);
    return d ? { bytes: d.bytes, mime: d.mime } : null;
  }
  const db = await getDb();
  const rows = await db.select<{ bytes: number[] | null; mime: string }[]>(
    "SELECT bytes, mime FROM source_documents WHERE id = $1",
    [id],
  );
  const r = rows[0];
  if (!r || r.bytes == null) return null;
  return { bytes: Uint8Array.from(r.bytes), mime: r.mime };
}

export async function listSourceDocuments(
  workspaceId: number,
): Promise<SourceDocument[]> {
  if (HOSTED) return [];
  if (!isTauri())
    return fb.sourceDocuments
      .filter((d) => d.workspaceId === workspaceId)
      .map(stripDocBytes)
      .sort((a, b) => b.createdAt - a.createdAt);
  const db = await getDb();
  // Never SELECT `bytes` here — list queries would balloon (same reason
  // READER_COLS omits audio_data). Fetch bytes lazily via getSourceDocumentBytes.
  const rows = await db.select<SourceDocRow[]>(
    `SELECT ${SOURCE_DOC_COLS} FROM source_documents WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map(rowToSourceDoc);
}

type PageLayoutRow = {
  id: number;
  source_document_id: number;
  page_index: number;
  width: number;
  height: number;
  words_json: string;
  ocr_done: number;
};

const PAGE_LAYOUT_COLS =
  "id, source_document_id, page_index, width, height, words_json, ocr_done";

function rowToPageLayout(r: PageLayoutRow): PageLayout {
  let words: WordBox[] = [];
  try {
    const parsed = JSON.parse(r.words_json);
    if (Array.isArray(parsed)) words = parsed as WordBox[];
  } catch {
    // Corrupt JSON — render the page image with no hotspots rather than throw.
  }
  return {
    id: r.id,
    sourceDocumentId: r.source_document_id,
    pageIndex: r.page_index,
    width: r.width,
    height: r.height,
    words,
    ocrDone: r.ocr_done > 0,
  };
}

export async function savePageLayout(input: {
  sourceDocumentId: number;
  pageIndex: number;
  width: number;
  height: number;
  words: WordBox[];
  ocrDone?: boolean;
}): Promise<void> {
  if (HOSTED) return;
  if (!isTauri()) {
    const existing = fb.pageLayouts.find(
      (p) =>
        p.sourceDocumentId === input.sourceDocumentId &&
        p.pageIndex === input.pageIndex,
    );
    if (existing) {
      existing.width = input.width;
      existing.height = input.height;
      existing.words = input.words;
      existing.ocrDone = input.ocrDone ?? false;
      return;
    }
    fb.pageLayouts.push({
      id: fb.nextId++,
      sourceDocumentId: input.sourceDocumentId,
      pageIndex: input.pageIndex,
      width: input.width,
      height: input.height,
      words: input.words,
      ocrDone: input.ocrDone ?? false,
    });
    return;
  }
  const db = await getDb();
  // Upsert on the (source_document_id, page_index) unique key — lets Phase 3
  // fill in a scanned page's boxes lazily without a separate update path.
  await db.execute(
    `INSERT INTO page_layouts (source_document_id, page_index, width, height, words_json, ocr_done)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(source_document_id, page_index)
     DO UPDATE SET width = excluded.width, height = excluded.height,
                   words_json = excluded.words_json, ocr_done = excluded.ocr_done`,
    [
      input.sourceDocumentId,
      input.pageIndex,
      input.width,
      input.height,
      JSON.stringify(input.words),
      input.ocrDone ? 1 : 0,
    ],
  );
}

export async function getPageLayout(
  sourceDocumentId: number,
  pageIndex: number,
): Promise<PageLayout | null> {
  if (HOSTED) return null;
  if (!isTauri())
    return (
      fb.pageLayouts.find(
        (p) =>
          p.sourceDocumentId === sourceDocumentId && p.pageIndex === pageIndex,
      ) ?? null
    );
  const db = await getDb();
  const rows = await db.select<PageLayoutRow[]>(
    `SELECT ${PAGE_LAYOUT_COLS} FROM page_layouts WHERE source_document_id = $1 AND page_index = $2`,
    [sourceDocumentId, pageIndex],
  );
  return rows[0] ? rowToPageLayout(rows[0]) : null;
}

export async function listPageLayouts(
  sourceDocumentId: number,
): Promise<PageLayout[]> {
  if (HOSTED) return [];
  if (!isTauri())
    return fb.pageLayouts
      .filter((p) => p.sourceDocumentId === sourceDocumentId)
      .sort((a, b) => a.pageIndex - b.pageIndex);
  const db = await getDb();
  const rows = await db.select<PageLayoutRow[]>(
    `SELECT ${PAGE_LAYOUT_COLS} FROM page_layouts WHERE source_document_id = $1 ORDER BY page_index ASC`,
    [sourceDocumentId],
  );
  return rows.map(rowToPageLayout);
}

export async function addNoteAttachment(input: {
  noteId: number;
  sourceDocumentId: number;
}): Promise<NoteAttachment | null> {
  if (HOSTED) return null;
  if (!isTauri()) {
    const a: NoteAttachment = {
      id: fb.nextId++,
      noteId: input.noteId,
      sourceDocumentId: input.sourceDocumentId,
      createdAt: nowSec(),
    };
    fb.noteAttachments.push(a);
    return a;
  }
  const db = await getDb();
  const r = await db.execute(
    "INSERT INTO note_attachments (note_id, source_document_id) VALUES ($1, $2)",
    [input.noteId, input.sourceDocumentId],
  );
  return {
    id: Number(r.lastInsertId ?? 0),
    noteId: input.noteId,
    sourceDocumentId: input.sourceDocumentId,
    createdAt: nowSec(),
  };
}

export async function listNoteAttachments(
  noteId: number,
): Promise<NoteAttachment[]> {
  if (HOSTED) return [];
  if (!isTauri())
    return fb.noteAttachments
      .filter((a) => a.noteId === noteId)
      .sort((a, b) => a.createdAt - b.createdAt);
  const db = await getDb();
  const rows = await db.select<{
    id: number;
    note_id: number;
    source_document_id: number;
    created_at: number;
  }[]>(
    "SELECT id, note_id, source_document_id, created_at FROM note_attachments WHERE note_id = $1 ORDER BY created_at ASC",
    [noteId],
  );
  return rows.map((r) => ({
    id: r.id,
    noteId: r.note_id,
    sourceDocumentId: r.source_document_id,
    createdAt: r.created_at,
  }));
}

type CollectionRow = {
  id: number;
  workspace_id: number;
  name: string;
  description: string | null;
  is_default: number;
  source: string;
  preset_id: string | null;
  parent_collection_id: number | null;
  created_at: number;
  updated_at: number;
  word_count?: number;
};

function rowToCollection(r: CollectionRow): Collection {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    description: r.description,
    isDefault: r.is_default === 1,
    source: (r.source as CollectionSource) ?? "user",
    presetId: r.preset_id,
    parentId: r.parent_collection_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    wordCount: r.word_count,
  };
}

const COLLECTION_COLS =
  "id, workspace_id, name, description, is_default, source, preset_id, parent_collection_id, created_at, updated_at";

const DEFAULT_COLLECTION_NAME = "Default";

export async function listCollections(workspaceId: number): Promise<Collection[]> {
  if (HOSTED) return cloudListCollections(workspaceId);
  if (!isTauri()) {
    const rows = (fb.collections ?? [])
      .filter((c) => c.workspaceId === workspaceId)
      .map((c) => ({
        ...c,
        wordCount: (fb.collectionWords ?? []).filter((cw) => cw.collectionId === c.id).length,
      }))
      // Default first, then most recently updated.
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
    return rows;
  }
  const db = await getDb();
  const rows = await db.select<CollectionRow[]>(
    `SELECT ${COLLECTION_COLS},
       (SELECT COUNT(*) FROM collection_words cw WHERE cw.collection_id = collections.id) AS word_count
     FROM collections WHERE workspace_id = $1
     ORDER BY is_default DESC, updated_at DESC`,
    [workspaceId],
  );
  return rows.map(rowToCollection);
}

export async function createCollection(input: {
  workspaceId: number;
  name: string;
  description?: string | null;
  source?: CollectionSource;
  presetId?: string | null;
  isDefault?: boolean;
  parentId?: number | null;
}): Promise<Collection> {
  if (HOSTED) {
    return cloudCreateCollection({
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description,
      source: input.source,
      presetId: input.presetId,
      parentId: input.parentId,
    });
  }
  if (!isTauri()) {
    fb.collections ??= [];
    const c: Collection = {
      id: fb.nextId++,
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description ?? null,
      isDefault: !!input.isDefault,
      source: input.source ?? "user",
      presetId: input.presetId ?? null,
      parentId: input.parentId ?? null,
      createdAt: nowSec(),
      updatedAt: nowSec(),
    };
    fb.collections.push(c);
    return c;
  }
  const db = await getDb();
  const r = await db.execute(
    `INSERT INTO collections (workspace_id, name, description, is_default, source, preset_id, parent_collection_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.workspaceId,
      input.name.trim() || "Untitled",
      input.description ?? null,
      input.isDefault ? 1 : 0,
      input.source ?? "user",
      input.presetId ?? null,
      input.parentId ?? null,
    ],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<CollectionRow[]>(
    `SELECT ${COLLECTION_COLS}, 0 AS word_count FROM collections WHERE id = $1`,
    [id],
  );
  return rowToCollection(rows[0]);
}

// No cycle protection — the UI's picker prevents descendants; callers from
// code must not create cycles themselves.
export async function setCollectionParent(
  id: number,
  parentId: number | null,
): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudUpdateCollection({
        workspaceId,
        collectionId: id,
        patch: { parentId },
      }),
    );
    return;
  }
  if (!isTauri()) {
    const c = (fb.collections ?? []).find((x) => x.id === id);
    if (c) {
      c.parentId = parentId;
      c.updatedAt = nowSec();
    }
    return;
  }
  const db = await getDb();
  await db.execute(
    `UPDATE collections SET parent_collection_id = $1, updated_at = strftime('%s','now') WHERE id = $2`,
    [parentId, id],
  );
}

export function collectionSubtree(
  all: Collection[],
  rootId: number,
): Collection[] {
  const byParent = new Map<number | null, Collection[]>();
  const byId = new Map<number, Collection>();
  for (const c of all) {
    const arr = byParent.get(c.parentId) ?? [];
    arr.push(c);
    byParent.set(c.parentId, arr);
    byId.set(c.id, c);
  }
  const out: Collection[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = byId.get(id);
    if (!node) continue;
    out.push(node);
    for (const child of byParent.get(id) ?? []) stack.push(child.id);
  }
  return out;
}

export async function getOrCreateDefaultCollection(
  workspaceId: number,
): Promise<Collection> {
  if (HOSTED) return cloudGetOrCreateDefaultCollection(workspaceId);
  const all = await listCollections(workspaceId);
  const found = all.find((c) => c.isDefault);
  if (found) return found;
  return createCollection({
    workspaceId,
    name: DEFAULT_COLLECTION_NAME,
    description: "Auto-created. Words you save without picking a list go here.",
    isDefault: true,
  });
}

export async function renameCollection(
  id: number,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudUpdateCollection({ workspaceId, collectionId: id, patch }),
    );
    return;
  }
  if (!isTauri()) {
    const c = (fb.collections ?? []).find((x) => x.id === id);
    if (!c) return;
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.description !== undefined) c.description = patch.description;
    c.updatedAt = nowSec();
    return;
  }
  const db = await getDb();
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    fields.push(`name = $${fields.length + 1}`);
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    fields.push(`description = $${fields.length + 1}`);
    params.push(patch.description);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = strftime('%s','now')`);
  params.push(id);
  await db.execute(
    `UPDATE collections SET ${fields.join(", ")} WHERE id = $${params.length}`,
    params,
  );
}

export async function deleteCollection(id: number): Promise<void> {
  if (HOSTED) {
    // Workspace-probe pattern (see deleteVocab / deleteLibraryItem).
    const all = await cloudListWorkspaces();
    for (const ws of all) {
      try {
        await cloudDeleteCollection(ws.id, id);
        return;
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("not found")) {
          throw err;
        }
      }
    }
    return;
  }
  if (!isTauri()) {
    fb.collections = (fb.collections ?? []).filter((c) => c.id !== id);
    fb.collectionWords = (fb.collectionWords ?? []).filter((cw) => cw.collectionId !== id);
    return;
  }
  const db = await getDb();
  // Don't allow deleting the default — guard at the call site, but be defensive.
  await db.execute("DELETE FROM collections WHERE id = $1 AND is_default = 0", [id]);
}

export async function listCollectionWords(collectionId: number): Promise<VocabEntry[]> {
  if (HOSTED) {
    // Workspace probe — see deleteVocab for the same pattern.
    const all = await cloudListWorkspaces();
    for (const ws of all) {
      try {
        return await cloudListCollectionWords(ws.id, collectionId);
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("not found")) {
          throw err;
        }
      }
    }
    return [];
  }
  if (!isTauri()) {
    const ids = (fb.collectionWords ?? [])
      .filter((cw) => cw.collectionId === collectionId)
      .sort((a, b) => a.position - b.position)
      .map((cw) => cw.vocabId);
    return ids
      .map((id) => fb.vocab.find((v) => v.id === id))
      .filter((v): v is VocabEntry => v != null);
  }
  const db = await getDb();
  const rows = await db.select<VocabRow[]>(
    // Inline list columns with the `v.` prefix — VOCAB_LIST_COLS holds a
    // CASE expression that can't be naively split + prefixed. Shape
    // mirrors VOCAB_LIST_COLS.
    `SELECT v.id, v.workspace_id, v.word, v.reading, v.gloss, v.source,
            v.status, v.stability, v.difficulty, v.due_at, v.last_review,
            v.review_count, v.created_at,
            CASE WHEN v.image_data IS NOT NULL AND v.image_data != '' THEN 1 ELSE 0 END AS has_image,
            v.card_notes, v.front_extra
     FROM vocab_entries v
     JOIN collection_words cw ON cw.vocab_id = v.id
     WHERE cw.collection_id = $1
     ORDER BY cw.position ASC, cw.added_at ASC`,
    [collectionId],
  );
  return rows.map(rowToVocab);
}

export async function collectionsForVocab(
  workspaceId: number,
  vocabId: number,
): Promise<Collection[]> {
  if (HOSTED) return cloudCollectionsForVocab(workspaceId, vocabId);
  if (!isTauri()) {
    const collIds = (fb.collectionWords ?? [])
      .filter((cw) => cw.vocabId === vocabId)
      .map((cw) => cw.collectionId);
    return (fb.collections ?? []).filter(
      (c) => c.workspaceId === workspaceId && collIds.includes(c.id),
    );
  }
  const db = await getDb();
  const rows = await db.select<CollectionRow[]>(
    `SELECT ${COLLECTION_COLS}, 0 AS word_count
     FROM collections
     WHERE workspace_id = $1
       AND id IN (SELECT collection_id FROM collection_words WHERE vocab_id = $2)
     ORDER BY is_default DESC, name ASC`,
    [workspaceId, vocabId],
  );
  return rows.map(rowToCollection);
}

// Single query over `IN (...)` instead of one per collection — that loop
// scaled with collection-count and saturated the SQLx pool on big workspaces.
export async function vocabIdsInCollections(
  workspaceId: number,
  collectionIds: number[],
): Promise<Set<number>> {
  if (collectionIds.length === 0) return new Set();
  if (HOSTED) {
    // No bulk-ids endpoint yet — one words call per collection, in
    // parallel, bounded by the subtree size (a chapter is 1 list; a
    // full pack tree is a few dozen). Before this branch existed the
    // hosted build fell into the empty in-memory store, returned ∅,
    // and custom study silently widened to the whole workspace.
    const lists = await Promise.all(
      collectionIds.map((cid) => cloudListCollectionWords(workspaceId, cid)),
    );
    const out = new Set<number>();
    for (const rows of lists) for (const v of rows) out.add(v.id);
    return out;
  }
  if (!isTauri()) {
    const set = new Set<number>();
    const idSet = new Set(collectionIds);
    for (const cw of fb.collectionWords ?? []) {
      if (idSet.has(cw.collectionId)) set.add(cw.vocabId);
    }
    return set;
  }
  const db = await getDb();
  const placeholders = collectionIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await db.select<{ vocab_id: number }[]>(
    `SELECT DISTINCT vocab_id FROM collection_words WHERE collection_id IN (${placeholders})`,
    collectionIds,
  );
  const out = new Set<number>();
  for (const r of rows) out.add(r.vocab_id);
  return out;
}

// Upserts the vocab row first, then links it into the collection.
export async function addWordToCollection(input: {
  workspaceId: number;
  collectionId: number;
  word: string;
  reading?: string | null;
  gloss?: string | null;
  // Pack importer passes false so pack words land as library, not active SRS.
  isActive?: boolean;
}): Promise<VocabEntry> {
  if (HOSTED) {
    // The cloud endpoint upserts the vocab AND adds the link in one
    // transaction. Then re-fetch the full vocab row by re-calling
    // saveVocab — cheaper than adding a "give me the full row"
    // round-trip to the link endpoint, and idempotent on the cloud.
    await cloudAddWordToCollection(input);
    return saveVocab({
      workspaceId: input.workspaceId,
      word: input.word,
      reading: input.reading,
      gloss: input.gloss,
      source: "collection",
      isActive: input.isActive,
    });
  }
  const v = await saveVocab({
    workspaceId: input.workspaceId,
    word: input.word,
    reading: input.reading,
    gloss: input.gloss,
    source: "collection",
    isActive: input.isActive,
  });
  if (!isTauri()) {
    fb.collectionWords ??= [];
    const exists = fb.collectionWords.some(
      (cw) => cw.collectionId === input.collectionId && cw.vocabId === v.id,
    );
    if (!exists) {
      const max = fb.collectionWords
        .filter((cw) => cw.collectionId === input.collectionId)
        .reduce((m, cw) => Math.max(m, cw.position), -1);
      fb.collectionWords.push({
        collectionId: input.collectionId,
        vocabId: v.id,
        position: max + 1,
        addedAt: nowSec(),
      });
    }
    return v;
  }
  const db = await getDb();
  // Compute next position.
  const posRows = await db.select<{ p: number | null }[]>(
    "SELECT MAX(position) AS p FROM collection_words WHERE collection_id = $1",
    [input.collectionId],
  );
  const nextPos = (posRows[0]?.p ?? -1) + 1;
  await db.execute(
    `INSERT OR IGNORE INTO collection_words (collection_id, vocab_id, position)
     VALUES ($1, $2, $3)`,
    [input.collectionId, v.id, nextPos],
  );
  await db.execute(
    "UPDATE collections SET updated_at = strftime('%s','now') WHERE id = $1",
    [input.collectionId],
  );
  return v;
}

export async function bulkAddToCollection(input: {
  workspaceId: number;
  collectionId: number;
  words: Array<{ word: string; reading?: string | null; gloss?: string | null }>;
}): Promise<{ added: number; skipped: number }> {
  if (HOSTED) {
    // One round-trip handles the batch on the cloud (vs N for the
    // desktop fallback). Empty / blank words are filtered server-side.
    const valid = input.words.filter((w) => w.word?.trim());
    const skipped = input.words.length - valid.length;
    const added = await cloudBulkAddToCollection({
      workspaceId: input.workspaceId,
      collectionId: input.collectionId,
      words: valid,
    });
    return { added, skipped };
  }
  let added = 0;
  let skipped = 0;
  for (const w of input.words) {
    const word = w.word?.trim();
    if (!word) {
      skipped += 1;
      continue;
    }
    try {
      await addWordToCollection({
        workspaceId: input.workspaceId,
        collectionId: input.collectionId,
        word,
        reading: w.reading,
        gloss: w.gloss,
      });
      added += 1;
    } catch {
      skipped += 1;
    }
  }
  return { added, skipped };
}

export async function removeWordFromCollection(
  collectionId: number,
  vocabId: number,
): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudRemoveWordFromCollection({ workspaceId, collectionId, vocabId }).then(
        () => true,
      ),
    );
    return;
  }
  if (!isTauri()) {
    fb.collectionWords = (fb.collectionWords ?? []).filter(
      (cw) => !(cw.collectionId === collectionId && cw.vocabId === vocabId),
    );
    return;
  }
  const db = await getDb();
  await db.execute(
    "DELETE FROM collection_words WHERE collection_id = $1 AND vocab_id = $2",
    [collectionId, vocabId],
  );
}

type GoalRow = {
  id: number;
  workspace_id: number;
  title: string;
  kind: string;
  skill: string | null;
  target: number;
  deadline: number | null;
  created_at: number;
  completed_at: number | null;
};

function rowToGoal(r: GoalRow): Goal {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    kind: r.kind as GoalKind,
    skill: r.skill as GoalSkill,
    target: r.target,
    deadline: r.deadline,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

const GOAL_COLS =
  "id, workspace_id, title, kind, skill, target, deadline, created_at, completed_at";

export async function listGoals(workspaceId: number): Promise<Goal[]> {
  if (HOSTED) return cloudListGoals(workspaceId);
  if (!isTauri()) {
    return fb.goals
      .filter((g) => g.workspaceId === workspaceId)
      .sort((a, b) => {
        // Active first (no completed_at), then by deadline asc, then created_at desc.
        const aDone = a.completedAt != null ? 1 : 0;
        const bDone = b.completedAt != null ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        const ad = a.deadline ?? Number.MAX_SAFE_INTEGER;
        const bd = b.deadline ?? Number.MAX_SAFE_INTEGER;
        if (ad !== bd) return ad - bd;
        return b.createdAt - a.createdAt;
      });
  }
  const db = await getDb();
  const rows = await db.select<GoalRow[]>(
    `SELECT ${GOAL_COLS} FROM goals
     WHERE workspace_id = $1
     ORDER BY (completed_at IS NOT NULL) ASC,
              CASE WHEN deadline IS NULL THEN 1 ELSE 0 END ASC,
              deadline ASC,
              created_at DESC`,
    [workspaceId],
  );
  return rows.map(rowToGoal);
}

export async function createGoal(input: {
  workspaceId: number;
  title: string;
  kind: GoalKind;
  skill?: GoalSkill;
  target: number;
  deadline?: number | null;
}): Promise<Goal> {
  if (HOSTED) return cloudCreateGoal(input);
  if (!isTauri()) {
    const g: Goal = {
      id: fb.nextId++,
      workspaceId: input.workspaceId,
      title: input.title,
      kind: input.kind,
      skill: input.skill ?? null,
      target: input.target,
      deadline: input.deadline ?? null,
      createdAt: nowSec(),
      completedAt: null,
    };
    fb.goals.push(g);
    return g;
  }
  const db = await getDb();
  const r = await db.execute(
    "INSERT INTO goals (workspace_id, title, kind, skill, target, deadline) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      input.workspaceId,
      input.title,
      input.kind,
      input.skill ?? null,
      input.target,
      input.deadline ?? null,
    ],
  );
  const id = Number(r.lastInsertId ?? 0);
  const rows = await db.select<GoalRow[]>(`SELECT ${GOAL_COLS} FROM goals WHERE id = $1`, [id]);
  return rowToGoal(rows[0]);
}

export async function completeGoal(id: number, completed: boolean): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudUpdateGoal({ workspaceId, goalId: id, patch: { completed } }),
    );
    return;
  }
  if (!isTauri()) {
    const g = fb.goals.find((x) => x.id === id);
    if (g) g.completedAt = completed ? nowSec() : null;
    return;
  }
  const db = await getDb();
  if (completed) {
    await db.execute("UPDATE goals SET completed_at = strftime('%s','now') WHERE id = $1", [id]);
  } else {
    await db.execute("UPDATE goals SET completed_at = NULL WHERE id = $1", [id]);
  }
}

export async function deleteGoal(id: number): Promise<void> {
  if (HOSTED) {
    await probeWorkspace((workspaceId) =>
      cloudDeleteGoal(workspaceId, id).then(() => true),
    );
    return;
  }
  if (!isTauri()) {
    fb.goals = fb.goals.filter((g) => g.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM goals WHERE id = $1", [id]);
}
