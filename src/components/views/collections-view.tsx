import { useEffect, useMemo, useState } from "react";
import {
  FolderPlus,
  Loader2,
  Package,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Pinyin } from "@/components/pinyin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  addWordToCollection,
  bulkAddToCollection,
  collectionSubtree,
  createCollection,
  deleteCollection,
  getOrCreateDefaultCollection,
  listCollections,
  listCollectionWords,
  listLibrary,
  removeWordFromCollection,
  renameCollection,
  type Collection,
  type LibraryItem,
  type VocabEntry,
} from "@/lib/db";
import { repairPackTextbookCollectionTrees } from "@/lib/pack-import";
import { queueCustomStudy } from "@/lib/study/custom-study";
import { PackImportDialog } from "@/components/pack-import-dialog";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";
import {
  SidebarCollapser,
  useSidebarCollapse,
} from "@/components/sidebar-collapser";

/**
 * Collections — named bundles of vocabulary. Every workspace gets a "Default"
 * collection auto-created on first visit. Words added to any collection are
 * also saved to vocab_entries, so they enter the flashcard rotation.
 */
export function CollectionsView({
  onNavigate,
}: {
  /** Tab-switch callback wired through the shell so the "Custom study"
   *  button on a collection can pop the user straight into Flashcards. */
  onNavigate?: (tab: "flashcards") => void;
} = {}) {
  const { active: workspace } = useWorkspace();
  const [collections, setCollections] = useState<Collection[] | null>(null);
  // Library items provide the "is this textbook active?" + "what's
  // the current lesson?" signals we need to decorate textbook root
  // collections + the current chapter pill in the detail page.
  // Loaded alongside collections (and re-fetched on workspace change)
  // so the badge/border don't lag behind a status flip the user
  // makes from the Library view.
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [words, setWords] = useState<VocabEntry[]>([]);
  const [loadingWords, setLoadingWords] = useState(false);
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  // Packs ship vocab as collections (one per chapter, plus textbook
  // roots), so the import action belongs here alongside "New
  // collection" rather than in the Vocabulary view.
  const [showPack, setShowPack] = useState(false);
  const [renaming, setRenaming] = useState<Collection | null>(null);
  const { open: sidebarOpen, toggle: toggleSidebar } = useSidebarCollapse(
    "collections.sidebarOpen",
  );

  // User-resizable sidebar — wider for users with deeply nested
  // packs ("HSK 3 → Lektion 1 → Wortschatz Tag 4"), narrower for
  // small displays. Width is clamped server-side to avoid the
  // sidebar swallowing the whole screen, and persisted so the user's
  // preferred breadth survives reloads.
  const SIDEBAR_KEY = "collections.sidebarWidth";
  const SIDEBAR_DEFAULT = 280;
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 560;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT;
    const raw = window.localStorage.getItem(SIDEBAR_KEY);
    const n = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT;
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, n));
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth));
    }
  }, [sidebarWidth]);
  /** Mousedown on the splitter — install temporary document-level
   *  listeners so the drag continues even when the cursor leaves the
   *  splitter element. While dragging we lock body cursor and
   *  user-select to keep the visual feedback consistent and stop
   *  text selection in the surrounding views. */
  function startSidebarResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + dx));
      setSidebarWidth(next);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Bootstrap: load (and create default if missing) on workspace change.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void (async () => {
      await getOrCreateDefaultCollection(workspace.id);
      // One-time-per-load repair pass for users who imported a pack
      // (e.g. "HSK 1 standard course") before the import path
      // started parenting chapter collections under a per-textbook
      // root. Walks any orphaned `*:textbookId:position` preset
      // collections, synthesises a textbook root for each
      // distinct textbook, and re-links the chapters under it. The
      // repair is idempotent (it short-circuits when parents are
      // already correct), so re-running on every mount is cheap.
      try {
        await repairPackTextbookCollectionTrees(workspace.id);
      } catch (err) {
        // Repair is opportunistic — a failure shouldn't block the
        // page from loading. Surface to the console for diagnosis.
        console.warn("[collections] tree repair failed", err);
      }
      const [list, libs] = await Promise.all([
        listCollections(workspace.id),
        listLibrary(workspace.id),
      ]);
      if (cancelled) return;
      setCollections(list);
      setLibraryItems(libs);
      if (activeId == null && list.length > 0) {
        setActiveId(list[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Sub-collection picker state. `null` = "All" (union of the active
  // root and every descendant); a number narrows to that one
  // sub-collection. Only meaningful when the active collection has
  // children — the detail page hides the picker otherwise.
  const [subActiveId, setSubActiveId] = useState<number | null>(null);
  // Reset the sub-pick whenever the user navigates to a different
  // root collection — otherwise switching from "Chinesisch 2 → Lektion 1"
  // to "HSK 3" would silently keep "Lektion 1" highlighted even though
  // it's not under the new parent.
  useEffect(() => {
    setSubActiveId(null);
  }, [activeId]);

  // Load words for the active collection. When a specific sub is
  // picked we fetch its rows directly; when "All" is in effect we
  // fan out across the whole subtree (root + descendants), then
  // dedupe by vocab id so a word that lives in two sub-lists doesn't
  // show twice. The fan-out runs in parallel since each collection's
  // word list is small and bounded.
  useEffect(() => {
    if (activeId == null || !collections) {
      setWords([]);
      return;
    }
    let cancelled = false;
    setLoadingWords(true);
    const targetIds =
      subActiveId != null
        ? [subActiveId]
        : collectionSubtree(collections, activeId).map((c) => c.id);
    void Promise.all(targetIds.map((id) => listCollectionWords(id)))
      .then((arrays) => {
        if (cancelled) return;
        const seen = new Set<number>();
        const merged: VocabEntry[] = [];
        for (const arr of arrays) {
          for (const v of arr) {
            if (seen.has(v.id)) continue;
            seen.add(v.id);
            merged.push(v);
          }
        }
        setWords(merged);
      })
      .finally(() => {
        if (!cancelled) setLoadingWords(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, subActiveId, collections]);

  async function refresh() {
    if (!workspace) return;
    const list = await listCollections(workspace.id);
    setCollections(list);
    // The load-words effect above re-runs when `collections` updates,
    // so we don't fetch again here — that would race with the effect
    // and occasionally leave stale rows on screen.
  }

  const activeCollection = collections?.find((c) => c.id === activeId) ?? null;

  // Build presetId → library item lookup once. Textbook root
  // collections we synthesise during pack import use the presetId
  // shape `${packId}:textbook:${textbookId}`; the matching library
  // item carries `source = pack:${packId}:${textbookId}`. Parsing the
  // source tag back lets us link the two without storing a foreign
  // key on either side.
  const textbookByCollectionPresetId = useMemo(() => {
    const map = new Map<string, LibraryItem>();
    for (const it of libraryItems) {
      if (it.kind !== "textbook" || !it.source) continue;
      const m = it.source.match(/^pack:([^:]+):(.+)$/);
      if (!m) continue;
      const [, packId, textbookId] = m;
      map.set(`${packId}:textbook:${textbookId}`, it);
    }
    return map;
  }, [libraryItems]);

  // Library item that backs the currently-active root collection
  // (when it's a textbook root). Null for user-made / non-textbook
  // collections — the detail page just hides the "current lesson"
  // ring in that case.
  const activeTextbook = useMemo(() => {
    if (!activeCollection?.presetId) return null;
    return textbookByCollectionPresetId.get(activeCollection.presetId) ?? null;
  }, [activeCollection, textbookByCollectionPresetId]);
  const filteredWords = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return words;
    return words.filter(
      (w) =>
        w.word.toLowerCase().includes(q) ||
        (w.reading?.toLowerCase().includes(q) ?? false) ||
        (w.gloss?.toLowerCase().includes(q) ?? false),
    );
  }, [words, search]);

  // Guard placed after all hooks above so the hook order is stable
  // whether or not a workspace is active (nothing above dereferences it).
  if (!workspace) return null;

  return (
    <div className="relative flex h-full">
      {sidebarOpen && (
      <aside
        className="relative flex shrink-0 flex-col border-r border-border"
        style={{ width: sidebarWidth }}
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-5 pb-3">
          <div>
            <h2 className="font-serif text-xl tracking-tight">Collections</h2>
            <p className="text-[11.5px] text-muted-foreground">Named vocab lists</p>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setShowPack(true)}
              title="Redeem a pack — adds textbook + chapter collections without filling your Flashcards queue"
            >
              <Package className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setShowNew(true)}
              title="New collection"
            >
              <FolderPlus className="size-4" />
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {collections == null ? (
            <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading…</p>
          ) : collections.length === 0 ? (
            <div className="px-2 py-3 space-y-2">
              <p className="text-[12px] text-muted-foreground">
                No collections yet.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                onClick={() => setShowPack(true)}
              >
                <Package className="size-3.5" />
                Redeem a pack
              </Button>
              <p className="text-[10.5px] leading-snug text-muted-foreground">
                Packs land here as textbook + chapter lists. Vocab stays as
                reference until you choose to study it.
              </p>
            </div>
          ) : (
            // Sidebar shows only top-level ("main") collections. The
            // sub-lists for a parent like "Chinesisch 2" are reachable
            // from the detail page via the sub-collection picker — that
            // keeps the sidebar a flat outline of the workspace's main
            // study sets instead of a sprawling tree.
            <RootCollectionList
              collections={collections}
              activeId={activeId}
              onPick={setActiveId}
              textbookByPresetId={textbookByCollectionPresetId}
            />
          )}
        </div>
        {/* Splitter — sits over the right edge of the aside so the
            user can grab anywhere along the border to resize. The
            handle itself is invisible until hover; at rest only the
            existing border-r is visible, keeping the chrome quiet.
            Double-click resets to the default width — useful escape
            hatch when someone drags too far in either direction. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize collections sidebar"
          onMouseDown={startSidebarResize}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
          title="Drag to resize · double-click to reset"
          className="absolute top-0 right-0 z-20 h-full w-1.5 -mr-0.5 cursor-col-resize select-none transition-colors hover:bg-foreground/10"
        />
      </aside>
      )}

      <SidebarCollapser
        open={sidebarOpen}
        onToggle={toggleSidebar}
        width={sidebarWidth}
        visibleLabel="Hide collections"
        hiddenLabel="Show collections"
      />

      <main className="flex-1 overflow-hidden">
        {activeCollection ? (
          <CollectionDetail
            collection={activeCollection}
            children={sortChildrenForPicker(
              (collections ?? []).filter(
                (c) => c.parentId === activeCollection.id,
              ),
            )}
            subActiveId={subActiveId}
            onPickSub={setSubActiveId}
            activeTextbook={activeTextbook}
            words={filteredWords}
            allWords={words}
            loading={loadingWords}
            search={search}
            onSearchChange={setSearch}
            onRefresh={refresh}
            onNavigate={onNavigate}
            onRename={() => setRenaming(activeCollection)}
            onDelete={async () => {
              if (activeCollection.isDefault) {
                toast.error("Can't delete the default collection.");
                return;
              }
              if (!confirm(`Delete "${activeCollection.name}"? Words stay in your vocabulary.`)) return;
              await deleteCollection(activeCollection.id);
              setActiveId(null);
              await refresh();
              toast(`Deleted ${activeCollection.name}`);
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <FolderPlus className="size-6 text-muted-foreground" />
            <p className="max-w-sm text-[13.5px] text-muted-foreground">
              Pick a collection on the left, or create a new one. Every word you add
              to a collection also enters your flashcard review queue.
            </p>
          </div>
        )}
      </main>

      <NewCollectionDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={async (id) => {
          setShowNew(false);
          await refresh();
          setActiveId(id);
        }}
        collections={collections ?? []}
      />

      <RenameDialog
        collection={renaming}
        onClose={() => setRenaming(null)}
        onSaved={async () => {
          setRenaming(null);
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

function CollectionDetail({
  collection,
  children,
  subActiveId,
  onPickSub,
  activeTextbook,
  words,
  allWords,
  loading,
  search,
  onSearchChange,
  onRefresh,
  onNavigate,
  onRename,
  onDelete,
}: {
  collection: Collection;
  /** Direct sub-collections (parentId === collection.id). Only direct
   *  children; deeper descendants appear once the user picks a child
   *  and drills down. */
  children: Collection[];
  /** `null` = "All" view (parent + every descendant). Otherwise the
   *  numeric id of the chosen sub-collection. */
  subActiveId: number | null;
  onPickSub: (id: number | null) => void;
  /** Library item backing `collection` when it's a textbook root.
   *  Used to find the "current" lesson position so we can ring its
   *  pill. Null for non-textbook collections. */
  activeTextbook: LibraryItem | null;
  words: VocabEntry[];
  allWords: VocabEntry[];
  loading: boolean;
  search: string;
  onSearchChange: (s: string) => void;
  onRefresh: () => void | Promise<void>;
  onNavigate?: (tab: "flashcards") => void;
  onRename: () => void;
  onDelete: () => void | Promise<void>;
}) {
  const { active: workspace } = useWorkspace();
  const [showAdd, setShowAdd] = useState(false);
  const [showBulk, setShowBulk] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 pt-6 pb-4">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Collection · {collection.source === "preset" ? "preset pack" : "user list"}
            </p>
            <h1 className="font-serif text-3xl tracking-tight truncate">
              {collection.name}
            </h1>
            {collection.description && (
              <p className="mt-1 text-[13px] text-muted-foreground">
                {collection.description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              size="sm"
              onClick={() => {
                // Hand off the chosen collection to the Flashcards view.
                // StudyMode consumes the handoff on mount and narrows
                // both vocab pools to this collection's subtree. Drill
                // by default — "study this collection" shouldn't move
                // the SRS schedule unless the user flips the toggle.
                queueCustomStudy(collection, { drill: true });
                onNavigate?.("flashcards");
              }}
              title="Study only the words in this collection (and its subcollections)"
            >
              <Sparkles className="size-4" />
              Custom study
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="size-4" />
              Add word
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowBulk(true)}>
              <Sparkles className="size-4" />
              Bulk add
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onRename} title="Rename">
              <Pencil className="size-3.5" />
            </Button>
            {!collection.isDefault && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void onDelete()}
                title="Delete collection"
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Sub-collection picker. Only rendered when the active
            collection has direct children — otherwise a parent like
            "HSK 3" with no sub-lists shouldn't waste a row on an
            empty pill bar. "All" pulls the union from the whole
            subtree (root + descendants); the per-child pills narrow
            down to that one list. */}
        {children.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <SubPill
              label="All"
              active={subActiveId === null}
              onClick={() => onPickSub(null)}
            />
            {children.map((child) => {
              // A chapter collection's presetId is
              // `${packId}:${textbookId}:${position}` — the trailing
              // segment is the 0-indexed chapter position. Compare
              // it to the parent textbook's `completedUnits` (which
              // points at the lesson the user is currently working
              // through — completedUnits = N means N lessons are
              // done, lesson N is the next one) to decide whether
              // to ring this pill.
              const parts = child.presetId?.split(":") ?? [];
              const childPos =
                parts.length === 3 && /^\d+$/.test(parts[2])
                  ? Number(parts[2])
                  : null;
              const isCurrent =
                activeTextbook != null &&
                childPos != null &&
                childPos === activeTextbook.completedUnits;
              return (
                <SubPill
                  key={child.id}
                  label={child.name}
                  count={child.wordCount ?? 0}
                  active={subActiveId === child.id}
                  current={isCurrent}
                  onClick={() => onPickSub(child.id)}
                />
              );
            })}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search this list…"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className="h-9 pl-9"
            />
          </div>
          <span className="text-[12px] text-muted-foreground">
            {allWords.length} word{allWords.length === 1 ? "" : "s"}
            {search && ` · ${words.length} match${words.length === 1 ? "" : "es"}`}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading…
          </div>
        ) : words.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              {allWords.length === 0
                ? "No words yet. Add some via the buttons above, or save words from chat / dictionary search."
                : "No matches for your search."}
            </p>
          </div>
        ) : (
          <ul className="grid gap-1.5">
            {words.map((w) => (
              <li
                key={w.id}
                className="group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
              >
                <span className="font-serif text-[18px]">{w.word}</span>
                {w.reading && <Pinyin raw={w.reading} className="text-[12px]" />}
                <span className="ml-auto truncate text-[12.5px] text-muted-foreground">
                  {w.gloss}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={async () => {
                    await removeWordFromCollection(collection.id, w.id);
                    await onRefresh();
                  }}
                  title="Remove from collection"
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AddWordDialog
        open={showAdd}
        collection={collection}
        onClose={() => setShowAdd(false)}
        onAdded={async () => {
          setShowAdd(false);
          await onRefresh();
        }}
      />

      <BulkAddDialog
        open={showBulk}
        collection={collection}
        onClose={() => setShowBulk(false)}
        onAdded={async () => {
          setShowBulk(false);
          await onRefresh();
        }}
        workspaceId={workspace?.id ?? 0}
      />
    </div>
  );
}

function NewCollectionDialog({
  open,
  onClose,
  onCreated,
  collections,
  defaultParentId = null,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
  /** All collections in the workspace, used to populate the parent picker. */
  collections: Collection[];
  /** When opened from a row's "Add subcollection" action, pre-select that
   *  parent so the user doesn't have to pick. null = top-level. */
  defaultParentId?: number | null;
}) {
  const { active: workspace } = useWorkspace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentKey, setParentKey] = useState<string>(
    defaultParentId == null ? "__none__" : String(defaultParentId),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setParentKey(defaultParentId == null ? "__none__" : String(defaultParentId));
      setBusy(false);
    }
  }, [open, defaultParentId]);

  async function submit() {
    if (!workspace || !name.trim()) return;
    setBusy(true);
    try {
      const parentId = parentKey === "__none__" ? null : Number(parentKey);
      const c = await createCollection({
        workspaceId: workspace.id,
        name: name.trim(),
        description: description.trim() || null,
        parentId,
      });
      toast.success(`Created "${c.name}"`);
      onCreated(c.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New collection</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="coll-name">Name</Label>
            <Input
              id="coll-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. HSK 3, Genki Lesson 5, Travel words"
              autoFocus
              disabled={busy}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="coll-desc">Description (optional)</Label>
            <Input
              id="coll-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A short note for yourself"
              disabled={busy}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="coll-parent">Parent collection (optional)</Label>
            <select
              id="coll-parent"
              value={parentKey}
              onChange={(e) => setParentKey(e.target.value)}
              disabled={busy}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-[13px]"
            >
              <option value="__none__">— Top level —</option>
              {collections.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Nest under another collection to build a tree (e.g. "HSK 3 →
              Lesson 1"). "Custom study" on the parent will drill every
              subcollection's words at once.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  collection,
  onClose,
  onSaved,
}: {
  collection: Collection | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (collection) {
      setName(collection.name);
      setDescription(collection.description ?? "");
    }
  }, [collection]);

  if (!collection) return null;

  async function save() {
    setBusy(true);
    try {
      await renameCollection(collection!.id, {
        name: name.trim() || collection!.name,
        description: description.trim() || null,
      });
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename collection</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </div>
          <div className="grid gap-1.5">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddWordDialog({
  open,
  collection,
  onClose,
  onAdded,
}: {
  open: boolean;
  collection: Collection;
  onClose: () => void;
  onAdded: () => void | Promise<void>;
}) {
  const { active: workspace } = useWorkspace();
  const [word, setWord] = useState("");
  const [reading, setReading] = useState("");
  const [gloss, setGloss] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setWord("");
      setReading("");
      setGloss("");
      setBusy(false);
    }
  }, [open]);

  async function add() {
    if (!workspace || !word.trim()) return;
    setBusy(true);
    try {
      await addWordToCollection({
        workspaceId: workspace.id,
        collectionId: collection.id,
        word: word.trim(),
        reading: reading.trim() || null,
        gloss: gloss.trim() || null,
      });
      toast.success(`Added "${word.trim()}"`);
      await onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add word to {collection.name}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label>Word</Label>
            <Input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              placeholder="你好 / こんにちは / Apfel"
              autoFocus
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && word.trim()) {
                  e.preventDefault();
                  void add();
                }
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Reading (optional)</Label>
            <Input
              value={reading}
              onChange={(e) => setReading(e.target.value)}
              placeholder="nǐ hǎo / こんにちは"
              disabled={busy}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Definition (optional)</Label>
            <Input
              value={gloss}
              onChange={(e) => setGloss(e.target.value)}
              placeholder="hello"
              disabled={busy}
            />
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            Adding a word here also saves it to your vocabulary, so it shows up in
            flashcard review.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={add} disabled={busy || !word.trim()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkAddDialog({
  open,
  collection,
  workspaceId,
  onClose,
  onAdded,
}: {
  open: boolean;
  collection: Collection;
  workspaceId: number;
  onClose: () => void;
  onAdded: () => void | Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setText("");
      setBusy(false);
    }
  }, [open]);

  async function importNow() {
    setBusy(true);
    try {
      const words = parseLines(text);
      if (words.length === 0) {
        toast.error("No valid lines to import.");
        return;
      }
      const result = await bulkAddToCollection({
        workspaceId,
        collectionId: collection.id,
        words,
      });
      toast.success(
        `Added ${result.added} word${result.added === 1 ? "" : "s"}` +
          (result.skipped ? ` · skipped ${result.skipped}` : ""),
      );
      await onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk add to {collection.name}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <p className="text-[12.5px] text-muted-foreground">
            One word per line. Use commas / tabs to separate <code>word</code>,{" "}
            <code>reading</code>, <code>gloss</code>:
          </p>
          <Textarea
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`你好, nǐ hǎo, hello\n谢谢, xiè xie, thanks\n再见, zài jiàn, goodbye`}
            className="font-mono text-[13px]"
            disabled={busy}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={importNow} disabled={busy || !text.trim()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Sort the sub-collection picker pills.
 *
 *  Pack chapter collections carry their position as the trailing
 *  segment of `presetId` (`packId:textbookId:position`). When that's
 *  available we sort numerically by position so "Lesson 1" comes
 *  before "Lesson 2" before "Lesson 10" — beats the default insertion
 *  order, which has been observed to land as 6→15 then 1→2 on
 *  re-imports / partial pack updates.
 *
 *  When the position isn't parseable (user-made sub-collections,
 *  imported lists without a numeric position) we fall back to a
 *  natural-key locale compare so "Lesson 2" still sorts before
 *  "Lesson 10" without us having to hand-craft a regex. */
function sortChildrenForPicker(rows: Collection[]): Collection[] {
  const withPos = rows.map((c) => {
    const parts = c.presetId?.split(":") ?? [];
    const pos =
      parts.length === 3 && /^\d+$/.test(parts[2])
        ? Number(parts[2])
        : null;
    return { c, pos };
  });
  return withPos
    .sort((a, b) => {
      if (a.pos != null && b.pos != null) return a.pos - b.pos;
      if (a.pos != null) return -1;
      if (b.pos != null) return 1;
      return a.c.name.localeCompare(b.c.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    })
    .map((x) => x.c);
}

function parseLines(text: string): { word: string; reading?: string; gloss?: string }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const cols = line.split(/[,\t]\s*/).map((c) => c.trim());
      if (cols.length === 1) return { word: cols[0] };
      if (cols.length === 2) return { word: cols[0], gloss: cols[1] };
      return { word: cols[0], reading: cols[1], gloss: cols.slice(2).join(", ") };
    })
    .filter((r) => r.word.length > 0);
}

/**
 * Flat sidebar list — top-level ("main") collections only. Sub-lists
 * surface inside the detail page via the SubPill row, so the sidebar
 * stays a clean outline of the workspace's main study sets. Each row
 * shows the collection's total word count (sum across the whole
 * subtree) so the user can see breadth at a glance, plus a small
 * "n sublists" hint when the parent has children — that's the cue
 * to drill in.
 */
function RootCollectionList({
  collections,
  activeId,
  onPick,
  textbookByPresetId,
}: {
  collections: Collection[];
  activeId: number | null;
  onPick: (id: number) => void;
  /** Map from textbook-root collection presetId → library item.
   *  Used to decorate the row with an "Active" badge when the
   *  matching textbook is the workspace's currently-active one. */
  textbookByPresetId: Map<string, LibraryItem>;
}) {
  const childCounts = new Map<number, number>();
  // Sum the descendants per root so each row can advertise its
  // sub-list count. We also pre-compute a subtree word total because
  // the per-row Collection.wordCount only reflects words directly
  // attached to that row, not the descendants.
  const subtreeWords = new Map<number, number>();
  const childrenByParent = new Map<number, Collection[]>();
  for (const c of collections) {
    if (c.parentId === null) continue;
    const arr = childrenByParent.get(c.parentId) ?? [];
    arr.push(c);
    childrenByParent.set(c.parentId, arr);
  }
  function walk(id: number): { kids: number; words: number } {
    const direct = childrenByParent.get(id) ?? [];
    let kids = direct.length;
    let words = 0;
    for (const child of direct) {
      const inner = walk(child.id);
      kids += inner.kids;
      words += (child.wordCount ?? 0) + inner.words;
    }
    return { kids, words };
  }
  const roots = collections.filter((c) => c.parentId === null);
  for (const r of roots) {
    const w = walk(r.id);
    childCounts.set(r.id, w.kids);
    subtreeWords.set(r.id, (r.wordCount ?? 0) + w.words);
  }
  return (
    <ul className="space-y-0.5">
      {roots.map((c) => {
        const subKids = childCounts.get(c.id) ?? 0;
        const totalWords = subtreeWords.get(c.id) ?? c.wordCount ?? 0;
        const active = activeId === c.id;
        // A textbook root collection (created during pack import)
        // links 1:1 to a library_item via its presetId. If that
        // item's status is "active", this is the user's currently-
        // selected textbook — surface the fact with a blue chip so
        // the right collection is obvious at a glance.
        const tb = c.presetId ? textbookByPresetId.get(c.presetId) : undefined;
        const isActiveTextbook = tb?.status === "active";
        return (
          <li key={c.id}>
            <button
              onClick={() => onPick(c.id)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                active ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{c.name}</span>
                  {isActiveTextbook && (
                    <Badge
                      variant="outline"
                      className="h-4 gap-1 border-sky-500/60 bg-sky-500/10 px-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300"
                      title="This is your currently active textbook"
                    >
                      <span className="size-1.5 rounded-full bg-sky-500" />
                      active
                    </Badge>
                  )}
                  {c.isDefault && (
                    <Badge variant="secondary" className="h-4 text-[9.5px]">
                      default
                    </Badge>
                  )}
                  {c.source === "preset" && !isActiveTextbook && (
                    <Badge variant="outline" className="h-4 text-[9.5px]">
                      pack
                    </Badge>
                  )}
                </div>
                {subKids > 0 ? (
                  <div className="text-[11px] text-muted-foreground">
                    {subKids} sublist{subKids === 1 ? "" : "s"}
                  </div>
                ) : c.description ? (
                  <div className="truncate text-[11px] text-muted-foreground">
                    {c.description}
                  </div>
                ) : null}
              </div>
              <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                {totalWords}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Pill button used by the detail page's sub-collection picker.
 *
 *  `current` adds a green ring around the pill — used to mark the
 *  textbook's current lesson regardless of whether the user has
 *  selected it. The ring sits OUTSIDE the pill border (`ring-offset-1`)
 *  so it stays visible on both the un-selected card-coloured pill
 *  and the selected foreground-coloured one. */
function SubPill({
  label,
  count,
  active,
  current,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  current?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={current ? `${label} — your current lesson` : label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
        active
          ? "border-foreground/40 bg-foreground text-background"
          : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
        current &&
          "ring-2 ring-emerald-500/70 ring-offset-1 ring-offset-background",
      )}
    >
      <span className="truncate max-w-[180px]">{label}</span>
      {count != null && (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
            active ? "bg-background/15" : "bg-muted/60",
          )}
        >
          {count}
        </span>
      )}
      {current && (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider",
            active
              ? "bg-emerald-400/30 text-emerald-100"
              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
          )}
        >
          current
        </span>
      )}
    </button>
  );
}

