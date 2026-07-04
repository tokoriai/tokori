/**
 * Shared card-level chrome for study plugins — the grade row, the
 * floating side rail (audio / AI / notes), the notes drawer, and the
 * keyboard-hint chips. Lifted out of `vocab-recall.tsx` so kaniwani
 * (and future modes) reuse the exact same surfaces instead of forking
 * them: the four grade buttons must look and key identically in every
 * mode or the user's muscle memory breaks between plugins.
 *
 * Top-bar controls + the pause overlay live in `session-controls.tsx`;
 * this module is everything attached to the card body itself.
 */

import { useEffect, useState } from "react";
import { Edit3, Loader2, Sparkles, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { updateVocabFields, type VocabEntry } from "@/lib/db";
import type { Grade } from "@/lib/study/api";
import { cn } from "@/lib/utils";

// ── Grade row ──────────────────────────────────────────────────────────

/** Canonical order, labels, and accent tints for the four FSRS grades.
 *  Single source so every plugin's grade row (and hint chips) agree. */
export const GRADE_ROW_DEFS: {
  grade: Grade;
  label: string;
  accent: string;
}[] = [
  {
    grade: "again",
    label: "Again",
    accent: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  },
  {
    grade: "hard",
    label: "Hard",
    accent: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  {
    grade: "good",
    label: "Good",
    accent: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  },
  {
    grade: "easy",
    label: "Easy",
    accent: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
];

/** Static fallback labels for the grade row. These match a fresh new
 *  card's FSRS-5 graduation (Hard ≈ 1d, Good ≈ 3d, Easy ≈ 2w), but
 *  modes that grade FSRS directly should pass *live* per-card labels
 *  from `gradeIntervalHints(card, srs)` (see vocab-recall) so the hint
 *  always reflects the real next interval — a review card's Hard isn't
 *  1 day. Self-assessment modes whose grade is aggregated across stages
 *  (kaniwani) pass their own wording instead. */
export const FSRS_INTERVAL_HINTS: Record<Grade, string> = {
  again: "<1m",
  hard: "~1d",
  good: "~3d",
  easy: "~2w",
};

export function GradeButton({
  label,
  hint,
  accent,
  onClick,
  disabled,
  suggested,
}: {
  label: string;
  hint: string;
  accent: string;
  onClick: () => void;
  disabled?: boolean;
  suggested?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col items-center gap-0.5 rounded-md border border-border px-2 py-2 text-[12px] font-medium transition-all",
        accent,
        disabled && "opacity-40",
        suggested && "ring-2 ring-foreground/30",
      )}
    >
      <span>{label}</span>
      <span className="text-[10.5px] opacity-70">{hint}</span>
    </button>
  );
}

/** The standard Again / Hard / Good / Easy strip. */
export function GradeRow({
  onGrade,
  suggested,
  hints,
  className,
}: {
  onGrade: (grade: Grade) => void;
  /** Ring-highlighted grade — the one Enter accepts. */
  suggested?: Grade | null;
  /** Sub-label per grade — see FSRS_INTERVAL_HINTS. */
  hints: Record<Grade, string>;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-4 gap-2", className)}>
      {GRADE_ROW_DEFS.map((d) => (
        <GradeButton
          key={d.grade}
          label={d.label}
          hint={hints[d.grade]}
          accent={d.accent}
          onClick={() => onGrade(d.grade)}
          suggested={suggested === d.grade}
        />
      ))}
    </div>
  );
}

// ── Yes / No gate ──────────────────────────────────────────────────────

/** The two-tone self-assessment gate ("Do you know …?") shown before a
 *  reveal. No is rose on the left, Yes is emerald on the right — the
 *  same order and tints everywhere so the user's ← / → muscle memory
 *  never has to re-learn per plugin. */
export function YesNoGate({
  question,
  onYes,
  onNo,
  hint,
}: {
  question: string;
  onYes: () => void;
  onNo: () => void;
  hint: string;
}) {
  return (
    <div className="mt-5 space-y-3 text-center">
      <p className="text-[15px] font-medium">{question}</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onNo}
          className="rounded-md border border-border bg-rose-500/5 px-4 py-3 text-[13px] font-semibold text-rose-700 transition-colors hover:bg-rose-500/15 dark:text-rose-400"
        >
          No
        </button>
        <button
          type="button"
          onClick={onYes}
          className="rounded-md border border-border bg-emerald-500/5 px-4 py-3 text-[13px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400"
        >
          Yes
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

// ── Click-to-reveal blur ───────────────────────────────────────────────

/** Click-to-toggle blur over an answer fragment (translation, reading)
 *  that must start hidden so it can't leak a hint — revealing is the
 *  user's deliberate choice. Owns its own toggle state; key the parent
 *  per card/task so it resets between cards. */
export function BlurReveal({
  text,
  className,
  hiddenTitle = "Click to reveal",
}: {
  text: string;
  className?: string;
  hiddenTitle?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setRevealed((v) => !v);
      }}
      className={cn(
        "rounded-sm border-b border-dotted border-foreground/40 px-0.5 transition-all text-left",
        !revealed && "blur-[3px] hover:blur-[1.5px] cursor-pointer select-none",
        className,
      )}
      title={revealed ? "Click to blur" : hiddenTitle}
    >
      {text}
    </button>
  );
}

// ── Floating side rail ─────────────────────────────────────────────────

export function SideRail({
  onSpeak,
  onNotes,
  onAi,
  notesOpen,
  aiOpen,
  notesShortcut,
  aiShortcut,
}: {
  onSpeak: () => void;
  onNotes: () => void;
  onAi: () => void;
  notesOpen: boolean;
  aiOpen: boolean;
  /** Shortcut key shown in the tooltip — omit when the host plugin
   *  doesn't bind one (typing-heavy modes can't spare single letters). */
  notesShortcut?: string;
  aiShortcut?: string;
}) {
  return (
    <div className="hidden lg:flex fixed right-3 top-1/2 -translate-y-1/2 flex-col gap-2 z-30">
      <RailButton onClick={onSpeak} title="Play pronunciation">
        <Volume2 className="size-4" />
      </RailButton>
      <RailButton
        onClick={onAi}
        title={`Ask AI about this card${aiShortcut ? `  ·  ${aiShortcut}` : ""}`}
        active={aiOpen}
      >
        <Sparkles className="size-4" />
      </RailButton>
      <RailButton
        onClick={onNotes}
        title={`Notes${notesShortcut ? `  ·  ${notesShortcut}` : ""}`}
        active={notesOpen}
      >
        <Edit3 className="size-4" />
      </RailButton>
    </div>
  );
}

function RailButton({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "flex size-10 items-center justify-center rounded-xl border transition-colors",
        active
          ? "border-foreground/30 bg-accent text-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ── Notes drawer ───────────────────────────────────────────────────────

export function NotesDrawer({
  open,
  card,
  onClose,
  onSaved,
}: {
  open: boolean;
  card: VocabEntry;
  onClose: () => void;
  onSaved: (updated: VocabEntry) => void;
}) {
  const [text, setText] = useState(card.cardNotes ?? "");
  const [busy, setBusy] = useState(false);

  // Reset the textarea whenever the dialog opens or the card changes
  // underneath us (the user can step through cards while the drawer is
  // closed and we want fresh content next time it opens).
  useEffect(() => {
    if (!open) return;
    setText(card.cardNotes ?? "");
  }, [open, card.id, card.cardNotes]);

  async function save() {
    setBusy(true);
    try {
      await updateVocabFields({ id: card.id, cardNotes: text || null });
      onSaved({ ...card, cardNotes: text || null });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-background/40 backdrop-blur-[1px] animate-in fade-in"
        onClick={onClose}
      />
      <div className="fixed right-0 top-0 bottom-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card shadow-xl animate-in slide-in-from-right">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Notes
            </p>
            <p className="font-serif text-lg leading-tight">{card.word}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            placeholder={
              "Mnemonics. A teacher's explanation. The first time you saw this word in the wild. Anything that helps you remember."
            }
            className="h-full min-h-[260px] w-full resize-none rounded-md border border-border bg-background p-3 text-[13.5px] leading-relaxed shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <p className="text-[11px] text-muted-foreground">
            Saved on this card · shows up in the reference rail next session.
          </p>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </>
  );
}

// ── Keyboard hint chips ────────────────────────────────────────────────

export function KeyChip({
  k,
  label,
  tone,
}: {
  k: [string, string] | [string];
  label: string;
  tone?: "rose" | "amber" | "sky" | "emerald";
}) {
  const toneClass: Record<NonNullable<typeof tone>, string> = {
    rose: "text-rose-500/80 dark:text-rose-400/80",
    amber: "text-amber-600/80 dark:text-amber-400/80",
    sky: "text-sky-600/80 dark:text-sky-400/80",
    emerald: "text-emerald-600/80 dark:text-emerald-400/80",
  };
  return (
    <span className="flex w-12 flex-col items-center gap-px rounded border border-border/40 bg-muted/20 px-1 py-1 text-center">
      <kbd className="font-mono text-[12px] leading-none text-muted-foreground/85">
        {k[0]}
      </kbd>
      {k[1] && (
        <span className="font-mono text-[9px] leading-none text-muted-foreground/55">
          {k[1]}
        </span>
      )}
      <span
        className={cn(
          "mt-0.5 text-[9px] leading-none text-muted-foreground/55",
          tone && toneClass[tone],
        )}
      >
        {label}
      </span>
    </span>
  );
}

/** The colored 1/2/3/4 + a/s/d/f grade-key strip — pairs with GradeRow
 *  the same way everywhere. */
export function GradeKeyChips() {
  return (
    <div className="flex items-center gap-1">
      <KeyChip k={["1", "a"]} label="again" tone="rose" />
      <KeyChip k={["2", "s"]} label="hard" tone="amber" />
      <KeyChip k={["3", "d"]} label="good" tone="sky" />
      <KeyChip k={["4", "f"]} label="easy" tone="emerald" />
    </div>
  );
}
