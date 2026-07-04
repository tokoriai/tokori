/**
 * Read-only stats + history view for a vocab card. Pops when the user
 * taps a row in BrowseMode (or anywhere else cards are listed) — the
 * existing CardEditorDialog stays for actual edits, this one focuses
 * on "tell me what's going on with this card."
 *
 * Sections:
 *   - Header: word + reading + gloss + image preview + cached audio
 *   - SRS state: status badge, current stability/difficulty, next due
 *   - Stats: total reviews, breakdown by grade, lapse count
 *   - History: per-review row with grade + before/after stability
 *   - Actions: Edit / Reset to new / Mark mastered / Delete
 *
 * Stability is shown as days because that's the unit FSRS treats as
 * "memory half-life" and it matches what the user sees in the due-at
 * line (e.g. "due in 14 days, stability 12d → review will reinforce
 * and push it out further").
 */

import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { SpeakButton } from "@/components/speak-button";
import {
  activateVocab,
  deleteVocab,
  getVocabAudio,
  getVocabImage,
  getVocabReviewStats,
  listVocabReviews,
  reviewVocab,
  setVocabStatus,
  type VocabEntry,
  type VocabReview,
  type VocabReviewStats,
  type VocabStatus,
} from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";
import type { Grade } from "@/lib/fsrs";
import { cn } from "@/lib/utils";

const GRADE_TONE: Record<Grade, string> = {
  again: "bg-rose-100 text-rose-800",
  hard: "bg-amber-100 text-amber-800",
  good: "bg-blue-100 text-blue-800",
  easy: "bg-emerald-100 text-emerald-800",
};

const STATUS_LABEL: Record<VocabStatus, string> = {
  unseen: "Library",
  new: "New",
  learning: "Learning",
  review: "Review",
  mastered: "Mastered",
};

type Props = {
  open: boolean;
  card: VocabEntry | null;
  onClose: () => void;
  onEdit?: (card: VocabEntry) => void;
  /** Called when the card was changed (status reset, deleted, etc.)
   *  so the parent list can refetch. */
  onChanged?: () => void;
};

export function CardDetailDialog({
  open,
  card,
  onClose,
  onEdit,
  onChanged,
}: Props) {
  const { active: workspace } = useWorkspace();
  const [reviews, setReviews] = useState<VocabReview[]>([]);
  const [stats, setStats] = useState<VocabReviewStats | null>(null);
  const [imageData, setImageData] = useState<string | null>(null);
  const [hasAudio, setHasAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<
    | null
    | { kind: "delete" | "reset"; title: string; description: string }
  >(null);

  useEffect(() => {
    if (!card) return;
    let cancelled = false;
    void Promise.all([
      listVocabReviews(card.id, 50),
      getVocabReviewStats(card.id),
    ]).then(([r, s]) => {
      if (cancelled) return;
      setReviews(r);
      setStats(s);
    });
    setImageData(card.imageData ?? null);
    if (!card.imageData && card.hasImage) {
      void getVocabImage(card.id).then((bytes) => {
        if (!cancelled) setImageData(bytes);
      });
    }
    setHasAudio(card.hasAudio);
    if (card.hasAudio) {
      // Just probe — playback comes from the SpeakButton which fetches
      // bytes on demand.
      void getVocabAudio(card.id).then((res) => {
        if (!cancelled) setHasAudio(res != null && res.bytes.byteLength > 0);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [card]);

  // Compute the sparkline before the `!card` early return so this hook
  // runs unconditionally — otherwise the hook order changes when `card`
  // toggles null↔set and React throws "rendered more/fewer hooks".
  const sparkPath = useMemo(
    () => stabilitySparkline(reviews),
    [reviews],
  );

  if (!card) return null;

  const targetLang = workspace?.targetLang ?? "en";

  async function resetCard() {
    if (!card) return;
    setBusy(true);
    try {
      // Reset = nuke FSRS state without deleting the card or its
      // history. The user can start over from "new" while the
      // review log keeps the audit trail of what came before.
      await reviewVocab({
        id: card.id,
        status: "new",
        stability: 0,
        difficulty: 5,
        learningStep: 0,
        dueAt: null,
        grade: "again",
        // HOSTED fast-path — skip the probe-every-workspace walk.
        workspaceId: workspace?.id,
      });
      toast.success(`Reset "${card.word}" to new.`);
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error("Couldn't reset", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      setPendingConfirm(null);
    }
  }

  async function markMastered() {
    if (!card || !workspace) return;
    setBusy(true);
    try {
      await setVocabStatus({
        workspaceId: workspace.id,
        word: card.word,
        reading: card.reading,
        gloss: card.gloss,
        status: "mastered",
      });
      toast.success(`Marked "${card.word}" as mastered.`);
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error("Couldn't update", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeCard() {
    if (!card) return;
    setBusy(true);
    try {
      await deleteVocab(card.id);
      toast.success(`Deleted "${card.word}".`);
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error("Couldn't delete", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      setPendingConfirm(null);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
        <DialogContent className="max-w-2xl overflow-hidden p-0">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle className="font-serif text-lg tracking-tight">
              Card details
            </DialogTitle>
          </DialogHeader>

          <ScrollArea className="max-h-[72vh]">
            <div className="space-y-6 px-5 py-5">
              {/* Header */}
              <div className="flex items-start gap-4">
                {imageData && (
                  <img
                    src={imageData}
                    alt=""
                    className="h-20 w-20 shrink-0 rounded-md object-cover ring-1 ring-border"
                  />
                )}
                <div className="flex-1">
                  <div className="flex items-baseline gap-2">
                    <h2 className="font-serif text-3xl tracking-tight">
                      {card.word}
                    </h2>
                    <SpeakButton
                      text={card.word}
                      lang={targetLang}
                      vocabId={card.id}
                      cachedAudioAvailable={hasAudio}
                    />
                  </div>
                  {card.reading && (
                    <p className="mt-0.5 text-[13px] font-medium text-emerald-600 dark:text-emerald-400">
                      {card.reading}
                    </p>
                  )}
                  {card.gloss && (
                    <p className="mt-1 text-[13.5px] leading-relaxed text-foreground/85">
                      {card.gloss}
                    </p>
                  )}
                  {card.cardNotes && (
                    <p className="mt-2 text-[12.5px] italic leading-relaxed text-muted-foreground whitespace-pre-line">
                      {card.cardNotes}
                    </p>
                  )}
                </div>
              </div>

              <Separator />

              {/* SRS state */}
              <div>
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Current state
                </h3>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Status" value={STATUS_LABEL[card.status]} />
                  <Stat
                    label="Stability"
                    value={
                      card.stability > 0
                        ? `${formatDays(card.stability)}`
                        : "—"
                    }
                  />
                  <Stat
                    label="Difficulty"
                    value={card.difficulty.toFixed(1)}
                  />
                  <Stat
                    label="Next due"
                    value={
                      card.dueAt
                        ? formatRelative(card.dueAt * 1000)
                        : "—"
                    }
                  />
                </div>
                {!card.isActive && (
                  <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2.5">
                    <div>
                      <p className="text-[12px] font-medium">In your library</p>
                      <p className="text-[11px] text-muted-foreground">
                        Imported from a pack. It won't show up in study
                        sessions until you add it to your active learning.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={async () => {
                        if (!card) return;
                        setBusy(true);
                        try {
                          await activateVocab([card.id]);
                          toast.success(`"${card.word}" added to your learning.`);
                          onChanged?.();
                          onClose();
                        } finally {
                          setBusy(false);
                        }
                      }}
                      disabled={busy}
                    >
                      Add to learning
                    </Button>
                  </div>
                )}
              </div>

              <Separator />

              {/* Aggregate stats */}
              <div>
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Reviews so far
                </h3>
                {stats && stats.totalReviews > 0 ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Stat
                        label="Total"
                        value={stats.totalReviews.toLocaleString()}
                      />
                      <Stat label="Lapses" value={stats.lapses} />
                      <Stat
                        label="First seen"
                        value={
                          stats.firstReviewedAt
                            ? formatRelative(stats.firstReviewedAt * 1000)
                            : "—"
                        }
                      />
                      <Stat
                        label="Last review"
                        value={
                          stats.lastReviewedAt
                            ? formatRelative(stats.lastReviewedAt * 1000)
                            : "—"
                        }
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {(["again", "hard", "good", "easy"] as Grade[]).map((g) => (
                        <Badge
                          key={g}
                          className={cn("font-normal", GRADE_TONE[g])}
                        >
                          {g}: {stats.byGrade[g]}
                        </Badge>
                      ))}
                    </div>
                    {sparkPath && (
                      <div className="rounded-md border border-border bg-card p-2">
                        <p className="px-1 pb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                          Stability over time
                        </p>
                        <svg
                          width="100%"
                          height="48"
                          viewBox="0 0 200 48"
                          preserveAspectRatio="none"
                          className="overflow-visible"
                        >
                          <path
                            d={sparkPath}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            className="text-foreground/70"
                          />
                        </svg>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[12.5px] text-muted-foreground">
                    No reviews yet — this card hasn't been graded.
                  </p>
                )}
              </div>

              <Separator />

              {/* History list */}
              <div>
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  History
                </h3>
                {reviews.length === 0 ? (
                  <p className="text-[12.5px] text-muted-foreground">
                    No history yet.
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-md border border-border">
                    {reviews.map((r, i) => (
                      <div
                        key={r.id}
                        className={cn(
                          "flex items-center justify-between gap-3 px-3 py-1.5 text-[12px]",
                          i % 2 === 0 ? "bg-card" : "bg-muted/40",
                        )}
                      >
                        <span className="text-muted-foreground tabular-nums">
                          {formatRelative(r.reviewedAt * 1000)}
                        </span>
                        <Badge className={cn("font-normal", GRADE_TONE[r.grade])}>
                          {r.grade}
                        </Badge>
                        <span className="text-muted-foreground tabular-nums">
                          {r.prevStability != null
                            ? `${formatDays(r.prevStability)} → ${formatDays(r.newStability)}`
                            : `→ ${formatDays(r.newStability)}`}
                        </span>
                        <span className="text-muted-foreground">
                          {STATUS_LABEL[r.newStatus]}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>

          <div className="flex flex-wrap items-center gap-2 border-t border-border bg-card/40 px-5 py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onEdit?.(card)}
              disabled={busy}
            >
              <Pencil className="size-3.5" /> Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void markMastered()}
              disabled={busy || card.status === "mastered"}
            >
              <Sparkles className="size-3.5" /> Mark mastered
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setPendingConfirm({
                  kind: "reset",
                  title: `Reset "${card.word}"?`,
                  description:
                    "Sends the card back to 'new' and clears its FSRS state. The review history is kept.",
                })
              }
              disabled={busy}
            >
              <RotateCcw className="size-3.5" /> Reset
            </Button>
            {card.gloss && (
              <Button
                variant="ghost"
                size="sm"
                disabled
                title="Open in dictionary (coming soon)"
              >
                <BookOpen className="size-3.5" /> Dictionary
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {busy && (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setPendingConfirm({
                    kind: "delete",
                    title: `Delete "${card.word}"?`,
                    description:
                      "The card and its review history are removed. Cards from packs can be re-added later.",
                  })
                }
                disabled={busy}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3.5" /> Delete
              </Button>
            </div>
          </div>

          {/* Suppress unused-import warnings for icons we reference but
              only render conditionally above. */}
          <Volume2 className="hidden" />
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingConfirm != null}
        onOpenChange={(v) => !v && !busy && setPendingConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingConfirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingConfirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (pendingConfirm?.kind === "delete") void removeCard();
                else if (pendingConfirm?.kind === "reset") void resetCard();
              }}
            >
              {pendingConfirm?.kind === "delete" ? "Delete" : "Reset"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <p className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-[14px] font-medium text-foreground tabular-nums">
        {value}
      </p>
    </div>
  );
}

function formatDays(days: number): string {
  if (days < 1) return "<1d";
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

function formatRelative(ms: number): string {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 0) {
    // Future: "in X" — used for the next-due display.
    const ahead = -diff;
    if (ahead < 86400) return `in ${Math.round(ahead / 3600)}h`;
    if (ahead < 30 * 86400) return `in ${Math.round(ahead / 86400)}d`;
    if (ahead < 365 * 86400) return `in ${Math.round(ahead / (30 * 86400))}mo`;
    return `in ${(ahead / (365 * 86400)).toFixed(1)}y`;
  }
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 30 * 86400) return `${Math.round(diff / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Build a tiny SVG path of stability over time. Reviews come back
 *  newest-first; we reverse for chronological order, normalise
 *  stability to 0–1 against the run's max, and drop into a 200x48
 *  viewport. */
function stabilitySparkline(reviews: VocabReview[]): string | null {
  if (reviews.length < 2) return null;
  const ordered = [...reviews].reverse();
  const ys = ordered.map((r) => Math.max(0, r.newStability));
  const maxY = Math.max(...ys);
  if (maxY === 0) return null;
  const w = 200;
  const h = 48;
  const stepX = w / Math.max(1, ordered.length - 1);
  let d = "";
  for (let i = 0; i < ordered.length; i++) {
    const x = i * stepX;
    const y = h - (ys[i] / maxY) * (h - 4) - 2;
    d += `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  return d.trim();
}
