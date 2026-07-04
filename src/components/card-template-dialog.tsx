/**
 * Card template editor — pick which fields appear on the front vs the
 * back of a card, with a live `<CardFace>` preview. The chosen layout
 * is stored per-card in `vocab_entries.layout` (JSON); a "Reset to
 * default" clears the override and falls back to the per-kind default.
 *
 * Two modes:
 *   - Single card: edits the one card's layout, seeded from its
 *     current resolved layout.
 *   - Bulk: edits N selected cards. The form is seeded from the first
 *     selection; Save applies the same layout to every card.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { CardFace } from "@/components/card-face";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ALL_FIELDS,
  type CardLayout,
  type FieldId,
  resolveLayout,
  serializeLayout,
} from "@/lib/card-layout";
import { updateVocabFields, type VocabEntry } from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";

type Placement = "front" | "back" | "hidden";

const FIELD_LABEL: Record<FieldId, string> = {
  word: "Word",
  reading: "Reading",
  definition: "Definition",
  translation: "Translation",
  notes: "Notes",
  image: "Image",
  audio: "Audio",
};

/** Per-field "front | back | hidden" map derived from a CardLayout.
 *  Fields absent from both faces sort to "hidden". */
function placementFromLayout(layout: CardLayout): Record<FieldId, Placement> {
  const out: Record<FieldId, Placement> = {
    word: "hidden",
    reading: "hidden",
    definition: "hidden",
    translation: "hidden",
    notes: "hidden",
    image: "hidden",
    audio: "hidden",
  };
  for (const f of layout.front) out[f] = "front";
  for (const f of layout.back) out[f] = "back";
  return out;
}

/** Build a CardLayout from a placement map. Order within each face is
 *  the canonical FieldId order (so re-saving stays stable and the
 *  "before / after" comparison reads cleanly). */
function layoutFromPlacement(p: Record<FieldId, Placement>): CardLayout {
  return {
    front: ALL_FIELDS.filter((f) => p[f] === "front"),
    back: ALL_FIELDS.filter((f) => p[f] === "back"),
  };
}

export function CardTemplateDialog({
  open,
  cards,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Card(s) the dialog edits. Length === 1: single-card edit, seeded
   *  from that card. Length > 1: bulk apply; seed from cards[0]. */
  cards: VocabEntry[];
  onClose: () => void;
  /** Fires after a successful save, with the new layout (or null when
   *  "Reset to default"). Lets the host patch its local list without a
   *  re-fetch. */
  onSaved?: (cardIds: number[], layout: CardLayout | null) => void;
}) {
  const { active: workspace } = useWorkspace();
  const targetLang = workspace?.targetLang ?? "en";
  const first = cards[0] ?? null;

  // Seed placement from the first card's resolved layout. We re-seed
  // when the card identity changes so reopening the modal with a
  // different selection doesn't show the previous card's state.
  const initialPlacement = useMemo<Record<FieldId, Placement>>(() => {
    if (!first) return placementFromLayout({ front: [], back: [] });
    return placementFromLayout(resolveLayout(first.layout, first.kind));
  }, [first?.id, first?.layout, first?.kind]);

  const [placement, setPlacement] =
    useState<Record<FieldId, Placement>>(initialPlacement);
  const [saving, setSaving] = useState(false);

  // Re-seed whenever the modal is reopened or the selection changes.
  useEffect(() => {
    if (open) setPlacement(initialPlacement);
  }, [open, initialPlacement]);

  const draftLayout = useMemo(
    () => layoutFromPlacement(placement),
    [placement],
  );

  function setOne(field: FieldId, where: Placement) {
    setPlacement((prev) => ({ ...prev, [field]: where }));
  }

  async function applyLayout(layout: CardLayout | null) {
    if (cards.length === 0) return;
    setSaving(true);
    try {
      const serialized = layout == null ? null : serializeLayout(layout);
      // Sequential writes — the per-card surface in the cloud
      // probe-walks workspaces, and parallelising N PATCHes would
      // burst the rate-limit. For a typical bulk (<20 cards) the
      // sequential cost is unnoticeable.
      for (const c of cards) {
        await updateVocabFields({ id: c.id, layout: serialized });
      }
      onSaved?.(
        cards.map((c) => c.id),
        layout,
      );
      toast.success(
        layout == null
          ? cards.length > 1
            ? `Reset ${cards.length} cards to the default layout`
            : "Reset to default layout"
          : cards.length > 1
            ? `Applied layout to ${cards.length} cards`
            : "Layout saved",
      );
      onClose();
    } catch (err) {
      toast.error("Couldn't save layout", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  if (!first) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {cards.length > 1
              ? `Layout for ${cards.length} cards`
              : "Card layout"}
          </DialogTitle>
          <DialogDescription>
            Pick which fields appear on the front and back of{" "}
            {cards.length > 1 ? "the selected cards" : "this card"}. The back
            re-shows the front above the revealed answer, matching Anki's
            question + answer flip.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_1.1fr]">
          {/* Field placement column */}
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Fields
            </p>
            <div className="space-y-1.5">
              {ALL_FIELDS.map((f) => (
                <PlacementRow
                  key={f}
                  label={FIELD_LABEL[f]}
                  value={placement[f]}
                  onChange={(p) => setOne(f, p)}
                />
              ))}
            </div>
            <p className="pt-1 text-[11px] text-muted-foreground">
              Fields without data on the card render nothing — leaving them on a
              face is harmless.
            </p>
          </div>

          {/* Live preview column */}
          <div className="space-y-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Preview
            </p>
            <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
              <div>
                <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Front
                </p>
                <CardFace
                  fields={draftLayout.front}
                  card={first}
                  targetLang={targetLang}
                  side="front"
                />
              </div>
              <div className="h-px bg-border" />
              <div>
                <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Back (after reveal)
                </p>
                <div className="flex flex-col items-center gap-3">
                  <CardFace
                    fields={draftLayout.front}
                    card={first}
                    targetLang={targetLang}
                    side="back"
                  />
                  {draftLayout.back.length > 0 && (
                    <div className="h-px w-16 bg-border" aria-hidden />
                  )}
                  <CardFace
                    fields={draftLayout.back}
                    card={first}
                    targetLang={targetLang}
                    side="back"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="flex flex-row items-center justify-between gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void applyLayout(null)}
          >
            Reset to default
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={saving}
              onClick={() => void applyLayout(draftLayout)}
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {cards.length > 1 ? `Apply to ${cards.length} cards` : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A single row of the field-placement editor: field name + a 3-way
 *  segmented toggle (Front / Back / Hide). */
function PlacementRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Placement;
  onChange: (v: Placement) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      <div className="flex items-center gap-0.5 rounded-full border border-border bg-background p-0.5">
        {(["front", "back", "hidden"] as Placement[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[11px] capitalize transition-colors",
              value === p
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {p === "hidden" ? "Hide" : p}
          </button>
        ))}
      </div>
    </div>
  );
}
