import { useEffect, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  BookMarked,
  BookOpen,
  BookOpenText,
  Clapperboard,
  FolderOpen,
  ChevronDown,
  Home,
  Layers,
  Library,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  Settings,
  StickyNote,
  Target,
  Trash2,
  User,
  X,
} from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Pinyin } from "@/components/pinyin";
import { AddCustomWordDialog } from "@/components/add-custom-word-dialog";
import { cn } from "@/lib/utils";
import { HOSTED } from "@/lib/build-flags";
import { useBackgroundChat } from "@/lib/background-chat-context";
import { useChatList } from "@/lib/chat-list-context";
import { useSearch } from "@/lib/search-context";
import { useWorkspace } from "@/lib/workspace-context";
import { useProviderConfigs } from "@/lib/provider-context";
import { useCloud } from "@/lib/cloud-context";
import { useSession } from "@/lib/session-context";
import { useProfile } from "@/lib/profile-context";
import {
  languageGlyph,
  languageName,
  languageNative,
} from "@/lib/languages";
import type { DictEntry } from "@/lib/db";
import type { TabId } from "./shell";
import { SidebarGlyph } from "./sidebar-glyph";
import { TierBadge } from "./tier-badge";
import { SidebarSessionControl } from "./sidebar-session-control";

type NavItem = {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

// Tabs that are local-only — they depend on the desktop's filesystem,
// FastEmbed bindings, or other Tauri-only APIs. The hosted build
// strips them from the sidebar so users don't bump into broken
// affordances. The terser pass also dead-code-eliminates the ones
// behind a HOSTED guard at the entry point.
const HOSTED_HIDDEN_TABS: ReadonlySet<TabId> = new Set<TabId>([
  "dictionaries",
]);

const ALL_NAV_GROUPS: { label: string | null; items: NavItem[] }[] = [
  {
    label: null,
    items: [
      { id: "dashboard", label: "Home", icon: Home },
      { id: "chat", label: "Conversation", icon: MessageSquare },
      { id: "reader", label: "Reader", icon: BookOpenText },
      { id: "immersion", label: "Immersion", icon: Clapperboard },
      { id: "flashcards", label: "Flashcards", icon: Layers },
    ],
  },
  {
    label: "Library",
    items: [
      { id: "vocab", label: "Vocabulary", icon: BookMarked },
      { id: "collections", label: "Collections", icon: FolderOpen },
      { id: "library", label: "Library", icon: Library },
      { id: "notes", label: "Notes", icon: StickyNote },
      { id: "journal", label: "Journal", icon: NotebookPen },
      { id: "search", label: "Dictionary", icon: Search },
      { id: "dictionaries", label: "Sources", icon: BookOpen },
    ],
  },
  {
    // Trimmed: Milestones folded into Journey (the level ladder
    // supersedes the hard-coded 100/1000/5000 thresholds). Sources
    // moved up into Library where it semantically belongs. Activities
    // dropped — the same data surfaces inside Goals & habits, so a
    // dedicated tab is redundant. The view + case in shell.tsx are
    // kept so deep-links to /activities (and the coach's `log-session`
    // intent) still resolve cleanly.
    label: "Progress",
    items: [
      { id: "journey", label: "Journey", icon: Target },
      { id: "statistics", label: "Statistics", icon: BarChart3 },
    ],
  },
];

const NAV_GROUPS = HOSTED
  ? ALL_NAV_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((it) => !HOSTED_HIDDEN_TABS.has(it.id)),
    })).filter((g) => g.items.length > 0)
  : ALL_NAV_GROUPS;

export function Sidebar({
  activeTab,
  onTabChange,
  onNewWorkspace,
  collapsed,
  onCollapsedChange,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  onNewWorkspace: () => void;
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
}) {
  const { workspaces, active, setActive, deleteWorkspace } = useWorkspace();
  const { active: provider } = useProviderConfigs();
  const { active: session } = useSession();
  const { profile } = useProfile();
  const search = useSearch();
  const setCollapsed = onCollapsedChange;

  // Force-expand the sidebar when entering search mode — results need width.
  useEffect(() => {
    if (search.isActive && collapsed) setCollapsed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.isActive]);

  return (
    <TooltipProvider delayDuration={120} disableHoverableContent>
      <aside
        className={cn(
          "relative flex shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200",
          collapsed ? "w-[64px]" : search.isActive ? "w-[320px]" : "w-[260px]",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-1.5 px-3 pt-3 pb-3",
            collapsed && "flex-col gap-2 px-2",
          )}
        >
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher
              collapsed={collapsed}
              activeId={active?.id ?? null}
              workspaces={workspaces}
              onPick={setActive}
              onNew={onNewWorkspace}
              onDelete={deleteWorkspace}
            />
          </div>
          {/* Collapse toggle lives in the sidebar's top header rather
              than as a floating chip on the right edge — the edge
              version was hard to spot, and small enough to feel
              fiddly. Sized at 9 / 4.5 (button / icon) so it reads
              as a peer to the workspace pill, not an afterthought. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setCollapsed(!collapsed)}
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
                  collapsed && "size-9",
                )}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                {/* Same glyph as the title bar's toggle — one
                    mechanism, one icon (filled pill = sidebar open). */}
                <SidebarGlyph open={!collapsed} className="size-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side={collapsed ? "right" : "bottom"} sideOffset={6}>
              {collapsed ? "Expand sidebar" : "Collapse sidebar"}
            </TooltipContent>
          </Tooltip>
        </div>

        <div className={cn("px-2 pb-2", collapsed && "px-1.5")}>
          <SidebarSearch
            collapsed={collapsed}
            value={search.query}
            onChange={search.setQuery}
            onExpand={() => setCollapsed(false)}
            targetLang={active?.targetLang}
            onClear={search.isActive ? search.clear : undefined}
          />
        </div>

        {search.isActive && !collapsed ? (
          <SearchResultsPane />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <nav className="flex flex-col gap-2 px-2 pt-1">
              {NAV_GROUPS.map((group, gi) => (
                <div key={gi}>
                  {!collapsed && group.label && (
                    <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </div>
                  )}
                  {collapsed && gi > 0 && <Separator className="my-1.5" />}
                  {group.items.map((item) => (
                    <NavButton
                      key={item.id}
                      collapsed={collapsed}
                      active={activeTab === item.id}
                      onClick={() => onTabChange(item.id)}
                      icon={<item.icon className="size-4" />}
                      label={item.label}
                    />
                  ))}
                </div>
              ))}
            </nav>
            {!collapsed && <RecentsSection onTabChange={onTabChange} />}
          </div>
        )}

        {/* Session control — same SessionContext the rest of the app
            uses, so anything logged here flows into the dashboard,
            journey, goals, and habits like every other session. */}
        <SidebarSessionControl collapsed={collapsed} />

        <Separator />

        <div
          className={cn(
            "flex items-center gap-2 px-3 py-2.5",
            collapsed && "flex-col gap-1.5 px-0 py-2",
          )}
        >
          <Avatar className="size-8 shrink-0">
            <AvatarFallback className="bg-foreground text-background text-[11px]">
              {(profile.name || "you").slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium">
                  {profile.name || "Local user"}
                </span>
                {/* Trial / Pro pill — only rendered in the hosted
                    build. Trial users in their 3-day signup window
                    see a countdown; paid (non-trial) Pro users see
                    "Pro"; everyone else renders nothing. */}
                {HOSTED && <SidebarTierBadge />}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    provider ? "bg-emerald-500" : "bg-amber-500",
                  )}
                />
                <span className="truncate">
                  {provider ? provider.label : "no provider"}
                  {session && " · session"}
                </span>
              </div>
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onTabChange("settings")}
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
                  activeTab === "settings"
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                aria-label="Settings"
              >
                <Settings className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side={collapsed ? "right" : "top"} sideOffset={6}>
              Settings
            </TooltipContent>
          </Tooltip>
        </div>

      </aside>
    </TooltipProvider>
  );
}

function SidebarTierBadge() {
  const cloud = useCloud();
  return (
    <TierBadge subscription={cloud.account?.subscription} variant="pill" />
  );
}

function NavButton({
  collapsed,
  active,
  onClick,
  icon,
  label,
}: {
  collapsed: boolean;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md text-[13.5px] transition-colors",
        collapsed ? "h-8 justify-center" : "px-2.5 py-1.5",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {icon}
      {!collapsed && label}
    </button>
  );
  if (!collapsed) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function WorkspaceSwitcher({
  collapsed,
  activeId,
  workspaces,
  onPick,
  onNew,
  onDelete,
}: {
  collapsed: boolean;
  activeId: number | null;
  workspaces: { id: number; targetLang: string; nativeLang: string }[];
  onPick: (id: number) => void;
  onNew: () => void;
  /** Permanently delete the workspace (cascade — vocab, sessions, etc.). */
  onDelete: (id: number) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  // What the AlertDialog is currently asking the user to confirm. Keeping
  // the pending workspace separate from `open` so the popover can close
  // before the dialog renders (otherwise the focus trap fights itself).
  const [pendingDelete, setPendingDelete] = useState<{
    id: number;
    targetLang: string;
  } | null>(null);
  const active = workspaces.find((w) => w.id === activeId);

  const trigger = collapsed ? (
    <button
      type="button"
      className="flex w-full items-center justify-center rounded-md py-1 transition-colors hover:bg-accent/60"
      title={active ? languageName(active.targetLang) : "Tokori — no workspace"}
    >
      <LangBadge code={active?.targetLang} />
    </button>
  ) : (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
    >
      <LangBadge code={active?.targetLang} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold tracking-tight">
          {active ? languageName(active.targetLang) : "Tokori"}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {active ? languageNative(active.targetLang) : "click to set up a workspace"}
        </div>
      </div>
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        className="w-[244px] p-1.5"
        align={collapsed ? "start" : "start"}
        side={collapsed ? "right" : "bottom"}
        sideOffset={6}
      >
        <div className="px-1 pb-1 pt-0.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Workspaces
        </div>
        <div className="flex flex-col">
          {workspaces.length === 0 && (
            <p className="px-2 py-2 text-[12px] text-muted-foreground">No workspaces yet.</p>
          )}
          {workspaces.map((w) => (
            <div
              key={w.id}
              className={cn(
                "group/ws flex items-center gap-1 rounded-md transition-colors",
                w.id === activeId
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/60",
              )}
            >
              <button
                onClick={() => {
                  onPick(w.id);
                  setOpen(false);
                }}
                className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 text-left text-[13px]"
              >
                <LangBadge code={w.targetLang} small />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{languageName(w.targetLang)}</span>
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    {languageNative(w.targetLang)}
                  </span>
                </div>
              </button>
              <button
                type="button"
                aria-label={`Delete ${languageName(w.targetLang)} workspace`}
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDelete({ id: w.id, targetLang: w.targetLang });
                  setOpen(false);
                }}
                className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/ws:opacity-100"
                title="Delete workspace"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <Separator className="my-1" />
        <button
          onClick={() => {
            onNew();
            setOpen(false);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <Plus className="size-3.5" />
          New workspace
        </button>
      </PopoverContent>
      {/* Confirm-delete dialog — destructive action, so we always confirm
          rather than letting a single click wipe months of study data. */}
      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(v) => {
          if (!v) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete ? languageName(pendingDelete.targetLang) : ""} workspace?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes everything in this workspace — vocabulary,
              reader documents, sessions, milestones, collections, chats. Your
              dictionaries and provider keys are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) await onDelete(target.id);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Popover>
  );
}

function SidebarSearch({
  collapsed,
  value,
  onChange,
  onExpand,
  targetLang,
  onClear,
}: {
  collapsed: boolean;
  value: string;
  onChange: (v: string) => void;
  onExpand: () => void;
  targetLang: string | undefined;
  onClear?: () => void;
}) {
  const placeholder =
    targetLang === "zh"
      ? "搜索 character, pinyin, English…"
      : "Search dictionary…";

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onExpand}
            className="flex h-8 w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            aria-label="Search"
          >
            <Search className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          Search
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Esc closes the dictionary search and (via the Shell's
          // last-tab tracking) bounces the user back to whatever
          // tab they were on before search activated.
          if (e.key === "Escape") {
            e.preventDefault();
            if (onClear) onClear();
            else onChange("");
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
        className={cn(
          "h-8 w-full rounded-md border border-border/60 bg-background/40 pl-7.5 pr-7 text-[12.5px] text-foreground placeholder:text-muted-foreground/70",
          "focus:border-ring focus:bg-background focus:outline-none focus:ring-1 focus:ring-ring",
        )}
        aria-label="Search dictionary"
      />
      {(value || onClear) && (
        <button
          type="button"
          onClick={onClear ?? (() => onChange(""))}
          className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

function SearchResultsPane() {
  const { debounced, results, loading, active, setActive, clear, refresh } =
    useSearch();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pb-1.5 pt-1">
        <button
          type="button"
          onClick={clear}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          Back to nav
        </button>
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          {loading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : results.length > 0 ? (
            `${results.length} match${results.length === 1 ? "" : "es"}`
          ) : (
            ""
          )}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {!debounced ? (
          <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            Keep typing to search the dictionary…
          </p>
        ) : results.length === 0 && !loading ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            No matches for "{debounced}".
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="mt-3 inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-accent/60"
            >
              <Plus className="size-3.5" />
              Add "{debounced}"
            </button>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {results.map((entry, i) => (
              <ResultRow
                key={`${entry.word}-${i}`}
                entry={entry}
                isActive={
                  active?.word === entry.word && active.gloss === entry.gloss
                }
                onPick={() => setActive(entry)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Persistent quick-add in the pane's free space — reachable whether
          or not the current query found anything. Pre-fills the headword
          with the live query so "search, miss, add" is two clicks. */}
      <div className="border-t border-border px-2 py-1.5">
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <Plus className="size-3.5" />
          Add a custom word
        </button>
      </div>

      <AddCustomWordDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        initialWord={debounced}
        onAdded={refresh}
      />
    </div>
  );
}

function ResultRow({
  entry,
  isActive,
  onPick,
}: {
  entry: DictEntry;
  isActive: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onPick}
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
          isActive ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-serif text-[16px] shrink-0">{entry.word}</span>
          <Pinyin raw={entry.reading} className="shrink-0 text-[11px]" />
        </div>
        <span className="line-clamp-1 text-[11.5px] text-muted-foreground">
          {entry.gloss}
        </span>
      </button>
    </li>
  );
}

function RecentsSection({ onTabChange }: { onTabChange: (tab: TabId) => void }) {
  const { chats, activeChatId, setActiveChatId, rename, remove } = useChatList();
  // Pull in the unread set + active streams so the row can show a green
  // dot when a reply landed while the user was elsewhere, and a soft
  // pulse when generation is currently mid-flight.
  const bg = useBackgroundChat();
  const [showAll, setShowAll] = useState(false);
  // Which chat the destructive AlertDialog is currently asking about.
  // Lifted to state so we can render the shadcn dialog in-tree instead
  // of the OS-level `window.confirm`, which doesn't match the app's
  // visual language and steals focus to the browser chrome.
  const [pendingDelete, setPendingDelete] = useState<{
    id: number;
    title: string;
  } | null>(null);
  // Separate pending-state for the bulk "Clear all" action so the two
  // dialogs never collide. `clearing` is the active-spinner flag while
  // the loop runs, so the user sees something is happening on workspaces
  // with hundreds of chats where deletion isn't instant.
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function clearAllChats() {
    // Snapshot the list because `remove` mutates the underlying chats
    // state — iterating the live array would skip every other entry.
    const ids = chats.map((c) => c.id);
    setClearing(true);
    try {
      // Sequential rather than Promise.all: each delete cascades through
      // messages + FTS rows, and the SQLx pool collapses if a workspace
      // with hundreds of chats fires them all at once.
      for (const id of ids) {
        await remove(id);
      }
      setActiveChatId(null);
    } finally {
      setClearing(false);
    }
  }

  if (chats.length === 0) {
    return (
      <div className="px-3 pb-3 pt-3">
        <div className="px-1 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Recents
        </div>
        <p className="px-1 py-1.5 text-[11.5px] text-muted-foreground">
          No conversations yet.
        </p>
      </div>
    );
  }

  const limit = 7;
  const visible = showAll ? chats : chats.slice(0, limit);
  const hasMore = chats.length > limit;

  function pickChat(id: number) {
    setActiveChatId(id);
    onTabChange("chat");
  }

  async function onRename(id: number, currentTitle: string) {
    const next = window.prompt("Rename chat", currentTitle || "");
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    await rename(id, trimmed);
  }

  function onDelete(id: number, title: string) {
    setPendingDelete({ id, title });
  }

  return (
    <>
    <div className="mt-1 flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-2.5 pb-1 pt-3">
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          Recents
        </span>
        {/* Bulk clear — only renders when there's something to clear so
            the section stays visually quiet on first launch. Tooltip
            spells out destructiveness; the AlertDialog below is the
            actual gate. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setConfirmClearAll(true)}
              className="flex size-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-destructive"
              aria-label="Clear all chats"
            >
              <Trash2 className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={6}>
            Clear all recent chats
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <ul className="flex flex-col">
          {visible.map((c) => {
            const isUnread = bg.unread.has(c.id);
            const isStreaming = bg.activeStreamIds.has(c.id);
            const isTitlePending = bg.titlePending.has(c.id);
            return (
            // Keyed entry animation: a freshly-created chat glides in
            // instead of popping. Reorders (existing chat bumped to the
            // top) reuse the keyed node, so they don't re-animate.
            <li
              key={c.id}
              className="group/row relative animate-in fade-in slide-in-from-left-1 duration-300"
            >
              <button
                onClick={() => pickChat(c.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md py-1.5 pl-9 pr-8 text-left text-[13.5px] transition-colors duration-200",
                  activeChatId === c.id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  isUnread && activeChatId !== c.id && "text-foreground",
                )}
                title={
                  isTitlePending
                    ? `${c.title || "Untitled"} — naming this chat…`
                    : isStreaming
                      ? `${c.title || "Untitled"} — generating reply…`
                      : isUnread
                        ? `${c.title || "Untitled"} — new reply`
                        : c.title || "Untitled"
                }
              >
                <span
                  className={cn(
                    "truncate transition-[filter,opacity] duration-500 ease-out",
                    isUnread && "font-medium",
                    // Skeleton-blur while the AI titler is still
                    // running. Once `titlePending` clears, the blur
                    // eases away and the proper title resolves in place.
                    isTitlePending &&
                      "blur-[2.5px] opacity-60 animate-pulse select-none",
                  )}
                >
                  {c.title || "Untitled"}
                </span>
                {/* Status dot: green = unseen reply waiting; pulsing
                    sky = generation currently in flight (regardless of
                    whether the user is on this chat). */}
                {(isUnread || isStreaming) && (
                  <span
                    className={cn(
                      "ml-auto size-1.5 shrink-0 rounded-full",
                      isStreaming
                        ? "bg-sky-500 animate-pulse"
                        : "bg-emerald-500",
                    )}
                    aria-hidden
                  />
                )}
              </button>
              <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="Chat options"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    <DropdownMenuItem onSelect={() => void onRename(c.id, c.title)}>
                      <Pencil className="size-3.5" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void onDelete(c.id, c.title)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
            );
          })}
        </ul>
        {hasMore && (
          <button
            type="button"
            onClick={() => setShowAll((s) => !s)}
            className="mt-1.5 flex w-full items-center gap-1.5 rounded-md py-1 pl-9 pr-2 text-[12px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                showAll && "rotate-180",
              )}
            />
            {showAll ? "Show less" : `Load more (${chats.length - limit})`}
          </button>
        )}
      </div>
    </div>
    {/* Confirm-delete dialog — destructive action, so we use the
        in-app AlertDialog rather than `window.confirm`. The OS prompt
        is jarring against the app's visual language and pulls focus
        out of the webview. */}
    <AlertDialog
      open={pendingDelete != null}
      onOpenChange={(v) => {
        if (!v) setPendingDelete(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete &ldquo;{pendingDelete?.title || "this chat"}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the conversation and all its messages.
            This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              const target = pendingDelete;
              setPendingDelete(null);
              if (target) await remove(target.id);
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Bulk clear-all dialog. Phrased to make the count visible up
        front — deleting 200 chats by accident is a worse feeling
        than deleting 5, and the wording should reflect that. */}
    <AlertDialog
      open={confirmClearAll}
      onOpenChange={(v) => {
        if (!v && !clearing) setConfirmClearAll(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Clear {chats.length} recent chat{chats.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Every conversation in this workspace will be permanently
            deleted, along with their messages. Your vocabulary,
            collections, and notes are not affected. This can&apos;t be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={clearing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={clearing}
            variant="destructive"
            onClick={async () => {
              await clearAllChats();
              setConfirmClearAll(false);
            }}
          >
            {clearing ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Clearing…
              </>
            ) : (
              "Clear all"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

function LangBadge({ code, small = false }: { code: string | undefined; small?: boolean }) {
  if (!code)
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
          small ? "size-6 text-xs" : "size-8 text-sm",
        )}
      >
        <User className="size-3.5" />
      </div>
    );
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-foreground/90 font-medium text-background",
        small ? "size-6 text-[11px]" : "size-8 text-[13px]",
      )}
      title={languageNative(code)}
    >
      {languageGlyph(code)}
    </div>
  );
}
