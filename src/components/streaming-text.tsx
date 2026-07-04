import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Streaming "typing" effect, the cheap way.
 *
 * The assistant reply grows token by token, but providers deliver it in
 * bursty chunks — rendering each chunk as it lands reads as text "spat
 * out" in random lumps. Instead we keep a backlog (target text minus
 * what's on screen) and drain it on a requestAnimationFrame loop, a few
 * characters per frame, so the reply *types itself* at a very fast but
 * steady pace — the ChatGPT/Claude feel.
 *
 * The drain rate is proportional to the backlog (`backlog / 12`, min 2
 * chars per frame ≈ 120 cps floor), so it self-tunes: a fast provider
 * settles ~0.2 s behind the wire and never falls further back, a slow
 * one gets a smooth steady type instead of stop-start lumps, and the
 * tail after the stream ends drains in well under a second. Users with
 * reduced-motion get the whole backlog per frame (no typing theatre).
 *
 * Per-frame cost stays O(slice): each frame appends ONE small <span>
 * (fade-in via .token-in) and never touches already-shown text — same
 * imperative-append trick as before, just paced. React renders an empty
 * <div> and never manages its children, so the spans survive re-renders.
 *
 * Plain text only: markdown, pinyin, and click-to-define are applied
 * once the message lands (the saved bubble re-renders through the full
 * pipeline).
 */
export function StreamingText({
  text,
  className,
}: {
  text: string;
  /** Extra classes on the container — e.g. `inline` so a blinking
   *  caret rendered right after the component sits at the end of the
   *  streamed text instead of dropping to its own line. */
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const targetRef = useRef(text);
  const shownRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Token appends only ever grow the string, so a shorter `text` means
    // a new/replaced stream (start() reset the partial, or a tool block
    // was stripped) — wipe and restart from scratch.
    if (text.length < shownRef.current) {
      el.replaceChildren();
      shownRef.current = 0;
    }
    targetRef.current = text;
    if (rafRef.current != null) return; // drain loop already running

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const step = () => {
      rafRef.current = null;
      const node = ref.current;
      if (!node) return;
      const target = targetRef.current;
      const backlog = target.length - shownRef.current;
      if (backlog <= 0) return; // drained — restarted by the next text change
      const take = reducedMotion ? backlog : Math.max(2, Math.ceil(backlog / 12));
      const span = document.createElement("span");
      span.className = "token-in";
      // textContent, not innerHTML — no injection.
      span.textContent = target.slice(shownRef.current, shownRef.current + take);
      node.appendChild(span);
      shownRef.current = Math.min(target.length, shownRef.current + take);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [text]);

  // Stop the drain loop with the component — without this a pending
  // frame could touch the detached node after unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return <div ref={ref} className={cn("whitespace-pre-wrap", className)} />;
}
