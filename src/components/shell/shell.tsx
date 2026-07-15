import { Suspense, lazy, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { DictSearchModal } from "@/components/dict-search-modal";
import { GlobalAddCard } from "@/components/global-add-card";
import { PairRequestDialog } from "@/components/pair-request-dialog";
import { MissingDictionaryBanner } from "@/components/missing-dictionary-banner";
import { OnboardingDialog } from "@/components/onboarding-dialog";
import { loadChatMarkdownImpl } from "@/components/chat-markdown";
import {
  onAnalyzeSentence,
  type AnalyzerRequest,
} from "@/lib/analyzer-event";
import { useAutoSync } from "@/lib/use-auto-sync";
import { useChineseConfig } from "@/lib/chinese-config";
import { HOSTED } from "@/lib/build-flags";
import { useSearch } from "@/lib/search-context";
import { useWorkspace } from "@/lib/workspace-context";
import { useCloud } from "@/lib/cloud-context";
import { applyGlobalSearchOnBoot, applyVoiceAskOnBoot } from "@/lib/global-search";
import { requestVoiceAsk } from "@/lib/ask-intent";
import { onNavigateToTab } from "@/lib/nav-event";
import { Sidebar } from "./sidebar";
import { TitleBar } from "./title-bar";

// Views are code-split per tab so the entry bundle stays lean — the
// hosted build's first paint shouldn't pay for the reader, flashcards,
// and settings when the user lands on the dashboard. Each view keeps a
// named export; the loader pair below (a) feeds React.lazy and (b) is
// reused by the idle-time prefetch in <Shell> so later tab switches
// resolve from the module cache instead of the network.
const loadActivitiesView = () => import("@/components/views/activities-view");
const loadChatView = () => import("@/components/views/chat-view");
const loadDashboardView = () => import("@/components/views/dashboard-view");
const loadDictionariesView = () => import("@/components/views/dictionaries-view");
const loadFlashcardsView = () => import("@/components/views/flashcards-view");
const loadCollectionsView = () => import("@/components/views/collections-view");
const loadJournalView = () => import("@/components/views/journal-view");
const loadLibraryView = () => import("@/components/views/library-view");
const loadImmersionView = () => import("@/components/views/immersion-view");
const loadJourneyView = () => import("@/components/views/journey-view");
const loadStatisticsView = () => import("@/components/views/statistics-view");
const loadMilestonesView = () => import("@/components/views/milestones-view");
const loadNotesView = () => import("@/components/views/notes-view");
const loadReaderView = () => import("@/components/views/reader-view");
const loadSearchView = () => import("@/components/views/search-view");
const loadSettingsView = () => import("@/components/views/settings-view");
const loadVocabView = () => import("@/components/views/vocab-view");
// Not a view, but the analyzer drags the whole markdown render stack
// (react-markdown + remark) with it — splitting it keeps that stack
// out of the eager bundle. It mounts on the first analyze request.
const loadSentenceAnalyzerModal = () =>
  import("@/components/sentence-analyzer-modal");

const ActivitiesView = lazy(async () => ({ default: (await loadActivitiesView()).ActivitiesView }));
const ChatView = lazy(async () => ({ default: (await loadChatView()).ChatView }));
const DashboardView = lazy(async () => ({ default: (await loadDashboardView()).DashboardView }));
const DictionariesView = lazy(async () => ({ default: (await loadDictionariesView()).DictionariesView }));
const FlashcardsView = lazy(async () => ({ default: (await loadFlashcardsView()).FlashcardsView }));
const CollectionsView = lazy(async () => ({ default: (await loadCollectionsView()).CollectionsView }));
const JournalView = lazy(async () => ({ default: (await loadJournalView()).JournalView }));
const LibraryView = lazy(async () => ({ default: (await loadLibraryView()).LibraryView }));
const ImmersionView = lazy(async () => ({ default: (await loadImmersionView()).ImmersionView }));
const JourneyView = lazy(async () => ({ default: (await loadJourneyView()).JourneyView }));
const StatisticsPanel = lazy(async () => ({ default: (await loadStatisticsView()).StatisticsPanel }));
const MilestonesView = lazy(async () => ({ default: (await loadMilestonesView()).MilestonesView }));
const NotesView = lazy(async () => ({ default: (await loadNotesView()).NotesView }));
const ReaderView = lazy(async () => ({ default: (await loadReaderView()).ReaderView }));
const SearchView = lazy(async () => ({ default: (await loadSearchView()).SearchView }));
const SettingsView = lazy(async () => ({ default: (await loadSettingsView()).SettingsView }));
const VocabView = lazy(async () => ({ default: (await loadVocabView()).VocabView }));
const SentenceAnalyzerModal = lazy(async () => ({
  default: (await loadSentenceAnalyzerModal()).SentenceAnalyzerModal,
}));

const ALL_LAZY_LOADERS = [
  loadActivitiesView,
  loadChatView,
  loadDashboardView,
  loadDictionariesView,
  loadFlashcardsView,
  loadCollectionsView,
  loadJournalView,
  loadLibraryView,
  loadImmersionView,
  loadJourneyView,
  loadStatisticsView,
  loadMilestonesView,
  loadNotesView,
  loadReaderView,
  loadSearchView,
  loadSettingsView,
  loadVocabView,
  loadSentenceAnalyzerModal,
  loadChatMarkdownImpl,
];

export type TabId =
  | "dashboard"
  | "chat"
  | "reader"
  | "immersion"
  | "flashcards"
  | "vocab"
  | "collections"
  | "library"
  | "notes"
  | "journal"
  | "search"
  | "journey"
  | "statistics"
  | "milestones"
  | "habits"
  | "activities"
  | "dictionaries"
  | "settings";

const SIDEBAR_COLLAPSED_KEY = "sidebar.collapsed";

export function Shell() {
  const { loading, workspaces, active } = useWorkspace();
  const cloud = useCloud();
  const search = useSearch();
  // Auto-sync runs in the background when the user toggles it on
  // (Settings → Cloud) and they're Pro. Returns a status the sidebar
  // can read — kept as a discarded value for now; a future iteration
  // can wire it into a "Synced 2 min ago" pill.
  useAutoSync();
  // Apply the active workspace's pinyin tone colours to the
  // document on every workspace switch. The hook also listens for
  // `tokori:chinese-config-changed` so saves from Settings → Chinese
  // take effect everywhere without a route change. We invoke it for
  // its side effects only; the returned config isn't read here.
  useChineseConfig(active?.id ?? null);
  // Demo + real desktop both land on Home (the dashboard). The seeded
  // workspace has enough vocab / sessions / goals that the dashboard
  // is the most representative single-screen pitch — and once a
  // visitor browses to Chat or Reader, the side-nav makes returning
  // obvious.
  const [tab, setTab] = useState<TabId>("dashboard");
  // Where the user was before search hijacked the tab. Used so Esc /
  // clearing the search box bounces them back instead of stranding
  // them on the empty Search hero.
  const [lastNonSearchTab, setLastNonSearchTab] = useState<TabId>("dashboard");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
  );
  // Most recent sentence-analyzer request. The lazy modal mounts on
  // the first request and then stays mounted (so close animations
  // survive); `analyzerOpen` drives visibility, and firing a new
  // request swaps the contents in place rather than queuing.
  const [analyzer, setAnalyzer] = useState<AnalyzerRequest | null>(null);
  const [analyzerOpen, setAnalyzerOpen] = useState(false);

  useEffect(() => {
    return onAnalyzeSentence((req) => {
      setAnalyzer(req);
      setAnalyzerOpen(true);
    });
  }, []);

  // Track the most recent non-search tab so we know where to return.
  useEffect(() => {
    if (tab !== "search") setLastNonSearchTab(tab);
  }, [tab]);

  // Typing in the sidebar jumps to search; clearing it (or Esc) bounces
  // the user back to whatever tab they were on.
  useEffect(() => {
    if (search.isActive && tab !== "search") {
      setTab("search");
    } else if (!search.isActive && tab === "search") {
      setTab(lastNonSearchTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.isActive]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  // Listen for `navigateToTab(...)` calls fired from deeply-nested
  // components that don't have an onNavigate prop (e.g. the
  // click-to-define popover's "no dictionary set up" link).
  useEffect(() => {
    return onNavigateToTab((target) => {
      // Trust the tab string at runtime — TabId is a TS type, the
      // event carries plain strings. Anything unknown is a no-op.
      navigate(target as TabId);
    });
    // navigate references search.clear which is stable for the
    // lifetime of the provider, so this effect doesn't need deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply the persisted Global Search + Voice Ask settings on app
  // boot so the tray + OS-level shortcuts come back without the user
  // revisiting Settings. Cheap no-ops outside Tauri / when off.
  useEffect(() => {
    void applyGlobalSearchOnBoot();
    void applyVoiceAskOnBoot();
  }, []);

  // Warm every view chunk once the browser goes idle after first paint.
  // The initial load only ships the active tab; this makes every later
  // tab switch resolve from the module cache, so lazy loading never
  // costs the user a visible wait. requestIdleCallback is missing in
  // some WebKitGTK versions — fall back to a short timer there.
  useEffect(() => {
    const warm = () => {
      for (const load of ALL_LAZY_LOADERS) void load().catch(() => {});
    };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warm);
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(warm, 1_500);
    return () => window.clearTimeout(handle);
  }, []);

  // Spotlight bridge — when the user picks a result from the global
  // search popup, the Rust side brings this window forward and emits
  // `tokori:open-search` with the chosen word. Pump it into the
  // SearchProvider so the search tab renders the detail page.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const off = await listen<string>("tokori:open-search", (e) => {
          const q = (e.payload ?? "").toString();
          if (!q) return;
          search.setQuery(q);
          setTab("search");
        });
        unlisten = off;
      } catch {
        /* not running under Tauri (browser dev) — ignore */
      }
    })();
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Voice-ask bridge — the voice popup hands its transcript to Rust,
  // which brings this window forward and emits `tokori:voice-ask`.
  // Park the question in ask-intent (ChatView consumes it once its
  // chat row is ready) and flip to the chat tab.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const off = await listen<{ text: string; speak: boolean }>(
          "tokori:voice-ask",
          (e) => {
            const text = (e.payload?.text ?? "").toString().trim();
            if (!text) return;
            requestVoiceAsk({ text, speak: !!e.payload?.speak });
            setTab("chat");
          },
        );
        unlisten = off;
      } catch {
        /* not running under Tauri (browser dev) — ignore */
      }
    })();
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // macOS menu-bar bridge — "Settings…" (⌘,) and "Toggle Sidebar"
  // (⌥⌘S) in the native menu emit `tokori:menu` from Rust. No menu
  // is installed on Windows/Linux, and listen() rejects outside
  // Tauri (browser dev) — both make this a silent no-op.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const off = await listen<string>("tokori:menu", (e) => {
          if (e.payload === "settings") navigate("settings");
          if (e.payload === "toggle-sidebar") setSidebarCollapsed((c) => !c);
        });
        unlisten = off;
      } catch {
        /* not running under Tauri (browser dev) — ignore */
      }
    })();
    return () => {
      unlisten?.();
    };
    // navigate references search.clear which is stable for the
    // lifetime of the provider, so this effect doesn't need deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Block the webview's default "drop a file → navigate to it" so a
  // PDF dropped anywhere on the window doesn't replace the app with
  // a built-in PDF viewer. WebKitGTK on Linux is particularly eager
  // to do this; without these listeners, drops outside the chat-view's
  // own zone (sidebar, gaps, while a dialog is open) fall through to
  // the default and yank the user out of the app. The chat-view's
  // local onDrop still handles attachments as before — these listeners
  // just stop the default; they don't consume the event.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      // Only swallow when the drag is carrying actual files. Internal
      // drag-and-drop (e.g. text selections) keeps working.
      const types = e.dataTransfer?.types;
      if (!types) return;
      const hasFiles = Array.from(types).some(
        (t) => t === "Files" || t === "application/x-moz-file",
      );
      if (!hasFiles) return;
      e.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  function navigate(t: TabId) {
    if (t !== "search") search.clear();
    setTab(t);
  }

  // Latch `showOnboarding` on first run. Without this, submitting step 1
  // grows `workspaces.length` from 0 to 1, which would unmount the dialog
  // before the onboarding component could transition to step 2 (dict
  // install). With the latch, only an explicit `onClose` from the dialog
  // can dismiss it. Re-fires if the user deletes their last workspace —
  // UNLESS the cloud knows this account already finished onboarding on
  // another device. In that case (account.user.onboardedAt set), the
  // user is opted out of the picker entirely; they can still create a
  // workspace manually from the workspace switcher.
  useEffect(() => {
    if (loading) return;
    if (cloud.account?.user.onboardedAt != null) return;
    if (workspaces.length === 0) setShowOnboarding(true);
  }, [loading, workspaces.length, cloud.account?.user.onboardedAt]);

  // Push the local "onboarded" signal up to the cloud the first time
  // this device finishes a successful workspace creation. The cloud
  // call is idempotent on null → first writer wins; subsequent local
  // completions short-circuit on the cached value. Anonymous users
  // (no `account`) skip; the next sign-in will mirror state.
  useEffect(() => {
    if (loading) return;
    if (!cloud.account) return;
    if (cloud.account.user.onboardedAt != null) return;
    if (workspaces.length === 0) return;
    void cloud.markOnboarded();
  }, [
    loading,
    workspaces.length,
    cloud.account?.user.onboardedAt,
    cloud.account,
    cloud.markOnboarded,
  ]);

  const onboardingOpen = !loading && showOnboarding;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Custom window chrome — desktop builds only. The hosted build
          runs in a real browser tab (which has its own chrome), so the
          whole bar is dead-stripped from that bundle; in plain-browser
          dev the component renders null on its own. */}
      {!HOSTED && (
        <TitleBar
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
          onOpenSettings={() => navigate("settings")}
          settingsActive={tab === "settings"}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <Sidebar
          activeTab={tab}
          onTabChange={navigate}
          onNewWorkspace={() => setShowOnboarding(true)}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
        />

        <main className="flex flex-1 flex-col overflow-hidden">
          {/* Banner sits above the tab content so the prompt is visible
              on every workspace-scoped tab. It hides itself when the
              active workspace already has a dictionary, when nothing is
              loaded yet (no flash on boot), or when the user has
              dismissed it for the current workspace + language pair.
              Skipped on the Dictionaries tab because the install UI is
              literally already on screen, and on Settings to keep that
              view chrome-free. */}
          {active && tab !== "dictionaries" && tab !== "settings" && (
            <MissingDictionaryBanner />
          )}
          <div className="flex-1 overflow-hidden">
            {/* fallback={null}: view chunks come from disk (Tauri) or
                the HTTP cache after the idle prefetch, so a spinner
                would only ever flash. An empty pane for a few frames
                on a cold hosted load reads better than a flicker. */}
            <Suspense fallback={null}>
              {tab === "settings" ? (
                <SettingsView />
              ) : !active ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {loading ? "Loading…" : "Set up a workspace to begin."}
                </div>
              ) : (
                <TabContent
                  key={`${active.id}-${tab}`}
                  tab={tab}
                  onNavigate={navigate}
                  onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
                />
              )}
            </Suspense>
          </div>
        </main>
      </div>

      <OnboardingDialog open={onboardingOpen} onClose={() => setShowOnboarding(false)} />

      {/* Global Ctrl/Cmd+K dictionary search — listens on window so any
          tab/state can summon it. The modal is always mounted; it
          renders nothing while closed. */}
      <DictSearchModal />

      {/* Global "+" FAB and Ctrl/Cmd+Shift+A binding. Opens the same
          CardComposerDialog the vocab view uses, so the full enricher
          pipeline is reachable from any page. */}
      {/* FAB hidden on the chat tab (conversation + live voice mode) —
          the composer stays reachable via Cmd/Ctrl+Shift+A and the
          popover's "Make card" everywhere. */}
      <GlobalAddCard hidden={tab === "chat"} />

      {/* Session control lives inside the sidebar (`SidebarSessionControl`)
          rather than as a floating chip — same SessionContext, just
          embedded so it doesn't crowd the workspace. */}

      {/* Pairing approval — listens for `tokori:pair-request` events
          emitted by the local API server when a fresh extension/CLI
          client posts to /v1/pair/request without a token. */}
      <PairRequestDialog />

      {/* Global sentence analyzer — fired by the tokenized popover
          (and any future caller) via `requestAnalyzeSentence`. Lazy:
          nothing mounts (or loads) until the first request. */}
      {analyzer != null && (
        <Suspense fallback={null}>
          <SentenceAnalyzerModal
            open={analyzerOpen}
            onClose={() => setAnalyzerOpen(false)}
            sentence={analyzer.sentence}
            lang={analyzer.lang}
            initialFocus={analyzer.focus}
            source={analyzer.source}
          />
        </Suspense>
      )}
    </div>
  );
}

function TabContent({
  tab,
  onNavigate,
  onToggleSidebar,
}: {
  tab: TabId;
  onNavigate: (t: TabId) => void;
  onToggleSidebar: () => void;
}) {
  switch (tab) {
    case "dashboard":
      return <DashboardView onNavigate={onNavigate} />;
    case "chat":
      return (
        <ChatView
          onToggleSidebar={onToggleSidebar}
          onNavigate={onNavigate}
        />
      );
    case "reader":
      return <ReaderView />;
    case "flashcards":
      return <FlashcardsView />;
    case "vocab":
      return <VocabView />;
    case "collections":
      return <CollectionsView onNavigate={onNavigate} />;
    case "library":
      return <LibraryView onNavigate={onNavigate} />;
    case "immersion":
      return <ImmersionView />;
    case "notes":
      return <NotesView />;
    case "journal":
      return <JournalView />;
    case "search":
      return <SearchView />;
    case "journey":
      return <JourneyView />;
    case "statistics":
      return <StatisticsPanel />;
    case "milestones":
      return <MilestonesView />;
    case "habits":
      return <JourneyView initialSubtab="habits" />;
    case "activities":
      return <ActivitiesView />;
    case "dictionaries":
      return <DictionariesView />;
    case "settings":
      return <SettingsView />;
  }
}
