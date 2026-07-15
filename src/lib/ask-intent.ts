/**
 * One-shot buffer for a question that should be sent into the chat.
 *
 * The voice-ask popup lives in its own webview window, so it can't
 * call ChatView's send() directly — it hands the transcript to Rust
 * (`focus_main_with_ask`), Rust emits a Tauri event into the main
 * window, and the shell parks the question here while it flips the
 * active tab to "chat". ChatView consumes it once its chat row is
 * loaded and no stream is running.
 *
 * Module state rather than sessionStorage (cf. settings-intent):
 * sessionStorage is per-window, so it can't carry anything from the
 * popup anyway, and a spoken question that outlives a webview reload
 * would be more surprising than one that's simply lost.
 */

export type VoiceAsk = {
  text: string;
  /** Read the tutor's reply aloud once it lands (the popup's
   *  speaker toggle). */
  speak: boolean;
};

const EVENT = "tokori:voice-ask-pending";

let pending: VoiceAsk | null = null;

export function requestVoiceAsk(ask: VoiceAsk): void {
  pending = ask;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

/** Read and clear the pending ask. Returns null when nothing's queued. */
export function consumeVoiceAsk(): VoiceAsk | null {
  const p = pending;
  pending = null;
  return p;
}

/** Subscribe to "an ask just got queued". The handler should call
 *  `consumeVoiceAsk` itself — it may legitimately decide to leave the
 *  ask parked (e.g. a reply is still streaming). */
export function onVoiceAskPending(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
