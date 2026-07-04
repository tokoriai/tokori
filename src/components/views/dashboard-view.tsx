import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BookMarked,
  BookOpenText,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flame,
  GraduationCap,
  GripVertical,
  Headphones,
  LayoutDashboard,
  Layers,
  Maximize2,
  Pencil,
  Plus,
  RotateCcw,
  StickyNote,
  Target,
  X,
} from "lucide-react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { levelsFor, levelsForScale, type LevelInfo } from "@/lib/level";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LevelScaleChoice } from "@/lib/profile-context";
import {
  listChapters,
  listCollections,
  listDueVocab,
  listLibrary,
  listNotes,
  listSessions,
  listVocab,
  listWorkspaceReviews,
  updateChapter,
  type Collection,
  type LibraryChapter,
  type LibraryItem,
  type Note,
  type StudySession,
  type VocabEntry,
  type VocabReview,
} from "@/lib/db";
import { useChapterAdvanceFlow } from "@/components/chapter-advance-flow";
import { useCloudRefresh } from "@/lib/cloud-refresh";
import {
  importerLabelsForLanguage,
  joinImporterLabels,
} from "@/lib/vocab-import/registry";
import { useHasDictionary } from "@/lib/dict-availability";
import { computeStreak } from "@/lib/streak";
import { buildStudySessionQueue, useStudyConfig } from "@/lib/study-config";
import { computeLevel, scaleFor, scaleLabel } from "@/lib/level";
import type { LanguageCode } from "@/lib/languages";
import { useWorkspace } from "@/lib/workspace-context";
import { useProfile } from "@/lib/profile-context";
import { helloFor, languageName, languageNative } from "@/lib/languages";
import { cn } from "@/lib/utils";
import {
  ConsistencyHeatmap,
  SkillsRadar,
  VocabGrowthChart,
} from "@/components/dashboard/charts";
import { GoalsCard } from "@/components/dashboard/goals-card";
import { JourneyCard } from "@/components/dashboard/journey-card";
import { LogActivityDialog } from "@/components/dashboard/log-activity-dialog";
import { VocabImportDialog } from "@/components/vocab-import-dialog";
import { PackImportDialog } from "@/components/pack-import-dialog";
import { TrialBanner } from "@/components/trial-banner";
import type { TabId } from "@/components/shell/shell";
import {
  registerWidget,
  useWidgetRegistry,
  type WidgetContext,
  type WidgetSize,
} from "@/lib/widget-registry";
import {
  loadDashboardLayout,
  saveDashboardLayout,
  resetDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function DashboardView({ onNavigate }: { onNavigate: (t: TabId) => void }) {
  const { active: workspace } = useWorkspace();
  const { profile } = useProfile();
  // Per-workspace study config — feeds the dashboard's "X cards
  // ready" badge so it matches the flashcards picker (both apply
  // dailyReviewLimit + dailyNewLimit). useStudyConfig short-circuits
  // when workspace is null, returning defaults; we still pass an
  // explicit fallback so the hook order is stable across renders.
  const studyCfg = useStudyConfig(
    workspace?.id ?? 0,
    workspace?.targetLang ?? "en",
  );
  const [vocab, setVocab] = useState<VocabEntry[]>([]);
  const [due, setDue] = useState<VocabEntry[]>([]);
  const [sessions, setSessions] = useState<StudySession[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  // Workspace-wide review history. Powers the SRS-aware vocab growth
  // chart (replays each review event forward to compute per-day
  // counts of known/learning/leech words). Loaded lazily once on
  // workspace change since the chart's the only consumer.
  const [reviews, setReviews] = useState<VocabReview[]>([]);
  const [showLogActivity, setShowLogActivity] = useState(false);
  // Hosted at the dashboard level so any widget (currently just the
  // vocab-growth empty state) can summon the importer through the
  // shared WidgetContext without each widget mounting its own dialog.
  const [showImportVocab, setShowImportVocab] = useState(false);
  const [showRedeemPack, setShowRedeemPack] = useState(false);
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const [editMode, setEditMode] = useState(false);
  // Pull the live registry so widgets registered after mount (e.g. by
  // a future plugin loader) show up in the picker without a reload.
  const widgets = useWidgetRegistry();

  async function refreshAll() {
    if (!workspace) return;
    const [v, d, s, l, n, r] = await Promise.all([
      listVocab(workspace.id),
      listDueVocab(workspace.id, 200),
      listSessions(workspace.id),
      listLibrary(workspace.id),
      listNotes(workspace.id),
      listWorkspaceReviews(workspace.id),
    ]);
    setVocab(v);
    setDue(d);
    setSessions(s);
    setLibrary(l);
    setNotes(n);
    setReviews(r);
  }

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void (async () => {
      const [v, d, s, l, n, r, layoutRow] = await Promise.all([
        listVocab(workspace.id),
        listDueVocab(workspace.id, 200),
        listSessions(workspace.id),
        listLibrary(workspace.id),
        listNotes(workspace.id),
        listWorkspaceReviews(workspace.id),
        loadDashboardLayout(workspace.id),
      ]);
      if (cancelled) return;
      setVocab(v);
      setDue(d);
      setSessions(s);
      setLibrary(l);
      setNotes(n);
      setReviews(r);
      setLayout(layoutRow);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  // Cross-device refresh. When another install pushes new data to
  // the same cloud account, the auto-sync hook (or a manual
  // "Refresh" tap) fires a `tokori:cloud-refresh` event; we re-run
  // `refreshAll` so dashboard widgets reflect the latest cloud
  // state without a page reload.
  useCloudRefresh(refreshAll);

  if (!workspace || !layout) return null;

  // Localised greeting in the workspace's target language. A Japanese
  // workspace says "こんにちは, Flo" instead of "Welcome back, Flo".
  // `helloFor()` falls back to "Hello" on unknown languages, so this
  // never breaks if a new language is added before its profile is
  // filled in.
  const hello = helloFor(workspace.targetLang);
  const greeting = profile.name ? `${hello}, ${profile.name}.` : `${hello}.`;

  // The dashboard badge is the daily-*paced* count: due reviews + new
  // cards up to the daily limits. It's a glanceable "what's on the plate
  // today" nudge, so it stays capped even though the flashcard prestart
  // picker now offers the full uncapped ready pool ("All N") — the picker
  // is where you deliberately decide to grind the whole backlog.
  const sessionQueue = buildStudySessionQueue(due, vocab, studyCfg.config);

  const ctx: WidgetContext = {
    workspace,
    vocab,
    sessions,
    library,
    notes,
    due,
    sessionQueue,
    reviews,
    onNavigate,
    refresh: refreshAll,
    openLogActivity: () => setShowLogActivity(true),
    openImportVocab: () => setShowImportVocab(true),
    openRedeemPack: () => setShowRedeemPack(true),
  };

  function persistLayout(next: DashboardLayout) {
    setLayout(next);
    if (workspace) void saveDashboardLayout(workspace.id, next);
  }

  function moveWidget(activeId: string, overId: string) {
    if (!layout || activeId === overId) return;
    const oldIdx = layout.slots.findIndex((s) => s.widgetId === activeId);
    const newIdx = layout.slots.findIndex((s) => s.widgetId === overId);
    if (oldIdx === -1 || newIdx === -1) return;
    persistLayout({
      ...layout,
      slots: arrayMove(layout.slots, oldIdx, newIdx),
    });
  }

  // Common sizes the resize handle cycles through. Plugins can store
  // arbitrary 1–12 values, but the handle picks tasteful defaults.
  const SIZE_CYCLE: WidgetSize[] = [3, 4, 6, 8, 12];

  function resizeWidget(widgetId: string) {
    if (!layout) return;
    persistLayout({
      ...layout,
      slots: layout.slots.map((s) => {
        if (s.widgetId !== widgetId) return s;
        const idx = SIZE_CYCLE.indexOf(s.size);
        const next = SIZE_CYCLE[(idx === -1 ? 0 : idx + 1) % SIZE_CYCLE.length];
        return { ...s, size: next };
      }),
    });
  }

  function removeWidget(widgetId: string) {
    if (!layout) return;
    persistLayout({
      ...layout,
      slots: layout.slots.filter((s) => s.widgetId !== widgetId),
    });
  }

  function addWidget(widgetId: string) {
    if (!layout) return;
    if (layout.slots.some((s) => s.widgetId === widgetId)) return;
    const def = widgets.find((w) => w.id === widgetId);
    persistLayout({
      ...layout,
      slots: [
        ...layout.slots,
        { widgetId, size: def?.defaultSize ?? 1 },
      ],
    });
  }

  async function resetLayout() {
    if (!workspace) return;
    await resetDashboardLayout(workspace.id);
    const fresh = await loadDashboardLayout(workspace.id);
    setLayout(fresh);
  }

  // Drop slots whose widgets aren't in the registry (a plugin was
  // uninstalled, or the user is on a build without a known widget).
  // Keeps the dashboard rendering instead of erroring.
  const renderableSlots = layout.slots.filter((s) =>
    widgets.some((w) => w.id === s.widgetId),
  );
  const availableToAdd = widgets.filter(
    (w) => !layout.slots.some((s) => s.widgetId === w.id),
  );

  return (
    <>
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-4xl xl:max-w-6xl 2xl:max-w-7xl space-y-8">
        {/* Trial banner — hosted-only, hidden once dismissed for the
            current trial window, hidden for paid Pro and free users.
            Lives above the page header so it's the first thing a
            trial user sees on every dashboard load. */}
        <TrialBanner />

        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
              {languageName(workspace.targetLang)} · {languageNative(workspace.targetLang)}
            </p>
            <h1 className="font-serif text-4xl tracking-tight">{greeting}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {editMode ? (
              <>
                <AddWidgetPopover
                  available={availableToAdd}
                  onAdd={addWidget}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void resetLayout()}
                  title="Reset to default layout"
                >
                  <RotateCcw className="size-3.5" />
                  Reset
                </Button>
                <Button size="sm" onClick={() => setEditMode(false)}>
                  <Check className="size-3.5" />
                  Done
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditMode(true)}
                title="Customise dashboard layout"
              >
                <LayoutDashboard className="size-3.5" />
                Edit dashboard
              </Button>
            )}
          </div>
        </div>

        <DashboardGrid
          slots={renderableSlots}
          editMode={editMode}
          ctx={ctx}
          onMove={moveWidget}
          onResize={resizeWidget}
          onRemove={removeWidget}
        />
      </div>
    </div>
    <LogActivityDialog
      open={showLogActivity}
      onClose={() => setShowLogActivity(false)}
      onLogged={() => void refreshAll()}
    />
    <VocabImportDialog
      open={showImportVocab}
      onClose={() => setShowImportVocab(false)}
      onDone={async () => {
        setShowImportVocab(false);
        await refreshAll();
      }}
    />
    <PackImportDialog
      open={showRedeemPack}
      onClose={() => setShowRedeemPack(false)}
      onImported={() => {
        setShowRedeemPack(false);
        void refreshAll();
      }}
    />
    </>
  );
}

function DashboardGrid({
  slots,
  editMode,
  ctx,
  onMove,
  onResize,
  onRemove,
}: {
  slots: { widgetId: string; size: WidgetSize }[];
  editMode: boolean;
  ctx: WidgetContext;
  onMove: (activeId: string, overId: string) => void;
  onResize: (widgetId: string) => void;
  onRemove: (widgetId: string) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(e: DragEndEvent) {
    if (!e.over) return;
    if (e.active.id !== e.over.id) {
      onMove(String(e.active.id), String(e.over.id));
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={slots.map((s) => s.widgetId)}
        strategy={rectSortingStrategy}
      >
        {/* 12-col grid so widgets can divide cleanly into thirds (4),
            quarters (3), halves (6), or full width (12). Default
            stretch alignment keeps every widget in a row at the same
            height as the tallest in that row. */}
        <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-12">
          {slots.map((slot) => (
            <SortableWidget
              key={slot.widgetId}
              slot={slot}
              editMode={editMode}
              ctx={ctx}
              onResize={onResize}
              onRemove={onRemove}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableWidget({
  slot,
  editMode,
  ctx,
  onResize,
  onRemove,
}: {
  slot: { widgetId: string; size: WidgetSize };
  editMode: boolean;
  ctx: WidgetContext;
  onResize: (widgetId: string) => void;
  onRemove: (widgetId: string) => void;
}) {
  const def = useWidgetRegistry().find((w) => w.id === slot.widgetId);
  const sortable = useSortable({ id: slot.widgetId });
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
    isSorting,
  } = sortable;
  // Clamp to the 1–12 grid even if a plugin wrote an out-of-range
  // size. Below the lg breakpoint we render single-column anyway, so
  // the span value only matters at lg+.
  const span = Math.max(1, Math.min(12, Math.round(slot.size)));
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    gridColumn: `span ${span} / span ${span}`,
    // Lift the dragged widget above its neighbours so the ring + shadow
    // don't get clipped by the next grid cell.
    zIndex: isDragging ? 30 : isOver ? 20 : "auto",
  };
  if (!def) return null;
  const removable = def.removable !== false;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative h-full min-w-0 rounded-2xl",
        // Edit-mode passive ring so the user sees the rearrangable cells.
        editMode &&
          !isDragging &&
          "ring-2 ring-foreground/10 ring-offset-2 ring-offset-background transition-shadow hover:ring-foreground/30",
        // Active drag: strong primary outline + shadow so the moving
        // tile reads as "this is what I'm picking up". Slight scale
        // gives it a tactile lift.
        isDragging &&
          "z-30 scale-[1.02] cursor-grabbing rounded-2xl shadow-2xl ring-2 ring-foreground ring-offset-2 ring-offset-background",
        // Drop-target hint: dashed accent ring on whichever cell the
        // pointer is currently over.
        isOver &&
          !isDragging &&
          "ring-2 ring-foreground/60 ring-offset-2 ring-offset-background",
      )}
    >
      {/* h-full so the widget fills the grid cell — combined with
          the grid's stretch alignment, every widget in a row matches
          the tallest one's height. The wrapped div also gets a soft
          fade while a sibling is being dragged so the hovered drop-
          target stands out from the rest. */}
      <div
        className={cn(
          "h-full transition-opacity",
          isSorting && !isDragging && !isOver && "opacity-60",
          isDragging && "opacity-90",
        )}
      >
        <def.Component ctx={ctx} />
      </div>
      {editMode && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full border border-border bg-card/95 px-1 py-1 shadow-sm backdrop-blur">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="flex size-6 cursor-grab items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
            title="Drag to reorder"
            aria-label="Drag widget"
          >
            <GripVertical className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onResize(slot.widgetId)}
            className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            title={`Width: ${slot.size}/12 — click to resize`}
            aria-label="Resize widget"
          >
            <Maximize2 className="size-3.5" />
          </button>
          {removable && (
            <button
              type="button"
              onClick={() => onRemove(slot.widgetId)}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="Remove from dashboard"
              aria-label="Remove widget"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AddWidgetPopover({
  available,
  onAdd,
}: {
  available: { id: string; title: string; description?: string; category: string }[];
  onAdd: (id: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={available.length === 0}>
          <Plus className="size-3.5" />
          Add widget
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-1">
        {available.length === 0 ? (
          <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">
            All widgets are already on your dashboard.
          </p>
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto">
            {available.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => onAdd(w.id)}
                  className="flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent"
                >
                  <span className="text-[13px] font-medium">{w.title}</span>
                  {w.description && (
                    <span className="text-[11.5px] text-muted-foreground">
                      {w.description}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function LevelWidget({ ctx }: { ctx: WidgetContext }) {
  const { profile, update: updateProfile } = useProfile();
  const stats = useDashboardStats(ctx);
  return (
    <LevelCard
      level={stats.level}
      lang={ctx.workspace.targetLang}
      goalLevelId={profile.goalLevel}
      onGoalChange={(id) => void updateProfile({ goalLevel: id })}
      manualLevelId={profile.manualLevelId}
      manualScore={profile.manualScore}
      onManualLevelChange={(id) => void updateProfile({ manualLevelId: id })}
      onManualScoreChange={(n) => void updateProfile({ manualScore: n })}
      scaleChoice={profile.levelScale}
      customScale={profile.customScale}
      onScaleChange={(choice, custom) =>
        void updateProfile({
          levelScale: choice,
          customScale: custom ?? null,
          manualLevelId: null,
        })
      }
    />
  );
}

function KpiStreakWidget({ ctx }: { ctx: WidgetContext }) {
  const stats = useDashboardStats(ctx);
  return (
    <Kpi
      icon={<Flame className="size-4" />}
      label="Day streak"
      value={String(stats.streak)}
      accent="bg-orange-500/10 text-orange-600 dark:text-orange-400"
    />
  );
}

function KpiWordsWidget({ ctx }: { ctx: WidgetContext }) {
  const stats = useDashboardStats(ctx);
  return (
    <Kpi
      icon={<BookMarked className="size-4" />}
      label="Words known"
      value={String(stats.wordsKnown)}
    />
  );
}

function KpiImmersionWidget({ ctx }: { ctx: WidgetContext }) {
  const stats = useDashboardStats(ctx);
  return (
    <Kpi
      icon={<Clock className="size-4" />}
      label="Immersion"
      value={`${stats.hours.toFixed(1)}h`}
    />
  );
}

function useSessionStats(sessions: StudySession[]) {
  return useMemo(() => {
    const now = Date.now();
    const day = 86_400_000;
    // Local-midnight cut for "today" — using a rolling 24h window
    // would call a session at 11pm yesterday "today's", which is not
    // what users mean by "immersion today".
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const totalSecs = sessions.reduce((s, x) => s + (x.durationSecs ?? 0), 0);
    const weekSecs = sessions
      .filter((x) => x.startedAt * 1000 >= now - 7 * day)
      .reduce((s, x) => s + (x.durationSecs ?? 0), 0);
    const monthSecs = sessions
      .filter((x) => x.startedAt * 1000 >= now - 30 * day)
      .reduce((s, x) => s + (x.durationSecs ?? 0), 0);
    const todaySecs = sessions
      .filter((x) => x.startedAt * 1000 >= todayMs)
      .reduce((s, x) => s + (x.durationSecs ?? 0), 0);
    const dailyAvgMin = monthSecs / 30 / 60;
    const longestMin = sessions.reduce(
      (m, x) => Math.max(m, (x.durationSecs ?? 0) / 60),
      0,
    );
    return {
      totalH: totalSecs / 3600,
      weekH: weekSecs / 3600,
      todayMin: todaySecs / 60,
      dailyAvgMin,
      longestMin,
      sessionsCount: sessions.length,
    };
  }, [sessions]);
}

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-4 py-3.5">
      <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-2xl font-semibold tracking-tight">
        {value}
      </div>
      <div className="mt-auto pt-1 text-[10.5px] text-muted-foreground">
        {sub}
      </div>
    </div>
  );
}

function StatTotalWidget({ ctx }: { ctx: WidgetContext }) {
  const s = useSessionStats(ctx.sessions);
  return (
    <StatTile
      label="Total"
      value={s.totalH < 1 ? `${Math.round(s.totalH * 60)}m` : `${s.totalH.toFixed(1)}h`}
      sub={`${s.sessionsCount} sessions`}
    />
  );
}

function StatWeekWidget({ ctx }: { ctx: WidgetContext }) {
  const s = useSessionStats(ctx.sessions);
  return (
    <StatTile
      label="This week"
      value={s.weekH < 1 ? `${Math.round(s.weekH * 60)}m` : `${s.weekH.toFixed(1)}h`}
      sub="last 7 days"
    />
  );
}

function StatDailyAvgWidget({ ctx }: { ctx: WidgetContext }) {
  const s = useSessionStats(ctx.sessions);
  return (
    <StatTile
      label="Daily avg"
      value={`${Math.round(s.dailyAvgMin)}m`}
      sub="last 30 days"
    />
  );
}

function StatLongestWidget({ ctx }: { ctx: WidgetContext }) {
  const s = useSessionStats(ctx.sessions);
  return (
    <StatTile
      label="Longest"
      value={`${Math.round(s.longestMin)}m`}
      sub="single session"
    />
  );
}

function StatTodayWidget({ ctx }: { ctx: WidgetContext }) {
  const s = useSessionStats(ctx.sessions);
  // Show in minutes under an hour, hours over — matches the rest of
  // the stats row's display convention.
  const value =
    s.todayMin < 60
      ? `${Math.round(s.todayMin)}m`
      : `${(s.todayMin / 60).toFixed(1)}h`;
  return <StatTile label="Today" value={value} sub="immersion so far" />;
}

function QuickActionsWidget({ ctx }: { ctx: WidgetContext }) {
  // Split the waiting work into real "due" (cards already in the SRS
  // ladder whose interval has elapsed) and "new" (cards never seen
  // before). The session queue is capped by the workspace's daily
  // new-card / review limits, which made the badge silently read
  // "20 due now" after every pack import — the cap masked the real
  // backlog AND mislabelled fresh cards as "due". Counting from the
  // unfiltered `due` array keeps the badge honest; the study session
  // itself still respects the daily caps when the user opens it.
  const dueNow = ctx.due.filter((v) => v.status !== "new").length;
  const newWaiting = ctx.due.filter((v) => v.status === "new").length;
  const waitingTotal = dueNow + newWaiting;
  const waitingSub =
    waitingTotal === 0
      ? "Nothing due — keep saving from chat"
      : dueNow > 0 && newWaiting > 0
        ? `${dueNow} due · ${newWaiting} new`
        : dueNow > 0
          ? `${dueNow} due now`
          : `${newWaiting} new to learn`;
  return (
    <div className="grid h-full grid-cols-1 gap-3 sm:grid-cols-3">
      <ActionCard
        onClick={() => ctx.onNavigate("flashcards")}
        icon={<Layers className="size-5" />}
        title="Review flashcards"
        sub={waitingSub}
        highlight={waitingTotal > 0}
      />
      <ActionCard
        onClick={() => ctx.onNavigate("chat")}
        icon={<BookOpenText className="size-5" />}
        title="Start a chat"
        sub="Talk to your tutor in target language"
      />
      <ActionCard
        onClick={() => ctx.openLogActivity()}
        icon={<Headphones className="size-5" />}
        title="Log activity"
        sub="Tutor, class, immersion, podcast…"
      />
    </div>
  );
}

function VocabGrowthWidget({ ctx }: { ctx: WidgetContext }) {
  // Pass `onSearchDictionary` only when the workspace's target
  // language has a real (entry-bearing) dictionary installed. The
  // hook returns null while resolving — we treat that as "not yet
  // known" and withhold the link, matching the shell-level
  // MissingDictionaryBanner's logic so the two never disagree.
  const hasDict = useHasDictionary(ctx.workspace.targetLang);
  const importerNames = joinImporterLabels(
    importerLabelsForLanguage(ctx.workspace.targetLang),
  );
  return (
    <VocabGrowthChart
      vocab={ctx.vocab}
      reviews={ctx.reviews}
      onImportVocab={ctx.openImportVocab}
      onRedeemPack={ctx.openRedeemPack}
      onSearchDictionary={
        hasDict === true ? () => ctx.onNavigate("dictionaries") : undefined
      }
      importerNames={importerNames}
    />
  );
}

function SkillsRadarWidget({ ctx }: { ctx: WidgetContext }) {
  return <SkillsRadar sessions={ctx.sessions} />;
}

function GoalsWidget({ ctx }: { ctx: WidgetContext }) {
  return <GoalsCard vocab={ctx.vocab} sessions={ctx.sessions} />;
}

function TextbookWidget({ ctx }: { ctx: WidgetContext }) {
  const activeTextbook = useMemo(() => {
    const tb = ctx.library
      .filter((l) => l.kind === "textbook" && l.status === "active")
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return tb[0] ?? null;
  }, [ctx.library]);
  const [chapters, setChapters] = useState<LibraryChapter[]>([]);
  // The advance-flow hook needs the workspace's collections to look
  // up wordCount + name when rendering the modals. We fetch them
  // alongside chapters so the dashboard's "mark done" surface gets
  // the same vocab-aware behaviour as the Library page.
  const [collections, setCollections] = useState<Collection[]>([]);
  useEffect(() => {
    if (!activeTextbook) {
      setChapters([]);
      return;
    }
    let cancelled = false;
    void listChapters(activeTextbook.id).then((c) => {
      if (!cancelled) setChapters(c);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTextbook?.id]);
  useEffect(() => {
    let cancelled = false;
    void listCollections(ctx.workspace.id).then((c) => {
      if (!cancelled) setCollections(c);
    });
    return () => {
      cancelled = true;
    };
  }, [ctx.workspace.id]);
  if (!activeTextbook) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/50 px-5 py-6 text-center">
        <GraduationCap className="mx-auto mb-2 size-5 text-muted-foreground" />
        <p className="text-[13px] font-medium">No active textbook</p>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          Mark a textbook as active in the Library to track chapters here.
        </p>
      </div>
    );
  }
  return (
    <TextbookCard
      textbook={activeTextbook}
      chapters={chapters}
      collections={collections}
      onNavigate={ctx.onNavigate}
      onChange={async () => {
        const next = await listChapters(activeTextbook.id);
        setChapters(next);
      }}
      onOpen={() => ctx.onNavigate("library")}
    />
  );
}

function ConsistencyHeatmapWidget({ ctx }: { ctx: WidgetContext }) {
  return <ConsistencyHeatmap sessions={ctx.sessions} />;
}

function LibraryListWidget({ ctx }: { ctx: WidgetContext }) {
  const activeLib = ctx.library.filter((l) => l.status === "active").slice(0, 3);
  return (
    <SectionCard
      title="Reading & immersion"
      cta="Open library"
      onCta={() => ctx.onNavigate("library")}
    >
      {activeLib.length === 0 ? (
        <Empty
          icon={<BookOpenText className="size-5" />}
          title="No active books"
          desc="Track books, textbooks, videos, and articles you're working through."
        />
      ) : (
        <ul className="space-y-2">
          {activeLib.map((it) => (
            <li
              key={it.id}
              className="rounded-lg border border-border bg-card px-3 py-2"
            >
              <div className="flex items-center justify-between text-[13.5px]">
                <span className="font-medium truncate">{it.title}</span>
                <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                  {it.kind}
                </span>
              </div>
              {it.totalUnits ? (
                <>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      {it.completedUnits} / {it.totalUnits} {it.unitLabel}
                    </span>
                    <span>
                      {Math.round((it.completedUnits / it.totalUnits) * 100)}%
                    </span>
                  </div>
                  <Progress
                    className="mt-1 h-1"
                    value={(it.completedUnits / it.totalUnits) * 100}
                  />
                </>
              ) : (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {Math.round(it.totalSeconds / 60)} minutes logged
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function NotesListWidget({ ctx }: { ctx: WidgetContext }) {
  return (
    <SectionCard
      title="Notes"
      cta="Open notes"
      onCta={() => ctx.onNavigate("notes")}
    >
      {ctx.notes.length === 0 ? (
        <Empty
          icon={<StickyNote className="size-5" />}
          title="No notes yet"
          desc="Capture grammar finds, drills, mnemonics. Markdown supported."
        />
      ) : (
        <ul className="space-y-1">
          {ctx.notes.slice(0, 4).map((n) => (
            <li
              key={n.id}
              className="truncate rounded-md px-2 py-1.5 text-[13.5px] hover:bg-accent/40"
            >
              <span className="font-medium">{n.title}</span>
              <span className="ml-2 text-[12px] text-muted-foreground">
                {new Date(n.updatedAt * 1000).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function RecentActivitiesWidget({ ctx }: { ctx: WidgetContext }) {
  return (
    <RecentActivitiesCard
      sessions={ctx.sessions}
      onExpand={() => ctx.onNavigate("activities")}
      onLog={() => ctx.openLogActivity()}
    />
  );
}

function useDashboardStats(ctx: WidgetContext) {
  const { profile } = useProfile();
  return useMemo(() => {
    const wordsKnown = ctx.vocab.filter((v) => v.status === "mastered").length;
    const seconds = ctx.sessions.reduce(
      (sum, s) => sum + (s.durationSecs ?? 0),
      0,
    );
    const hours = seconds / 3600;
    const streak = computeStreak(ctx.sessions);
    const level = computeLevel(
      ctx.workspace.targetLang,
      wordsKnown,
      hours,
      profile.goalLevel,
      {
        manualLevelId: profile.manualLevelId,
        manualScore: profile.manualScore,
        scale: profile.levelScale === "auto" ? null : profile.levelScale,
        customLevels: profile.customScale,
      },
    );
    return { wordsKnown, hours, streak, level };
  }, [
    ctx.vocab,
    ctx.sessions,
    ctx.workspace.targetLang,
    profile.goalLevel,
    profile.manualLevelId,
    profile.manualScore,
    profile.levelScale,
    profile.customScale,
  ]);
}

// Built-in widgets register themselves at module load. Plugins follow the
// same pattern from their own modules.
registerWidget({
  id: "level-card",
  title: "Level & progress",
  description: "Your estimated level on the active scale plus a progress bar to the next rung.",
  category: "stats",
  defaultSize: 9,
  Component: LevelWidget,
  source: "built-in",
});

// Learning journey — current → target level on the chosen scale,
// derived milestones, AI coach nudge. Sized at 6 cols so it pairs
// naturally with another half-width widget (skills-radar, goals, etc).
registerWidget({
  id: "journey-card",
  title: "Learning journey",
  description: "Progress toward your target level + an AI nudge for what to do next.",
  category: "study",
  defaultSize: 6,
  Component: JourneyCard,
  source: "built-in",
});

// KPI tiles — three tiny independent widgets sized to slot in
// alongside the level-card (9 + 1 + 1 + 1 = 12).
registerWidget({
  id: "kpi-streak",
  title: "Day streak",
  description: "Consecutive days with at least one logged study session.",
  category: "stats",
  defaultSize: 1,
  Component: KpiStreakWidget,
  source: "built-in",
});

registerWidget({
  id: "kpi-words",
  title: "Words known",
  description: "Vocabulary count promoted to mastered via SRS.",
  category: "stats",
  defaultSize: 1,
  Component: KpiWordsWidget,
  source: "built-in",
});

registerWidget({
  id: "kpi-immersion",
  title: "Immersion hours",
  description: "Total time logged across all study sessions.",
  category: "stats",
  defaultSize: 1,
  Component: KpiImmersionWidget,
  source: "built-in",
});

// Stats tiles — four independent widgets so each one can be hidden,
// resized, or moved on its own.
registerWidget({
  id: "stat-total",
  title: "Total study time",
  description: "Cumulative study time across every session (lifetime workspace total).",
  category: "stats",
  defaultSize: 3,
  Component: StatTotalWidget,
  source: "built-in",
});

registerWidget({
  id: "stat-week",
  title: "This week",
  description: "Hours studied in the last 7 days.",
  category: "stats",
  defaultSize: 3,
  Component: StatWeekWidget,
  source: "built-in",
});

registerWidget({
  id: "stat-daily-avg",
  title: "Daily average",
  description: "Minutes per day, averaged over the last 30 days.",
  category: "stats",
  defaultSize: 3,
  Component: StatDailyAvgWidget,
  source: "built-in",
});

registerWidget({
  id: "stat-longest",
  title: "Longest session",
  description: "The longest single study session on record.",
  category: "stats",
  defaultSize: 3,
  Component: StatLongestWidget,
  source: "built-in",
});

registerWidget({
  id: "stat-today",
  title: "Today",
  description: "Immersion minutes (or hours) logged since local midnight.",
  category: "stats",
  defaultSize: 3,
  Component: StatTodayWidget,
  source: "built-in",
});

// Quick actions — bundled as one widget so the three buttons read as
// a single "what should I do next" panel. Defaults to full width;
// drop to 6 if you want it side-by-side with another widget.
registerWidget({
  id: "quick-actions",
  title: "Quick actions",
  description: "Bundled review-flashcards / start-a-chat / log-activity buttons.",
  category: "actions",
  defaultSize: 12,
  Component: QuickActionsWidget,
  source: "built-in",
});

registerWidget({
  id: "vocab-growth",
  title: "Vocab growth",
  description: "Line chart of words known + learning over time.",
  category: "stats",
  defaultSize: 8,
  Component: VocabGrowthWidget,
  source: "built-in",
});

registerWidget({
  id: "skills-radar",
  title: "Skills balance",
  description: "Radar chart of how time is split across reading / speaking / listening / writing.",
  category: "stats",
  defaultSize: 4,
  Component: SkillsRadarWidget,
  source: "built-in",
});

registerWidget({
  id: "goals",
  title: "Goals",
  description: "Active goals with progress bars; the user can edit / complete from the card.",
  category: "study",
  defaultSize: 8,
  Component: GoalsWidget,
  source: "built-in",
});

registerWidget({
  id: "textbook",
  title: "Active textbook",
  description: "Current chapter of the workspace's active textbook with a 'mark done' shortcut.",
  category: "study",
  defaultSize: 4,
  Component: TextbookWidget,
  source: "built-in",
});

registerWidget({
  id: "consistency-heatmap",
  title: "Consistency heatmap",
  description: "GitHub-style year heatmap of study sessions.",
  category: "stats",
  defaultSize: 12,
  Component: ConsistencyHeatmapWidget,
  source: "built-in",
});

registerWidget({
  id: "library-list",
  title: "Reading & immersion",
  description: "Top 3 active books / videos / articles with progress.",
  category: "library",
  defaultSize: 8,
  Component: LibraryListWidget,
  source: "built-in",
});

registerWidget({
  id: "notes-list",
  title: "Recent notes",
  description: "Newest 4 notes with date stamps; click 'Open notes' to jump.",
  category: "library",
  defaultSize: 4,
  Component: NotesListWidget,
  source: "built-in",
});

registerWidget({
  id: "recent-activities",
  title: "Recent activity",
  description: "Last 4 logged sessions (off-app practice) plus today's total.",
  category: "library",
  defaultSize: 12,
  Component: RecentActivitiesWidget,
  source: "built-in",
});

function TextbookCard({
  textbook,
  chapters,
  collections,
  onChange,
  onOpen,
  onNavigate,
}: {
  textbook: LibraryItem;
  chapters: LibraryChapter[];
  collections: Collection[];
  onChange: () => void | Promise<void>;
  onOpen: () => void;
  onNavigate?: (tab: TabId) => void;
}) {
  // "Current chapter" derivation — two signals, falling back.
  //
  // Primary: count of chapters with `completedAt` set. This is the
  // authoritative "user has marked these done" signal — set by both
  // the manual "Mark done" flow (chapter-advance-flow) AND by the
  // pack importer in "previous-known" mode.
  //
  // Fallback: `textbook.completedUnits` from the library_item row.
  // The importer writes this directly from the "I'm on chapter N"
  // picker even when individual chapter rows don't have completedAt
  // (e.g. workspaces imported BEFORE the chapter-stamping fix landed).
  // Without this fallback the dashboard sticks on chapter 1 for any
  // pre-fix import and the user can't get unstuck without
  // re-importing.
  //
  // We don't max the two: once the user has started managing chapter
  // completion in the UI, the per-chapter signal is the truth — even
  // if they walk it back. completedUnits is a one-time seed from
  // import, nothing keeps it in sync afterwards.
  const sorted = useMemo(
    () => [...chapters].sort((a, b) => a.position - b.position),
    [chapters],
  );
  const total = sorted.length;
  const fromCompletedAt = sorted.filter((c) => c.completedAt != null).length;
  const completed =
    fromCompletedAt > 0
      ? fromCompletedAt
      : Math.min(total, textbook.completedUnits ?? 0);
  const currentIdx = total === 0 ? -1 : Math.min(completed, total - 1);
  const current = currentIdx >= 0 ? sorted[currentIdx] ?? null : null;
  const allDone = total > 0 && completed === total;
  const advanceFlow = useChapterAdvanceFlow({
    itemId: textbook.id,
    collections,
    isTextbook: true,
    onNavigate,
    onChange,
  });

  // One-time drift repair. When `completedUnits` says N but fewer
  // chapter rows have `completedAt`, backfill the earlier chapters'
  // timestamps so the two signals agree. This fires for workspaces
  // imported BEFORE the pack-import "previous-known" stamping fix
  // landed — without it, marking the next chapter done from the
  // dashboard makes the current-chapter pointer jump backwards
  // (since the post-mark fromCompletedAt count is suddenly the only
  // signal and it's much smaller than completedUnits). Idempotent;
  // re-renders after a successful backfill find nothing to do.
  useEffect(() => {
    if (sorted.length === 0) return;
    const have = sorted.filter((c) => c.completedAt != null).length;
    const want = Math.min(sorted.length, textbook.completedUnits ?? 0);
    if (want <= have) return;
    const toFill = sorted
      .slice(0, want)
      .filter((c) => c.completedAt == null);
    if (toFill.length === 0) return;
    const ts = Math.floor(Date.now() / 1000);
    void Promise.all(
      toFill.map((c) => updateChapter(c.id, { completedAt: ts })),
    )
      .then(() => onChange())
      .catch((err) => console.warn("[dashboard] chapter backfill failed", err));
  }, [sorted, textbook.completedUnits, onChange]);

  function markDone() {
    advanceFlow.startAdvance(current);
  }
  async function goPrev() {
    // Step back: uncomplete the most recently completed chapter so it becomes current.
    const lastCompleted = [...sorted]
      .reverse()
      .find((c) => c.completedAt != null);
    if (!lastCompleted) return;
    await updateChapter(lastCompleted.id, { completedAt: null });
    await onChange();
  }

  if (sorted.length === 0) {
    return (
      <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <GraduationCap className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                Textbook
              </p>
              <p className="truncate text-[14px] font-medium">{textbook.title}</p>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={onOpen} className="h-7 px-2 text-[12px]">
            Add chapters
            <ArrowRight className="size-3" />
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-muted-foreground">
          Open the library to add chapters and track progress here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-5 py-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/10 text-foreground">
            <GraduationCap className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              Now studying · textbook
            </p>
            <h3 className="truncate font-serif text-lg leading-tight tracking-tight">
              {textbook.title}
            </h3>
            {textbook.author && (
              <p className="truncate text-[11.5px] text-muted-foreground">
                {textbook.author}
              </p>
            )}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onOpen} className="h-7 shrink-0 px-2 text-[12px]">
          Open
          <ArrowRight className="size-3" />
        </Button>
      </div>

      {/* Current chapter */}
      <div className="mt-4 rounded-xl border border-border bg-background/40 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              {allDone ? "Finished" : `Chapter ${currentIdx + 1} of ${total}`}
            </p>
            <p className="truncate text-[14px] font-medium">
              {current?.title ?? "—"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void goPrev()}
              disabled={completed === 0}
              title="Previous chapter (un-complete the last one)"
            >
              <ChevronLeft className="size-4" />
            </Button>
            {/* Always-available custom-study trigger. Renders only when
                the current chapter has a linked collection — and stays
                visible after the textbook is fully complete (the
                Mark-done button is replaced by a Complete pill at that
                point, but a learner usually still wants to re-drill
                the current chapter's words). */}
            {(() => {
              const linked = current?.collectionId
                ? collections.find((x) => x.id === current.collectionId)
                : null;
              if (!linked || (linked.wordCount ?? 0) === 0) return null;
              return (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() =>
                    advanceFlow.launchCustomStudy(linked, { drill: true })
                  }
                  title={`Custom study — drill the words in "${linked.name}"`}
                >
                  <GraduationCap className="size-4" />
                </Button>
              );
            })()}
            {allDone ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-[11.5px] font-medium text-emerald-700 dark:text-emerald-400">
                <Check className="size-3.5" /> Complete
              </span>
            ) : (
              <Button size="sm" onClick={markDone} className="h-8 px-2.5 text-[12px]">
                <Check className="size-3.5" />
                Mark done
                <ChevronRight className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-[11.5px] text-muted-foreground">
        <span>
          {completed} / {total} chapters · {Math.round((completed / total) * 100)}%
        </span>
        {!allDone && currentIdx + 1 < total && sorted[currentIdx + 1] && (
          <span className="truncate text-right text-[11px] opacity-80">
            Next: {sorted[currentIdx + 1].title}
          </span>
        )}
      </div>
      <Progress className="mt-1 h-1" value={(completed / total) * 100} />
      {advanceFlow.dialogs}
    </div>
  );
}

function LevelCard({
  level,
  lang,
  goalLevelId,
  onGoalChange,
  manualLevelId,
  manualScore,
  onManualLevelChange,
  onManualScoreChange,
  scaleChoice,
  customScale,
  onScaleChange,
}: {
  level: ReturnType<typeof computeLevel>;
  lang: LanguageCode;
  goalLevelId: string | null;
  onGoalChange: (id: string | null) => void;
  manualLevelId: string | null;
  manualScore: number | null;
  onManualLevelChange: (id: string | null) => void;
  onManualScoreChange: (score: number | null) => void;
  scaleChoice: LevelScaleChoice;
  customScale: LevelInfo[] | null;
  onScaleChange: (choice: LevelScaleChoice, custom?: LevelInfo[] | null) => void;
}) {
  const goalSet = level.goal !== level.next && level.goal !== level.current;
  const showProgress = goalSet ? level.goalProgress : level.progress;
  // Render the active scale's levels in the manual-level + goal
  // selectors, not the language's default — otherwise picking "HSK"
  // on a German workspace would still show CEFR options.
  const allLevels =
    scaleChoice === "custom" && customScale && customScale.length > 0
      ? customScale
      : scaleChoice === "auto"
        ? levelsFor(lang)
        : levelsForScale(scaleChoice, customScale ?? undefined);
  const [scaleEditorOpen, setScaleEditorOpen] = useState(false);

  // Inline score editor state. We keep the textbox as a string while
  // the user types so backspace-to-empty doesn't fight with a numeric
  // controlled value; we parse + persist on blur / Enter.
  const [editingScore, setEditingScore] = useState(false);
  const [scoreDraft, setScoreDraft] = useState<string>("");
  const [editingLevel, setEditingLevel] = useState(false);
  function commitScore(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onManualScoreChange(null);
    } else {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n >= 0) onManualScoreChange(Math.round(n));
    }
    setEditingScore(false);
  }

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-6 py-5 shadow-sm">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <button
              type="button"
              onClick={() => setScaleEditorOpen(true)}
              className="rounded-md px-1 py-0.5 -mx-1 transition-colors hover:bg-accent/40 hover:text-foreground"
              title="Change level scale (HSK / JLPT / TOPIK / CEFR / custom)"
            >
              {scaleLabel(level.scale)}
            </button>{" "}
            ·{" "}
            {level.manualOverride ? (
              <span className="text-foreground">manual</span>
            ) : (
              "estimated"
            )}
          </p>
          {/* Current-level cell. Read-only by default; click to swap in
              a dropdown that lets the user override what the formula
              picked. "Auto" puts it back. */}
          {editingLevel ? (
            <div className="mt-1 flex items-baseline gap-3">
              <Select
                value={manualLevelId ?? "__auto__"}
                onValueChange={(v) => {
                  onManualLevelChange(v === "__auto__" ? null : v);
                  setEditingLevel(false);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="h-9 w-32 text-[15px] font-medium"
                  autoFocus
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__auto__">Auto (from score)</SelectItem>
                  {allLevels.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.id} — {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                onClick={() => setEditingLevel(false)}
                className="text-[11.5px] text-muted-foreground hover:text-foreground hover:underline"
              >
                cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditingLevel(true)}
              className="group mt-1 inline-flex items-baseline gap-3 rounded-md px-1 py-0.5 -mx-1 text-left transition-colors hover:bg-accent/40"
              title="Click to override the estimated level"
            >
              <span className="font-serif text-5xl tracking-tight">
                {level.current.id}
              </span>
              <span className="text-[13.5px] text-muted-foreground">
                {level.current.label}
              </span>
              <Pencil className="size-3 self-center text-muted-foreground/0 transition-opacity group-hover:text-muted-foreground" />
            </button>
          )}
        </div>
        <div className="space-y-1 text-right text-[12px] text-muted-foreground">
          <div className="inline-flex items-center gap-1.5">
            <Target className="size-3" />
            <Select
              value={goalLevelId ?? "__auto__"}
              onValueChange={(v) => onGoalChange(v === "__auto__" ? null : v)}
            >
              <SelectTrigger
                size="sm"
                className="h-6 border-0 bg-transparent px-1.5 text-[12px] font-medium text-foreground shadow-none focus-visible:ring-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="__auto__">Auto (next level)</SelectItem>
                {allLevels.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.id} — {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            {goalSet ? (
              <>{Math.round(level.toGoal).toLocaleString()} score to {level.goal.id}</>
            ) : level.next !== level.current ? (
              <>{Math.round(level.toNext).toLocaleString()} score to {level.next.id}</>
            ) : (
              <>Top of scale 🎉</>
            )}
          </div>
        </div>
      </div>
      <Progress className="mt-3 h-1.5" value={showProgress * 100} />

      {/* Score row: editable. Clicking the number flips it into a
          tight numeric input. Blur or Enter commits. Empty → auto. */}
      <div className="mt-2 flex items-center justify-between gap-3 text-[11.5px] text-muted-foreground">
        <p>
          Score = vocab known + 1.5 × immersion hours (capped at 1,500h).
        </p>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Score:</span>
          {editingScore ? (
            <Input
              type="number"
              min={0}
              autoFocus
              value={scoreDraft}
              onChange={(e) => setScoreDraft(e.target.value)}
              onBlur={() => commitScore(scoreDraft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitScore(scoreDraft);
                if (e.key === "Escape") setEditingScore(false);
              }}
              className="h-6 w-20 px-1.5 text-right text-[12px] tabular-nums"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setScoreDraft(
                  manualScore != null ? String(manualScore) : String(Math.round(level.score)),
                );
                setEditingScore(true);
              }}
              className="group inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 tabular-nums text-foreground transition-colors hover:bg-accent/40"
              title="Click to override the score"
            >
              {Math.round(level.score).toLocaleString()}
              <Pencil className="size-3 text-muted-foreground/0 transition-opacity group-hover:text-muted-foreground" />
            </button>
          )}
          {manualScore != null && (
            <button
              type="button"
              onClick={() => onManualScoreChange(null)}
              className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              title="Reset to auto-computed score"
            >
              auto
            </button>
          )}
        </div>
      </div>

      <ScaleEditorDialog
        open={scaleEditorOpen}
        onClose={() => setScaleEditorOpen(false)}
        lang={lang}
        scaleChoice={scaleChoice}
        customScale={customScale}
        onSave={(choice, custom) => {
          onScaleChange(choice, custom);
          setScaleEditorOpen(false);
        }}
      />
    </div>
  );
}

/** One-liner shown next to each radio in the scale picker. Auto reads
 *  the language default off `scaleLabel(scaleFor(lang))` so the hint
 *  stays accurate as new scales are added. */
function scaleOptionLabel(opt: LevelScaleChoice, lang: LanguageCode): string {
  switch (opt) {
    case "auto":
      return `Auto (matches workspace language — currently ${scaleLabel(scaleFor(lang))})`;
    case "hsk":
      return "HSK 3.0 (Chinese)";
    case "jlpt":
      return "JLPT (Japanese — N5 → N1)";
    case "topik":
      return "TOPIK (Korean — 1 → 6)";
    case "cefr":
      return "CEFR (A1 – C2)";
    case "custom":
      return "Custom — define your own rungs";
  }
}

function ScaleEditorDialog({
  open,
  onClose,
  lang,
  scaleChoice,
  customScale,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  lang: LanguageCode;
  scaleChoice: LevelScaleChoice;
  customScale: LevelInfo[] | null;
  onSave: (choice: LevelScaleChoice, custom: LevelInfo[] | null) => void;
}) {
  const [choice, setChoice] = useState<LevelScaleChoice>(scaleChoice);
  // Editable copy of the custom rows so cancelling discards changes.
  // Falls back to a sensible starting point — either the user's
  // existing custom scale, or the language's default scale, so the
  // first edit isn't from a blank slate.
  const seed = customScale && customScale.length > 0 ? customScale : levelsFor(lang);
  const [rows, setRows] = useState<LevelInfo[]>(() =>
    seed.map((l) => ({ ...l })),
  );

  // Reset local state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setChoice(scaleChoice);
      const fresh =
        customScale && customScale.length > 0 ? customScale : levelsFor(lang);
      setRows(fresh.map((l) => ({ ...l })));
    }
  }, [open, scaleChoice, customScale, lang]);

  function updateRow(i: number, patch: Partial<LevelInfo>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [
      ...prev,
      { id: `Level ${prev.length + 1}`, label: "", minVocab: prev[prev.length - 1]?.minVocab + 500 || 0 },
    ]);
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  function commit() {
    if (choice === "custom") {
      // Strip empties and ensure ascending minVocab so the level
      // computation behaves predictably.
      const cleaned = rows
        .map((r) => ({
          id: r.id.trim() || "Level",
          label: r.label.trim(),
          minVocab: Math.max(0, Math.round(Number(r.minVocab) || 0)),
        }))
        .filter((r) => r.id.length > 0)
        .sort((a, b) => a.minVocab - b.minVocab);
      if (cleaned.length === 0) {
        onSave("auto", null);
        return;
      }
      onSave("custom", cleaned);
    } else {
      // Switching to HSK / CEFR / auto — clear customScale so a
      // future "custom" reopens from the language default.
      onSave(choice, null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Level scale</DialogTitle>
          <DialogDescription>
            Pick the scale used for the dashboard's estimated level. Custom
            scales let you define your own rungs and score thresholds.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-2">
          {(["auto", "hsk", "jlpt", "topik", "cefr", "custom"] as LevelScaleChoice[]).map((opt) => (
            <label
              key={opt}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors",
                choice === opt
                  ? "border-foreground/40 bg-accent/40"
                  : "border-border hover:bg-accent/20",
              )}
            >
              <input
                type="radio"
                checked={choice === opt}
                onChange={() => setChoice(opt)}
                className="mt-0.5 h-3.5 w-3.5 accent-foreground"
              />
              <div className="flex-1">
                <p className="text-[13px] font-medium leading-tight">
                  {scaleOptionLabel(opt, lang)}
                </p>
              </div>
            </label>
          ))}
        </div>

        {choice === "custom" && (
          <div className="space-y-2 border-t border-border/60 pt-3">
            <div className="grid grid-cols-[1fr_1fr_90px_28px] items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              <span className="px-1">Name</span>
              <span className="px-1">Label</span>
              <span className="px-1 text-right">Min score</span>
              <span />
            </div>
            {rows.map((r, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_1fr_90px_28px] items-center gap-1.5"
              >
                <Input
                  value={r.id}
                  onChange={(e) => updateRow(i, { id: e.target.value })}
                  placeholder="A1"
                  className="h-8 text-[12.5px]"
                />
                <Input
                  value={r.label}
                  onChange={(e) => updateRow(i, { label: e.target.value })}
                  placeholder="Beginner"
                  className="h-8 text-[12.5px]"
                />
                <Input
                  type="number"
                  min={0}
                  value={r.minVocab}
                  onChange={(e) =>
                    updateRow(i, { minVocab: Number(e.target.value) || 0 })
                  }
                  className="h-8 text-right text-[12.5px] tabular-nums"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeRow(i)}
                  title="Remove row"
                >
                  ×
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addRow} className="w-full">
              + Add level
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Rows are auto-sorted by min score on save. Lowest threshold is
              the entry level.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={commit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col items-center justify-center gap-1.5 rounded-2xl border border-border bg-card px-3 py-4 text-center">
      <div
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md",
          accent ?? "bg-muted text-muted-foreground",
        )}
      >
        {icon}
      </div>
      <div className="text-3xl font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      {/* Label wraps instead of truncating — even at the wider 3/12
          slot we keep it short, but legacy callers / smaller layouts
          may still squeeze the label. */}
      <div className="text-[11px] font-medium uppercase tracking-wide leading-tight text-muted-foreground">
        {label}
      </div>
      {sub && (
        <div className="text-[10px] text-muted-foreground/80">{sub}</div>
      )}
    </div>
  );
}

function ActionCard({
  icon,
  title,
  sub,
  onClick,
  highlight = false,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
  highlight?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex h-full items-center justify-between gap-4 rounded-2xl border bg-card px-5 py-4 text-left transition-all hover:shadow-sm",
        highlight ? "border-foreground/30" : "border-border",
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "flex size-9 items-center justify-center rounded-lg",
            highlight ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
          )}
        >
          {icon}
        </div>
        <div>
          <div className="font-medium">{title}</div>
          <div className="text-[12px] text-muted-foreground">{sub}</div>
        </div>
      </div>
      <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function SectionCard({
  title,
  cta,
  onCta,
  children,
}: {
  title: string;
  cta?: string;
  onCta?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-5 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {cta && (
          <Button size="sm" variant="ghost" onClick={onCta} className="h-7 px-2 text-[12px]">
            {cta}
            <ArrowRight className="size-3" />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function Empty({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-background/50 px-4 py-6 text-center">
      <div className="mx-auto mb-2 inline-flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </div>
      <p className="text-[13px] font-medium">{title}</p>
      <p className="mx-auto mt-0.5 max-w-xs text-[11.5px] text-muted-foreground">{desc}</p>
    </div>
  );
}

function RecentActivitiesCard({
  sessions,
  onExpand,
  onLog,
}: {
  sessions: StudySession[];
  onExpand: () => void;
  onLog: () => void;
}) {
  const recent = useMemo(() => {
    return sessions
      .filter((s) => s.notes !== null && s.endedAt != null)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, 4);
  }, [sessions]);

  if (recent.length === 0) return null;

  const totalToday = sessions
    .filter((s) => s.notes !== null && s.endedAt != null && isToday(s.endedAt!))
    .reduce((acc, s) => acc + Math.round((s.durationSecs ?? 0) / 60), 0);

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-5 py-4">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Recent activity</h3>
          <p className="text-[11.5px] text-muted-foreground">
            {totalToday > 0
              ? `${totalToday} min logged today`
              : "Off-app practice you've logged"}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onExpand} className="h-7 px-2 text-[12px]">
          View all
          <ArrowRight className="size-3" />
        </Button>
      </div>
      <ul className="grid gap-1.5">
        {recent.map((s) => (
          <DashboardActivityRow key={s.id} session={s} />
        ))}
      </ul>
      <div className="mt-3 flex justify-end">
        <Button variant="outline" size="sm" onClick={onLog} className="h-7 px-2 text-[12px]">
          + Log another
        </Button>
      </div>
    </div>
  );
}

function DashboardActivityRow({ session }: { session: StudySession }) {
  const customName = session.notes?.trim() || null;
  const label = customName ?? activityKindLabel(session.kind);
  const minutes = Math.max(1, Math.round((session.durationSecs ?? 0) / 60));
  const ts = session.endedAt ?? session.startedAt;
  const dateLabel = formatRelativeShort(ts);
  return (
    <li className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-1.5 text-[12.5px]">
      <span className="size-1.5 shrink-0 rounded-full bg-foreground/30" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{label}</span>
        {customName && (
          <span className="ml-1.5 text-[11px] text-muted-foreground">
            · {activityKindLabel(session.kind)}
          </span>
        )}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {dateLabel}
      </span>
      <span className="shrink-0 tabular-nums text-[12px]">{minutes}m</span>
    </li>
  );
}

function activityKindLabel(kind: string): string {
  // Mirror of the labels in log-activity-dialog.tsx — same map kept
  // here as a fallback so the dashboard renders the right name without
  // depending on the dialog's internal state.
  const m: Record<string, string> = {
    italki: "italki",
    class: "Class",
    tutor: "Tutor",
    conversation: "Conversation",
    immersion: "Immersion",
    podcast: "Podcast",
    video: "Video / TV",
    book: "Reading",
  };
  return m[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

function isToday(unixSec: number): boolean {
  const d = new Date(unixSec * 1000);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function formatRelativeShort(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const today = new Date();
  const dateMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const diff = Math.round((todayMidnight - dateMidnight) / 86_400_000);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff > 1 && diff < 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Streak math lives in `lib/streak.ts` so this KPI and the
// Milestones page agree on what counts as a streak-qualifying day.
