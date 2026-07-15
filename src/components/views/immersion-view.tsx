/**
 * Immersion — the watch/listen shelf.
 *
 * A lens over `library_items` (NOT a separate table — see
 * src/lib/media/kinds.ts for the split): videos, series, and podcasts
 * with progress, rendered as status sections rather than a filtered
 * grid. "Continue watching" is what you reach for, "Up next" is the
 * queue you built, history sits below.
 *
 * Progress arrives three ways and all of them bypass this React tree:
 * the Companion extension and MCP agents write through the local
 * api_server (`/v1/media/*`, its own SQLite connection), and sync v2
 * writes through the raw engine. Hence the focus/interval refetch —
 * a watched minute on YouTube shows up here without a reload.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clapperboard,
  Clock,
  ExternalLink,
  Film,
  Mic,
  Package,
  Play,
  Plus,
  Search,
  Trash2,
  Tv,
  X,
} from "lucide-react";
import { toast } from "sonner";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ItemStatusMenu, Stepper } from "@/components/library-item-controls";
import { PackImportDialog } from "@/components/pack-import-dialog";
import {
  bumpLibrary,
  deleteLibraryItem,
  listLibrary,
  listSessions,
  saveLibraryItem,
  setLibraryStatus,
  type LibraryItem,
  type LibraryStatus,
  type StudySession,
} from "@/lib/db";
import {
  isMediaKind,
  MEDIA_DEFAULT_UNIT,
  MEDIA_KIND_LABEL,
  MEDIA_KINDS,
  type MediaKind,
} from "@/lib/media/kinds";
import { groupMedia, mediaPercent, minutesTracked } from "@/lib/media/order";
import { probeMediaUrl } from "@/lib/media/probe";
import { formatWatchTime, watchTimeTotals } from "@/lib/media/stats";
import {
  mediaThumbnail,
  mediaUrlsMatch,
  mediaUrlWithResume,
  parseMediaUrl,
} from "@/lib/media/url";
import { isMinutesUnit, singularUnitLabel } from "@/lib/library-units";
import { useCloudRefresh } from "@/lib/cloud-refresh";
import { setWorkspaceFocus } from "@/lib/focus";
import { openExternalUrl } from "@/lib/open-url";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";

const MEDIA_KIND_ICON: Record<MediaKind, React.ComponentType<{ className?: string }>> = {
  video: Film,
  series: Tv,
  podcast: Mic,
};

/** How often a mounted, visible Immersion view re-reads the list so
 *  extension-reported progress appears while you watch. */
const LIVE_REFRESH_MS = 20_000;

export function ImmersionView() {
  const { active: workspace } = useWorkspace();
  // null = not-yet-loaded: the empty state must not flash before the
  // first read resolves.
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [kindFilter, setKindFilter] = useState<MediaKind | "all">("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<LibraryItem | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LibraryItem | null>(null);
  const [showDropped, setShowDropped] = useState(false);
  const [showPack, setShowPack] = useState(false);

  const refreshRef = useRef<() => Promise<void>>(async () => {});
  async function refresh() {
    if (!workspace) return;
    const [all, sessionRows] = await Promise.all([
      listLibrary(workspace.id),
      listSessions(workspace.id),
    ]);
    setItems(all.filter((i) => isMediaKind(i.kind)));
    setSessions(sessionRows);
  }
  refreshRef.current = refresh;

  useEffect(() => {
    setItems(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Out-of-band writers (extension beats, MCP, sync pulls) don't
  // notify this tree — refetch when the window comes back and on a
  // slow tick while visible. Cheap: a workspace's media list is tens
  // of rows.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void refreshRef.current();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(onVisible, LIVE_REFRESH_MS);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, []);
  useCloudRefresh(refresh);

  const visible = useMemo(
    () => (items ?? []).filter((i) => kindFilter === "all" || i.kind === kindFilter),
    [items, kindFilter],
  );
  const groups = useMemo(() => groupMedia(visible), [visible]);

  // Searching flips the sections into one flat result list (every
  // status, dropped included) so "where was I on that video?" is a
  // single lookup — each hit renders the full card with its progress.
  const trimmedQuery = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!trimmedQuery) return null;
    return visible
      .filter(
        (i) =>
          i.title.toLowerCase().includes(trimmedQuery) ||
          (i.author ?? "").toLowerCase().includes(trimmedQuery),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [visible, trimmedQuery]);

  if (!workspace) return null;

  async function applyStatus(item: LibraryItem, status: LibraryStatus) {
    if (status === item.status) return;
    await setLibraryStatus(item.id, status);
    await refresh();
  }

  /** Open externally + tell the chat what's on. Opening something from
   *  the queue means you're watching it now, so planned flips to active
   *  without a separate step. Minute-tracked items resume where the
   *  progress left off (`&t=` on YouTube) instead of starting over —
   *  a finished item is a rewatch and opens from the top. */
  async function openItem(item: LibraryItem) {
    if (!item.source) return;
    const resumeSec =
      item.status !== "finished" && isMinutesUnit(item.unitLabel) && item.completedUnits > 0
        ? item.completedUnits * 60
        : null;
    await openExternalUrl(mediaUrlWithResume(item.source, resumeSec));
    void setWorkspaceFocus({
      workspaceId: workspace!.id,
      libraryItemId: item.id,
      chapterId: null,
      readerDocId: null,
    }).catch(() => {});
    if (item.status === "planned") await applyStatus(item, "active");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 pt-8 pb-5">
        <div className="mx-auto flex max-w-4xl xl:max-w-6xl 2xl:max-w-7xl items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-3xl tracking-tight">Immersion</h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              Shows, videos, podcasts — queue what you want to watch, open it
              with one click, and let the Companion extension log your progress.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Packs can ship watch recommendations (media entries) —
                same import dialog the Library uses; imported items
                land in the Up next queue below. */}
            <Button variant="outline" onClick={() => setShowPack(true)}>
              <Package className="size-4" />
              Packs
            </Button>
            <Button onClick={() => setEditing("new")}>
              <Plus className="size-4" />
              Add media
            </Button>
          </div>
        </div>

        <div className="mx-auto mt-5 flex max-w-4xl xl:max-w-6xl 2xl:max-w-7xl flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1 rounded-full border border-border bg-card p-1 w-fit">
            {(["all", ...MEDIA_KINDS] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKindFilter(k)}
                className={cn(
                  "rounded-full px-3 py-1 text-[12.5px] transition-colors",
                  kindFilter === k
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {k === "all" ? "All" : `${MEDIA_KIND_LABEL[k]}s`}
              </button>
            ))}
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search titles and channels…"
              aria-label="Search your immersion library"
              className="h-8 pl-8 pr-8 text-[12.5px]"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                title="Clear search"
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-4xl xl:max-w-6xl 2xl:max-w-7xl">
          {items === null ? null : (
            <div className="flex flex-col gap-6">
              {items.length > 0 && (
                <StatsStrip sessions={sessions} groups={groups} />
              )}
              {results !== null ? (
                results.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    No matches for “{query.trim()}”.
                  </p>
                ) : (
                  <Section title={`Results · ${results.length}`} items={results}>
                    {(it) => card(it)}
                  </Section>
                )
              ) : visible.length === 0 ? (
                <EmptyState onAdd={() => setEditing("new")} hasItems={items.length > 0} />
              ) : (
                <div className="flex flex-col gap-8">
                  <Section title="Continue watching" items={groups.watching}>
                    {(it) => card(it)}
                  </Section>
                  <Section title="Up next" items={groups.upNext}>
                    {(it) => card(it)}
                  </Section>
                  <Section title="Finished" items={groups.finished}>
                    {(it) => card(it)}
                  </Section>
                  {groups.dropped.length > 0 && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setShowDropped((v) => !v)}
                        className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {showDropped
                          ? "Hide dropped"
                          : `Show ${groups.dropped.length} dropped`}
                      </button>
                      {showDropped && (
                        <ul className="mt-3 grid gap-3 md:grid-cols-2">
                          {groups.dropped.map((it) => card(it))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <MediaEditor
        open={editing != null}
        item={editing === "new" ? null : editing}
        existing={items ?? []}
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

      <AlertDialog open={confirmDelete != null} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{confirmDelete?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the item and its tracked progress. Logged immersion
              time in your statistics is unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!confirmDelete) return;
                await deleteLibraryItem(confirmDelete.id);
                setConfirmDelete(null);
                await refresh();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  function card(item: LibraryItem) {
    return (
      <MediaCard
        key={item.id}
        item={item}
        onOpen={() => void openItem(item)}
        onEdit={() => setEditing(item)}
        onDelete={() => setConfirmDelete(item)}
        onBump={async (units, seconds) => {
          await bumpLibrary(item.id, units, seconds);
          await refresh();
        }}
        applyStatus={(s) => void applyStatus(item, s)}
      />
    );
  }
}

/** The extension library page's stat strip, desktop edition: session
 *  watch/listen time (today / week / all-time) plus the queue shape. */
function StatsStrip({
  sessions,
  groups,
}: {
  sessions: StudySession[];
  groups: ReturnType<typeof groupMedia>;
}) {
  const totals = useMemo(() => watchTimeTotals(sessions, Date.now()), [sessions]);
  const tiles: Array<{ label: string; value: string; sub?: string }> = [
    { label: "Today", value: formatWatchTime(totals.todaySecs) },
    { label: "This week", value: formatWatchTime(totals.weekSecs) },
    { label: "All time", value: formatWatchTime(totals.totalSecs) },
    {
      label: "Queue",
      value: String(groups.watching.length + groups.upNext.length),
      sub: `${groups.watching.length} watching · ${groups.upNext.length} up next · ${groups.finished.length} done`,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-2xl border border-border bg-card p-4">
          <div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {t.label}
          </div>
          <div className="mt-1 flex items-baseline gap-1.5 font-serif text-2xl tracking-tight">
            {!t.sub && <Clock className="size-4 self-center text-muted-foreground" aria-hidden />}
            <span className="tabular-nums">{t.value}</span>
          </div>
          {t.sub && (
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={t.sub}>
              {t.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Section({
  title,
  items,
  children,
}: {
  title: string;
  items: LibraryItem[];
  children: (item: LibraryItem) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="flex items-baseline gap-2 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
        <span className="tabular-nums">{items.length}</span>
      </h2>
      <ul className="mt-3 grid gap-3 md:grid-cols-2">{items.map(children)}</ul>
    </section>
  );
}

function MediaCard({
  item,
  onOpen,
  onEdit,
  onDelete,
  onBump,
  applyStatus,
}: {
  item: LibraryItem;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onBump: (units: number, seconds: number) => void;
  applyStatus: (status: LibraryStatus) => void;
}) {
  const kind = item.kind as MediaKind;
  const Icon = MEDIA_KIND_ICON[kind] ?? Film;
  const parsed = useMemo(
    () => (item.source ? parseMediaUrl(item.source) : null),
    [item.source],
  );
  // A stored cover always wins; otherwise derive the provider poster
  // from the link (YouTube's CDN scheme — see mediaThumbnail).
  const thumb = useMemo(
    () => item.coverUrl ?? (item.source ? mediaThumbnail(item.source) : null),
    [item.coverUrl, item.source],
  );
  const pct = mediaPercent(item);
  const minutes = minutesTracked(item);
  const minutesUnit = isMinutesUnit(item.unitLabel);
  const started = item.completedUnits > 0 || item.totalSeconds > 0;
  const watchLabel =
    item.status === "finished" ? "Rewatch" : started ? "Continue" : "Start watching";

  return (
    <li className="group flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 transition-shadow hover:shadow-sm">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => parsed && onOpen()}
          disabled={!parsed}
          title={parsed ? "Open in your browser" : undefined}
          className={cn(
            "relative h-[81px] w-36 shrink-0 overflow-hidden rounded-lg bg-muted",
            parsed && "cursor-pointer",
          )}
        >
          {thumb ? (
            <img
              src={thumb}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              onError={(e) => {
                // Dead poster (video removed, provider change) — fall
                // back to the kind tile instead of a broken image.
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : null}
          <span
            className={cn(
              "absolute inset-0 flex items-center justify-center text-muted-foreground",
              thumb && "opacity-0",
            )}
          >
            <Icon className="size-6" />
          </span>
          {parsed && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/25 group-hover:opacity-100">
              <span className="flex size-9 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm">
                <Play className="ml-0.5 size-4" />
              </span>
            </span>
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {MEDIA_KIND_LABEL[kind] ?? item.kind}
            </Badge>
            {parsed && (
              <Badge variant="ghost" className="px-0 text-[10px] text-muted-foreground">
                {parsed.providerLabel}
              </Badge>
            )}
            <ItemStatusMenu status={item.status} applyStatus={applyStatus} />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              title="Delete from Immersion"
              aria-label={`Delete ${item.title}`}
              className="ml-auto size-6 text-muted-foreground/60 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          <h3
            className={cn(
              "mt-1 line-clamp-2 font-serif text-[15px] leading-snug",
              parsed && "cursor-pointer hover:underline underline-offset-2",
            )}
            onClick={() => parsed && onOpen()}
            title={item.title}
          >
            {item.title}
          </h3>
          {item.author && (
            <p className="truncate text-[12px] text-muted-foreground">{item.author}</p>
          )}
          {pct != null ? (
            <div className="mt-1.5">
              <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
                <span>
                  {item.completedUnits} / {item.totalUnits} {item.unitLabel}
                  {minutes > 0 && !minutesUnit && <> · {minutes} min</>}
                </span>
                <span className="tabular-nums">{Math.round(pct)}%</span>
              </div>
              <Progress className="mt-1 h-1.5" value={pct} />
            </div>
          ) : (
            <div className="mt-1.5 text-[11px] text-muted-foreground">
              {item.completedUnits > 0 && (
                <>
                  {item.completedUnits} {item.unitLabel} ·{" "}
                </>
              )}
              {minutes > 0 ? `${minutes} min logged` : "not started"}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {minutesUnit ? (
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
        <div className="ml-auto flex items-center gap-1">
          {parsed && (
            <Button
              variant="outline"
              size="sm"
              onClick={onOpen}
              className="h-7 px-2.5 text-[12px]"
              title="Open in your browser"
            >
              <ExternalLink className="size-3" />
              {watchLabel}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onEdit} className="h-7 px-2 text-[12px]">
            Edit
          </Button>
        </div>
      </div>
    </li>
  );
}

function EmptyState({ onAdd, hasItems }: { onAdd: () => void; hasItems: boolean }) {
  if (hasItems) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nothing of this kind yet.
      </p>
    );
  }
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
      <Clapperboard className="mx-auto mb-3 size-7 text-muted-foreground" />
      <h3 className="font-serif text-2xl tracking-tight">Build your immersion queue.</h3>
      <p className="mx-auto mt-2 max-w-md text-[13.5px] text-muted-foreground">
        Paste a YouTube, Netflix, or podcast link to queue it here. Open items
        with one click — and with the Companion extension installed, your watch
        progress and immersion minutes track themselves.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={onAdd}>
          <Plus className="size-4" />
          Add your first
        </Button>
      </div>
    </div>
  );
}

function MediaEditor({
  open,
  item,
  existing,
  workspaceId,
  onClose,
  onSaved,
}: {
  open: boolean;
  item: LibraryItem | null;
  /** Current media list, for duplicate-URL detection on create. */
  existing: LibraryItem[];
  workspaceId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<MediaKind>("video");
  // Once the user picks a kind by hand, URL autodetection stops
  // second-guessing them.
  const [kindTouched, setKindTouched] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [totalUnits, setTotalUnits] = useState("");
  const [status, setStatus] = useState<LibraryStatus>("planned");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (item) {
      setUrl(item.source ?? "");
      setKind(isMediaKind(item.kind) ? item.kind : "video");
      setTitle(item.title);
      setAuthor(item.author ?? "");
      setTotalUnits(item.totalUnits != null ? String(item.totalUnits) : "");
      setStatus(item.status);
    } else {
      setUrl("");
      setKind("video");
      setTitle("");
      setAuthor("");
      setTotalUnits("");
      setStatus("planned");
    }
    setKindTouched(false);
  }, [open, item]);

  const parsed = useMemo(() => (url.trim() ? parseMediaUrl(url) : null), [url]);

  useEffect(() => {
    if (!item && !kindTouched && parsed) setKind(parsed.suggestedKind);
  }, [parsed, item, kindTouched]);

  // Autofill from the link (create flow only): title + channel via
  // oEmbed, video length via the page. Debounced per canonical key,
  // and only ever fills fields the user hasn't typed — a probe must
  // never clobber manual input that landed while it was in flight.
  const [probing, setProbing] = useState(false);
  useEffect(() => {
    if (item || !parsed) return;
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setProbing(true);
      const meta = await probeMediaUrl(url.trim());
      if (cancelled) return;
      setProbing(false);
      if (!meta) return;
      if (meta.title) setTitle((t) => (t.trim() ? t : meta.title!));
      if (meta.author) setAuthor((a) => (a.trim() ? a : meta.author!));
      if (meta.durationSecs && meta.durationSecs > 0) {
        const minutes = String(Math.ceil(meta.durationSecs / 60));
        setTotalUnits((v) => (v.trim() ? v : minutes));
      }
    }, 400);
    return () => {
      cancelled = true;
      setProbing(false);
      window.clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed?.key, item]);

  async function save() {
    if (!title.trim()) return;
    const cleanUrl = url.trim() || null;
    if (!item && cleanUrl) {
      const dupe = existing.find((e) => mediaUrlsMatch(e.source, cleanUrl));
      if (dupe) {
        toast.info(`Already in your list as "${dupe.title}"`);
        onClose();
        return;
      }
    }
    setBusy(true);
    try {
      await saveLibraryItem({
        id: item?.id,
        workspaceId,
        kind,
        title: title.trim(),
        author: author.trim() || null,
        source: cleanUrl,
        totalUnits: totalUnits ? Number(totalUnits) : null,
        // Media units are fixed per kind (minutes vs episodes); only a
        // kind change rewrites a pre-existing label.
        unitLabel: item && item.kind === kind ? item.unitLabel : MEDIA_DEFAULT_UNIT[kind],
        status,
        completedUnits: item?.completedUnits,
        totalSeconds: item?.totalSeconds,
        coverUrl: item?.coverUrl,
        notes: item?.notes,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  const totalLabel = kind === "video" ? "Length in minutes (optional)" : "Total episodes (optional)";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{item ? "Edit media" : "Add to immersion"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="media-url">Link (optional)</Label>
            <Input
              id="media-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste a YouTube, Netflix, Spotify … link"
            />
            {parsed && (
              <p className="text-[11.5px] text-muted-foreground">
                {parsed.providerLabel} · opens in your browser
                {probing
                  ? " · fetching details…"
                  : !item
                    ? " · progress tracks automatically with the extension"
                    : ""}
              </p>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="media-kind">Kind</Label>
              <Select
                value={kind}
                onValueChange={(v) => {
                  setKind(v as MediaKind);
                  setKindTouched(true);
                }}
              >
                <SelectTrigger id="media-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEDIA_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {MEDIA_KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="media-status">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as LibraryStatus)}>
                <SelectTrigger id="media-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="planned">Planned</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="finished">Finished</SelectItem>
                  <SelectItem value="dropped">Dropped</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="media-title">Title</Label>
            <Input id="media-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="media-author">Channel / creator (optional)</Label>
              <Input id="media-author" value={author} onChange={(e) => setAuthor(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="media-total">{totalLabel}</Label>
              <Input
                id="media-total"
                inputMode="numeric"
                value={totalUnits}
                onChange={(e) => setTotalUnits(e.target.value)}
                placeholder={kind === "video" ? "e.g. 43" : "e.g. 12"}
              />
            </div>
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
