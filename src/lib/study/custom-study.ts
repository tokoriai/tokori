/**
 * Custom-study handoff + queue shaping.
 *
 * "Custom study" = a flashcard session restricted to one collection's
 * subtree — the Library's per-chapter GraduationCap, the textbook
 * detail page, the dashboard textbook widget, and the Collections
 * view all funnel through here. The launching view writes a handoff
 * payload to localStorage and navigates to Flashcards; StudyMode
 * consumes it on mount and narrows both vocab pools to the scope.
 *
 * Why localStorage and not navigation state: the tab switch goes
 * through the shell's TabId callback, which carries no payload — and
 * a stale handoff surviving a reload is harmless (it's consumed and
 * cleared on the next Flashcards mount).
 *
 * The read is split into peek (read, leave in place) + clear (remove)
 * so StudyMode can peek synchronously in a useState initializer —
 * giving the very first pool fetch the narrowed scope, no
 * whole-workspace flash — and clear in an effect. Both halves are
 * idempotent, which makes the pair safe under React StrictMode's
 * double-invoked initializers and effects; a single pop-and-remove in
 * either place would consume the payload on the first invocation and
 * find nothing on the second.
 */

export type CustomStudyHandoff = {
  collectionId: number;
  name: string;
  /** Whether the session should open with drill mode (no SRS writes)
   *  pre-enabled. GraduationCap-style "drill this chapter" buttons
   *  promise "without affecting due dates" → true. The post-push
   *  "Add & study now" flows just made the words due and want real
   *  reviews → false. The user can still flip the toggle on any
   *  plugin's prestart screen. */
  drill: boolean;
};

const KEY = "study.customCollection";

/** Parse a raw handoff payload. Exported for tests — the storage I/O
 *  wrappers below stay thin. Tolerates the legacy `{ id, name }`
 *  shape (pre-drill builds); legacy entries default to drill so a
 *  stale payload can't silently move the user's schedule. */
export function parseCustomStudyHandoff(
  raw: string | null,
): CustomStudyHandoff | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      id?: unknown;
      name?: unknown;
      drill?: unknown;
    };
    if (typeof parsed?.id !== "number") return null;
    return {
      collectionId: parsed.id,
      name: typeof parsed.name === "string" ? parsed.name : "Custom",
      drill: typeof parsed.drill === "boolean" ? parsed.drill : true,
    };
  } catch {
    return null;
  }
}

/** Queue a custom-study session for the next Flashcards mount. */
export function queueCustomStudy(
  collection: { id: number; name: string },
  opts: { drill: boolean },
): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        id: collection.id,
        name: collection.name,
        drill: opts.drill,
      }),
    );
  } catch {
    /* localStorage may be denied */
  }
}

/** Read the pending handoff without consuming it. */
export function peekCustomStudyHandoff(): CustomStudyHandoff | null {
  try {
    return parseCustomStudyHandoff(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** Remove the pending handoff. Idempotent. */
export function clearCustomStudyHandoff(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* localStorage may be denied */
  }
}

/**
 * Order a custom-scope pool into a study queue: cards that need
 * attention first, known material last.
 *
 *   0. due / overdue (active learning or review, incl. null due_at)
 *   1. fresh (status new or unseen — never graded)
 *   2. scheduled later (future due_at)
 *   3. mastered
 *
 * Ties break by due_at (then created_at), matching the SQL ordering
 * the whole-workspace queues use, so within a rank the queue roughly
 * follows textbook/import order.
 */
export function orderCustomQueue<
  T extends {
    status: string;
    dueAt: number | null;
    createdAt: number;
  },
>(cards: readonly T[], now: number = Math.floor(Date.now() / 1000)): T[] {
  const rank = (c: T): number => {
    if (c.status === "mastered") return 3;
    if (c.status === "new" || c.status === "unseen") return 1;
    if (c.dueAt != null && c.dueAt > now) return 2;
    return 0;
  };
  return [...cards].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return (a.dueAt ?? a.createdAt) - (b.dueAt ?? b.createdAt);
  });
}
