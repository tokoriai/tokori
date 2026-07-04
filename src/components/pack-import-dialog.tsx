import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  Eye,
  FileJson,
  Loader2,
  Package,
  ShoppingBag,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  importPack,
  readPackFile,
  summarisePack,
  validatePack,
  type ImportProgress,
  type Pack,
  type PackChapter,
  type PackSummary,
  type PackTextbook,
  type TextbookImportMode,
  type TextbookPreference,
} from "@/lib/pack-import";
import {
  freePacksForLanguage,
  type FreePackEntry,
} from "@/lib/free-packs";
import { triggerCloudRefresh } from "@/lib/cloud-refresh";
import { useWorkspace } from "@/lib/workspace-context";
import { languageName } from "@/lib/languages";
import { PacksBrowser } from "@/components/packs-browser";
import { PackPreviewDialog } from "@/components/pack-preview-dialog";
import { CloudSignInDialog } from "@/components/cloud-signin-dialog";

/**
 * Drag-drop or file-pick a `.json` pack file. We parse, validate, and show
 * a preview before kicking off the import — so a buyer who downloaded the
 * wrong file or a corrupted one finds out before any rows hit the database.
 */
export function PackImportDialog({
  open,
  onClose,
  onImported,
  presetPack,
  presetTitle,
}: {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
  /** Pre-validated pack to land directly on the preview step.
   *  When set, the free-pack list and drop zone are hidden — the
   *  dialog is purely "review this pack and pick activation options".
   *  Used by the store flow after a successful purchase so a buyer
   *  gets the same prefs UX as a free-pack redeem. */
  presetPack?: Pack | null;
  /** Optional title override for the preset case (e.g. "Redeem your
   *  pack"). Falls back to the standard "Redeem a pack" title. */
  presetTitle?: string;
}) {
  const { active: workspace } = useWorkspace();
  const [pack, setPack] = useState<Pack | null>(null);
  const [summary, setSummary] = useState<PackSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // One pref per textbook in the pack. Defaults to "library" mode (no
  // chapter activation) so importing a 15-lesson textbook doesn't
  // dump 200 cards into the user's review queue. The user can switch
  // to "I'm currently on lesson N" to get the smart seeding flow.
  const [textbookPrefs, setTextbookPrefs] = useState<
    Record<string, TextbookPreference>
  >({});
  // Which textbook cards are expanded. On packs with one textbook
  // this is functionally irrelevant — the one card is always open.
  // On bundles (HSK 1+2+3 etc.) only the first card opens by default
  // so the dialog doesn't render as a wall of radio groups.
  const [expandedTextbookIds, setExpandedTextbookIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Sign-in modal is layered on top of this dialog. Triggered from
  // the Browse tab when an unauthenticated user clicks Buy.
  const [signInOpen, setSignInOpen] = useState(false);
  // Free-pack preview state. The Browse tab handles paid-pack previews
  // internally via PacksBrowser; the Free tab manages its own preview
  // here so the row-level Preview button can lazy-load the JSON.
  const [previewFree, setPreviewFree] = useState<FreePackEntry | null>(null);
  const [previewFreePack, setPreviewFreePack] = useState<Pack | null>(null);
  const [previewFreeLoading, setPreviewFreeLoading] = useState(false);
  // Tracks the currently-installing free pack id so we can show a
  // spinner on the right row only.
  const [installingFreeId, setInstallingFreeId] = useState<string | null>(null);

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setPack(null);
      setSummary(null);
      setError(null);
      setParsing(false);
      setImporting(false);
      setProgress(null);
      setDragOver(false);
      setTextbookPrefs({});
      setExpandedTextbookIds(new Set());
    }
  }, [open]);

  // When a preset pack is handed in, drop straight into the
  // preview state. We still validate the workspace-language match
  // so a buyer who switched workspaces between purchase and redeem
  // gets the same friendly error as the file-picker path.
  useEffect(() => {
    if (!open || !presetPack) return;
    if (workspace && presetPack.language !== workspace.targetLang) {
      setError(
        `This pack is for ${languageName(presetPack.language)}, but your active workspace is ${languageName(
          workspace.targetLang,
        )}. Switch workspaces or create a new ${languageName(presetPack.language)} workspace before importing.`,
      );
      setPack(null);
      setSummary(null);
      return;
    }
    setError(null);
    setPack(presetPack);
    setSummary(summarisePack(presetPack));
  }, [open, presetPack, workspace]);

  // When a pack is freshly parsed, set up the per-textbook prefs.
  // Default is "library" — the pack lands as textbooks + collections
  // (reference material), and NO vocab enters the SRS queue. That
  // matches the mental model packs are meant to support: "I'm
  // installing a course; I'll pick what to study from it later." If
  // the user already knows earlier chapters, they can switch to
  // "previous-known" to seed those as mastered. The old default —
  // "previous-known" — silently queued hundreds of cards on every
  // pack install, which surprised users who just wanted the textbook
  // available as reference.
  // Collections are always imported in full — the user can prune
  // unwanted ones from the Collections view after install, where
  // they have actual content visible to decide against.
  useEffect(() => {
    if (!pack) return;
    const tbNext: Record<string, TextbookPreference> = {};
    for (const t of pack.textbooks ?? []) {
      tbNext[t.id] = {
        textbookId: t.id,
        mode: "library",
        currentChapter: 1,
      };
    }
    setTextbookPrefs(tbNext);
    // Open the first textbook by default. Multi-textbook bundles
    // stay otherwise collapsed so the dialog is a scannable list,
    // not a wall of radio groups.
    const firstId = pack.textbooks?.[0]?.id;
    setExpandedTextbookIds(firstId ? new Set([firstId]) : new Set());
  }, [pack]);

  /** Load a bundled free pack and hand it to the parse/preview slot.
   *  Same downstream flow as the file-drop path: validate → set
   *  pack + summary → the activation prefs UI appears. */
  async function installFreePack(entry: FreePackEntry) {
    setError(null);
    setInstallingFreeId(entry.id);
    try {
      const raw = await entry.load();
      const valid = validatePack(raw);
      if (!valid.ok) {
        setError(valid.error);
        return;
      }
      if (workspace && valid.pack.language !== workspace.targetLang) {
        setError(
          `This pack is for ${languageName(valid.pack.language)}, but your active workspace is ${languageName(
            workspace.targetLang,
          )}. Switch workspaces or create a new ${languageName(valid.pack.language)} workspace before importing.`,
        );
        return;
      }
      setPack(valid.pack);
      setSummary(summarisePack(valid.pack));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingFreeId(null);
    }
  }

  /** Open the preview dialog for a bundled free pack. Loads the JSON
   *  on demand (the import() inside `entry.load()` is cached after the
   *  first call, so a Preview-then-Install only pays the parse cost
   *  once). */
  async function openFreePreview(entry: FreePackEntry) {
    setPreviewFree(entry);
    setPreviewFreePack(null);
    setPreviewFreeLoading(true);
    try {
      const raw = await entry.load();
      const valid = validatePack(raw);
      if (valid.ok) {
        setPreviewFreePack(valid.pack);
      } else {
        toast.error(`Pack file looks invalid: ${valid.error}`);
        setPreviewFree(null);
      }
    } catch (err) {
      toast.error(
        `Couldn't load pack: ${err instanceof Error ? err.message : String(err)}`,
      );
      setPreviewFree(null);
    } finally {
      setPreviewFreeLoading(false);
    }
  }

  function closeFreePreview() {
    setPreviewFree(null);
    setPreviewFreePack(null);
    setPreviewFreeLoading(false);
  }

  async function handleFile(f: File | null | undefined) {
    if (!f) return;
    setError(null);
    setParsing(true);
    try {
      const valid = await readPackFile(f);
      if (!valid.ok) {
        setError(valid.error);
        setPack(null);
        setSummary(null);
        return;
      }
      // Cross-check that the pack language matches the workspace. Importing a
      // Chinese pack into a German workspace would put hanzi into a German
      // vocab list — silently confusing, so we block early.
      if (workspace && valid.pack.language !== workspace.targetLang) {
        setError(
          `This pack is for ${languageName(valid.pack.language)}, but your active workspace is ${languageName(
            workspace.targetLang,
          )}. Switch workspaces or pick a matching pack.`,
        );
        setPack(null);
        setSummary(null);
        return;
      }
      setPack(valid.pack);
      setSummary(summarisePack(valid.pack));
    } finally {
      setParsing(false);
    }
  }

  async function runImport() {
    if (!pack || !workspace) return;
    setImporting(true);
    setProgress({ stage: "starting", ratio: 0, wordsTotal: 0 });
    try {
      const result = await importPack({
        workspaceId: workspace.id,
        pack,
        textbookPrefs: Object.values(textbookPrefs),
        // collectionPrefs intentionally omitted — the importer
        // defaults missing entries to include: true, which matches
        // the dialog's "always import all collections" behaviour.
        onProgress: (p) => setProgress(p),
      });
      const parts: string[] = [];
      if (result.collectionsCreated > 0)
        parts.push(`${result.collectionsCreated} collection${result.collectionsCreated === 1 ? "" : "s"}`);
      if (result.textbooksCreated > 0)
        parts.push(`${result.textbooksCreated} textbook${result.textbooksCreated === 1 ? "" : "s"}`);
      if (result.chaptersCreated > 0)
        parts.push(`${result.chaptersCreated} chapter${result.chaptersCreated === 1 ? "" : "s"}`);
      const skipMsg =
        result.collectionsSkipped + result.textbooksSkipped > 0
          ? ` · ${result.collectionsSkipped + result.textbooksSkipped} already-installed item${
              result.collectionsSkipped + result.textbooksSkipped === 1 ? "" : "s"
            } updated in place.`
          : "";
      toast.success(
        `Imported "${pack.name}" — ${result.wordsCreated.toLocaleString()} words across ${parts.join(", ") || "no new items"}.${skipMsg}`,
      );
      onImported?.();
      // Broadcast to every mounted view so freshly-imported vocab,
      // collections, library items, etc. show up immediately —
      // without this, only the surface that owns the dialog
      // (Collections / Library) refreshes; the Vocab list waits
      // until the next navigation. The bus is workspace-aware on
      // the consumer side, so views that aren't relevant simply
      // ignore the tick.
      triggerCloudRefresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      setProgress(null);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={(v) => !v && !importing && !parsing && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="size-5" />
            {presetTitle ?? "Redeem a pack"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {presetPack ? (
            <p className="text-[12.5px] text-muted-foreground">
              Pick how you want this pack to land in your workspace. Textbooks
              and vocab lists are added as reference by default — nothing enters
              your Flashcards queue until you choose to activate it.
            </p>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">
              Drag in (or pick) the <code className="rounded bg-muted px-1.5 py-0.5 text-[11.5px]">.json</code> pack file
              you got after purchase. Textbooks, chapters, and vocab collections are added to your active workspace
              as reference — nothing enters your Flashcards queue until you choose to activate it. To bulk-import
              words you already know from Duolingo, HackChinese, or a CSV, use{" "}
              <span className="font-medium text-foreground">Vocabulary → Import CSV</span> instead.
              Re-importing the same pack is safe — anything already there is updated in place.
            </p>
          )}

          {/* Source picker — hidden once a pack is parsed (the
              preview + activation prefs take over) and when a preset
              pack is handed in (the buyer just wants to redeem the
              thing they bought). Two tabs:
                · Free packs — built-in bundled packs (no account
                  required) plus the drop zone for user-supplied JSON.
                  Each row has Preview + Install buttons.
                · Browse — paid packs from the cloud catalog only.
                  No free packs here — those live in the Free tab.
                  Requires sign-in to buy; redeem is one click for
                  already-owned packs. */}
          {!pack && !presetPack && workspace && (
            <Tabs defaultValue="free" className="w-full">
              <TabsList className="w-full">
                <TabsTrigger value="free" className="flex-1">
                  <BookOpen className="size-3.5" />
                  Free packs
                </TabsTrigger>
                <TabsTrigger value="browse" className="flex-1">
                  <ShoppingBag className="size-3.5" />
                  Browse
                </TabsTrigger>
              </TabsList>

              <TabsContent value="free" className="mt-3 space-y-3">
                {freePacksForLanguage(workspace.targetLang).length > 0 && (
                  <div className="grid gap-2">
                    {freePacksForLanguage(workspace.targetLang).map((p) => (
                      <div
                        key={p.id}
                        className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5"
                      >
                        <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <h4 className="truncate text-[13.5px] font-medium">
                              {p.title}
                            </h4>
                            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                              {p.preview.vocabCount.toLocaleString()} words
                              {p.preview.chapterCount
                                ? ` · ${p.preview.chapterCount} chapters`
                                : ""}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                            {p.pitch}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void openFreePreview(p)}
                            disabled={installingFreeId != null || parsing || importing}
                            aria-label="Preview pack contents"
                          >
                            <Eye className="size-3.5" />
                            Preview
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => void installFreePack(p)}
                            disabled={installingFreeId != null || parsing || importing}
                          >
                            {installingFreeId === p.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : null}
                            Install
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    void handleFile(f);
                  }}
                  className={
                    "flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-6 text-center transition-colors " +
                    (dragOver
                      ? "border-foreground/40 bg-accent/30"
                      : "border-border bg-muted/20")
                  }
                >
                  <FileJson className="size-6 text-muted-foreground" />
                  <p className="text-[12.5px] font-medium">
                    Or drop a{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                      .json
                    </code>{" "}
                    pack file
                  </p>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      void handleFile(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={parsing || importing}
                    className="mt-1"
                  >
                    Choose file
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="browse" className="mt-3">
                <PacksBrowser
                  filterLang={workspace.targetLang}
                  emptyMessage={`No paid packs for ${languageName(workspace.targetLang)} yet — check back soon.`}
                  onSignInRequested={() => setSignInOpen(true)}
                  onRedeem={(downloaded) => {
                    // Swap the dialog's content from "pick a pack" to
                    // "review and activate this one". Same downstream
                    // flow as the free-pack and drop-zone paths.
                    setPack(downloaded);
                    setSummary(summarisePack(downloaded));
                  }}
                />
              </TabsContent>
            </Tabs>
          )}

          {parsing && (
            <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Parsing pack…
            </p>
          )}

          {/* Preview card after a successful parse. Counts give the buyer
              confidence the pack is what they expected before they commit. */}
          {pack && summary && (
            <div className="rounded-md border border-border bg-card px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-serif text-lg tracking-tight">{pack.name}</h3>
                <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                  {languageName(pack.language)}
                </span>
              </div>
              {pack.description && (
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                  {pack.description}
                </p>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2 text-[12.5px]">
                <Stat
                  label="Collections"
                  value={summary.collectionCount}
                  sub={`${summary.collectionWordCount.toLocaleString()} words`}
                />
                <Stat
                  label="Textbooks"
                  value={summary.textbookCount}
                  sub={`${summary.textbookChapterCount} chapter${
                    summary.textbookChapterCount === 1 ? "" : "s"
                  } · ${summary.textbookVocabCount.toLocaleString()} words`}
                  icon={<BookOpen className="size-3.5" />}
                />
              </div>
              {pack.version && (
                <p className="mt-2 text-[10.5px] text-muted-foreground">
                  Version {pack.version}
                  {pack.license ? ` · ${pack.license}` : ""}
                </p>
              )}
            </div>
          )}

          {/* Per-textbook activation picker. Only renders when the pack
              ships a textbook — most non-textbook packs land here as
              just collections + dict, where library-style import is
              already the right default. Each textbook collapses to a
              one-line summary on multi-textbook bundles so the dialog
              stays scannable; the first card is open by default and
              the rest expand on click. */}
          {pack && (pack.textbooks?.length ?? 0) > 0 && (
            <div className="space-y-2">
              {(pack.textbooks ?? []).map((t, i) => {
                const pref = textbookPrefs[t.id];
                if (!pref) return null;
                return (
                  <TextbookCard
                    key={t.id}
                    textbook={t}
                    pref={pref}
                    previousTextbooks={(pack.textbooks ?? []).slice(0, i)}
                    expanded={expandedTextbookIds.has(t.id)}
                    onToggleExpand={() =>
                      setExpandedTextbookIds((s) => {
                        const next = new Set(s);
                        if (next.has(t.id)) next.delete(t.id);
                        else next.add(t.id);
                        return next;
                      })
                    }
                    onChange={(p) =>
                      setTextbookPrefs((s) => ({ ...s, [t.id]: p }))
                    }
                  />
                );
              })}
            </div>
          )}

          {/* Progress bar during import. The pack-import library streams
              `wordsTotal` so we show what's actually been written. */}
          {importing && progress && (
            <div className="space-y-1.5">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-foreground transition-all"
                  style={{ width: `${Math.round(progress.ratio * 100)}%` }}
                />
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                {progress.stage === "collections"
                  ? "Importing collections"
                  : progress.stage === "textbooks"
                    ? "Importing textbooks"
                    : "Starting"}
                {" · "}
                {progress.wordsTotal.toLocaleString()} word
                {progress.wordsTotal === 1 ? "" : "s"} written
              </p>
            </div>
          )}

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive whitespace-pre-line">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={importing || parsing}>
            Cancel
          </Button>
          <Button
            onClick={runImport}
            disabled={!pack || importing || parsing}
          >
            {importing && <Loader2 className="size-3.5 animate-spin" />}
            Install pack
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <CloudSignInDialog
      open={signInOpen}
      onClose={() => setSignInOpen(false)}
    />
    <PackPreviewDialog
      pack={previewFreePack}
      loading={previewFreeLoading}
      primaryAction={
        previewFree
          ? {
              label:
                installingFreeId === previewFree.id ? "Installing…" : "Install",
              disabled: installingFreeId != null,
              onClick: () => {
                const entry = previewFree;
                closeFreePreview();
                if (entry) void installFreePack(entry);
              },
            }
          : undefined
      }
      onClose={closeFreePreview}
    />
    </>
  );
}

/** One textbook in the per-pack picker. Collapsed by default on bundles;
 *  the header always shows a live summary of what this textbook will do
 *  on import, so the user can scan a multi-textbook bundle without
 *  expanding each one. Activation is opt-in: "library" mode is the
 *  implicit default (no radio shown), and the two activation modes are
 *  click-once-to-toggle, click-again-to-clear. */
function TextbookCard({
  textbook,
  pref,
  previousTextbooks,
  expanded,
  onToggleExpand,
  onChange,
}: {
  textbook: PackTextbook;
  pref: TextbookPreference;
  /** Textbooks positioned earlier than this one in the pack. Drives
   *  the "Also mark earlier books as known" checkbox and the
   *  cross-book Known total in the chapter picker / summary line. */
  previousTextbooks: PackTextbook[];
  expanded: boolean;
  onToggleExpand: () => void;
  onChange: (next: TextbookPreference) => void;
}) {
  const chapters = textbook.chapters;
  const totalWords = useMemo(
    () => chapters.reduce((n, c) => n + (c.vocab?.length ?? 0), 0),
    [chapters],
  );
  const previousBookWords = useMemo(
    () =>
      previousTextbooks.reduce(
        (sum, tb) =>
          sum +
          tb.chapters.reduce((n, c) => n + (c.vocab?.length ?? 0), 0),
        0,
      ),
    [previousTextbooks],
  );
  const includePrevious =
    pref.mode === "previous-known" &&
    previousTextbooks.length > 0 &&
    !!pref.includePreviousTextbooks;
  const summary = activationSummary(
    chapters,
    pref,
    includePrevious ? previousBookWords : 0,
  );

  function setMode(mode: TextbookImportMode) {
    // Click the active mode again → toggle back to library (the
    // implicit default). Otherwise switch to the requested mode and
    // carry the current chapter forward. Switching modes clears the
    // cross-book flag — it only makes sense under "previous-known".
    if (pref.mode === mode) {
      onChange({
        textbookId: pref.textbookId,
        mode: "library",
        currentChapter: pref.currentChapter,
        includePreviousTextbooks: false,
      });
      return;
    }
    onChange({
      textbookId: pref.textbookId,
      mode,
      currentChapter: pref.currentChapter ?? 1,
      includePreviousTextbooks:
        mode === "previous-known" ? pref.includePreviousTextbooks : false,
    });
  }

  function toggleIncludePrevious(next: boolean) {
    onChange({
      textbookId: pref.textbookId,
      mode: pref.mode,
      currentChapter: pref.currentChapter,
      includePreviousTextbooks: next,
    });
  }

  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/20"
      >
        <BookOpen className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <h4 className="truncate text-[13px] font-medium">
              {textbook.title}
            </h4>
            <span className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums">
              {chapters.length} ch · {totalWords.toLocaleString()} words
            </span>
          </div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
            {summary}
          </p>
        </div>
        <ChevronDown
          className={
            "size-4 shrink-0 text-muted-foreground transition-transform " +
            (expanded ? "rotate-180" : "")
          }
        />
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-1.5">
          <p className="text-[11.5px] text-muted-foreground">
            Installs as reference by default — nothing enters Flashcards.
            Pick an option below if you want the SRS to seed from this
            textbook now. Click again to clear.
          </p>
          <ModeRadio
            pref={pref}
            value="previous-known"
            label="I already know previous chapters"
            sub="Chapters before this one seed as mastered (resurface in months as retention checks). Current chapter activates as new."
            chapters={chapters}
            extraKnownWords={includePrevious ? previousBookWords : 0}
            onChange={onChange}
            onToggle={setMode}
          />
          {pref.mode === "previous-known" && previousTextbooks.length > 0 && (
            <label className="ml-6 flex cursor-pointer items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2">
              <input
                type="checkbox"
                checked={!!pref.includePreviousTextbooks}
                onChange={(e) => toggleIncludePrevious(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
                className="mt-0.5 h-3.5 w-3.5 accent-foreground"
              />
              <div className="flex-1">
                <p className="text-[12px] font-medium leading-tight">
                  Also mark earlier books as known
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  Seeds every chapter of{" "}
                  {previousTextbooks
                    .map((tb) => tb.title)
                    .join(", ")}{" "}
                  as mastered — {previousBookWords.toLocaleString()} extra
                  word{previousBookWords === 1 ? "" : "s"} added to long-term
                  retention. Pick this when you've already worked through the
                  prerequisite levels of a course series.
                </p>
              </div>
            </label>
          )}
          <ModeRadio
            pref={pref}
            value="current-only"
            label="I'm starting a chapter — activate just that one"
            sub="Only the current chapter's vocab enters review."
            chapters={chapters}
            onChange={onChange}
            onToggle={setMode}
          />
        </div>
      )}
    </div>
  );
}

/** One-line "what this textbook will do on import" summary, used in the
 *  collapsed-card header. Stays in sync with the actual import counts
 *  the user sees if they expand the picker. `extraKnownWords` folds
 *  in word counts from earlier books in the same pack when the user
 *  ticked the cross-book "include previous books" checkbox. */
function activationSummary(
  chapters: PackChapter[],
  pref: TextbookPreference,
  extraKnownWords: number,
): string {
  if (pref.mode === "library") return "Reference only — no cards in review.";
  const idx = Math.max(
    0,
    Math.min(chapters.length - 1, (pref.currentChapter ?? 1) - 1),
  );
  let known = extraKnownWords;
  let due = 0;
  for (let i = 0; i < chapters.length; i++) {
    const n = chapters[i].vocab?.length ?? 0;
    if (pref.mode === "previous-known") {
      if (i < idx) known += n;
      else if (i === idx) due += n;
    } else if (pref.mode === "current-only") {
      if (i === idx) due += n;
    } else if (pref.mode === "everything-new") {
      due += n;
    }
  }
  const current = chapters[idx];
  const head = `Ch ${pref.currentChapter ?? 1}: ${current?.title ?? ""}`;
  if (pref.mode === "previous-known") {
    return `${head} — ${due} new, ${known.toLocaleString()} seeded as known.`;
  }
  if (pref.mode === "current-only") {
    return `${head} — ${due} new.`;
  }
  return head;
}

function ModeRadio({
  pref,
  value,
  label,
  sub,
  chapters,
  extraKnownWords = 0,
  onChange,
  onToggle,
}: {
  pref: TextbookPreference;
  value: TextbookImportMode;
  label: string;
  sub: string;
  /** Full chapter list — used to drive the slider's max, the
   *  chapter-title label, and the stats card. */
  chapters: PackChapter[];
  /** Words from earlier books in the same pack (HSK 1+2 when the
   *  user is on HSK 3 with "include previous books" ticked). Folded
   *  into the "Known" stat tile so the user sees the real total. */
  extraKnownWords?: number;
  onChange: (next: TextbookPreference) => void;
  onToggle: (mode: TextbookImportMode) => void;
}) {
  const selected = pref.mode === value;
  const maxChapter = chapters.length;
  const currentChapter = Math.max(
    1,
    Math.min(maxChapter, pref.currentChapter ?? 1),
  );
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onToggle(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(value);
        }
      }}
      className={
        "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors " +
        (selected
          ? "border-foreground/40 bg-accent/40"
          : "border-border bg-card hover:bg-accent/20")
      }
    >
      <span
        aria-hidden
        className={
          "mt-1 size-3.5 shrink-0 rounded-full border transition-colors " +
          (selected ? "border-foreground bg-foreground" : "border-muted-foreground/40")
        }
      />
      <div className="flex-1">
        <p className="text-[12.5px] font-medium leading-tight">{label}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {sub}
        </p>
        {selected && maxChapter > 0 && (
          <ChapterPicker
            chapters={chapters}
            mode={value}
            currentChapter={currentChapter}
            extraKnownWords={extraKnownWords}
            onChange={(n) =>
              onChange({
                ...pref,
                mode: value,
                currentChapter: n,
              })
            }
          />
        )}
      </div>
    </div>
  );
}

/** Slider + live chapter title + per-mode stats. Replaces the old
 *  number-spinner so the user gets visual feedback on (a) which
 *  chapter they've landed on (the title under the slider) and
 *  (b) what the import will actually do at this position (the
 *  stats grid). The stats are computed from each chapter's
 *  `vocab.length`, so they match the real word counts the
 *  importer will write. */
function ChapterPicker({
  chapters,
  mode,
  currentChapter,
  extraKnownWords = 0,
  onChange,
}: {
  chapters: PackChapter[];
  mode: TextbookImportMode;
  /** 1-indexed (matches the existing TextbookPreference contract). */
  currentChapter: number;
  /** Words from earlier books in the pack that the user marked as
   *  known via the cross-book checkbox. Added to the Known counter so
   *  the stats grid reflects the true seed size. */
  extraKnownWords?: number;
  onChange: (next: number) => void;
}) {
  const maxChapter = chapters.length;
  const idx = Math.max(0, Math.min(chapters.length - 1, currentChapter - 1));
  const current = chapters[idx];
  // Per-mode counters. 0-indexed positions for the math:
  //   "previous-known": chapters [0..idx-1] = mastered seed, chapter
  //     [idx] = activated as new (due), chapters (idx..end] = library.
  //   "current-only":   chapter [idx] = activated as new (due), all
  //     others = library.
  let knownWords = extraKnownWords;
  let dueWords = 0;
  let libraryWords = 0;
  for (let i = 0; i < chapters.length; i++) {
    const n = chapters[i].vocab?.length ?? 0;
    if (mode === "previous-known") {
      if (i < idx) knownWords += n;
      else if (i === idx) dueWords += n;
      else libraryWords += n;
    } else if (mode === "current-only") {
      if (i === idx) dueWords += n;
      else libraryWords += n;
    } else if (mode === "everything-new") {
      dueWords += n;
    } else {
      libraryWords += n;
    }
  }

  // Stop the slider from bubbling its click up to the wrapping
  // <label>, which would otherwise toggle the radio off-and-on
  // every drag — visible as flicker in the parent border.
  const stop = (e: React.MouseEvent | React.TouchEvent | React.KeyboardEvent) =>
    e.stopPropagation();

  return (
    <div className="mt-3 space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Current chapter
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {currentChapter} / {maxChapter}
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={maxChapter}
        step={1}
        value={currentChapter}
        onChange={(e) => onChange(Number(e.target.value) || 1)}
        onClick={stop}
        onMouseDown={stop}
        onTouchStart={stop}
        onKeyDown={stop}
        className="w-full accent-foreground"
        aria-label="Current chapter"
      />
      <p className="text-[12px] leading-tight">
        <span className="text-muted-foreground">Lesson {currentChapter}: </span>
        <span className="font-medium">{current?.title ?? "—"}</span>
      </p>

      {/* Stats grid — three cells reflecting how this mode + slider
          position will land in the SRS. Cells with zero counts are
          rendered muted so the live-changing ones pop. */}
      <div className="grid grid-cols-3 gap-1.5 rounded-md border border-border bg-background/40 p-2 text-[11px]">
        <StatCell
          tone="emerald"
          label="Known"
          n={knownWords}
          hint="seeded as mastered"
        />
        <StatCell
          tone="sky"
          label="Due / new"
          n={dueWords}
          hint="enter review now"
        />
        <StatCell
          tone="muted"
          label="Library"
          n={libraryWords}
          hint="reference only"
        />
      </div>
    </div>
  );
}

function StatCell({
  tone,
  label,
  n,
  hint,
}: {
  tone: "emerald" | "sky" | "muted";
  label: string;
  n: number;
  hint: string;
}) {
  const empty = n === 0;
  const toneClass =
    tone === "emerald"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
      : tone === "sky"
        ? "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300"
        : "border-border bg-card text-muted-foreground";
  return (
    <div
      className={
        "flex flex-col gap-0.5 rounded-sm border px-2 py-1.5 transition-opacity " +
        toneClass +
        (empty ? " opacity-50" : "")
      }
    >
      <span className="text-[9.5px] font-medium uppercase tracking-wider">
        {label}
      </span>
      <span className="text-[15px] font-semibold tabular-nums leading-tight">
        {n.toLocaleString()}
      </span>
      <span className="text-[9.5px] leading-tight text-muted-foreground">
        {hint}
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: number;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tracking-tight">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
