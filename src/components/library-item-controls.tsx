/**
 * Card controls shared by the two `library_items` lenses — Library
 * (print) and Immersion (watch/listen). Both render the same status
 * vocabulary and the same −/+ progress adjuster; keeping them here
 * means a status color or interaction fix lands in both views at once.
 */

import { Check, ChevronDown, Minus, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LibraryStatus } from "@/lib/db";
import { cn } from "@/lib/utils";

export const LIBRARY_STATUS_BADGE: Record<LibraryStatus, string> = {
  planned: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  active: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  paused: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  finished: "border-violet-500/40 text-violet-700 dark:text-violet-300",
  dropped: "border-muted-foreground/40 text-muted-foreground",
};

export const LIBRARY_STATUS_DOT: Record<LibraryStatus, string> = {
  planned: "bg-sky-500",
  active: "bg-emerald-500",
  paused: "bg-amber-500",
  finished: "bg-violet-500",
  dropped: "bg-muted-foreground",
};

export const LIBRARY_STATUS_ORDER: LibraryStatus[] = [
  "planned",
  "active",
  "paused",
  "finished",
  "dropped",
];

/** The status badge, made interactive — click it to move the item
 *  between statuses without opening the editor dialog. The view
 *  supplies the writer so each lens can attach its own side effects
 *  (e.g. the Library's single-active-textbook toast). */
export function ItemStatusMenu({
  status,
  applyStatus,
}: {
  status: LibraryStatus;
  applyStatus: (status: LibraryStatus) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge asChild variant="outline" className={cn("text-[10px]", LIBRARY_STATUS_BADGE[status])}>
          <button
            type="button"
            aria-label={`Status: ${status} — change`}
            title="Change status"
            className="cursor-pointer capitalize transition-colors hover:bg-accent/60"
          >
            {status}
            <ChevronDown className="size-2.5! opacity-60" />
          </button>
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-36">
        {LIBRARY_STATUS_ORDER.map((s) => (
          <DropdownMenuItem
            key={s}
            onSelect={() => applyStatus(s)}
            className="gap-2 text-[12.5px] capitalize"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", LIBRARY_STATUS_DOT[s])} />
            {s}
            {s === status && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Segmented − | + control. The plus side carries the label ("+1 page",
 *  "+10 min") so the pair reads as one adjuster for one quantity — a
 *  bare "−" floating between unrelated "+" buttons read as three
 *  separate actions. */
export function Stepper({
  label,
  minusTitle,
  plusTitle,
  onMinus,
  onPlus,
  minusDisabled,
}: {
  label: string;
  minusTitle: string;
  plusTitle: string;
  onMinus: () => void;
  onPlus: () => void;
  minusDisabled?: boolean;
}) {
  return (
    <div className="inline-flex h-7 items-stretch overflow-hidden rounded-md border border-border">
      <button
        type="button"
        onClick={onMinus}
        disabled={minusDisabled}
        title={minusTitle}
        aria-label={minusTitle}
        className="flex items-center px-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
      >
        <Minus className="size-3.5" />
      </button>
      <div className="w-px shrink-0 bg-border" aria-hidden />
      <button
        type="button"
        onClick={onPlus}
        title={plusTitle}
        aria-label={plusTitle}
        className="flex items-center gap-1 px-2 text-[12px] font-medium transition-colors hover:bg-accent/60"
      >
        <Plus className="size-3.5" />
        {label}
      </button>
    </div>
  );
}
