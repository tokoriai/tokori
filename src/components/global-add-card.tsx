/**
 * GlobalAddCard — the always-mounted "add a card from anywhere"
 * surface. Renders two things:
 *
 *   1. A small floating "+" button pinned to the bottom-right of the
 *      viewport. Visible on every page so the user can drop a card in
 *      without navigating to the vocab view first.
 *   2. The same `CardComposerDialog` the vocab view and the dict
 *      search modal use, but opened in `create` mode with no
 *      pre-fill. Always lazy-mounted — the dialog is only rendered
 *      while `open === true` so the heavy form (TTS context, dict
 *      lookup, enricher list) doesn't pay React's mount cost on every
 *      page navigation.
 *
 * Keyboard binding: `Cmd/Ctrl+Shift+A` ("Add") toggles the composer
 * from anywhere. Replaces the older `QuickAddDialog` palette — users
 * asked for the full composer instead of the minimal one so all the
 * enrichments (dict typeahead, AI cloze, TTS, image) are reachable
 * via one keystroke from any page.
 *
 * Why a separate component (rather than a hook + state in shell.tsx):
 *   - The FAB is a piece of UI; the keybind owner is a piece of UI.
 *     Keeping them paired makes the trigger and the surface
 *     impossible to drift out of sync.
 *   - Mounted once in `shell.tsx` next to the dict search modal so
 *     it inherits the same workspace + provider contexts without
 *     extra plumbing.
 */

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useWorkspace } from "@/lib/workspace-context";
import { CardComposerDialog } from "@/components/card-composer-dialog";
import {
  onComposeCard,
  type ComposeCardRequest,
} from "@/lib/compose-card-event";
import { useStudyActive } from "@/lib/study-active-event";

/** Seed payload routed into the composer when something other than
 *  the FAB / shortcut opened it — currently the click-to-define
 *  popover's "Make card" button. `null` means "open blank". */
type Seed = ComposeCardRequest | null;

export function GlobalAddCard({
  hidden = false,
}: {
  /** Hide the floating "+" on surfaces where it's noise (the shell
   *  passes `tab === "chat"`, which covers the conversation view AND
   *  live voice mode rendered inside it). The keyboard shortcut and
   *  the compose-card event bus keep working — only the button goes. */
  hidden?: boolean;
} = {}) {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<Seed>(null);
  const { active: workspace } = useWorkspace();
  // Hide the floating "+" while a flashcards study session is on
  // screen — the card surface already crowds the bottom edge and a
  // FAB sitting on top of a graded card is just noise. The keyboard
  // shortcut still opens the composer (the early-return is render-
  // only); a learner who really wants to make a card mid-session can
  // still hit Cmd/Ctrl+Shift+A.
  const studyActive = useStudyActive();

  // Global Cmd/Ctrl+Shift+A — toggle the composer. Shift is mandatory
  // so we don't clash with the OS-level "Select all" (Cmd+A) inside
  // text inputs. Browsers don't claim this combo, so it makes it to
  // us cleanly on every desktop platform.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        setSeed(null);
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Bus subscription — anywhere in the app can request the composer
  // pre-filled. We always force-open on a request (no toggle): if
  // the user clicked "Make card" they expect a dialog, not a
  // close-if-already-open guess.
  useEffect(() => {
    return onComposeCard((req) => {
      setSeed(req);
      setOpen(true);
    });
  }, []);

  // No workspace means the user hasn't onboarded — hide the FAB
  // entirely. The composer wouldn't have anywhere to save a card
  // anyway.
  if (!workspace) return null;

  return (
    <>
      {!studyActive && !hidden && (
        <button
          type="button"
          onClick={() => {
            setSeed(null);
            setOpen(true);
          }}
          aria-label="Add card"
          title="Add card (Ctrl/Cmd+Shift+A)"
          className="fixed bottom-5 right-5 z-40 flex size-11 items-center justify-center rounded-full bg-foreground text-background shadow-lg ring-1 ring-border transition-transform hover:scale-105 active:scale-95"
        >
          <Plus className="size-5" />
        </button>
      )}

      {open && (
        <CardComposerDialog
          mode="create"
          open
          initialWord={seed?.word}
          initialReading={seed?.reading ?? undefined}
          initialGloss={seed?.gloss ?? undefined}
          initialFrontExtra={seed?.frontExtra ?? undefined}
          onClose={() => {
            setOpen(false);
            setSeed(null);
          }}
          onSaved={() => {
            setOpen(false);
            setSeed(null);
          }}
        />
      )}
    </>
  );
}
