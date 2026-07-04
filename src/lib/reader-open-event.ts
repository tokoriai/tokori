/**
 * Ask the Reader to open a specific document — e.g. after "Open in Reader"
 * from the Notes OCR capture. Pair with `navigateToTab("reader")`.
 *
 * Two delivery paths so it works whether or not the Reader is already mounted:
 *   - a window event, handled when the Reader is live, and
 *   - a one-shot "pending" id the Reader consumes on its next load (covers the
 *     case where switching tabs mounts the Reader fresh, after the event fired).
 */

export const READER_OPEN_EVENT = "tokori:reader-open";

let pending: number | null = null;

export function requestOpenReaderDoc(id: number): void {
  pending = id;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ id: number }>(READER_OPEN_EVENT, { detail: { id } }),
  );
}

/** Read + clear the pending open request (call once on Reader load). */
export function consumePendingReaderOpen(): number | null {
  const p = pending;
  pending = null;
  return p;
}

export function onOpenReaderDoc(handler: (id: number) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<{ id: number }>).detail;
    if (detail && typeof detail.id === "number") handler(detail.id);
  };
  window.addEventListener(READER_OPEN_EVENT, listener);
  return () => window.removeEventListener(READER_OPEN_EVENT, listener);
}
