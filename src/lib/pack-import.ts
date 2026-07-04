/**
 * Tokori pack importer.
 *
 * A "pack" is a single JSON file that bundles together the data a user gets
 * when they buy a curated learning bundle — vocabulary collections, optional
 * textbook structure with chapters and per-chapter vocab, dictionary
 * extras, etc.
 *
 * The format is deliberately simple, declarative, and self-contained so a
 * pack file is portable: a buyer downloads one .json, drags it into the
 * app, and everything lands in the right place. Re-importing the same pack
 * is idempotent — collections are matched by `presetId`, vocab by word.
 *
 * Format spec — kept stable under `schema: "tokori-pack/v1"`. Future breaking
 * changes ship under `tokori-pack/v2`. See `marketing/docs/api/...` (TBD).
 *
 *   {
 *     "schema":      "tokori-pack/v1",
 *     "id":          "chinese-hsk30-bundle",   // unique pack id
 *     "name":        "HSK 3.0 + Standard Course",
 *     "language":    "zh",                     // ISO 639-1; targets a workspace
 *     "description": "...",
 *     "version":     "1.0.0",
 *     "license":     "All rights reserved...",
 *     "collections": [Collection],             // optional
 *     "textbooks":   [Textbook],               // optional
 *     "dictionary":  Dictionary | null,        // optional (rare)
 *   }
 *
 * Collection: { id, name, description?, words: Word[] }
 * Textbook:   { id, title, author?, totalUnits, unitLabel?, chapters: Chapter[] }
 * Chapter:    { position, title, vocab?: Word[], notes?: string, body?: string }
 * Word:       { word, reading?, gloss? }
 *
 * The importer creates:
 *   - one `collection` per `Collection` (source='preset', preset_id=collection.id)
 *   - one `library_item` per `Textbook` (kind='textbook')
 *   - one `library_chapter` per Chapter
 *   - one auto-collection per textbook chapter (so each chapter's vocab is
 *     drillable on its own)
 *   - vocab entries via `saveVocab` (idempotent on workspace+word)
 */

import {
  addWordToCollection,
  createChapter,
  createCollection,
  listChapters,
  listCollections,
  listLibrary,
  saveLibraryItem,
  saveVocab,
  setChapterCollection,
  setCollectionParent,
  updateChapter,
  type Collection,
  type LibraryItem,
  type VocabStatus,
} from "./db";
import { HOSTED } from "./build-flags";
import { cloudImportPack } from "./cloud-client";

// ── Pack format types ─────────────────────────────────────────────────────

export type PackWord = {
  word: string;
  reading?: string | null;
  gloss?: string | null;
};

export type PackCollection = {
  id: string;
  name: string;
  description?: string | null;
  words: PackWord[];
};

export type PackChapter = {
  /** 0-indexed within the textbook. */
  position: number;
  title: string;
  /** Words this chapter introduces — stored as a per-chapter collection. */
  vocab?: PackWord[];
  /** Optional plain-text notes / outline that lands on the chapter row. */
  notes?: string | null;
  /** Optional reading body — if present, also creates a reader_document for the chapter. */
  body?: string | null;
};

export type PackTextbook = {
  id: string;
  title: string;
  author?: string | null;
  totalUnits?: number | null;
  /** Defaults to "lessons" for textbook chapters. */
  unitLabel?: string;
  chapters: PackChapter[];
};

export type Pack = {
  schema: "tokori-pack/v1";
  id: string;
  name: string;
  language: string; // ISO 639-1
  description?: string;
  version?: string;
  license?: string;
  collections?: PackCollection[];
  textbooks?: PackTextbook[];
};

// ── Validation ────────────────────────────────────────────────────────────

export type PackValidationResult =
  | { ok: true; pack: Pack }
  | { ok: false; error: string };

/**
 * Strict-but-friendly validator. We intentionally don't use a schema library
 * here — the pack format is small, and a hand-rolled validator gives clearer
 * error messages ("missing `name` on collection #3" beats "expected string").
 */
export function validatePack(raw: unknown): PackValidationResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Pack JSON must be an object." };
  }
  const r = raw as Record<string, unknown>;
  if (r.schema !== "tokori-pack/v1") {
    return {
      ok: false,
      error: `Unsupported pack schema "${String(r.schema)}". Expected "tokori-pack/v1".`,
    };
  }
  if (typeof r.id !== "string" || !r.id) return { ok: false, error: "Pack missing id." };
  if (typeof r.name !== "string" || !r.name) return { ok: false, error: "Pack missing name." };
  if (typeof r.language !== "string" || !r.language) {
    return { ok: false, error: "Pack missing language." };
  }
  const collections = Array.isArray(r.collections) ? (r.collections as PackCollection[]) : [];
  const textbooks = Array.isArray(r.textbooks) ? (r.textbooks as PackTextbook[]) : [];

  for (let i = 0; i < collections.length; i++) {
    const c = collections[i];
    if (typeof c.id !== "string" || !c.id) {
      return { ok: false, error: `Collection #${i} missing id.` };
    }
    if (typeof c.name !== "string" || !c.name) {
      return { ok: false, error: `Collection ${c.id ?? i} missing name.` };
    }
    if (!Array.isArray(c.words)) {
      return { ok: false, error: `Collection ${c.id} has no words array.` };
    }
  }
  for (let i = 0; i < textbooks.length; i++) {
    const t = textbooks[i];
    if (typeof t.title !== "string" || !t.title) {
      return { ok: false, error: `Textbook #${i} missing title.` };
    }
    if (!Array.isArray(t.chapters)) {
      return { ok: false, error: `Textbook ${t.title} has no chapters array.` };
    }
  }
  return { ok: true, pack: { ...(r as Pack), collections, textbooks } };
}

/**
 * Read a user-supplied `.json` File and validate it as a Pack. Shared
 * by the pack-import dialog's drop zone and the onboarding starter-
 * content step so both surfaces parse + validate identically (and
 * report the same "not valid JSON" / schema errors). Keeps the
 * File→Pack seam in one place rather than re-implementing the
 * read-parse-validate dance per call site.
 */
export async function readPackFile(file: File): Promise<PackValidationResult> {
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't read the file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't valid JSON." };
  }
  return validatePack(json);
}

// ── Summary (for the preview UI) ──────────────────────────────────────────

export type PackSummary = {
  collectionCount: number;
  collectionWordCount: number;
  textbookCount: number;
  textbookChapterCount: number;
  textbookVocabCount: number;
};

export function summarisePack(pack: Pack): PackSummary {
  const collectionCount = pack.collections?.length ?? 0;
  const collectionWordCount =
    pack.collections?.reduce((s, c) => s + c.words.length, 0) ?? 0;
  const textbookCount = pack.textbooks?.length ?? 0;
  let textbookChapterCount = 0;
  let textbookVocabCount = 0;
  for (const t of pack.textbooks ?? []) {
    textbookChapterCount += t.chapters.length;
    for (const ch of t.chapters) textbookVocabCount += ch.vocab?.length ?? 0;
  }
  return {
    collectionCount,
    collectionWordCount,
    textbookCount,
    textbookChapterCount,
    textbookVocabCount,
  };
}

// ── Import ────────────────────────────────────────────────────────────────

export type ImportProgress = {
  /** Stage name shown in the UI: "collections", "textbooks". */
  stage: string;
  /** 0–1 progress within the current stage. */
  ratio: number;
  /** Cumulative words created across the whole import (for a tally). */
  wordsTotal: number;
};

export type ImportResult = {
  collectionsCreated: number;
  collectionsSkipped: number;
  textbooksCreated: number;
  textbooksSkipped: number;
  chaptersCreated: number;
  wordsCreated: number;
};

/** Per-textbook import preference. The user picks one mode + a current
 *  chapter when a pack contains textbooks; we route every chapter into
 *  the right activation/SRS-seed bucket accordingly.
 *
 *   - "library":         legacy + default for non-textbook packs. Vocab
 *                        lands as is_active=0 across the board; user opts
 *                        in word-by-word later.
 *   - "current-only":    only the current chapter activates as new
 *                        cards; everything else stays library.
 *   - "previous-known":  chapters before the current one are seeded as
 *                        status='mastered' AND is_active=1 — they count
 *                        as known vocabulary. Earlier chapters get a
 *                        long-term schedule (stability 180d, due +180d,
 *                        occasional retention checks); the chapter the
 *                        user JUST finished (current-1) is still known
 *                        but keeps a near-term, per-word-staggered due
 *                        date so it cycles back through the SRS over the
 *                        coming week. The current chapter activates as
 *                        new. Anything past current stays library.
 *   - "everything-new":  legacy "import everything as active new
 *                        cards" mode. Most users won't want this; it's
 *                        kept as an escape hatch.
 */
export type TextbookImportMode =
  | "library"
  | "current-only"
  | "previous-known"
  | "everything-new";

export type TextbookPreference = {
  /** Pack-defined textbook id. */
  textbookId: string;
  mode: TextbookImportMode;
  /** 1-indexed chapter the student is currently on. Required for
   *  "current-only" and "previous-known"; ignored for the others. */
  currentChapter?: number;
  /** Only honoured when `mode === "previous-known"`. When true, every
   *  textbook positioned earlier than this one in the pack (HSK 1 + 2
   *  when the user is on HSK 3, etc.) has all of its chapters seeded
   *  as mastered — same SRS treatment the user's current textbook
   *  gives its own previous chapters. Useful for course bundles where
   *  the user has already worked through the prerequisite levels. */
  includePreviousTextbooks?: boolean;
};

/** Per-pack-collection preference. The HSK 1 free pack ships *both*
 *  a "all 461 words" flat collection and a 15-chapter textbook that
 *  covers the same vocabulary — importing both creates two top-level
 *  entries with overlapping content. We surface a checkbox per
 *  collection so the user can deselect the flat list when the
 *  textbook is the canonical organisation; the dialog defaults this
 *  to OFF when the pack also ships textbooks. */
export type CollectionPreference = {
  /** Pack-defined collection id. Must match `PackCollection.id`. */
  collectionId: string;
  /** When false, this collection is skipped entirely during import. */
  include: boolean;
};

/**
 * Run a full pack import against a workspace. Idempotent — re-running with
 * the same pack is a no-op:
 *
 *   - Collections are matched by their `preset_id` (= `<pack.id>:<collection.id>`).
 *   - Library items (textbooks) are matched by `(workspaceId, source = "pack:<pack.id>:<textbook.id>")`.
 *   - Vocab is matched by `(workspaceId, word)` via `saveVocab`'s upsert.
 *
 * Streams progress through the optional `onProgress` callback so a dialog
 * can show "Importing 1024 of 5000 words…".
 */
export async function importPack(args: {
  workspaceId: number;
  pack: Pack;
  onProgress?: (p: ImportProgress) => void;
  /** Per-textbook activation prefs. Anything not listed defaults to
   *  "library" — vocab lands inactive, user opts in word-by-word. */
  textbookPrefs?: TextbookPreference[];
  /** Per-pack-collection include/skip prefs. Anything not listed
   *  defaults to include = true. Pass `include: false` to skip a
   *  pack collection entirely (no row, no words). Used by the import
   *  dialog to default-skip the flat "all words" lists when the pack
   *  also ships textbooks that cover the same content. */
  collectionPrefs?: CollectionPreference[];
}): Promise<ImportResult> {
  const { workspaceId, pack, onProgress, textbookPrefs, collectionPrefs } = args;

  // HOSTED: hand the whole pack to the cloud's bulk import endpoint.
  // The desktop loop below fires ~1k HTTP requests for a 461-word
  // pack (one per saveVocab, plus collection + chapter creates, plus
  // a listCollections refetch per chapter). The server-side handler
  // runs the equivalent work in one Prisma transaction with bulk
  // inserts, so the same import drops from minutes-on-mobile to one
  // request. Progress is reported as a single "starting → done" hop
  // since the network round-trip dominates anyway.
  if (HOSTED) {
    onProgress?.({ stage: "starting", ratio: 0, wordsTotal: 0 });
    const res = await cloudImportPack({
      workspaceId,
      pack,
      textbookPrefs,
      collectionPrefs,
    });
    onProgress?.({ stage: "textbooks", ratio: 1, wordsTotal: res.wordsCreated });
    return res;
  }

  const result: ImportResult = {
    collectionsCreated: 0,
    collectionsSkipped: 0,
    textbooksCreated: 0,
    textbooksSkipped: 0,
    chaptersCreated: 0,
    wordsCreated: 0,
  };
  const presetIdFor = (innerId: string) => `${pack.id}:${innerId}`;
  const sourceTagFor = (innerId: string) => `pack:${pack.id}:${innerId}`;

  // 1. Collections.
  const collections = pack.collections ?? [];
  if (collections.length > 0) {
    const existing = await listCollections(workspaceId);
    const byPresetId = new Map(
      existing.map((c) => [c.presetId, c] as const).filter(([k]) => !!k),
    );
    let totalWords = 0;
    for (const c of collections) totalWords += c.words.length;
    let wordsSeen = 0;
    for (const c of collections) {
      // Honor the user's per-collection skip choice. Marking a
      // collection `include: false` short-circuits before we touch
      // either the collection row or any word — no partial state to
      // clean up later. Idempotent on re-import too: a previously
      // imported collection that the user now skips simply isn't
      // refreshed, but the existing row stays intact (we don't
      // delete on skip — that's a destructive action we leave to
      // the user via the regular delete UI).
      const pref = collectionPrefs?.find((p) => p.collectionId === c.id);
      if (pref && !pref.include) {
        // Still count its words against the progress meter so the
        // bar doesn't lurch when we hit a skipped one.
        totalWords -= c.words.length;
        continue;
      }
      const presetId = presetIdFor(c.id);
      let collectionId: number;
      const found = byPresetId.get(presetId);
      if (found) {
        collectionId = found.id;
        result.collectionsSkipped += 1;
      } else {
        const made = await createCollection({
          workspaceId,
          name: c.name,
          description: c.description ?? null,
          source: "preset",
          presetId,
        });
        collectionId = made.id;
        result.collectionsCreated += 1;
      }
      for (const w of c.words) {
        // Pack-as-library: imported words start INACTIVE so they
        // don't dump 461 cards into the user's review queue.
        // The collections page exposes "Activate this word" /
        // "Activate all" actions, and the click-to-define popover
        // promotes any word the user saves from the reader.
        await addWordToCollection({
          workspaceId,
          collectionId,
          word: w.word,
          reading: w.reading ?? null,
          gloss: w.gloss ?? null,
          isActive: false,
        });
        result.wordsCreated += 1;
        wordsSeen += 1;
        if (onProgress && wordsSeen % 50 === 0) {
          onProgress({
            stage: "collections",
            ratio: wordsSeen / Math.max(totalWords, 1),
            wordsTotal: result.wordsCreated,
          });
        }
      }
    }
    onProgress?.({ stage: "collections", ratio: 1, wordsTotal: result.wordsCreated });
  }

  // 2. Textbooks.
  const textbooks = pack.textbooks ?? [];
  // Pre-compute the set of textbook ids that should be seeded as
  // fully-known (every chapter mastered). This happens when the user
  // ticked "include previous books" on a later textbook in the same
  // pack — typical for course bundles like HSK 1+2+3, where a learner
  // currently on book 3 has already worked through books 1 and 2.
  // We resolve this up-front so policyFor() inside the chapter loop
  // can short-circuit cheaply.
  const fullyKnownTextbookIds = new Set<string>();
  for (let i = 0; i < textbooks.length; i++) {
    const tp = textbookPrefs?.find((p) => p.textbookId === textbooks[i].id);
    if (
      tp?.mode === "previous-known" &&
      tp.includePreviousTextbooks
    ) {
      for (let j = 0; j < i; j++) {
        fullyKnownTextbookIds.add(textbooks[j].id);
      }
    }
  }
  if (textbooks.length > 0) {
    const existingLibrary = await listLibrary(workspaceId);
    let totalUnits = 0;
    for (const t of textbooks) totalUnits += t.chapters.length;
    let unitsSeen = 0;
    for (const t of textbooks) {
      const tag = sourceTagFor(t.id);
      // Resolve the user's per-textbook preference up-front so we
      // can apply both the "you're starting at lesson N" seeding
      // (handled lower in the chapter loop) AND the matching
      // library_item state (handled here). The two used to drift:
      // import seeded chapter cards correctly but left the library
      // item with completedUnits = 0, so the green "current lesson"
      // ring on the collection detail page always pointed at lesson
      // 1 even when the user said they were on lesson 5.
      const pref = textbookPrefs?.find((p) => p.textbookId === t.id);
      const forcedAllKnown = fullyKnownTextbookIds.has(t.id);
      // 1-indexed in user input → 0-indexed for the library item's
      // completedUnits (which is the count of completed lessons,
      // i.e. the position of the lesson the user is *currently*
      // working through). When a later textbook's "include previous
      // books" flag marks this textbook as fully-known, we treat
      // every lesson as completed regardless of the user's own
      // current-chapter setting on this textbook (typically there
      // isn't one — they're on a later book).
      const completedUnitsFromPref = forcedAllKnown
        ? t.chapters.length
        : pref?.currentChapter && pref.currentChapter > 1
          ? pref.currentChapter - 1
          : pref?.currentChapter === 1
            ? 0
            : undefined;
      // Activate when the user actually expressed intent to study
      // this textbook (current-only or previous-known). The default
      // "library" mode should NOT silently activate the textbook —
      // the user said "just install it as reference". Cross-textbook
      // "include previous books" also counts as intent: the user is
      // explicitly saying these are part of their study state.
      const shouldActivate =
        pref?.mode === "current-only" ||
        pref?.mode === "previous-known" ||
        forcedAllKnown;

      let item: LibraryItem;
      const found = existingLibrary.find((l) => l.source === tag);
      if (found) {
        item = found;
        result.textbooksSkipped += 1;
        // Re-import path: the user may have changed their mind
        // about which textbook is active or where they are in it.
        // Update in place so the dialog's selections stick.
        if (shouldActivate || completedUnitsFromPref !== undefined) {
          item = await saveLibraryItem({
            id: found.id,
            workspaceId,
            kind: found.kind,
            title: found.title,
            author: found.author,
            source: found.source,
            totalUnits: found.totalUnits,
            unitLabel: found.unitLabel,
            completedUnits:
              completedUnitsFromPref ?? found.completedUnits,
            totalSeconds: found.totalSeconds,
            status: shouldActivate ? "active" : found.status,
            coverUrl: found.coverUrl,
            notes: found.notes,
          });
        }
      } else {
        item = await saveLibraryItem({
          workspaceId,
          kind: "textbook",
          title: t.title,
          author: t.author ?? null,
          source: tag,
          totalUnits: t.totalUnits ?? t.chapters.length,
          unitLabel: t.unitLabel ?? "lessons",
          completedUnits: completedUnitsFromPref ?? 0,
          // Inactive when the user picked "library" mode — they
          // explicitly said no. Active otherwise.
          status: shouldActivate ? "active" : "paused",
        });
        result.textbooksCreated += 1;
      }

      // Per-textbook ROOT collection. Each chapter collection
      // imported below sits under this as a child, so the
      // Collections sidebar shows one clean entry per textbook
      // ("HSK 1 standard course") instead of dumping every chapter
      // ("Lesson 1", "Lesson 2", … × N textbooks) into the top
      // level. The textbook root itself holds no words directly —
      // the "All" view in the detail page rolls up its descendants.
      //
      // PresetId distinguishes textbook roots from chapter
      // collections via the literal "textbook" segment so we can
      // tell them apart on re-import / repair.
      const tbPresetId = presetIdFor(`textbook:${t.id}`);
      const colsBeforeChapters = await listCollections(workspaceId);
      let textbookRootId: number;
      const tbFound = colsBeforeChapters.find(
        (c) => c.presetId === tbPresetId,
      );
      if (tbFound) {
        textbookRootId = tbFound.id;
      } else {
        const made = await createCollection({
          workspaceId,
          name: t.title,
          description: t.author
            ? `Textbook · ${t.author}`
            : "Textbook from pack",
          source: "preset",
          presetId: tbPresetId,
        });
        textbookRootId = made.id;
      }

      // Chapters. We always upsert chapters so re-import cleanly recreates
      // missing ones, but the existing-position check keeps idempotency.
      // Chapter creation happens sequentially because position auto-increments
      // when omitted.
      //
      // For re-imports we look up existing chapters by position so we can
      // still link any missing per-chapter collections — useful when an old
      // import of this same pack ran before the chapter↔collection link
      // was being persisted.
      // Per-textbook activation policy. Defaults to "library" when
      // the user didn't specify — matches the safe default of pack
      // import not dumping cards into the SRS queue. `pref` was
      // resolved further up so the library_item state and the
      // chapter seeding agree on which chapter is current.
      const mode: TextbookImportMode = pref?.mode ?? "library";
      // Convert 1-indexed chapter input to a 0-indexed comparison
      // against ch.position, which is 0-indexed in the pack format.
      const currentChapterIdx = pref?.currentChapter
        ? pref.currentChapter - 1
        : null;

      // Decide for one chapter what activation strategy to use.
      // Returns:
      //   { isActive, seedFor? }
      // where `seedFor(wordIndex)` (when present) overrides the
      // default new-card schedule. The factory takes a wordIndex so
      // the "half-mastered" chapter can stagger dueAt across the
      // coming days — the user gets a few cards per day instead of
      // one big cliff three days from now.
      //
      // A textbook the user marked as fully-known via a *later*
      // book's "include previous books" toggle: every chapter seeds
      // as mastered, no chapter activates as new. The current
      // textbook's own pref is ignored for this case — the
      // cross-textbook flag is the strictly stronger signal.
      const forceAllKnown = fullyKnownTextbookIds.has(t.id);
      const SIX_MONTHS_DAYS = 180;
      const SIX_MONTHS_SEC = SIX_MONTHS_DAYS * 86400;
      const nowSec = () => Math.floor(Date.now() / 1000);

      /** Long-term mastery seed — surfaces months from now as an
       *  occasional retention check. Used for chapters more than one
       *  position before the user's current chapter. */
      const masteredSeed = () => ({
        status: "mastered" as VocabStatus,
        stability: SIX_MONTHS_DAYS,
        dueAt: nowSec() + SIX_MONTHS_SEC,
      });

      /** Recently-learned seed — the chapter the user JUST finished
       *  (current-1). It counts as KNOWN (status 'mastered', same as
       *  the earlier chapters and what the dialog's "seeded as known"
       *  label promises) so the dashboard's vocabulary-known total
       *  reflects it. The difference from the long-term seed is purely
       *  the schedule: a near-term, per-word-staggered dueAt so each
       *  word still cycles back through the SRS over the next week as a
       *  light retention check — the user catches anything that didn't
       *  actually stick, without a patronising same-day quiz on top of
       *  the current chapter's new cards.
       *
       *  Per-word stagger: a chapter has ~20-40 words; a 6-day fan
       *  lands 3-7 cards on each of the next ~6 days, manageable
       *  alongside the daily new-card queue. */
      const RECENTLY_LEARNED_STABILITY_DAYS = 3;
      const recentlyLearnedSeed = (wordIndex: number) => ({
        status: "mastered" as VocabStatus,
        stability: RECENTLY_LEARNED_STABILITY_DAYS,
        // 1 + (i mod 6) days = days 1-6, evenly fanned across the
        // upcoming week.
        dueAt: nowSec() + (1 + (wordIndex % 6)) * 86400,
      });

      type SeedFactory = (
        wordIndex: number,
      ) => { status: VocabStatus; stability: number; dueAt: number };

      function policyFor(chapterPosition: number): {
        isActive: boolean;
        seedFor?: SeedFactory;
      } {
        if (forceAllKnown) {
          return { isActive: true, seedFor: () => masteredSeed() };
        }
        if (mode === "library") return { isActive: false };
        if (mode === "everything-new") return { isActive: true };
        if (currentChapterIdx == null) return { isActive: false };
        if (chapterPosition === currentChapterIdx) {
          // Current chapter — activate as new in both modes. No seed:
          // the standard new-card schedule applies (due immediately).
          return { isActive: true };
        }
        if (chapterPosition < currentChapterIdx && mode === "previous-known") {
          if (chapterPosition === currentChapterIdx - 1) {
            // The chapter the user JUST finished — counts as known, but
            // cycles back through the SRS over the next ~week as a light
            // retention check rather than vanishing for six months.
            return { isActive: true, seedFor: recentlyLearnedSeed };
          }
          // Chapters they finished earlier — long-term mastered.
          return { isActive: true, seedFor: () => masteredSeed() };
        }
        // Future chapters in any mode (and previous chapters in
        // "current-only") stay library.
        return { isActive: false };
      }

      const existingChapters = found ? await listChapters(item.id) : [];
      // Track which chapters need their `completedAt` stamped after the
      // chapter rows exist. Both the library_item's `completedUnits`
      // and the per-chapter `completedAt` are read by different
      // surfaces (the library detail page uses completedUnits; the
      // dashboard's TextbookCard scans chapters for the first
      // completedAt == null to decide "current chapter"). Keep both
      // in sync so the dashboard lands on the chapter the user said
      // they're on, not chapter 1.
      const shouldStampCompletion =
        forcedAllKnown ||
        (pref?.mode === "previous-known" && currentChapterIdx != null);
      const completedChapterIds: number[] = [];
      for (const ch of t.chapters) {
        // For a fresh textbook, positions are sequential; for an existing
        // one we trust the pack's position field. A real schema-evolution
        // friendly approach would dedupe by position, but `createChapter`
        // already de-dupes via the `position` we pass.
        let chapterId: number | null;
        if (!found) {
          const created = await createChapter({
            itemId: item.id,
            position: ch.position,
            title: ch.title,
          });
          chapterId = created.id;
          result.chaptersCreated += 1;
        } else {
          chapterId =
            existingChapters.find((c) => c.position === ch.position)?.id ?? null;
        }
        // Stamp completion for chapters before the user's current
        // position (previous-known on THIS book), or for every chapter
        // when this book is fully-known via a later book's flag.
        const isCompleted =
          forcedAllKnown ||
          (currentChapterIdx != null && ch.position < currentChapterIdx);
        if (shouldStampCompletion && chapterId != null && isCompleted) {
          completedChapterIds.push(chapterId);
        }

        // Per-chapter vocab → its own preset collection so the user can drill
        // it on its own. presetId combines pack + textbook + chapter so a
        // re-import is idempotent.
        if (ch.vocab && ch.vocab.length > 0) {
          const chapPresetId = presetIdFor(`${t.id}:${ch.position}`);
          let chapCollectionId: number;
          const existing = await listCollections(workspaceId);
          const found2 = existing.find((c) => c.presetId === chapPresetId);
          if (found2) {
            chapCollectionId = found2.id;
            // Repair pass for re-imports: an older import made the
            // chapter collection without a parent, so it currently
            // shows as a top-level entry in the sidebar. Re-link it
            // under the textbook root.
            if (found2.parentId !== textbookRootId) {
              await setCollectionParent(found2.id, textbookRootId);
            }
          } else {
            const made = await createCollection({
              workspaceId,
              // Drop the textbook prefix from the name — the parent
              // collection already supplies that context, and "Lesson 1"
              // reads cleaner in the sub-pill row than
              // "HSK 1 standard course · Lesson 1".
              name: ch.title,
              description: `Vocabulary from ${t.title} → ${ch.title}.`,
              source: "preset",
              presetId: chapPresetId,
              parentId: textbookRootId,
            });
            chapCollectionId = made.id;
          }
          const chapterPolicy = policyFor(ch.position);
          let wordIndex = 0;
          for (const w of ch.vocab) {
            // Branch: with an FSRS seed (previous-known mode), use the
            // seeded saveVocab path so this chapter's words land as
            // mastered (or half-mastered, with a near dueAt) instead
            // of as fresh new cards. Without a seed, the default
            // addWordToCollection upsert applies the chapter's
            // isActive policy.
            if (chapterPolicy.seedFor) {
              await saveVocab({
                workspaceId,
                word: w.word,
                reading: w.reading ?? null,
                gloss: w.gloss ?? null,
                source: "collection",
                isActive: chapterPolicy.isActive,
                srsState: chapterPolicy.seedFor(wordIndex),
              });
              // Still link the row to the chapter's collection so the
              // grouping shows up in the Collections view.
              await addWordToCollection({
                workspaceId,
                collectionId: chapCollectionId,
                word: w.word,
                reading: w.reading ?? null,
                gloss: w.gloss ?? null,
                // saveVocab above already set the activation; pass
                // matching isActive so the upsert doesn't downgrade.
                isActive: chapterPolicy.isActive,
              });
            } else {
              await addWordToCollection({
                workspaceId,
                collectionId: chapCollectionId,
                word: w.word,
                reading: w.reading ?? null,
                gloss: w.gloss ?? null,
                isActive: chapterPolicy.isActive,
              });
            }
            result.wordsCreated += 1;
            wordIndex += 1;
          }

          // Link the chapter ↔ collection so the library's "Show vocab" /
          // "Custom study" buttons light up automatically. We do this even
          // on re-imports of an existing chapter because the link may not
          // have been persisted by an older version of this importer.
          if (chapterId != null) {
            const existingChap =
              existingChapters.find((c) => c.id === chapterId) ?? null;
            if (!existingChap || existingChap.collectionId !== chapCollectionId) {
              await setChapterCollection(chapterId, chapCollectionId);
            }
          }
        }
        unitsSeen += 1;
        if (onProgress && unitsSeen % 5 === 0) {
          onProgress({
            stage: "textbooks",
            ratio: unitsSeen / Math.max(totalUnits, 1),
            wordsTotal: result.wordsCreated,
          });
        }
      }
      // Stamp completedAt on the chapters the user marked as already
      // done. The library_item's completedUnits is set further up; the
      // dashboard's TextbookCard reads completedAt to decide which
      // chapter is "current". Without this, the dashboard always
      // points at chapter 1 even after the user said "I'm on chapter 5".
      if (completedChapterIds.length > 0) {
        const completedAt = Math.floor(Date.now() / 1000);
        for (const id of completedChapterIds) {
          await updateChapter(id, { completedAt });
        }
      }
    }
    onProgress?.({ stage: "textbooks", ratio: 1, wordsTotal: result.wordsCreated });
  }

  return result;
}

/**
 * Repair already-imported pack data so chapter collections sit under
 * a per-textbook root collection instead of cluttering the top-level
 * sidebar. Idempotent — runs the same logic the import path now does,
 * but against existing rows.
 *
 * Chapter collections are detected by their presetId shape:
 * `${packId}:${textbookId}:${position}`, where `position` is a number
 * and the middle segment is NOT the literal `"textbook"` (that segment
 * marks textbook ROOT collections, which we synthesise here).
 *
 * Title for a freshly-created textbook root is taken from the matching
 * library item (`pack:${packId}:${textbookId}` source tag). If the
 * library item is gone, we fall back to a humane placeholder so the
 * user still gets a clean grouping.
 */
export async function repairPackTextbookCollectionTrees(
  workspaceId: number,
): Promise<{ rootsCreated: number; chaptersRelinked: number }> {
  const cols = await listCollections(workspaceId);
  // Group chapter-shaped preset collections by their inferred
  // textbook key (`${packId}:textbook:${textbookId}`).
  const chaptersByTextbookKey = new Map<string, Collection[]>();
  for (const c of cols) {
    if (c.source !== "preset" || !c.presetId) continue;
    const parts = c.presetId.split(":");
    if (parts.length !== 3) continue;
    if (parts[1] === "textbook") continue; // this IS a textbook root
    if (!/^\d+$/.test(parts[2])) continue;
    const key = `${parts[0]}:textbook:${parts[1]}`;
    const arr = chaptersByTextbookKey.get(key) ?? [];
    arr.push(c);
    chaptersByTextbookKey.set(key, arr);
  }
  if (chaptersByTextbookKey.size === 0) {
    return { rootsCreated: 0, chaptersRelinked: 0 };
  }
  // Library items provide the human title for any textbook root we
  // need to synthesise. Pre-fetch once to avoid an N+1 lookup.
  const lib = await listLibrary(workspaceId);
  let rootsCreated = 0;
  let chaptersRelinked = 0;
  for (const [tbPresetKey, chapters] of chaptersByTextbookKey) {
    let rootId: number;
    const existingRoot = cols.find((c) => c.presetId === tbPresetKey);
    if (existingRoot) {
      rootId = existingRoot.id;
    } else {
      const parts = tbPresetKey.split(":");
      const packId = parts[0];
      const textbookId = parts[2];
      const sourceTag = `pack:${packId}:${textbookId}`;
      const libItem = lib.find((l) => l.source === sourceTag);
      const created = await createCollection({
        workspaceId,
        name: libItem?.title ?? `Textbook ${textbookId}`,
        description: libItem?.author
          ? `Textbook · ${libItem.author}`
          : "Textbook from pack",
        source: "preset",
        presetId: tbPresetKey,
      });
      rootId = created.id;
      rootsCreated += 1;
    }
    for (const ch of chapters) {
      if (ch.parentId !== rootId) {
        await setCollectionParent(ch.id, rootId);
        chaptersRelinked += 1;
      }
    }
  }
  return { rootsCreated, chaptersRelinked };
}
