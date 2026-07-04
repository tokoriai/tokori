/**
 * Global "open the sentence analyzer" event.
 *
 * Mirrors `nav-event.ts`. Any deeply-nested component (a tokenized
 * popover in a chat reply, the reader's word-pop button, a future
 * keyboard shortcut) can fire this event without prop-drilling a
 * modal handle through the tree. The shell mounts a single listener
 * + the modal so we never have multiple analyzers open at once.
 */

import type { LanguageCode } from "./languages";

export const ANALYZER_EVENT = "tokori:analyze-sentence";

export type AnalyzerRequest = {
  sentence: string;
  lang: LanguageCode;
  /** Optional token to seed the modal's "word in context" panel. */
  focus?: string;
  /** Full text the sentence was lifted from plus the clicked word's
   *  offset within it — lets the modal offer prev/next-sentence
   *  navigation through the whole reply / passage. Omitted = the modal
   *  shows just the one sentence. */
  source?: { text: string; offset: number };
};

export function requestAnalyzeSentence(req: AnalyzerRequest): void {
  if (typeof window === "undefined") return;
  if (!req.sentence?.trim()) return;
  window.dispatchEvent(
    new CustomEvent<AnalyzerRequest>(ANALYZER_EVENT, { detail: req }),
  );
}

export function onAnalyzeSentence(
  handler: (req: AnalyzerRequest) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<AnalyzerRequest>).detail;
    if (detail?.sentence) handler(detail);
  };
  window.addEventListener(ANALYZER_EVENT, listener);
  return () => window.removeEventListener(ANALYZER_EVENT, listener);
}
