import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  BookmarkX,
  BookOpen,
  ChevronsUpDown,
  Download,
  LayoutGrid,
  List,
  Package,
  Plus,
  RotateCw,
  Search,
  Table2,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pinyin } from "@/components/pinyin";
import { PushToAnkiButton } from "@/components/push-to-anki";
import { CardComposerDialog } from "@/components/card-composer-dialog";
import { VocabImportDialog } from "@/components/vocab-import-dialog";
import { PackImportDialog } from "@/components/pack-import-dialog";
import { useCloudRefresh } from "@/lib/cloud-refresh";
import {
  importerLabelsForLanguage,
  joinImporterLabels,
} from "@/lib/vocab-import/registry";
import {
  deleteVocab,
  listVocab,
  setVocabStatus as setVocabStatusFn,
  type VocabEntry,
  type VocabStatus,
} from "@/lib/db";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MemoryDialog,
  StrengthBar,
  strengthBucket,
} from "@/components/vocab-memory";
import { useSearch } from "@/lib/search-context";
import { useWorkspace } from "@/lib/workspace-context";
import { navigateToTab } from "@/lib/nav-event";
import { cn } from "@/lib/utils";

const STATUSES: { id: VocabStatus | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "new", label: "New" },
  { id: "learning", label: "Learning" },
  { id: "review", label: "Review" },
  { id: "mastered", label: "Mastered" },
];

const STATUS_DOT: Record<VocabStatus, string> = {
  // "unseen" = library-imported content the user hasn't opted into
  // studying. Muted neutral so it visually recedes vs. truly-new
  // study items (which get the brighter sky-500).
  unseen: "bg-slate-300 dark:bg-slate-600",
  new: "bg-sky-500",
  learning: "bg-amber-500",
  review: "bg-violet-500",
  mastered: "bg-emerald-500",
};

const STATUS_BADGE: Record<VocabStatus, string> = {
  unseen: "border-slate-300/60 text-slate-500 dark:text-slate-400",
  new: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  learning: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  review: "border-violet-500/40 text-violet-700 dark:text-violet-300",
  mastered: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
};

/** "Due today" = anything the Study queue would actually pick up
 *  RIGHT NOW. Mirrors the desktop's `listDueVocab` SQL filter exactly:
 *
 *    isActive (in the SRS pool, not library)
 *    AND status != 'mastered'                 (graduated cards rest)
 *    AND (dueAt IS NULL OR dueAt <= now)      (genuinely due, or
 *                                             never-yet-scheduled new
 *                                             cards waiting on a
 *                                             first review)
 *
 *  New cards with `dueAt = null` are first-time reviews that the
 *  Flashcards picker WILL hand the user, so they count here too —
 *  otherwise a fresh pack import showed "469 new, 0 due" and the
 *  badge made it look like nothing was actionable. `mastered` still
 *  doesn't count; when FSRS reschedules a mastered card it
 *  downgrades it to `review` first. */
function isDueNow(
  entry: Pick<VocabEntry, "status" | "dueAt" | "isActive">,
): boolean {
  if (entry.isActive === false) return false;
  if (entry.status === "mastered") return false;
  const now = Math.floor(Date.now() / 1000);
  return entry.dueAt == null || entry.dueAt <= now;
}

function displayStatus(
  entry: Pick<VocabEntry, "status" | "dueAt" | "isActive">,
): {
  label: string;
  dotClass: string;
  badgeClass: string;
} {
  if (isDueNow(entry)) {
    return {
      label: "Due today",
      dotClass: "bg-violet-500",
      badgeClass: "border-violet-500/40 text-violet-700 dark:text-violet-300",
    };
  }
  return {
    label: entry.status,
    dotClass: STATUS_DOT[entry.status],
    badgeClass: STATUS_BADGE[entry.status],
  };
}

type ViewMode = "list" | "cards" | "table";
const VIEW_KEY = "vocab.viewMode";

/** RFC 4180 CSV escaping: wrap any field containing a comma, quote, or
 *  newline in double quotes, doubling internal quotes. Anything else
 *  passes through verbatim. */
function csvField(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build a CSV string from the currently-filtered vocab list and
 *  trigger a browser download. Columns are stable so the export can
 *  feed a spreadsheet or a re-import (the existing VocabImportDialog
 *  expects `word,reading,gloss` as a minimum, which lines up with the
 *  first three columns here). */
function downloadVocabCsv(rows: VocabEntry[], workspaceLabel: string) {
  const header = [
    "word",
    "reading",
    "gloss",
    "status",
    "source",
    "kind",
    "review_count",
    "stability",
    "difficulty",
    "due_at",
    "last_review",
    "created_at",
    "card_notes",
    "front_extra",
  ];
  const isoOrEmpty = (sec: number | null) =>
    sec ? new Date(sec * 1000).toISOString() : "";
  const lines = [
    header.join(","),
    ...rows.map((r) =>
      [
        csvField(r.word),
        csvField(r.reading),
        csvField(r.gloss),
        csvField(r.status),
        csvField(r.source),
        csvField(r.kind),
        csvField(r.reviewCount),
        csvField(r.stability),
        csvField(r.difficulty),
        csvField(isoOrEmpty(r.dueAt)),
        csvField(isoOrEmpty(r.lastReview)),
        csvField(isoOrEmpty(r.createdAt)),
        csvField(r.cardNotes),
        csvField(r.frontExtra),
      ].join(","),
    ),
  ];
  // BOM keeps Excel happy with non-ASCII (Chinese characters,
  // diacritics on European readings) when the file's opened on
  // Windows. Without it Excel silently mojibakes the file.
  const blob = new Blob(["﻿" + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const slug =
    workspaceLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "export";
  a.download = `vocab-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function VocabView() {
  const { active: workspace } = useWorkspace();
  const search = useSearch();
  // Workspace-aware "Anki, Duolingo, ..." copy. The empty-state +
  // import button title both name source apps; without filtering by
  // the active workspace's target language we'd suggest HackChinese
  // to a Japanese learner. The label list omits "Generic CSV" since
  // every call site tacks ", or any CSV" on the end itself.
  const importerNames = useMemo(
    () =>
      joinImporterLabels(
        importerLabelsForLanguage(workspace?.targetLang ?? "en"),
      ),
    [workspace?.targetLang],
  );
  const [entries, setEntries] = useState<VocabEntry[]>([]);
  const [filter, setFilter] = useState<VocabStatus | "all">("all");
  const [query, setQuery] = useState("");
  // Pack imports (HSK, JLPT, textbooks) write hundreds-to-thousands of
  // rows as `is_active = false` library cards — reference material the
  // user opted into, not vocab they're actively studying yet. The
  // collection view in Collections / Library already surfaces those
  // rows in context. Showing them here too drowns the Vocab tab in
  // unrelated entries the moment a pack lands. Default to hiding
  // library cards; the toggle re-shows them for users who want the
  // single-pane view.
  const SHOW_LIBRARY_KEY = "vocab.showLibrary";
  const [showLibrary, setShowLibrary] = useState<boolean>(() => {
    return localStorage.getItem(SHOW_LIBRARY_KEY) === "1";
  });
  useEffect(() => {
    localStorage.setItem(SHOW_LIBRARY_KEY, showLibrary ? "1" : "0");
  }, [showLibrary]);

  /** Open the rich dictionary detail page for a saved word. Uses the
   *  shared SearchProvider so the search tab renders the same surface
   *  the user sees when they search from the sidebar / Ctrl+K. */
  function openInDictionary(word: string) {
    search.setQuery(word);
    navigateToTab("search");
  }
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>(() => {
    return (localStorage.getItem(VIEW_KEY) as ViewMode) ?? "cards";
  });
  const [showImport, setShowImport] = useState(false);
  const [showPackImport, setShowPackImport] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    listVocab(workspace.id)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  async function refresh() {
    if (!workspace) return;
    setEntries(await listVocab(workspace.id));
  }

  // Re-fetch when something on the bus invalidates state — pack
  // import, multi-device push, manual "Refresh from cloud" tap.
  // Without this the vocab list silently stales out after an
  // import that happens from another view.
  useCloudRefresh(refresh);

  async function onDelete(id: number) {
    await deleteVocab(id);
    await refresh();
  }

  // Hide reference / library cards by default. They live in their
  // pack's collection and shouldn't crowd the Vocab tab. `entries` is
  // the raw fetch; `visibleEntries` is what every downstream
  // computation (stats, filter pills, listing) sees.
  const libraryCount = useMemo(
    () => entries.filter((e) => e.isActive === false).length,
    [entries],
  );
  const visibleEntries = useMemo(
    () => (showLibrary ? entries : entries.filter((e) => e.isActive !== false)),
    [entries, showLibrary],
  );

  const stats = useMemo(() => {
    const counts: Record<VocabStatus, number> = {
      unseen: 0,
      new: 0,
      learning: 0,
      review: 0,
      mastered: 0,
    };
    const nowSec = Date.now() / 1000;
    const weekAgo = nowSec - 7 * 86400;
    let dueToday = 0;
    let addedThisWeek = 0;
    let reviewedToday = 0;
    const startOfTodaySec = new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000;
    for (const e of visibleEntries) {
      counts[e.status] += 1;
      // Match the badge logic above: a `new` card with no due date (or
      // a past one) counts as due today — those are first-time reviews
      // waiting on the user, same as a `learning` / `review` card
      // whose interval has elapsed.
      if (isDueNow(e)) dueToday += 1;
      if (e.createdAt >= weekAgo) addedThisWeek += 1;
      if (e.lastReview != null && e.lastReview >= startOfTodaySec) reviewedToday += 1;
    }
    // "Known" — status-level approximation of the app-wide words-known
    // definition (studied and not lapsing): Mastered + Review. Deliberately
    // status-based, not the growth-chart replay, so the number always agrees
    // with the status chips and table rows it summarises.
    const known = counts.review + counts.mastered;
    const total = visibleEntries.length;
    const masteryPct = total === 0 ? 0 : Math.round((known / total) * 100);
    return {
      total,
      ...counts,
      dueToday,
      addedThisWeek,
      reviewedToday,
      known,
      masteryPct,
    };
  }, [visibleEntries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visibleEntries.filter((e) => {
      if (filter !== "all" && e.status !== filter) return false;
      if (!q) return true;
      return (
        e.word.toLowerCase().includes(q) ||
        (e.reading?.toLowerCase().includes(q) ?? false) ||
        (e.gloss?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [visibleEntries, filter, query]);

  // Optional sort applied on top of the filtered list. Driven by
  // clicking column headers in the table view; persists across views
  // so a user who sorts by status in the table still sees that order
  // if they switch back to cards / list. `null` = original order
  // (whatever listVocab returned, generally most-recent-first).
  type SortKey = "word" | "status" | "reviews" | "strength" | null;
  type SortDir = "asc" | "desc";
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // Status follows learner-progress order (new is the freshest, so it
  // appears first when sorted ascending — same convention every other
  // surface in the app uses for status pills).
  const STATUS_RANK: Record<VocabStatus, number> = {
    unseen: -1,
    new: 0,
    learning: 1,
    review: 2,
    mastered: 3,
  };
  const ranked = useMemo(() => {
    if (!sortKey) return filtered;
    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "word") cmp = a.word.localeCompare(b.word);
      else if (sortKey === "status")
        cmp = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      else if (sortKey === "reviews") cmp = a.reviewCount - b.reviewCount;
      else if (sortKey === "strength")
        cmp =
          strengthBucket(a.stability ?? 0).rank -
          strengthBucket(b.stability ?? 0).rank ||
          (a.stability ?? 0) - (b.stability ?? 0);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, sortDir]);

  /** Header-click cycle: unsorted → asc → desc → unsorted. Clicking a
   *  different column starts that column at asc. */
  function toggleSort(key: Exclude<SortKey, null>) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
      return;
    }
    if (sortDir === "asc") {
      setSortDir("desc");
      return;
    }
    setSortKey(null);
    setSortDir("asc");
  }

  // Pagination — large vocabularies (~15k+ words from a pack import) tank
  // the page if we render every card at once. Slice to a window and let
  // the user page through. The filter inputs don't depend on this — they
  // run over `entries`, so search across the full set still works.
  const PAGE_SIZE = view === "cards" ? 60 : view === "table" ? 200 : 100;
  const [page, setPage] = useState(0);
  // Reset to page 0 whenever filter / search / view / sort changes —
  // otherwise the user can land on "page 5 of 1" or be stranded
  // mid-list after a re-sort moves their content.
  useEffect(() => {
    setPage(0);
  }, [filter, query, view, sortKey, sortDir]);
  const pageCount = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = useMemo(
    () => ranked.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
    [ranked, currentPage, PAGE_SIZE],
  );

  // Memory-detail dialog state. Holds the row whose strength was
  // clicked; null = closed. Lives at the page level (rather than per
  // row) so we don't multiply Dialog instances across hundreds of
  // rows — there's only ever one open at a time.
  const [memoryEntry, setMemoryEntry] = useState<VocabEntry | null>(null);

  /** Update one card's status in-place AND in the DB. Used by the
   *  table view's clickable status badge. Optimistic — we update the
   *  local list right away so the row re-renders even if the round
   *  trip is slow on a big workspace. The DB write is best-effort;
   *  on failure we toast and revert. */
  async function changeStatus(entry: VocabEntry, next: VocabStatus) {
    if (entry.status === next) return;
    setEntries((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, status: next } : e)),
    );
    try {
      await setVocabStatusFn({
        workspaceId: entry.workspaceId,
        word: entry.word,
        reading: entry.reading,
        gloss: entry.gloss,
        status: next,
      });
    } catch (err) {
      // Revert if the write failed.
      setEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, status: entry.status } : e)),
      );
      console.error("status update failed", err);
    }
  }

  if (!workspace) return null;

  return (
    <div className="flex h-full flex-col">
      {/* Hero band */}
      <div className="border-b border-border px-8 pt-8 pb-6">
        <div className="mx-auto max-w-5xl 2xl:max-w-6xl">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h1 className="font-serif text-3xl tracking-tight">Vocabulary</h1>
              <p className="mt-1 text-[13.5px] text-muted-foreground">
                Words you've saved from chat, the reader, or the dictionary.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                onClick={() => setShowCreate(true)}
                title="Create a new flashcard"
              >
                <Plus className="size-3.5" />
                Add card
              </Button>
              {/* "Import vocab" pulls in words you already know — the
                  source list is workspace-aware (HackChinese only for
                  Chinese workspaces, etc.). Pack content (textbooks +
                  collections) lives in the Library and Collections
                  tabs because it represents reference material, not
                  pre-known vocab. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowImport(true)}
                title={`Import vocab you already know${
                  importerNames ? ` — ${importerNames}, or any CSV` : ""
                }`}
              >
                <Upload className="size-3.5" />
                Import vocab
              </Button>
            </div>
          </div>

          {/* Two-row stats panel.
              Top row — momentum signals (what you'd want at a glance):
                · Known          → review + mastered, the words that count toward fluency
                · Due today      → how much SRS work the user owes themselves right now
                · Added this week → growth signal
                · Reviewed today → activity signal
                · Mastery %      → mastered / total, for an at-a-glance trend
              Bottom row — the per-status counts that the existing filter pills
              also surface. Kept so users can sanity-check at a glance. */}
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <BigStat
              label="Known"
              value={stats.known}
              hint={stats.total > 0 ? `${stats.masteryPct}% of vocab` : undefined}
              accent="text-emerald-700 dark:text-emerald-300"
            />
            <BigStat
              label="Due today"
              value={stats.dueToday}
              hint={stats.dueToday > 0 ? "Open Study to review" : "All clear"}
              accent={stats.dueToday > 0 ? "text-violet-700 dark:text-violet-300" : undefined}
            />
            <BigStat label="Added this week" value={stats.addedThisWeek} />
            <BigStat label="Reviewed today" value={stats.reviewedToday} />
            <BigStat label="Total" value={stats.total} />
          </div>

          {/* Mastery progress bar — visualises how close the user is to "I
              know all the words I've ever saved". Only renders when there's
              vocab to talk about so an empty workspace doesn't show a 0%
              bar that looks like a regression. */}
          {stats.total > 0 && (
            <div className="mt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${stats.masteryPct}%` }}
                  aria-label={`Mastery ${stats.masteryPct}%`}
                />
              </div>
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                {stats.known} known · {stats.review} in review · {stats.learning} learning ·{" "}
                {stats.new} new
              </p>
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <BigStat label="New" value={stats.new} dot="bg-sky-500" />
            <BigStat label="Learning" value={stats.learning} dot="bg-amber-500" />
            <BigStat label="Review" value={stats.review} dot="bg-violet-500" />
            <BigStat label="Mastered" value={stats.mastered} dot="bg-emerald-500" />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1 rounded-full border border-border bg-card p-1">
              {STATUSES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setFilter(s.id)}
                  className={cn(
                    "rounded-full px-3 py-1 text-[12.5px] transition-colors",
                    filter === s.id
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* Library-card toggle. Visible only when the workspace
                actually has reference cards (otherwise this is just
                noise). Library cards are pack-imported with
                isActive=false — they belong to their pack's
                collection, not the user's active study pool. */}
            {libraryCount > 0 && (
              <button
                type="button"
                onClick={() => setShowLibrary((v) => !v)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors",
                  showLibrary
                    ? "border-foreground/40 bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                title={
                  showLibrary
                    ? "Hide pack-imported reference cards"
                    : "Show pack-imported reference cards alongside active vocab"
                }
              >
                <Package className="size-3.5" />
                {showLibrary ? "Hiding nothing" : `+${libraryCount.toLocaleString()} library`}
              </button>
            )}

            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  className="w-56 rounded-full pl-8"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadVocabCsv(filtered, workspace?.name ?? "vocab")
                }
                disabled={filtered.length === 0}
                title={
                  filtered.length === 0
                    ? "No vocab to export — adjust the filter or add cards first"
                    : `Download the ${filtered.length} filtered card${filtered.length === 1 ? "" : "s"} as a CSV`
                }
              >
                <Download className="size-3.5" />
                Export CSV
              </Button>
              <div className="flex gap-0.5 rounded-full border border-border bg-card p-0.5">
                <button
                  onClick={() => setView("cards")}
                  title="Card view"
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full transition-colors",
                    view === "cards"
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <LayoutGrid className="size-3.5" />
                </button>
                <button
                  onClick={() => setView("list")}
                  title="List view"
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full transition-colors",
                    view === "list"
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <List className="size-3.5" />
                </button>
                <button
                  onClick={() => setView("table")}
                  title="Table view"
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full transition-colors",
                    view === "table"
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Table2 className="size-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <CardComposerDialog
        mode="create"
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSaved={() => {
          void refresh();
        }}
      />

      <VocabImportDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onDone={async () => {
          setShowImport(false);
          await refresh();
        }}
      />

      <PackImportDialog
        open={showPackImport}
        onClose={() => setShowPackImport(false)}
        onImported={() => {
          setShowPackImport(false);
          void refresh();
        }}
      />

      <MemoryDialog
        entry={memoryEntry}
        open={memoryEntry != null}
        onClose={() => setMemoryEntry(null)}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-5xl 2xl:max-w-6xl">
          {loading ? (
            <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
          ) : filtered.length === 0 ? (
            <EmptyState
              empty={visibleEntries.length === 0}
              onImportCsv={() => setShowImport(true)}
              onRedeemPack={() => setShowPackImport(true)}
              onNavigate={(t) => navigateToTab(t)}
              importerNames={importerNames}
            />
          ) : view === "cards" ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((e) => (
                <FlashCard
                  key={e.id}
                  entry={e}
                  onDelete={() => onDelete(e.id)}
                  onOpenInDictionary={() => openInDictionary(e.word)}
                />
              ))}
            </div>
          ) : view === "table" ? (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2">
                      <SortableHeader
                        label="Word"
                        active={sortKey === "word"}
                        dir={sortDir}
                        onClick={() => toggleSort("word")}
                      />
                    </th>
                    <th className="px-3 py-2">Reading</th>
                    <th className="px-3 py-2">Meaning</th>
                    <th className="px-3 py-2">
                      <SortableHeader
                        label="Status"
                        active={sortKey === "status"}
                        dir={sortDir}
                        onClick={() => toggleSort("status")}
                      />
                    </th>
                    <th className="hidden px-3 py-2 lg:table-cell">
                      <SortableHeader
                        label="Strength"
                        active={sortKey === "strength"}
                        dir={sortDir}
                        onClick={() => toggleSort("strength")}
                      />
                    </th>
                    <th className="hidden px-3 py-2 md:table-cell">Source</th>
                    <th className="hidden px-3 py-2 text-right md:table-cell">
                      <SortableHeader
                        label="Reviews"
                        active={sortKey === "reviews"}
                        dir={sortDir}
                        onClick={() => toggleSort("reviews")}
                        align="right"
                      />
                    </th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((e) => (
                    <tr
                      key={e.id}
                      className="group border-b border-border/60 transition-colors last:border-b-0 hover:bg-accent/30"
                    >
                      <td className="px-3 py-2 align-top">
                        <button
                          type="button"
                          onClick={() => openInDictionary(e.word)}
                          className="font-serif text-[16px] hover:underline"
                          title="Open in dictionary"
                        >
                          {e.word}
                        </button>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {e.reading ? (
                          <Pinyin
                            raw={e.reading}
                            className="text-[12.5px] text-muted-foreground"
                          />
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top text-foreground/90">
                        <span className="line-clamp-2">{e.gloss ?? "—"}</span>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="cursor-pointer focus:outline-none"
                              title="Click to change status"
                            >
                              {(() => {
                                const d = displayStatus(e);
                                return (
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "h-5 gap-1 text-[10.5px] transition-colors hover:brightness-110",
                                      d.badgeClass,
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        "size-1.5 rounded-full",
                                        d.dotClass,
                                      )}
                                    />
                                    {d.label}
                                  </Badge>
                                );
                              })()}
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="min-w-[140px]">
                            {(["new", "learning", "review", "mastered"] as VocabStatus[]).map(
                              (s) => (
                                <DropdownMenuItem
                                  key={s}
                                  disabled={s === e.status}
                                  onClick={() => void changeStatus(e, s)}
                                  className="gap-2"
                                >
                                  <span
                                    className={cn(
                                      "size-1.5 rounded-full",
                                      STATUS_DOT[s],
                                    )}
                                  />
                                  <span className="capitalize">{s}</span>
                                  {s === e.status && (
                                    <span className="ml-auto text-[10.5px] text-muted-foreground">
                                      current
                                    </span>
                                  )}
                                </DropdownMenuItem>
                              ),
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                      <td className="hidden px-3 py-2 align-top lg:table-cell">
                        <button
                          type="button"
                          onClick={() => setMemoryEntry(e)}
                          className="rounded px-1 py-0.5 transition-colors hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          title="Click to view review history"
                        >
                          <StrengthBar stability={e.stability} />
                        </button>
                      </td>
                      <td className="hidden px-3 py-2 align-top text-[12px] text-muted-foreground md:table-cell">
                        {e.source === "chat"
                          ? "from chat"
                          : e.source === "search"
                            ? "from dictionary"
                            : e.source}
                      </td>
                      <td className="hidden px-3 py-2 text-right align-top tabular-nums text-muted-foreground md:table-cell">
                        {e.reviewCount}
                      </td>
                      <td className="px-3 py-2 align-top text-right">
                        <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Open in dictionary"
                            onClick={() => openInDictionary(e.word)}
                          >
                            <BookOpen className="size-4" />
                          </Button>
                          <PushToAnkiButton
                            word={e.word}
                            reading={e.reading}
                            gloss={e.gloss}
                            size="icon-sm"
                            variant="ghost"
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Remove"
                            onClick={() => onDelete(e.id)}
                          >
                            <BookmarkX className="size-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {visible.map((e) => (
                <li
                  key={e.id}
                  className="group flex items-start justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-shadow hover:shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => openInDictionary(e.word)}
                    className="min-w-0 flex-1 cursor-pointer text-left"
                    title="Open in dictionary"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-serif text-2xl group-hover:underline">
                        {e.word}
                      </span>
                      <Pinyin raw={e.reading} className="text-[13px]" />
                    </div>
                    {e.gloss && (
                      <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">
                        {e.gloss}
                      </p>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      {(() => {
                        const d = displayStatus(e);
                        return (
                          <Badge
                            variant="outline"
                            className={cn(
                              "h-5 gap-1 text-[10.5px]",
                              d.badgeClass,
                            )}
                          >
                            <span
                              className={cn(
                                "size-1.5 rounded-full",
                                d.dotClass,
                              )}
                            />
                            {d.label}
                          </Badge>
                        );
                      })()}
                      <span className="text-[10.5px] text-muted-foreground">
                        {e.source === "chat"
                          ? "from chat"
                          : e.source === "search"
                            ? "from dictionary"
                            : e.source}
                      </span>
                    </div>
                  </button>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Open in dictionary"
                      onClick={() => openInDictionary(e.word)}
                    >
                      <BookOpen className="size-4" />
                    </Button>
                    <PushToAnkiButton
                      word={e.word}
                      reading={e.reading}
                      gloss={e.gloss}
                      size="icon-sm"
                      variant="ghost"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Remove"
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={() => onDelete(e.id)}
                    >
                      <BookmarkX className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Pager — only when there's a backlog. Large packs ship 10k+
              words; rendering them all at once tanks the browser. */}
          {filtered.length > PAGE_SIZE && (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-3 py-2 text-[12.5px]">
              <span className="text-muted-foreground">
                Showing {currentPage * PAGE_SIZE + 1}–
                {Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of{" "}
                {filtered.length.toLocaleString()}
                {entries.length > filtered.length && (
                  <> · {entries.length.toLocaleString()} total</>
                )}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage(0)}
                  disabled={currentPage === 0}
                  className="h-7"
                >
                  ‹‹ First
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                  className="h-7"
                >
                  ‹ Prev
                </Button>
                <span className="px-2 text-muted-foreground">
                  Page {currentPage + 1} / {pageCount}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={currentPage >= pageCount - 1}
                  className="h-7"
                >
                  Next ›
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage(pageCount - 1)}
                  disabled={currentPage >= pageCount - 1}
                  className="h-7"
                >
                  Last ››
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Clickable column header for the table view. Cycles unsorted →
 *  asc → desc → unsorted via the parent's `toggleSort`. The arrow
 *  glyph reflects the current state: muted up-down when this column
 *  isn't the active sort, solid up/down arrow once it is. Right-align
 *  variant flips chevron + label so the Reviews column reads
 *  naturally next to a tabular-numbers value. */
function SortableHeader({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "right";
}) {
  const Glyph = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded transition-colors hover:text-foreground",
        active && "text-foreground",
        align === "right" && "flex-row-reverse",
      )}
      title={
        !active
          ? `Sort by ${label.toLowerCase()}`
          : dir === "asc"
            ? `Sorted by ${label.toLowerCase()} ascending — click again for descending`
            : `Sorted by ${label.toLowerCase()} descending — click again to clear`
      }
    >
      <span>{label}</span>
      <Glyph
        className={cn("size-3", active ? "opacity-100" : "opacity-50")}
      />
    </button>
  );
}

function FlashCard({
  entry,
  onDelete,
  onOpenInDictionary,
}: {
  entry: VocabEntry;
  onDelete: () => void;
  onOpenInDictionary: () => void;
}) {
  const [flipped, setFlipped] = useState(false);
  return (
    <div className="group relative aspect-[4/3]">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={flipped}
        aria-label={`${entry.word} — flip card`}
        onClick={() => setFlipped((f) => !f)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setFlipped((f) => !f);
          }
        }}
        className="absolute inset-0 cursor-pointer rounded-2xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Front and back share the same surface — we cross-fade
            between them on click instead of doing a 3D rotation. The
            previous rotateY(180deg) flip technically worked but read
            as "spiegelverkehrt" mid-animation: there's a moment where
            the headword is visible at an in-between angle and the
            text genuinely is mirrored. A direct content swap with a
            short opacity transition keeps the click-to-reveal beat
            without any rotated typography. */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center p-4 transition-opacity duration-200"
          style={{
            opacity: flipped ? 0 : 1,
            pointerEvents: flipped ? "none" : "auto",
          }}
        >
          <div className="font-serif text-6xl tracking-tight leading-none">
            {entry.word}
          </div>
          <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-[10.5px]">
            {(() => {
              const d = displayStatus(entry);
              return (
                <Badge
                  variant="outline"
                  className={cn("h-5 gap-1 text-[10px]", d.badgeClass)}
                >
                  <span className={cn("size-1.5 rounded-full", d.dotClass)} />
                  {d.label}
                </Badge>
              );
            })()}
            <span className="flex items-center gap-1 text-muted-foreground">
              <RotateCw className="size-3" />
              click to flip
            </span>
          </div>
        </div>

        <div
          className="absolute inset-0 flex flex-col gap-2 p-4 transition-opacity duration-200"
          style={{
            opacity: flipped ? 1 : 0,
            pointerEvents: flipped ? "auto" : "none",
          }}
        >
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-2xl">{entry.word}</span>
            {entry.reading && <Pinyin raw={entry.reading} className="text-sm" />}
          </div>
          <p className="line-clamp-4 flex-1 overflow-hidden text-[13.5px] leading-relaxed text-foreground/90">
            {entry.gloss ?? "—"}
          </p>
          <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
            <span>
              {entry.source === "chat"
                ? "from chat"
                : entry.source === "search"
                  ? "from dictionary"
                  : entry.source}
            </span>
            <span>
              {entry.reviewCount} review{entry.reviewCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </div>

      {/* Hover actions — sit above the flippable surface */}
      <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          variant="secondary"
          size="icon-sm"
          onClick={(e) => {
            e.stopPropagation();
            onOpenInDictionary();
          }}
          title="Open in dictionary"
        >
          <BookOpen className="size-3.5" />
        </Button>
        <PushToAnkiButton
          word={entry.word}
          reading={entry.reading}
          gloss={entry.gloss}
          size="icon-sm"
          variant="secondary"
        />
        <Button
          variant="secondary"
          size="icon-sm"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Remove"
        >
          <BookmarkX className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function BigStat({
  label,
  value,
  dot,
  hint,
  accent,
}: {
  label: string;
  value: number;
  dot?: string;
  /** Optional sub-line under the number — e.g. "12% of vocab", "All clear". */
  hint?: string;
  /** Optional Tailwind classes applied to the number for a colour accent. */
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        {dot && <span className={cn("size-1.5 rounded-full", dot)} />}
        {label}
      </div>
      <div className={cn("mt-0.5 text-xl font-semibold tracking-tight", accent)}>
        {value}
      </div>
      {hint && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

function EmptyState({
  empty,
  onImportCsv,
  onRedeemPack,
  onNavigate,
  importerNames,
}: {
  empty: boolean;
  onImportCsv: () => void;
  /** Opens the pack-import dialog directly. Used by the empty state
   *  so first-time users with no vocab can pick a free/paid pack
   *  without first navigating to the Library tab. */
  onRedeemPack: () => void;
  /** Tab-router for the Library / Collections deep-links. Routed
   *  through the global nav-event channel by the caller so we don't
   *  prop-drill the shell callback down into a leaf component. */
  onNavigate: (tab: "library" | "collections") => void;
  /** Workspace-aware "Anki, Duolingo, …" copy. Falls back to a
   *  generic "CSV" mention when no importers are available for the
   *  active language. */
  importerNames: string;
}) {
  if (empty) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
        <BookmarkPlus className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="text-sm font-medium">No vocabulary yet</p>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
          Save words from chat replies, the reader, or the dictionary as you
          come across them — they'll show up here. To bulk-import words you
          already know from {importerNames || "another app"}
          {importerNames ? ", or any CSV" : ""}, use the Import button.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" onClick={onImportCsv}>
            <Upload className="size-3.5" />
            Import vocab
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onRedeemPack}
            title="Install a free or paid pack to seed this workspace"
          >
            <Package className="size-3.5" />
            Redeem a pack
          </Button>
        </div>
        <p className="mx-auto mt-4 max-w-md text-[11.5px] leading-relaxed text-muted-foreground">
          Packs (HSK, JLPT, textbooks) install as reference in your{" "}
          <button
            type="button"
            onClick={() => onNavigate("library")}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Library
          </button>{" "}
          and{" "}
          <button
            type="button"
            onClick={() => onNavigate("collections")}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Collections
          </button>{" "}
          — they don't auto-fill your Flashcards queue.
        </p>
      </div>
    );
  }
  return (
    <p className="py-12 text-center text-sm text-muted-foreground">
      No matches for this filter.
    </p>
  );
}
