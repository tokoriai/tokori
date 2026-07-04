/**
 * Global "is the user actively in a study session?" signal.
 *
 * Mirrors the event-bus pattern in `nav-event.ts` / `compose-card-event.ts`,
 * with a module-level "last value" cache so a late subscriber (mounted
 * after the emitter fired) still sees the current state.
 *
 * Today the only emitter is `FlashcardsView`'s StudyMode — it flips to
 * `true` when a plugin is picked and the post-session summary isn't
 * showing, and back to `false` on unmount. The shell's `GlobalAddCard`
 * subscribes and hides its FAB while the flag is on, so the floating
 * "+" doesn't sit on top of the study card.
 *
 * Why this isn't `useSession().active?.kind === "review"`: the sidebar
 * chip can also start a "review"-kind session, so kind alone over-
 * matches. This signal is gated on the StudyMode actually being mounted.
 */

import { useEffect, useState } from "react";

const STUDY_ACTIVE_EVENT = "tokori:study-active";

let current = false;

export function setStudyActive(active: boolean): void {
  if (typeof window === "undefined") return;
  if (current === active) return;
  current = active;
  window.dispatchEvent(
    new CustomEvent<boolean>(STUDY_ACTIVE_EVENT, { detail: active }),
  );
}

export function useStudyActive(): boolean {
  const [v, setV] = useState<boolean>(current);
  useEffect(() => {
    const listener = (e: Event) =>
      setV((e as CustomEvent<boolean>).detail);
    window.addEventListener(STUDY_ACTIVE_EVENT, listener);
    setV(current);
    return () => window.removeEventListener(STUDY_ACTIVE_EVENT, listener);
  }, []);
  return v;
}
