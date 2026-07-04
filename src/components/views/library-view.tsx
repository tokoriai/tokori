import { useEffect, useMemo, useState } from "react";
import {
  BookmarkPlus,
  BookOpen,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Film,
  GraduationCap,
  Headphones,
  Library,
  ListPlus,
  Loader2,
  Mic,
  Newspaper,
  Package,
  Pause,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Minus,
} from "lucide-react";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pinyin } from "@/components/pinyin";
import {
  bumpLibrary,
  createChapter,
  createCollection,
  deleteChapter,
  updateChapter,
  deleteLibraryItem,
  listChapters,
  listCollectionWords,
  listCollections,
  listLibrary,
  saveLibraryItem,
  setChapterCollection,
  setChapterCompleted,
  setLibraryStatus,
  type Collection,
  type LibraryChapter,
  type LibraryItem,
  type LibraryKind,
  type LibraryStatus,
  type VocabEntry,
  type VocabStatus,
} from "@/lib/db";
import { filterAndOrderLibrary } from "@/lib/library-order";
import { isMinutesUnit, singularUnitLabel } from "@/lib/library-units";
import { queueCustomStudy } from "@/lib/study/custom-study";
import { useWorkspace } from "@/lib/workspace-context";
import { setWorkspaceFocus } from "@/lib/focus";
import { useSearch } from "@/lib/search-context";
import { navigateToTab } from "@/lib/nav-event";
import { HOSTED } from "@/lib/build-flags";
import { cn } from "@/lib/utils";
import { useChapterAdvanceFlow } from "@/components/chapter-advance-flow";
import { PackImportDialog } from "@/components/pack-import-dialog";
import type { TabId } from "@/components/shell/shell";

const KIND_META: Record<LibraryKind, { label: string; icon: React.ComponentType<{ className?: string }>; defaultUnit: string }> = {
  book: { label: "Book", icon: BookOpen, defaultUnit: "pages" },
  ebook: { label: "Ebook", icon: BookOpen, defaultUnit: "chapters" },
  textbook: { label: "Textbook", icon: Library, defaultUnit: "chapters" },
  video: { label: "Video", icon: Film, defaultUnit: "minutes" },
  article: { label: "Article", icon: Newspaper, defaultUnit: "minutes" },
  podcast: { label: "Podcast", icon: Mic, defaultUnit: "episodes" },
  other: { label: "Other", icon: Headphones, defaultUnit: "units" },
};

const STATUS_BADGE: Record<LibraryStatus, string> = {
  active: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  paused: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  finished: "border-violet-500/40 text-violet-700 dark:text-violet-300",
  dropped: "border-muted-foreground/40 text-muted-foreground",
};

const STATUS_DOT: Record<LibraryStatus, string> = {
  active: "bg-emerald-500",
  paused: "bg-amber-500",
  finished: "bg-violet-500",
  dropped: "bg-muted-foreground",
};

const STATUS_ORDER: LibraryStatus[] = ["active", "paused", "finished", "dropped"];

/** Shared status writer for the badge menu + the textbook quick
 *  button. Goes through setLibraryStatus (a targeted UPDATE) so a
 *  status flip can never clobber author / progress / notes the way a
 *  partial saveLibraryItem would. Activating a textbook pauses the
 *  others (enforced in the db layer) — the toast makes that visible. */
async function applyLibraryStatus(
  item: LibraryItem,
  status: LibraryStatus,
  onChanged: () => void | Promise<void>,
): Promise<void> {
  if (status === item.status) return;
  await setLibraryStatus(item.id, status);
  if (item.kind === "textbook" && status === "active") {
    toast.success(`Studying "${item.title}"`, {
      description:
        "Other textbooks have been paused. Mark each chapter complete to push its vocab into Flashcards.",
    });
  }
  await onChanged();
}

/** The status badge, made interactive — click it to move the item
 *  between active / paused / finished / dropped without opening the
 *  editor dialog. Used on the card and the detail header. */
function StatusMenu({
  item,
  onChanged,
}: {
  item: LibraryItem;
  onChanged: () => void | Promise<void>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge asChild variant="outline" className={cn("text-[10px]", STATUS_BADGE[item.status])}>
          <button
            type="button"
            aria-label={`Status: ${item.status} — change`}
            title="Change status"
            className="cursor-pointer capitalize transition-colors hover:bg-accent/60"
          >
            {item.status}
            <ChevronDown className="size-2.5! opacity-60" />
          </button>
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-36">
        {STATUS_ORDER.map((s) => (
          <DropdownMenuItem
            key={s}
            onSelect={() => void applyLibraryStatus(item, s, onChanged)}
            className="gap-2 text-[12.5px] capitalize"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[s])} />
            {s}
            {s === item.status && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One-click textbook flow control: the active textbook offers Pause,
 *  everything else offers Make active. Finished / dropped live on the
 *  status badge menu — this button is just the study loop. */
function QuickStatusButton({
  item,
  onChanged,
}: {
  item: LibraryItem;
  onChanged: () => void | Promise<void>;
}) {
  const active = item.status === "active";
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2 text-[12px]"
      title={
        active
          ? "Pause this textbook"
          : "Set this as your current textbook (pauses others)"
      }
      onClick={() =>
        void applyLibraryStatus(item, active ? "paused" : "active", onChanged)
      }
    >
      {active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      {active ? "Pause" : "Make active"}
    </Button>
  );
}

/** Segmented − | + control. The plus side carries the label ("+1 page",
 *  "+10 min") so the pair reads as one adjuster for one quantity — the
 *  old layout's bare "−" floating between two unrelated "+" buttons
 *  read as three separate actions. */
function Stepper({
  label,
  minusTitle,
  plusTitle,
  onMinus,
  onPlus,
  minusDisabled,
}: {
  label: string;
  minusTitle: string;
  plusTitle: string;
  onMinus: () => void;
  onPlus: () => void;
  minusDisabled?: boolean;
}) {
  return (
    <div className="inline-flex h-7 items-stretch overflow-hidden rounded-md border border-border">
      <button
        type="button"
        onClick={onMinus}
        disabled={minusDisabled}
        title={minusTitle}
        aria-label={minusTitle}
        className="flex items-center px-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
      >
        <Minus className="size-3.5" />
      </button>
      <div className="w-px shrink-0 bg-border" aria-hidden />
      <button
        type="button"
        onClick={onPlus}
        title={plusTitle}
        aria-label={plusTitle}
        className="flex items-center gap-1 px-2 text-[12px] font-medium transition-colors hover:bg-accent/60"
      >
        <Plus className="size-3.5" />
        {label}
      </button>
    </div>
  );
}

export function LibraryView({
  onNavigate,
}: {
  /** Tab-switch callback wired from the shell so the per-chapter
   *  "Custom study" button can route into Flashcards with a collection
   *  filter pre-loaded. */
  onNavigate?: (tab: TabId) => void;
}) {
  const { active: workspace } = useWorkspace();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [filter, setFilter] = useState<LibraryStatus | "all">("all");
  const [editing, setEditing] = useState<LibraryItem | "new" | null>(null);
  // The pack importer lives here (and in Collections) because packs
  // ship textbooks + chapter collections — those are Library- and
  // Collections-shaped, not loose vocab. Surfacing it on Vocabulary
  // misled users into thinking "Redeem" was the same kind of action
  // as "Import CSV".
  const [showPack, setShowPack] = useState(false);
  // When set, the LibraryView replaces the list grid with the detail
  // view for that item. Cleared via the detail view's "Back" button.
  // We persist `selectedItemId` instead of the LibraryItem object so a
  // refresh of `items` (e.g. after an edit) flows through naturally.
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);

  async function refresh() {
    if (!workspace) return;
    setItems(await listLibrary(workspace.id));
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Pure filter/sort lives in lib/library-order so the rules ("All"
  // keeps chronological order with active floated to the top; specific
  // statuses are a plain where) stay unit-testable.
  const filtered = useMemo(() => filterAndOrderLibrary(items, filter), [items, filter]);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );

  if (!workspace) return null;

  // Detail view takes over the entire pane when an item is selected.
  // The list-view chrome (filter pills, Add item button) doesn't apply
  // to a single-item drill-down so we render fully in the detail's
  // own layout.
  if (selectedItem) {
    return (
      <TextbookDetailView
        item={selectedItem}
        onBack={() => setSelectedItemId(null)}
        onChange={refresh}
        onEdit={() => setEditing(selectedItem)}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 pt-8 pb-5">
        <div className="mx-auto flex max-w-4xl xl:max-w-6xl 2xl:max-w-7xl items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl tracking-tight">Library</h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              Books, textbooks, videos, articles, podcasts — track what you're consuming
              and how far you've gotten.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              onClick={() => setShowPack(true)}
              title="Install a Tokori pack — textbook + chapter vocab collections"
            >
              <Package className="size-4" />
              Redeem pack
            </Button>
            <Button onClick={() => setEditing("new")}>
              <Plus className="size-4" />
              Add item
            </Button>
          </div>
        </div>

        <div className="mx-auto mt-5 flex max-w-4xl xl:max-w-6xl 2xl:max-w-7xl flex-wrap gap-1 rounded-full border border-border bg-card p-1 w-fit">
          {(["all", "active", "paused", "finished", "dropped"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={cn(
                "rounded-full px-3 py-1 text-[12.5px] capitalize transition-colors",
                filter === s
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-4xl xl:max-w-6xl 2xl:max-w-7xl">
          {filtered.length === 0 ? (
            <EmptyState
              onAdd={() => setEditing("new")}
              onRedeem={() => setShowPack(true)}
              hasItems={items.length > 0}
            />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {filtered.map((it) => (
                <Card
                  key={it.id}
                  item={it}
                  onEdit={() => setEditing(it)}
                  onDelete={async () => {
                    await deleteLibraryItem(it.id);
                    await refresh();
                  }}
                  onBump={async (units, seconds) => {
                    await bumpLibrary(it.id, units, seconds);
                    await refresh();
                  }}
                  onItemRefresh={refresh}
                  onNavigate={onNavigate}
                  onOpen={() => {
                    setSelectedItemId(it.id);
                    // Tell the chat the student has opened this
                    // book / textbook / podcast — drives the
                    // "current focus" prompt block. Best-effort.
                    if (workspace) {
                      void setWorkspaceFocus({
                        workspaceId: workspace.id,
                        libraryItemId: it.id,
                        chapterId: null,
                        readerDocId: null,
                      }).catch(() => {});
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <ItemEditor
        open={editing != null}
        item={editing === "new" ? null : editing}
        workspaceId={workspace.id}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await refresh();
        }}
      />

      <PackImportDialog
        open={showPack}
        onClose={() => setShowPack(false)}
        onImported={() => void refresh()}
      />
    </div>
  );
}

function Card({
  item,
  onEdit,
  onDelete,
  onBump,
  onItemRefresh,
  onNavigate,
  onOpen,
}: {
  item: LibraryItem;
  onEdit: () => void;
  onDelete: () => void;
  onBump: (units: number, seconds: number) => void;
  onItemRefresh: () => void;
  onNavigate?: (tab: TabId) => void;
  /** Open the textbook/book detail page. Only rendered for textbooks
   *  and books — other kinds (videos, podcasts) keep the inline-only
   *  card UX they had before. */
  onOpen?: () => void;
}) {
  const { icon: Icon, label } = KIND_META[item.kind];
  const isTextbook = item.kind === "textbook" || item.kind === "book";
  const [chapters, setChapters] = useState<LibraryChapter[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Chapters load eagerly for textbooks/books — the progress bar, the
  // action row (time-only vs unit stepper), and the textbook status
  // button all depend on knowing whether chapters exist. Loading only
  // on expand showed the wrong controls until the user opened the list.
  useEffect(() => {
    if (!isTextbook) return;
    let cancelled = false;
    listChapters(item.id).then((rows) => {
      if (!cancelled) setChapters(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [item.id, isTextbook]);

  // For chapter-driven progress.
  const chapterStats = useMemo(() => {
    if (!chapters) return null;
    const completed = chapters.filter((c) => c.completedAt != null).length;
    return { completed, total: chapters.length };
  }, [chapters]);

  // Progress: prefer chapter completion when available, else manual units.
  const usingChapters = chapterStats != null && chapterStats.total > 0;
  const minutesUnit = isMinutesUnit(item.unitLabel);
  const pct = usingChapters
    ? Math.min(100, (chapterStats.completed / chapterStats.total) * 100)
    : item.totalUnits && item.totalUnits > 0
      ? Math.min(100, (item.completedUnits / item.totalUnits) * 100)
      : null;

  async function refreshChapters() {
    setChapters(await listChapters(item.id));
  }

  return (
    <li className="group flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {label}
            </Badge>
            <StatusMenu item={item} onChanged={onItemRefresh} />
            {item.kind === "textbook" && item.status === "active" && (
              <Badge
                variant="secondary"
                className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                title="Only one textbook can be active at a time."
              >
                current textbook
              </Badge>
            )}
          </div>
          <h3
            className={cn(
              "mt-1 truncate font-serif text-lg leading-tight",
              isTextbook && onOpen && "cursor-pointer hover:underline underline-offset-2",
            )}
            onClick={() => isTextbook && onOpen?.()}
            title={isTextbook ? "Open detail view" : undefined}
          >
            {item.title}
          </h3>
          {item.author && (
            <p className="truncate text-[12px] text-muted-foreground">{item.author}</p>
          )}
        </div>
        {isTextbook && onOpen && (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpen}
            className="h-7 shrink-0 px-2 text-[12px]"
            title="Open the textbook detail page"
          >
            Open
            <ChevronRight className="size-3" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          className="opacity-0 transition-opacity group-hover:opacity-100"
          title="Delete"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {pct != null ? (
        <div>
          <div className="flex items-baseline justify-between text-[11.5px] text-muted-foreground">
            <span>
              {usingChapters ? (
                <>
                  {chapterStats!.completed} / {chapterStats!.total} chapters
                </>
              ) : (
                <>
                  {item.completedUnits} / {item.totalUnits} {item.unitLabel}
                </>
              )}
              {/* Logged time rides along so the +10 min stepper has
                  visible feedback even when progress is unit-driven.
                  Minutes-unit items skip it — their units ARE time. */}
              {item.totalSeconds > 0 && !minutesUnit && (
                <> · {Math.round(item.totalSeconds / 60)} min</>
              )}
            </span>
            <span>{Math.round(pct)}%</span>
          </div>
          <Progress className="mt-1 h-1.5" value={pct} />
        </div>
      ) : (
        <div className="text-[11.5px] text-muted-foreground">
          {item.completedUnits > 0 && (
            <>
              {item.completedUnits} {item.unitLabel} ·{" "}
            </>
          )}
          {Math.round(item.totalSeconds / 60)} min logged
        </div>
      )}

      {/* Actions: progress steppers + textbook flow control + edit.
          Chapter-driven items advance via chapter checkmarks, so they
          only log time here; minutes-unit items fold the unit stepper
          and the time log into one control (previously "+1 minutes"
          sat next to "+10 min", tracking the same thing twice). */}
      <div className="flex flex-wrap items-center gap-1.5">
        {usingChapters ? (
          <Stepper
            label="10 min"
            plusTitle="Log 10 minutes"
            minusTitle="Remove 10 minutes"
            onPlus={() => onBump(0, 600)}
            onMinus={() => onBump(0, -600)}
            minusDisabled={item.totalSeconds <= 0}
          />
        ) : minutesUnit ? (
          <Stepper
            label="10 min"
            plusTitle="Log 10 minutes"
            minusTitle="Remove 10 minutes"
            onPlus={() => onBump(10, 600)}
            onMinus={() => onBump(-10, -600)}
            minusDisabled={item.completedUnits <= 0 && item.totalSeconds <= 0}
          />
        ) : (
          <>
            <Stepper
              label={`1 ${singularUnitLabel(item.unitLabel)}`}
              plusTitle={`Mark one ${singularUnitLabel(item.unitLabel)} done`}
              minusTitle={`Take one ${singularUnitLabel(item.unitLabel)} back`}
              onPlus={() => onBump(1, 0)}
              onMinus={() => onBump(-1, 0)}
              minusDisabled={item.completedUnits <= 0}
            />
            <Stepper
              label="10 min"
              plusTitle="Log 10 minutes"
              minusTitle="Remove 10 minutes"
              onPlus={() => onBump(0, 600)}
              onMinus={() => onBump(0, -600)}
              minusDisabled={item.totalSeconds <= 0}
            />
          </>
        )}
        {item.kind === "textbook" && (
          <QuickStatusButton item={item} onChanged={onItemRefresh} />
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onEdit}
          className="ml-auto h-7 px-2 text-[12px]"
        >
          Edit
        </Button>
      </div>

      {/* Chapter section — books and textbooks only */}
      {isTextbook && (
        <div className="mt-1 border-t border-border/60 pt-2.5">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="flex w-full items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                expanded ? "rotate-180" : "rotate-0",
              )}
            />
            <span className="font-medium uppercase tracking-wider">
              Chapters
            </span>
            {chapters && (
              <span className="ml-auto tabular-nums">
                {chapters.filter((c) => c.completedAt).length} / {chapters.length}
              </span>
            )}
          </button>
          {expanded && (
            <ChapterList
              itemId={item.id}
              workspaceId={item.workspaceId}
              isTextbook={item.kind === "textbook"}
              chapters={chapters}
              onChange={async () => {
                await refreshChapters();
                onItemRefresh();
              }}
              onNavigate={onNavigate}
            />
          )}
        </div>
      )}
    </li>
  );
}

function ChapterList({
  itemId,
  chapters,
  workspaceId,
  isTextbook,
  onChange,
  onNavigate,
}: {
  itemId: number;
  chapters: LibraryChapter[] | null;
  workspaceId: number;
  /** Textbook chapters get the vocab-list side-effect on completion;
   *  novels / other "books" share the chapter UI but skip the SRS push. */
  isTextbook: boolean;
  onChange: () => void | Promise<void>;
  onNavigate?: (tab: TabId) => void;
}) {
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  /** Which chapter's vocab modal is open. Null = no modal. */
  const [vocabModal, setVocabModal] = useState<{
    chapter: LibraryChapter;
    collection: Collection;
  } | null>(null);
  // All chapter-advance + per-chapter-vocab-push state + modals are
  // owned by the shared hook so the dashboard's TextbookCard can wire
  // up the exact same flow without code duplication.
  const advanceFlow = useChapterAdvanceFlow({
    itemId,
    collections,
    isTextbook,
    onNavigate,
    onChange,
  });

  // Pull the workspace's collections once — the per-chapter picker
  // chooses among these to attach a vocab list to a lesson.
  useEffect(() => {
    let cancelled = false;
    listCollections(workspaceId)
      .then((cs) => {
        if (!cancelled) setCollections(cs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function add() {
    const title = newTitle.trim();
    if (!title) return;
    setBusy(true);
    try {
      await createChapter({ itemId, title });
      setNewTitle("");
      await onChange();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c: LibraryChapter) {
    const completing = !c.completedAt;
    // For textbook chapters, completing the chapter pushes its vocab
    // into active rotation. For novels and other books we just track
    // progress — `dueVocab=false` skips the SRS nudge.
    const { vocabNudged } = await setChapterCompleted(c.id, completing, {
      dueVocab: completing && isTextbook,
    });
    if (completing && vocabNudged > 0) {
      toast.success(
        `${vocabNudged.toLocaleString()} word${vocabNudged === 1 ? "" : "s"} now due`,
        {
          description: `From "${c.title}". Open Flashcards to drill them.`,
        },
      );
    } else if (completing && isTextbook && c.collectionId == null) {
      toast(`Chapter completed`, {
        description:
          "Tip: attach a vocabulary list to this chapter so completing it pushes those words into your Flashcards queue.",
      });
    }
    await onChange();
  }

  async function attach(c: LibraryChapter, choice: number | "new" | null) {
    let cid: number | null = null;
    if (choice === "new") {
      const created = await createCollection({
        workspaceId,
        name: c.title,
        description: `Vocabulary for chapter "${c.title}"`,
      });
      cid = created.id;
      setCollections((prev) => [...prev, created]);
    } else if (typeof choice === "number") {
      cid = choice;
    }
    await setChapterCollection(c.id, cid);
    await onChange();
  }

  async function remove(c: LibraryChapter) {
    await deleteChapter(c.id);
    await onChange();
  }

  // ── Lecture nav: prev / next + optional vocab push ───────────────────
  //
  // The "current" lecture is the first chapter that hasn't been completed
  // yet — same definition the dashboard's TextbookCard uses. When the user
  // clicks Next we mark this chapter complete and advance, optionally
  // pushing its vocab into the flashcard rotation. Three flows:
  //
  //   • Chapter has linked vocab        → AlertDialog asks "add to
  //                                        flashcards?" and lets the user
  //                                        choose to push or just advance.
  //   • Chapter has NO linked vocab     → silent advance.
  //   • All chapters already completed  → Next is hidden, Finished pill
  //                                        shown instead.
  //
  // Prev mirrors the dashboard's "step back" — we uncomplete the most
  // recent completed chapter so it becomes current again. Doesn't undo
  // any vocab push that already happened — those words stay in rotation.
  const sortedChapters = useMemo(
    () => (chapters ? [...chapters].sort((a, b) => a.position - b.position) : []),
    [chapters],
  );
  const currentLecture = useMemo(() => {
    if (sortedChapters.length === 0) return null;
    const next = sortedChapters.find((c) => c.completedAt == null);
    return next ?? null;
  }, [sortedChapters]);
  const completedCount = sortedChapters.filter((c) => c.completedAt != null).length;
  const allLecturesDone =
    sortedChapters.length > 0 && completedCount === sortedChapters.length;
  const currentLectureIdx = currentLecture
    ? sortedChapters.findIndex((c) => c.id === currentLecture.id)
    : sortedChapters.length - 1;

  function startAdvance() {
    advanceFlow.startAdvance(currentLecture);
  }

  async function goPrevLecture() {
    // Walk backwards through sortedChapters and uncomplete the most
    // recently completed entry. We re-sort within the find so a
    // re-order via drag-and-drop later wouldn't break the contract.
    const lastCompleted = [...sortedChapters]
      .reverse()
      .find((c) => c.completedAt != null);
    if (!lastCompleted) return;
    await setChapterCompleted(lastCompleted.id, false);
    await onChange();
  }

  if (chapters == null) {
    return <p className="mt-2 text-[12px] text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="mt-2 space-y-1.5">
      {/* Now-studying lecture nav — only for textbooks with at least one
          chapter. Mirrors the dashboard's TextbookCard but lives inline
          with the chapter list. Hidden for novels / other books because
          the vocab-push semantics only apply to textbooks. */}
      {isTextbook && chapters.length > 0 && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 mb-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {allLecturesDone
                  ? "Finished"
                  : `Lecture ${currentLectureIdx + 1} of ${sortedChapters.length}`}
              </p>
              <p className="truncate text-[13px] font-medium">
                {currentLecture?.title ?? "—"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void goPrevLecture()}
                disabled={completedCount === 0}
                title="Go back — un-complete the most recent lecture"
              >
                <ChevronLeft className="size-4" />
              </Button>
              {allLecturesDone ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                  <Check className="size-3" /> Done
                </span>
              ) : (
                <Button
                  size="sm"
                  onClick={startAdvance}
                  className="h-7 px-2 text-[12px]"
                  title="Mark this lecture done and move to the next"
                >
                  Next lecture
                  <ChevronRight className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {chapters.length === 0 ? (
        <p className="px-1 text-[12px] text-muted-foreground">
          No chapters yet. Add the first below.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {chapters.map((c, idx) => (
            <li key={c.id} className="group/ch flex items-center gap-2">
              <button
                onClick={() => void toggle(c)}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                title={c.completedAt ? "Mark unread" : "Mark read"}
              >
                {c.completedAt ? (
                  <CheckSquare className="size-4 text-emerald-500" />
                ) : (
                  <Square className="size-4" />
                )}
              </button>
              <span className="w-6 shrink-0 text-[10.5px] font-mono text-muted-foreground tabular-nums">
                {String(idx + 1).padStart(2, "0")}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px]",
                  c.completedAt && "text-muted-foreground line-through",
                )}
              >
                {c.title}
              </span>
              {/* Vocabulary picker — only meaningful for textbooks where
                  completing the chapter pushes its words into the SRS
                  queue. The picker shows existing workspace collections
                  + a "New collection (chapter title)" entry for the
                  common case where the user hasn't built one yet. */}
              {isTextbook && (
                <ChapterVocabButton
                  chapter={c}
                  collections={collections}
                  onPick={(choice) => void attach(c, choice)}
                />
              )}
              {/* Once a chapter has a linked collection, surface two
                  inline actions: open a modal listing the words, and
                  jump straight into a custom-study session restricted
                  to those words. Both are no-ops for chapters with no
                  linked vocab. */}
              {isTextbook && c.collectionId != null && (() => {
                const linked = collections.find((x) => x.id === c.collectionId);
                if (!linked) return null;
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => setVocabModal({ chapter: c, collection: linked })}
                      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                      title={`Show vocabulary in "${linked.name}"`}
                    >
                      <BookOpen className="size-3.5" />
                    </button>
                    {/* "Add to flashcards" — pushes the linked
                        collection's words into the SRS rotation right
                        now, regardless of chapter completion. The
                        follow-up study prompt asks whether to drill
                        them immediately or save for later. Distinct
                        from GraduationCap (which only opens a custom
                        study session without affecting due dates). */}
                    {(linked.wordCount ?? 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => void advanceFlow.pushChapterVocab(c)}
                        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                        title={`Add "${linked.name}" to flashcards`}
                      >
                        <BookmarkPlus className="size-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        advanceFlow.launchCustomStudy(linked, { drill: true })
                      }
                      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                      title={`Custom study — drill only the words in "${linked.name}"`}
                    >
                      <GraduationCap className="size-3.5" />
                    </button>
                  </>
                );
              })()}
              <button
                onClick={() => void remove(c)}
                className={cn(
                  "text-muted-foreground transition-opacity hover:text-destructive",
                  // Touch (hosted) shows it; desktop keeps hover-reveal.
                  HOSTED ? "opacity-100" : "opacity-0 group-hover/ch:opacity-100",
                )}
                title="Remove"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-1.5 pt-1">
        <Input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!busy) void add();
            }
          }}
          placeholder="Chapter title"
          className="h-7 text-[12px]"
          disabled={busy}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={add}
          disabled={busy || !newTitle.trim()}
          className="h-7 px-2"
        >
          <Plus className="size-3" />
        </Button>
      </div>
      <ChapterVocabModal
        state={vocabModal}
        onClose={() => setVocabModal(null)}
        onCustomStudy={(collection) => {
          setVocabModal(null);
          advanceFlow.launchCustomStudy(collection, { drill: true });
        }}
      />

      {advanceFlow.dialogs}
    </div>
  );
}

/** Read-only listing of the words in a chapter's linked collection,
 *  with a one-click "Custom study" handoff. Counts at the header help
 *  the user see if a list got out of date (e.g. "0 words — did I
 *  forget to bulk-add?"). */
function ChapterVocabModal({
  state,
  onClose,
  onCustomStudy,
}: {
  state: { chapter: LibraryChapter; collection: Collection } | null;
  onClose: () => void;
  onCustomStudy: (collection: Collection) => void;
}) {
  const [vocab, setVocab] = useState<VocabEntry[] | null>(null);
  const search = useSearch();

  useEffect(() => {
    if (!state) {
      setVocab(null);
      return;
    }
    let cancelled = false;
    setVocab(null);
    void listCollectionWords(state.collection.id)
      .then((rows) => {
        if (!cancelled) setVocab(rows);
      })
      .catch(() => {
        if (!cancelled) setVocab([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  const open = state != null;
  const title = state?.chapter.title ?? "";
  const collectionName = state?.collection.name ?? "";

  // Clicking a word jumps to the dictionary tab for it — the same handoff
  // the Vocabulary view uses. Close the modal so the dictionary entry
  // isn't left buried behind it.
  function openInDictionary(word: string) {
    search.setQuery(word);
    navigateToTab("search");
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Vocabulary in <span className="font-mono">{collectionName}</span>
            {vocab != null && (
              <span className="ml-1.5 text-muted-foreground">
                · {vocab.length} word{vocab.length === 1 ? "" : "s"}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {vocab == null ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading…
          </div>
        ) : vocab.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-[13px] text-muted-foreground">
            No words in this collection yet. Add some from the Collections tab,
            or import a list from a textbook.
          </div>
        ) : (
          <ScrollArea className="h-[360px] rounded-md border border-border">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-muted/50 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Word</th>
                  <th className="px-3 py-2">Reading</th>
                  <th className="px-3 py-2">Gloss</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {vocab.map((v) => (
                  <tr
                    key={v.id}
                    onClick={() => openInDictionary(v.word)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openInDictionary(v.word);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    title={`Open “${v.word}” in the dictionary`}
                    className="group cursor-pointer border-t border-border/60 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
                  >
                    <td className="px-3 py-2.5 font-serif text-[18px]">
                      <span className="underline-offset-2 group-hover:underline group-focus-visible:underline">
                        {v.word}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[13px] text-muted-foreground">
                      {v.reading ? <Pinyin raw={v.reading} className="text-[13px]" /> : "—"}
                    </td>
                    <td className="max-w-[280px] truncate px-3 py-2.5 text-[13px] text-muted-foreground">
                      {v.gloss ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <ModalStatusPill status={v.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => state && onCustomStudy(state.collection)}
            disabled={vocab == null || vocab.length === 0}
          >
            <Sparkles className="size-3.5" />
            Custom study
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModalStatusPill({ status }: { status: VocabStatus }) {
  const styles: Record<VocabStatus, string> = {
    unseen: "bg-slate-200/40 text-slate-500 dark:text-slate-400 border-slate-300/40",
    new: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
    learning: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    review: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
    mastered:
      "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  };
  const label =
    status === "mastered" ? "known" : status === "unseen" ? "library" : status;
  return (
    <span
      className={cn(
        "inline-block rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        styles[status],
      )}
    >
      {label}
    </span>
  );
}

/** Tiny inline picker that shows the linked vocabulary collection (if
 *  any) and lets the user attach / swap / detach via a popover list of
 *  workspace collections. The "New collection" row creates one named
 *  after the chapter and links it in one click — the most common path
 *  when the user is just starting a textbook. */
function ChapterVocabButton({
  chapter,
  collections,
  onPick,
}: {
  chapter: LibraryChapter;
  collections: Collection[];
  onPick: (choice: number | "new" | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const linked = collections.find((c) => c.id === chapter.collectionId) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium transition-colors",
            linked
              ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
          title={
            linked
              ? `Vocab list: ${linked.name} (click to change)`
              : "Attach a vocabulary list — completing this chapter will push its words into Flashcards"
          }
        >
          <ListPlus className="size-3" />
          {linked ? linked.name : "Vocab"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] p-1.5">
        <div className="px-1.5 pb-1.5 pt-0.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Vocabulary list
        </div>
        <button
          type="button"
          onClick={() => {
            onPick("new");
            setOpen(false);
          }}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <Plus className="size-3.5" />
          New collection — &ldquo;{chapter.title}&rdquo;
        </button>
        {collections.length > 0 && (
          <>
            <div className="my-1 h-px bg-border" />
            <div className="max-h-64 overflow-y-auto">
              {collections.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onPick(c.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px]",
                    c.id === chapter.collectionId
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/60",
                  )}
                >
                  <span className="truncate">{c.name}</span>
                  {c.id === chapter.collectionId && (
                    <CheckSquare className="ml-auto size-3.5 text-emerald-500" />
                  )}
                </button>
              ))}
            </div>
          </>
        )}
        {chapter.collectionId != null && (
          <>
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Detach vocabulary list
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function EmptyState({
  onAdd,
  onRedeem,
  hasItems,
}: {
  onAdd: () => void;
  onRedeem: () => void;
  hasItems: boolean;
}) {
  if (hasItems) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No items in this status.
      </p>
    );
  }
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
      <Library className="mx-auto mb-3 size-7 text-muted-foreground" />
      <h3 className="font-serif text-2xl tracking-tight">Track what you're working through.</h3>
      <p className="mx-auto mt-2 max-w-md text-[13.5px] text-muted-foreground">
        Add a textbook, novel, or podcast — or redeem a pack to
        get a full curriculum (HSK, JLPT, textbook chapters) preloaded. Log
        progress as you go and watch the immersion hours stack up.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={onAdd}>
          <Plus className="size-4" />
          Add your first
        </Button>
        <Button variant="outline" onClick={onRedeem}>
          <Package className="size-4" />
          Redeem a pack
        </Button>
      </div>
    </div>
  );
}

function ItemEditor({
  open,
  item,
  workspaceId,
  onClose,
  onSaved,
}: {
  open: boolean;
  item: LibraryItem | null;
  workspaceId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<LibraryKind>("book");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [source, setSource] = useState("");
  const [totalUnits, setTotalUnits] = useState<string>("");
  const [unitLabel, setUnitLabel] = useState("pages");
  const [status, setStatus] = useState<LibraryStatus>("active");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (item) {
      setKind(item.kind);
      setTitle(item.title);
      setAuthor(item.author ?? "");
      setSource(item.source ?? "");
      setTotalUnits(item.totalUnits != null ? String(item.totalUnits) : "");
      setUnitLabel(item.unitLabel);
      setStatus(item.status);
    } else {
      setKind("book");
      setTitle("");
      setAuthor("");
      setSource("");
      setTotalUnits("");
      setUnitLabel("pages");
      setStatus("active");
    }
  }, [open, item]);

  useEffect(() => {
    if (!item) setUnitLabel(KIND_META[kind].defaultUnit);
  }, [kind, item]);

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await saveLibraryItem({
        id: item?.id,
        workspaceId,
        kind,
        title: title.trim(),
        author: author.trim() || null,
        source: source.trim() || null,
        totalUnits: totalUnits ? Number(totalUnits) : null,
        unitLabel: unitLabel || KIND_META[kind].defaultUnit,
        status,
        completedUnits: item?.completedUnits,
        totalSeconds: item?.totalSeconds,
        // Not editable here, but saveLibraryItem is a full-row write —
        // omitting these would null them out on every edit.
        coverUrl: item?.coverUrl,
        notes: item?.notes,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{item ? "Edit item" : "Add to library"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="kind">Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as LibraryKind)}>
              <SelectTrigger id="kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(KIND_META).map(([k, m]) => (
                  <SelectItem key={k} value={k}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="title">Title</Label>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="author">Author / channel (optional)</Label>
              <Input id="author" value={author} onChange={(e) => setAuthor(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="source">URL or publisher (optional)</Label>
              <Input id="source" value={source} onChange={(e) => setSource(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="total">Total units (optional)</Label>
              <Input
                id="total"
                inputMode="numeric"
                value={totalUnits}
                onChange={(e) => setTotalUnits(e.target.value)}
                placeholder="e.g. 350"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="unit">Unit label</Label>
              <Input id="unit" value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="status">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as LibraryStatus)}>
              <SelectTrigger id="status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="finished">Finished</SelectItem>
                <SelectItem value="dropped">Dropped</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !title.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Textbook detail view ────────────────────────────────────────────────
//
// Full-page drill-down for a single textbook (or book — both kinds use
// chapters). Shows everything the inline Card surface couldn't hold:
// per-chapter rename, search, attach-collection popover, vocab modal,
// and per-chapter custom-study handoff. The overall textbook still goes
// through the regular ItemEditor for title / author / status edits via
// the "Edit" button in the header (delegated to the parent so the same
// dialog instance handles both list + detail flows).
//
// Custom-study from this page works two ways:
//   • Per-chapter: routes to Flashcards filtered to that chapter's
//     linked collection, mirroring the chapter-level button in the
//     library list view's expanded chapter list.
//   • "Current chapter": picks the first non-completed chapter and
//     does the same handoff. Convenience for "I want to study what's
//     next" without having to scan the list.

function TextbookDetailView({
  item,
  onBack,
  onChange,
  onEdit,
  onNavigate,
}: {
  item: LibraryItem;
  /** Return to the library list view. */
  onBack: () => void;
  /** Refresh parent state after a write so the list view stays in sync. */
  onChange: () => void | Promise<void>;
  /** Open the textbook ItemEditor (title, author, status, totalUnits). */
  onEdit: () => void;
  /** Tab-switch callback for routing into Flashcards on custom-study. */
  onNavigate?: (tab: TabId) => void;
}) {
  const [chapters, setChapters] = useState<LibraryChapter[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newChapterTitle, setNewChapterTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [vocabModal, setVocabModal] = useState<{
    chapter: LibraryChapter;
    collection: Collection;
  } | null>(null);
  const [pendingDeleteChapter, setPendingDeleteChapter] = useState<LibraryChapter | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [c, cols] = await Promise.all([
        listChapters(item.id),
        listCollections(item.workspaceId),
      ]);
      setChapters(c);
      setCollections(cols);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const sorted = useMemo(
    () => [...chapters].sort((a, b) => a.position - b.position),
    [chapters],
  );
  const completedCount = sorted.filter((c) => c.completedAt != null).length;
  const total = sorted.length;
  const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0;
  const currentChapter = useMemo(
    () => sorted.find((c) => c.completedAt == null) ?? null,
    [sorted],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true;
      const linked = c.collectionId
        ? collections.find((x) => x.id === c.collectionId)
        : null;
      if (linked && linked.name.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [sorted, collections, search]);

  function startCustomStudy(collection: Collection) {
    // Drill by default — these buttons promise "study the chapter
    // without affecting due dates". The prestart toggle can flip it.
    queueCustomStudy(collection, { drill: true });
    if (onNavigate) {
      onNavigate("flashcards");
    } else {
      toast.success(`Queued "${collection.name}" — open Flashcards to study.`);
    }
  }

  async function toggleCompletion(c: LibraryChapter) {
    const completing = !c.completedAt;
    const isTextbook = item.kind === "textbook";
    const { vocabNudged } = await setChapterCompleted(c.id, completing, {
      dueVocab: completing && isTextbook,
    });
    if (completing && vocabNudged > 0) {
      toast.success(
        `${vocabNudged.toLocaleString()} word${vocabNudged === 1 ? "" : "s"} now due`,
        { description: `From "${c.title}".` },
      );
    }
    await refresh();
    await onChange();
  }

  async function attach(c: LibraryChapter, choice: number | "new" | null) {
    let cid: number | null = null;
    if (choice === "new") {
      const created = await createCollection({
        workspaceId: item.workspaceId,
        name: c.title,
        description: `Vocabulary for chapter "${c.title}"`,
      });
      cid = created.id;
      setCollections((prev) => [...prev, created]);
    } else if (typeof choice === "number") {
      cid = choice;
    }
    await setChapterCollection(c.id, cid);
    await refresh();
  }

  function startRename(c: LibraryChapter) {
    setRenamingId(c.id);
    setRenameDraft(c.title);
  }

  async function commitRename() {
    if (renamingId == null) return;
    const title = renameDraft.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    await updateChapter(renamingId, { title });
    setRenamingId(null);
    await refresh();
    await onChange();
  }

  async function addChapter() {
    const title = newChapterTitle.trim();
    if (!title) return;
    setBusy(true);
    try {
      await createChapter({ itemId: item.id, title });
      setNewChapterTitle("");
      await refresh();
      await onChange();
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeleteChapter() {
    if (!pendingDeleteChapter) return;
    await deleteChapter(pendingDeleteChapter.id);
    setPendingDeleteChapter(null);
    await refresh();
    await onChange();
  }

  const KindIcon = KIND_META[item.kind].icon;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-8 pt-6 pb-5">
        <div className="mx-auto flex max-w-4xl xl:max-w-6xl flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onBack} className="h-7 px-2 text-[12px]">
              <ChevronLeft className="size-4" />
              Library
            </Button>
            <Badge variant="outline" className="text-[10px]">
              {KIND_META[item.kind].label}
            </Badge>
            <StatusMenu item={item} onChanged={onChange} />
            {item.kind === "textbook" && item.status === "active" && (
              <Badge
                variant="secondary"
                className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              >
                current textbook
              </Badge>
            )}
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-foreground/10 text-foreground">
                <KindIcon className="size-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate font-serif text-3xl tracking-tight">
                  {item.title}
                </h1>
                {item.author && (
                  <p className="truncate text-[13px] text-muted-foreground">
                    {item.author}
                  </p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Stepper
                label="10 min"
                plusTitle="Log 10 minutes"
                minusTitle="Remove 10 minutes"
                onPlus={() => void bumpLibrary(item.id, 0, 600).then(onChange)}
                onMinus={() => void bumpLibrary(item.id, 0, -600).then(onChange)}
                minusDisabled={item.totalSeconds <= 0}
              />
              {item.kind === "textbook" && (
                <QuickStatusButton item={item} onChanged={onChange} />
              )}
              {currentChapter && (
                <Button
                  size="sm"
                  onClick={() => {
                    const linked = currentChapter.collectionId
                      ? collections.find((c) => c.id === currentChapter.collectionId)
                      : null;
                    if (linked) {
                      startCustomStudy(linked);
                    } else {
                      toast(
                        "No vocab linked to the current chapter — attach a collection first.",
                      );
                    }
                  }}
                >
                  <GraduationCap className="size-3.5" />
                  Study current
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={onEdit}>
                Edit
              </Button>
            </div>
          </div>
          {/* Progress */}
          {total > 0 && (
            <div>
              <div className="mb-1 flex items-baseline justify-between text-[11.5px] text-muted-foreground">
                <span>
                  {completedCount} / {total} chapters
                  {item.totalSeconds > 0 && (
                    <> · {Math.round(item.totalSeconds / 60)} min</>
                  )}
                </span>
                <span>{pct}%</span>
              </div>
              <Progress className="h-1.5" value={pct} />
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-4xl xl:max-w-6xl space-y-4">
          {/* Search */}
          <div className="relative">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search chapters or vocab list…"
              className="pl-9"
            />
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Sparkles className="size-3.5" />
            </span>
          </div>

          {/* Chapters */}
          {loading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin" />
              Loading chapters…
            </p>
          ) : sorted.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-10 text-center">
              <p className="text-sm font-medium">No chapters yet.</p>
              <p className="mx-auto mt-1 max-w-sm text-[12.5px] text-muted-foreground">
                Add chapters below to track your progress and attach vocab lists.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-[13px] text-muted-foreground">
              No chapters match &ldquo;{search}&rdquo;.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((c) => {
                const idx = sorted.findIndex((x) => x.id === c.id);
                const linked = c.collectionId
                  ? collections.find((x) => x.id === c.collectionId) ?? null
                  : null;
                const isCurrent = currentChapter?.id === c.id;
                const isRenaming = renamingId === c.id;
                return (
                  <li
                    key={c.id}
                    className={cn(
                      "group/ch flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors",
                      isCurrent
                        ? "border-foreground/30 bg-accent/30"
                        : "border-border hover:bg-accent/20",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void toggleCompletion(c)}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                      title={c.completedAt ? "Mark unread" : "Mark complete"}
                    >
                      {c.completedAt ? (
                        <CheckSquare className="size-4 text-emerald-500" />
                      ) : (
                        <Square className="size-4" />
                      )}
                    </button>
                    <span className="w-6 shrink-0 text-right text-[10.5px] font-mono text-muted-foreground tabular-nums">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0 flex-1">
                      {isRenaming ? (
                        <Input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => void commitRename()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void commitRename();
                            } else if (e.key === "Escape") {
                              setRenamingId(null);
                            }
                          }}
                          className="h-7 text-[13px]"
                        />
                      ) : (
                        <div className="flex items-baseline gap-2">
                          <span
                            className={cn(
                              "truncate text-[13.5px] font-medium",
                              c.completedAt && "text-muted-foreground line-through",
                            )}
                          >
                            {c.title}
                          </span>
                          {isCurrent && (
                            <Badge
                              variant="secondary"
                              className="text-[9.5px] bg-foreground/10"
                            >
                              up next
                            </Badge>
                          )}
                        </div>
                      )}
                      {linked && (
                        <p className="text-[11px] text-muted-foreground">
                          {linked.name} · {linked.wordCount ?? 0} word
                          {linked.wordCount === 1 ? "" : "s"}
                        </p>
                      )}
                    </div>
                    <div
                      className={cn(
                        "flex shrink-0 items-center gap-0.5 transition-opacity",
                        // Hosted/tablet has no hover — show the per-chapter
                        // actions (vocab, custom study, rename, delete)
                        // outright so they're reachable by touch. Desktop
                        // keeps the hover-reveal (HOSTED is dead-stripped).
                        HOSTED
                          ? "opacity-100"
                          : "opacity-0 group-hover/ch:opacity-100",
                      )}
                    >
                      {linked && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setVocabModal({ chapter: c, collection: linked })}
                            title="Show vocabulary"
                          >
                            <BookOpen className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => startCustomStudy(linked)}
                            title="Custom study this chapter"
                          >
                            <GraduationCap className="size-3.5" />
                          </Button>
                        </>
                      )}
                      <ChapterVocabButton
                        chapter={c}
                        collections={collections}
                        onPick={(choice) => void attach(c, choice)}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => startRename(c)}
                        title="Rename chapter"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setPendingDeleteChapter(c)}
                        title="Delete chapter"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Add chapter — always shown so the user can extend a textbook
              even from a partially-imported pack. */}
          <div className="flex items-center gap-2 pt-2">
            <Input
              value={newChapterTitle}
              onChange={(e) => setNewChapterTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (!busy) void addChapter();
                }
              }}
              placeholder="New chapter title"
              className="h-8 text-[12.5px]"
              disabled={busy}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void addChapter()}
              disabled={busy || !newChapterTitle.trim()}
            >
              <Plus className="size-3.5" />
              Add
            </Button>
          </div>
        </div>
      </div>

      {/* Vocab modal — re-uses the modal already used by the inline
          ChapterList in the library card, so the UX is consistent. */}
      <ChapterVocabModal
        state={vocabModal}
        onClose={() => setVocabModal(null)}
        onCustomStudy={(collection) => {
          setVocabModal(null);
          startCustomStudy(collection);
        }}
      />

      {/* Delete chapter confirm */}
      <AlertDialog
        open={pendingDeleteChapter != null}
        onOpenChange={(v) => {
          if (!v) setPendingDeleteChapter(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete chapter &ldquo;{pendingDeleteChapter?.title}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The chapter row is removed. Any vocabulary collection
              attached to it stays — you can re-attach it to a different
              chapter or delete the collection separately from the
              Collections tab.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmDeleteChapter()}
            >
              Delete chapter
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
