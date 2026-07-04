/**
 * Lightweight flashcard preview modal. Replaces CardDetailDialog for
 * BrowseMode row clicks — the user asked for the "flashcard" view
 * (front / back flip) rather than the dense detail+history dialog,
 * which also avoids the multi-fetch race that wedged the dialog on
 * rapid row-clicks in HOSTED.
 *
 * Stateless beyond the flip toggle: everything the modal needs already
 * lives on the VocabEntry passed in. No DB reads here means no
 * loading/error states and no chance of an unhandled rejection
 * unmounting the tree.
 */

import { useEffect, useState } from "react";
import { BookOpen, LayoutTemplate, Pencil, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CardFace } from "@/components/card-face";
import { resolveLayout } from "@/lib/card-layout";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";
import type { VocabEntry, VocabStatus } from "@/lib/db";

const STATUS_BADGE: Record<VocabStatus, { label: string; cls: string }> = {
  unseen: {
    label: "Library",
    cls: "border-slate-300/60 text-slate-500 dark:text-slate-400",
  },
  new: {
    label: "New",
    cls: "border-rose-500/40 text-rose-700 dark:text-rose-300",
  },
  learning: {
    label: "Learning",
    cls: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  },
  review: {
    label: "Review",
    cls: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  },
  mastered: {
    label: "Known",
    cls: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  },
};

type Props = {
  open: boolean;
  card: VocabEntry | null;
  onClose: () => void;
  onEdit?: (card: VocabEntry) => void;
  /** Open the per-card layout modal (which fields go front / back). */
  onEditLayout?: (card: VocabEntry) => void;
  /** Open the rich dictionary detail page for the word. */
  onOpenInDictionary?: (word: string) => void;
};

export function FlashcardViewDialog({
  open,
  card,
  onClose,
  onEdit,
  onEditLayout,
  onOpenInDictionary,
}: Props) {
  const { active: workspace } = useWorkspace();
  const [flipped, setFlipped] = useState(false);

  // Reset to the question side when the dialog opens or the card
  // changes — otherwise switching between cards leaves the second one
  // already showing its answer.
  useEffect(() => {
    setFlipped(false);
  }, [card?.id, open]);

  if (!card) return null;

  const targetLang = workspace?.targetLang ?? "en";
  const badge = STATUS_BADGE[card.status];
  // Per-card layout (stored on `card.layout` JSON, falls back to the
  // per-kind default). Drives which fields render on each face.
  const layout = resolveLayout(card.layout, card.kind);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Flashcard preview</DialogTitle>
        </DialogHeader>

        <div
          onClick={() => setFlipped((f) => !f)}
          className="relative aspect-[4/3] cursor-pointer select-none bg-card transition-shadow"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              setFlipped((f) => !f);
            }
          }}
          title="Click to flip"
        >
          {/* Front — prompt fields from the card's layout. */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center px-6 py-8 transition-opacity duration-200"
            style={{
              opacity: flipped ? 0 : 1,
              pointerEvents: flipped ? "none" : "auto",
            }}
            onClick={(e) => {
              // The speak button (if 'audio' is on the front) shouldn't
              // flip the card when clicked.
              if ((e.target as HTMLElement).closest("button")) e.stopPropagation();
            }}
          >
            <CardFace
              fields={layout.front}
              card={card}
              targetLang={targetLang}
              side="front"
              size="lg"
            />
            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-[11px]">
              <Badge
                variant="outline"
                className={cn("h-5 gap-1 text-[10px]", badge.cls)}
              >
                {badge.label}
              </Badge>
              <span className="flex items-center gap-1 text-muted-foreground">
                <RotateCw className="size-3" />
                click to flip
              </span>
            </div>
          </div>

          {/* Back — prompt fields re-shown (revealed for cloze) above a
              divider, then the answer fields. Matches Anki's "question
              + answer" reveal. */}
          <div
            className="absolute inset-0 flex flex-col overflow-y-auto px-6 py-7 transition-opacity duration-200"
            style={{
              opacity: flipped ? 1 : 0,
              pointerEvents: flipped ? "auto" : "none",
            }}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button")) e.stopPropagation();
            }}
          >
            <div className="flex flex-col items-center gap-3">
              <CardFace
                fields={layout.front}
                card={card}
                targetLang={targetLang}
                side="back"
                size="lg"
              />
              {layout.back.length > 0 && (
                <div className="my-1 h-px w-24 bg-border" aria-hidden />
              )}
              <CardFace
                fields={layout.back}
                card={card}
                targetLang={targetLang}
                side="back"
                size="lg"
              />
            </div>
            <div className="mt-auto flex items-center justify-between pt-3 text-[11px] text-muted-foreground">
              <Badge
                variant="outline"
                className={cn("h-5 gap-1 text-[10px]", badge.cls)}
              >
                {badge.label}
              </Badge>
              <span>
                {card.reviewCount} review{card.reviewCount === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-card/40 px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFlipped((f) => !f)}
          >
            <RotateCw className="size-3.5" />
            Flip
          </Button>
          {onEdit && (
            <Button variant="outline" size="sm" onClick={() => onEdit(card)}>
              <Pencil className="size-3.5" />
              Edit
            </Button>
          )}
          {onEditLayout && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEditLayout(card)}
              title="Change which fields appear on the front and back"
            >
              <LayoutTemplate className="size-3.5" />
              Layout
            </Button>
          )}
          {onOpenInDictionary && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenInDictionary(card.word)}
              className="ml-auto"
            >
              <BookOpen className="size-3.5" />
              Dictionary
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
