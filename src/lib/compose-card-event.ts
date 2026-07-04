/**
 * Global "open the card composer pre-filled" event.
 *
 * Mirrors `analyzer-event.ts`. Any deeply-nested component (a
 * click-to-define popover in a chat reply, the reader's word
 * popover, a future Anki-style "make card" keyboard shortcut) can
 * fire this event without prop-drilling a composer handle through
 * the tree. The shell mounts a single listener inside
 * `GlobalAddCard` and routes the seed straight into the existing
 * `CardComposerDialog`.
 *
 * Why an event bus and not React context: the composer is a heavy
 * surface (TTS context, enricher pipeline, dict typeahead). We
 * don't want every popover render to subscribe to a "open this
 * card" context just so the rare click can summon it. Fire-and-
 * forget with a `CustomEvent` keeps the popover free of any
 * dependency on the composer.
 */

import type { LanguageCode } from "./languages";

export const COMPOSE_CARD_EVENT = "tokori:compose-card";

export type ComposeCardRequest = {
  /** Active workspace target language. Composer uses its own
   *  workspace context for the rest (native lang, providers), so
   *  we don't need to ship that here. */
  lang: LanguageCode;
  /** Word the user wants on the card — pre-fills the word input. */
  word: string;
  /** Phonetic reading if known. Already pretty-pinyin'd / un-
   *  romanised by the caller — the composer writes it verbatim. */
  reading?: string | null;
  /** Short definition / gloss. */
  gloss?: string | null;
  /** Cloze sentence with `{{c1::word}}` markers. When omitted the
   *  composer's cloze field starts empty (or the user can run the
   *  ai-cloze enricher to generate one). */
  frontExtra?: string | null;
};

export function requestComposeCard(req: ComposeCardRequest): void {
  if (typeof window === "undefined") return;
  if (!req.word?.trim()) return;
  window.dispatchEvent(
    new CustomEvent<ComposeCardRequest>(COMPOSE_CARD_EVENT, { detail: req }),
  );
}

export function onComposeCard(
  handler: (req: ComposeCardRequest) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<ComposeCardRequest>).detail;
    if (detail?.word) handler(detail);
  };
  window.addEventListener(COMPOSE_CARD_EVENT, listener);
  return () => window.removeEventListener(COMPOSE_CARD_EVENT, listener);
}
