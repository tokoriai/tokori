import { useEffect, useRef } from "react";
import { isCjkTarget, looksLikeInlineTranslation } from "@/lib/tools";
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
 * Per-frame cost stays O(slice): frames append to (or create) small
 * spans and never touch earlier text — React renders an empty <div>
 * and never manages its children, so the spans survive re-renders.
 *
 * Translation blur, live: the drain loop runs a tiny state machine so
 * `((…))` translations are blurred WHILE they stream (previously the
 * blur only appeared once the message landed — the answer had already
 * flashed by then, defeating the recall pedagogy):
 *   - `((` opens a blurred span (markers hidden, matching the final
 *     render); `))` closes it.
 *   - For CJK targets, a single-paren `(…)` span types into its own
 *     span and is retro-blurred the moment `)` arrives IF it reads
 *     like a translation (same `looksLikeInlineTranslation` heuristic
 *     the post-stream rescue uses) — mutating the existing span, so
 *     the already-typed prefix never shifts.
 *   - A lone `(`/`)` at the live edge is held back one frame so a
 *     marker can't split across frames.
 * Markdown, pinyin, and click-to-define still land with the final
 * message (the saved bubble re-renders through the full pipeline).
 */
export function StreamingText({
  text,
  className,
  lang,
  revealTranslations = false,
}: {
  text: string;
  /** Extra classes on the container — e.g. `inline` so a blinking
   *  caret rendered right after the component sits at the end of the
   *  streamed text instead of dropping to its own line. */
  className?: string;
  /** Workspace target language — gates the single-paren translation
   *  heuristic to CJK targets, same as enforceTranslationBlur. */
  lang?: string;
  /** Mirror of the global "show translations" toggle: when the user
   *  has revealed translations, don't blur the live ones either.
   *  Captured per-span; flipping mid-stream applies from the next
   *  span (the finished message re-renders correctly regardless). */
  revealTranslations?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const targetRef = useRef(text);
  const shownRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  // Blur state machine across frames.
  const modeRef = useRef<"text" | "double" | "single">("text");
  const spanRef = useRef<HTMLSpanElement | null>(null);
  const singleBufRef = useRef("");
  const optsRef = useRef({ lang, revealTranslations });
  optsRef.current = { lang, revealTranslations };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Token appends only ever grow the string, so a shorter `text` means
    // a new/replaced stream (start() reset the partial, or a tool block
    // was stripped) — wipe and restart from scratch.
    if (text.length < shownRef.current) {
      el.replaceChildren();
      shownRef.current = 0;
      modeRef.current = "text";
      spanRef.current = null;
      singleBufRef.current = "";
    }
    targetRef.current = text;
    if (rafRef.current != null) return; // drain loop already running

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const BLUR_CLASS = "blur-[3px] select-none rounded-sm";

    const openSpan = (node: HTMLElement, blurred: boolean) => {
      const span = document.createElement("span");
      span.className =
        blurred && !optsRef.current.revealTranslations
          ? `token-in ${BLUR_CLASS}`
          : "token-in";
      node.appendChild(span);
      spanRef.current = span;
      return span;
    };
    const emit = (node: HTMLElement, s: string, blurred = false) => {
      if (!s) return;
      let span = spanRef.current;
      if (!span) span = openSpan(node, blurred);
      span.textContent = (span.textContent ?? "") + s;
    };

    const step = () => {
      rafRef.current = null;
      const node = ref.current;
      if (!node) return;
      const target = targetRef.current;
      const backlog = target.length - shownRef.current;
      if (backlog <= 0) return; // drained — restarted by the next text change
      const take = reducedMotion ? backlog : Math.max(2, Math.ceil(backlog / 12));
      const end = Math.min(target.length, shownRef.current + take);
      const cjk = isCjkTarget(optsRef.current.lang ?? "");

      let i = shownRef.current;
      while (i < end) {
        const c = target[i]!;
        const next = i + 1 < target.length ? target[i + 1] : undefined;
        const atLiveEdge = i + 1 >= target.length;

        if (modeRef.current === "text") {
          if (c === "(") {
            if (atLiveEdge) break; // can't tell (( from ( yet — hold back
            if (next === "(") {
              // `((` — open a blurred run; markers stay hidden like the
              // final render.
              openSpan(node, true);
              modeRef.current = "double";
              i += 2;
              continue;
            }
            if (cjk) {
              // Tentative single-paren translation: type into its own
              // span (parens visible) and judge at the close.
              openSpan(node, false);
              singleBufRef.current = "";
              emit(node, "(");
              modeRef.current = "single";
              i += 1;
              continue;
            }
          }
          emit(node, c);
          i += 1;
          continue;
        }

        if (modeRef.current === "double") {
          if (c === ")") {
            if (atLiveEdge) break; // )) vs lone ) — hold back
            if (next === ")") {
              spanRef.current = null; // close the blurred run
              modeRef.current = "text";
              i += 2;
              continue;
            }
          }
          emit(node, c, true);
          i += 1;
          continue;
        }

        // modeRef.current === "single"
        if (c === ")") {
          const span = spanRef.current;
          const buf = singleBufRef.current;
          if (span && looksLikeInlineTranslation(buf)) {
            // Retro-blur: swap the visible "(…" for the blurred inner
            // text. Mutating the span keeps every earlier offset valid.
            span.textContent = buf;
            if (!optsRef.current.revealTranslations) {
              span.className = `token-in ${BLUR_CLASS}`;
            }
          } else {
            emit(node, ")");
          }
          spanRef.current = null;
          singleBufRef.current = "";
          modeRef.current = "text";
          i += 1;
          continue;
        }
        if (singleBufRef.current.length > 300 || c === "\n" || c === "(") {
          // Too long / newline / nested paren — this isn't an inline
          // translation. Keep what's typed, fall back to normal text.
          singleBufRef.current = "";
          modeRef.current = "text";
          continue; // reprocess c in text mode
        }
        singleBufRef.current += c;
        emit(node, c);
        i += 1;
      }

      shownRef.current = i;
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
