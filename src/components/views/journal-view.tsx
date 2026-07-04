/**
 * Journal — guided writing practice for the active workspace.
 *
 * Two-pane layout:
 *   • Left rail: list of journal entries, newest first, with a "New
 *     entry" button on top.
 *   • Right pane: editor or correction view, depending on the entry's
 *     state ('draft' | 'corrected').
 *
 * Topic sources (recorded on the row so we can show provenance):
 *   - manual:    user typed the topic themselves
 *   - ai:        clicked "Suggest a topic" → LLM generated it
 *   - vocab:     "Use my vocabulary" pulls a few learning-list words and
 *                asks for a topic that exercises them
 *   - chapter:   the active textbook's chapters list shows up under
 *                "From textbook" → topic anchored to that chapter title
 *
 * Submission flow:
 *   draft (write) → "Correct sentence by sentence" → corrected (read).
 * The corrections are persisted on the row, so re-opening the entry
 * later shows the same review. Hitting "Continue editing" flips it back
 * to draft for revision.
 */

import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  Loader2,
  NotebookPen,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  createJournal,
  deleteJournal,
  listChapters,
  listJournals,
  listLibrary,
  listVocab,
  updateJournal,
  type JournalCorrection,
  type JournalEntry,
  type JournalSource,
  type LibraryChapter,
  type LibraryItem,
} from "@/lib/db";
import { correctJournal, suggestTopic } from "@/lib/journal";
import { useProviderConfigs } from "@/lib/provider-context";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";
import {
  SidebarCollapser,
  useSidebarCollapse,
} from "@/components/sidebar-collapser";

export function JournalView() {
  const { active: workspace } = useWorkspace();
  const { sendChat, active: provider } = useProviderConfigs();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const { open: sidebarOpen, toggle: toggleSidebar } = useSidebarCollapse(
    "journal.sidebarOpen",
  );

  async function refresh() {
    if (!workspace) return;
    const list = await listJournals(workspace.id);
    setEntries(list);
    // Deliberately NOT auto-activating the most recent entry. Journal
    // opens on the "Practise writing" empty state by default — that's
    // the surface where new entries get started or suggested. The
    // user can click any past entry in the sidebar to open it.
    if (activeId != null && !list.some((e) => e.id === activeId)) {
      setActiveId(null);
    }
  }

  useEffect(() => {
    if (!workspace) return;
    setLoading(true);
    void refresh().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  const active = entries.find((e) => e.id === activeId) ?? null;

  if (!workspace) return null;

  async function newEntry(seed: {
    /** Short scannable label — shows in the sidebar list AND as the
     *  entry's heading. Falls back to a generic placeholder so the
     *  sidebar row isn't blank. */
    title?: string;
    /** The exercise / writing prompt. Stored separately from the
     *  title so the layout can render heading + exercise + textbox
     *  as distinct surfaces. */
    topic?: string;
    body?: string;
    source?: JournalSource | null;
  }) {
    if (!workspace) return;
    const j = await createJournal({
      workspaceId: workspace.id,
      title: seed.title?.trim() || seed.topic?.slice(0, 60).trim() || "Untitled entry",
      topic: seed.topic ?? null,
      body: seed.body ?? "",
      source: seed.source ?? "manual",
    });
    await refresh();
    setActiveId(j.id);
  }

  return (
    <div className="relative flex h-full">
      {/* Left rail — entry list. Same dimensions as the Notes view so
          the user's spatial memory transfers between writing surfaces. */}
      {sidebarOpen && (
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              Journal
            </p>
            <p className="text-[12px] text-muted-foreground">
              {entries.length} entr{entries.length === 1 ? "y" : "ies"}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void newEntry({ source: "manual" })}
            title="Start a new entry"
          >
            <Plus className="size-3.5" />
            New
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading…
            </div>
          ) : entries.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">
              No entries yet. Click <span className="font-medium text-foreground">New</span>{" "}
              to start writing.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {entries.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(e.id)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors",
                      e.id === activeId
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/60",
                    )}
                  >
                    <div className="flex w-full items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{e.title}</span>
                      {e.state === "corrected" ? (
                        <span className="ml-auto rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                          reviewed
                        </span>
                      ) : (
                        <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                          draft
                        </span>
                      )}
                    </div>
                    {e.topic && (
                      <span className="line-clamp-1 text-[11.5px] text-muted-foreground">
                        {e.topic}
                      </span>
                    )}
                    <span className="text-[10.5px] text-muted-foreground/80">
                      {new Date(e.updatedAt * 1000).toLocaleDateString()} ·{" "}
                      {wordCount(e.body)} words
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
      )}

      <SidebarCollapser
        open={sidebarOpen}
        onToggle={toggleSidebar}
        width={260}
        visibleLabel="Hide entries"
        hiddenLabel="Show entries"
      />

      {/* Right pane — editor for the active entry. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!active ? (
          <EmptyState
            onStart={() => void newEntry({ source: "manual" })}
            onSuggest={async () => {
              if (!provider) {
                toast.error("Add a provider first", {
                  description: "Settings → Providers — Live writing feedback needs a chat provider.",
                });
                return;
              }
              try {
                const knownWords = (await listVocab(workspace.id, 200))
                  .filter((v) => v.status !== "new")
                  .map((v) => v.word);
                const { title, prompt } = await suggestTopic({
                  targetLang: workspace.targetLang,
                  nativeLang: workspace.nativeLang,
                  knownWords,
                  sendChat,
                });
                void newEntry({ title, topic: prompt, source: "ai" });
              } catch (err) {
                toast.error("Couldn't suggest a topic", {
                  description: err instanceof Error ? err.message : String(err),
                });
              }
            }}
          />
        ) : (
          <EntryEditor
            key={active.id}
            entry={active}
            onChange={refresh}
            onDelete={async () => {
              await deleteJournal(active.id);
              await refresh();
            }}
          />
        )}
      </div>
    </div>
  );
}

function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

function EmptyState({
  onStart,
  onSuggest,
}: {
  onStart: () => void;
  onSuggest: () => Promise<void>;
}) {
  // Local "is the AI thinking" flag so the Suggest button can spin
  // and the body copy can flip into a status line. We don't bubble
  // this up to the parent — the EmptyState's responsibility ends
  // when newEntry resolves and the editor takes over.
  const [suggesting, setSuggesting] = useState(false);

  async function handleSuggest() {
    if (suggesting) return;
    setSuggesting(true);
    try {
      await onSuggest();
    } finally {
      // If the suggestion succeeded the EmptyState unmounts before
      // this runs (the new entry becomes active). If it failed the
      // user stays here and the spinner clears.
      setSuggesting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {suggesting ? (
            <Loader2 className="size-6 animate-spin" />
          ) : (
            <NotebookPen className="size-6" />
          )}
        </div>
        <h2 className="font-serif text-2xl tracking-tight">
          {suggesting ? "Generating exercise…" : "Practise writing."}
        </h2>
        <p className="mt-2 min-h-[42px] text-[13.5px] leading-relaxed text-muted-foreground">
          {suggesting
            ? "The tutor is picking a topic suited to your level. This usually takes a second or two."
            : "Pick a topic, write a few sentences in the target language, and the tutor will correct your draft sentence by sentence. Topics can come from your textbook, your vocabulary, or be invented by the AI."}
        </p>
        <div className="mt-5 flex flex-col items-center gap-2">
          <Button onClick={onStart} disabled={suggesting}>
            <Plus className="size-4" />
            Start a blank entry
          </Button>
          <Button variant="outline" onClick={() => void handleSuggest()} disabled={suggesting}>
            {suggesting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                Suggest a topic
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function EntryEditor({
  entry,
  onChange,
  onDelete,
}: {
  entry: JournalEntry;
  onChange: () => Promise<void> | void;
  onDelete: () => Promise<void>;
}) {
  const { active: workspace } = useWorkspace();
  const { sendChat, active: provider } = useProviderConfigs();
  const [title, setTitle] = useState(entry.title);
  const [topic, setTopic] = useState(entry.topic ?? "");
  const [body, setBody] = useState(entry.body);
  const [savingTimer, setSavingTimer] = useState<number | null>(null);
  const [working, setWorking] = useState<"idle" | "suggesting" | "correcting">(
    "idle",
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Auto-save title / topic / body 600 ms after the user stops typing.
  // Faster than typical IDE autosave because journal entries are
  // small and we don't want to lose work if the app crashes
  // mid-paragraph. Title falls back to the placeholder so the
  // sidebar row never goes blank.
  useEffect(() => {
    if (savingTimer) window.clearTimeout(savingTimer);
    const t = window.setTimeout(() => {
      void updateJournal(entry.id, {
        title: title.trim() || "Untitled entry",
        topic: topic.trim() || null,
        body,
        // If the user edits the corrected entry, drop the corrections —
        // they no longer match the text.
        ...(entry.state === "corrected" && body !== entry.body
          ? { state: "draft" as const, corrections: null }
          : {}),
      }).then(() => onChange());
    }, 600);
    setSavingTimer(t);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, topic, body, entry.id]);

  async function suggestNewTopic(hint?: string) {
    if (!workspace) return;
    if (!provider) {
      toast.error("Add a provider first", {
        description: "Settings → Providers — Live writing feedback needs a chat provider.",
      });
      return;
    }
    setWorking("suggesting");
    try {
      const knownWords = (await listVocab(workspace.id, 200))
        .filter((v) => v.status !== "new")
        .map((v) => v.word);
      const next = await suggestTopic({
        targetLang: workspace.targetLang,
        nativeLang: workspace.nativeLang,
        knownWords,
        hint,
        sendChat,
      });
      setTitle(next.title);
      setTopic(next.prompt);
      await updateJournal(entry.id, {
        title: next.title,
        topic: next.prompt,
        source: hint === "vocab" ? "vocab" : "ai",
      });
      await onChange();
    } catch (err) {
      toast.error("Couldn't suggest a topic", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setWorking("idle");
    }
  }

  async function pickChapterTopic(chapter: LibraryChapter) {
    if (!workspace) return;
    if (!provider) {
      toast.error("Add a provider first");
      return;
    }
    setWorking("suggesting");
    try {
      const knownWords = (await listVocab(workspace.id, 200))
        .filter((v) => v.status !== "new")
        .map((v) => v.word);
      const next = await suggestTopic({
        targetLang: workspace.targetLang,
        nativeLang: workspace.nativeLang,
        knownWords,
        chapterTitle: chapter.title,
        sendChat,
      });
      // Chapter-anchored suggestions: keep the AI's title (which
      // tends to be more specific than the chapter title itself) and
      // store the chapter id as the source for provenance display.
      setTitle(next.title);
      setTopic(next.prompt);
      await updateJournal(entry.id, {
        title: next.title,
        topic: next.prompt,
        source: { kind: "chapter", chapterId: chapter.id },
      });
      await onChange();
    } catch (err) {
      toast.error("Couldn't generate a chapter topic", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setWorking("idle");
    }
  }

  async function submitForCorrection() {
    if (!workspace) return;
    if (!provider) {
      toast.error("Add a provider first");
      return;
    }
    if (body.trim().length < 10) {
      toast("Write a bit more", {
        description: "At least a couple of sentences gives the tutor something to chew on.",
      });
      return;
    }
    setWorking("correcting");
    try {
      const corrections = await correctJournal({
        targetLang: workspace.targetLang,
        nativeLang: workspace.nativeLang,
        topic: topic.trim() || null,
        body,
        sendChat,
      });
      await updateJournal(entry.id, {
        state: "corrected",
        corrections,
      });
      await onChange();
      const fixed = corrections.filter((c) => c.severity !== "ok").length;
      toast.success("Reviewed!", {
        description:
          fixed === 0
            ? "Every sentence looked good. Nice work."
            : `${fixed} sentence${fixed === 1 ? "" : "s"} got a tweak — see the breakdown below.`,
      });
    } catch (err) {
      toast.error("Correction failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setWorking("idle");
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="border-b border-border px-8 py-5">
        <div className="mx-auto flex max-w-3xl items-start gap-2">
          <div className="min-w-0 flex-1">
            {/* Title — short scannable heading. Edits in place, no
                surrounding chrome so it reads as a heading rather
                than a form field. */}
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled entry"
              className="h-auto border-none bg-transparent px-0 py-0 font-serif text-2xl tracking-tight shadow-none focus-visible:ring-0"
            />
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              {provenanceLabel(entry.source)} · {wordCount(body)} words ·{" "}
              {entry.state === "corrected" ? "reviewed" : "draft"}
            </p>
          </div>
          <TopicSourcePopover
            disabled={working !== "idle"}
            // Forwarded so the trigger button can show a spinner +
            // label while the AI is mid-call. Saves the user
            // wondering whether their click registered.
            suggesting={working === "suggesting"}
            onSuggest={() => void suggestNewTopic()}
            onSuggestFromVocab={() => void suggestNewTopic("vocab")}
            onChapterPick={(ch) => void pickChapterTopic(ch)}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirmDelete(true)}
            title="Delete entry"
          >
            <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6">
          {entry.state === "corrected" && entry.corrections ? (
            <CorrectionView
              corrections={entry.corrections}
              onContinueEditing={async () => {
                await updateJournal(entry.id, { state: "draft" });
                await onChange();
              }}
            />
          ) : (
            <>
              {/* Exercise callout — the writing prompt itself. Always
                  rendered so the layout doesn't jump when the user
                  clicks "Suggest"; empty state shows a placeholder.
                  Editable so manual entries (no AI suggestion) still
                  have somewhere to jot what to write about. While the
                  AI is generating, the callout dims + swaps in a
                  loading row so the user sees that the click landed. */}
              <div
                className={cn(
                  "mb-5 rounded-lg border border-border bg-muted/30 px-4 py-3 transition-opacity",
                  working === "suggesting" && "pointer-events-none opacity-60",
                )}
              >
                <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  {working === "suggesting" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Sparkles className="size-3" />
                  )}
                  Exercise
                </div>
                {working === "suggesting" ? (
                  <p className="text-[13.5px] leading-relaxed text-muted-foreground italic">
                    Generating an exercise suited to your level…
                  </p>
                ) : (
                  <Textarea
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="The writing prompt. Click ‘Pick topic’ above to have one suggested, or type your own."
                    rows={2}
                    className="min-h-0 resize-none border-none bg-transparent p-0 text-[13.5px] leading-relaxed text-foreground/90 shadow-none focus-visible:ring-0"
                  />
                )}
              </div>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write here in the target language. Five short sentences are enough to start — the tutor will correct each one."
                className="min-h-[300px] resize-none bg-transparent text-[15px] leading-relaxed font-serif"
                autoFocus
              />
              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-[11.5px] text-muted-foreground">
                  Auto-saved as you type.
                </p>
                <Button
                  onClick={() => void submitForCorrection()}
                  disabled={working !== "idle" || body.trim().length < 10}
                >
                  {working === "correcting" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Reviewing…
                    </>
                  ) : (
                    <>
                      <Wand2 className="size-4" />
                      Correct sentence by sentence
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              The entry and any corrections will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                setConfirmDelete(false);
                await onDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function provenanceLabel(source: JournalSource | null): string {
  if (!source) return "Free-form";
  if (source === "ai") return "AI-suggested";
  if (source === "vocab") return "Vocabulary-driven";
  if (source === "manual") return "Manual topic";
  if (typeof source === "object" && source.kind === "chapter") {
    return "From textbook";
  }
  return "Manual topic";
}

function TopicSourcePopover({
  disabled,
  suggesting,
  onSuggest,
  onSuggestFromVocab,
  onChapterPick,
}: {
  disabled: boolean;
  /** True while a suggest call is in flight — swaps the trigger
   *  button's icon + label so the user sees their click landed.
   *  The `disabled` flag still gates re-entry. */
  suggesting: boolean;
  onSuggest: () => void;
  onSuggestFromVocab: () => void;
  onChapterPick: (chapter: LibraryChapter) => void;
}) {
  const { active: workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [textbook, setTextbook] = useState<LibraryItem | null>(null);
  const [chapters, setChapters] = useState<LibraryChapter[]>([]);

  // Lazy-load the active textbook + its chapters when the popover
  // opens — we don't want to fire library queries on every Journal
  // mount when the user might not even use this menu.
  useEffect(() => {
    if (!open || !workspace) return;
    let cancelled = false;
    void (async () => {
      try {
        const items = await listLibrary(workspace.id);
        const tb =
          items.find((i) => i.kind === "textbook" && i.status === "active") ??
          items.find((i) => i.kind === "textbook") ??
          null;
        if (cancelled) return;
        setTextbook(tb);
        if (tb) {
          const chs = await listChapters(tb.id);
          if (!cancelled) setChapters(chs);
        } else {
          setChapters([]);
        }
      } catch {
        if (!cancelled) setChapters([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspace?.id]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          title={suggesting ? "Generating exercise…" : "Pick a topic source"}
        >
          {suggesting ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Sparkles className="size-3.5" />
              Pick topic
              <ChevronDown className="size-3" />
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-1.5">
        <button
          type="button"
          onClick={() => {
            onSuggest();
            setOpen(false);
          }}
          className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/60"
        >
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium">Surprise me</p>
            <p className="text-[11.5px] text-muted-foreground">
              Free-form AI-suggested topic at your level.
            </p>
          </div>
        </button>
        <button
          type="button"
          onClick={() => {
            onSuggestFromVocab();
            setOpen(false);
          }}
          className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/60"
        >
          <Pencil className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium">Use my vocabulary</p>
            <p className="text-[11.5px] text-muted-foreground">
              Topic that exercises the words you&apos;re currently learning.
            </p>
          </div>
        </button>
        {textbook && chapters.length > 0 && (
          <>
            <div className="my-1 h-px bg-border" />
            <p className="px-2 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              From {textbook.title}
            </p>
            <div className="max-h-64 overflow-y-auto">
              {chapters.map((ch, idx) => (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => {
                    onChapterPick(ch);
                    setOpen(false);
                  }}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
                >
                  <BookOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px]">
                      <span className="font-mono text-[10.5px] text-muted-foreground">
                        {String(idx + 1).padStart(2, "0")}
                      </span>{" "}
                      {ch.title}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function CorrectionView({
  corrections,
  onContinueEditing,
}: {
  corrections: JournalCorrection[];
  onContinueEditing: () => void;
}) {
  const stats = useMemo(() => {
    const ok = corrections.filter((c) => c.severity === "ok").length;
    const minor = corrections.filter((c) => c.severity === "minor").length;
    const major = corrections.filter((c) => c.severity === "major").length;
    return { ok, minor, major, total: corrections.length };
  }, [corrections]);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Review summary
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
            {stats.ok} ok
          </span>
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300">
            {stats.minor} minor
          </span>
          <span className="rounded-full bg-rose-500/15 px-2 py-0.5 font-medium text-rose-700 dark:text-rose-300">
            {stats.major} major
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
            {stats.total} total
          </span>
        </div>
      </div>

      <ol className="space-y-3">
        {corrections.map((c, i) => (
          <CorrectionRow key={i} idx={i + 1} correction={c} />
        ))}
      </ol>

      <div className="flex justify-end">
        <Button variant="outline" onClick={onContinueEditing}>
          <Pencil className="size-3.5" />
          Continue editing
        </Button>
      </div>
    </div>
  );
}

function CorrectionRow({
  idx,
  correction,
}: {
  idx: number;
  correction: JournalCorrection;
}) {
  const accent =
    correction.severity === "ok"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : correction.severity === "major"
      ? "border-rose-500/40 bg-rose-500/5"
      : "border-amber-500/40 bg-amber-500/5";
  const label =
    correction.severity === "ok"
      ? "Correct"
      : correction.severity === "major"
      ? "Major"
      : "Minor";
  const labelColor =
    correction.severity === "ok"
      ? "text-emerald-700 dark:text-emerald-300"
      : correction.severity === "major"
      ? "text-rose-700 dark:text-rose-300"
      : "text-amber-700 dark:text-amber-300";
  const changed = correction.original.trim() !== correction.corrected.trim();

  return (
    <li className={cn("rounded-xl border px-4 py-3", accent)}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
          {String(idx).padStart(2, "0")}
        </span>
        <span className={cn("text-[10.5px] font-semibold uppercase tracking-wider", labelColor)}>
          {label}
        </span>
      </div>
      <div className="mt-1.5 space-y-1.5">
        <p className={cn(
          "font-serif text-[15px] leading-snug",
          changed && "text-muted-foreground line-through decoration-rose-400/60",
        )}>
          {correction.original}
        </p>
        {changed && (
          <p className="font-serif text-[15px] leading-snug">
            {correction.corrected}
          </p>
        )}
      </div>
      {correction.explanation && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
          {correction.explanation}
        </p>
      )}
    </li>
  );
}
