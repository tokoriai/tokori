import { Suspense, lazy, useState } from "react";
import { useDisplay } from "@/lib/display-context";
import type { LanguageCode } from "@/lib/languages";
import { cn } from "@/lib/utils";

/**
 * Public face of the chat markdown renderer. This module is imported by
 * enough lazily-loaded views (chat, notes, study drawer, analyzer) that
 * the bundler hoists it into the eager entry chunk — so it must stay
 * cheap. The actual react-markdown + remark render tree lives in
 * chat-markdown-impl.tsx behind a dynamic import; while that chunk
 * loads, the message renders as plain text (same styling as the
 * error-boundary fallback), which reads as progressive enhancement
 * rather than a flash.
 */

export type ChatMarkdownProps = {
  text: string;
  lang: LanguageCode;
  /** Skip the Tokenized click-to-define pipeline (render raw text) while a
   *  reply streams, to avoid re-tokenising — and, in HOSTED, re-fetching dict
   *  lookups — on every token batch. Used by the study AI drawer's streaming
   *  preview; the main chat streams via `StreamingText`. */
  streaming?: boolean;
};

/** Loader shared by the lazy component and the shell's idle prefetch, so
 *  the impl chunk is warm before the first message renders. */
export const loadChatMarkdownImpl = () =>
  import("@/components/chat-markdown-impl");

const ChatMarkdownImpl = lazy(loadChatMarkdownImpl);

/** Splits a string into target-language runs and `((translation))` runs.
 *  Translation runs are rendered blurred-by-default; click reveals them.
 *  This pattern is what we ask the model for in the system prompt — see
 *  `buildSystemPrompt` in chat-view.tsx.
 *
 *  Implemented as a single forward scan over `indexOf` calls — the
 *  previous regex (`/\(\(([^()]+|\((?!\()[^()]*\)(?!\)))+?\)\)/g`) had
 *  nested alternation with a lazy quantifier, which on a long reply
 *  containing many parentheses backtracked exponentially. That blew up
 *  inside `ChatMarkdown`'s render path on every streamed token, the
 *  ScopedErrorBoundary retried 60×/s on each new token, and the tab
 *  froze. This version is O(n) total (cursor only ever moves forward),
 *  allocates one substring per part, and can't backtrack. */
export function splitOnTranslations(
  text: string,
): Array<{ kind: "text" | "translation"; value: string }> {
  const out: Array<{ kind: "text" | "translation"; value: string }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("((", cursor);
    if (open < 0) break;
    const close = text.indexOf("))", open + 2);
    // No closing yet — common during streaming when only `((…` has
    // arrived. Stop here and let the rest land as plain text; the next
    // chunk re-scans and picks the closing up.
    if (close < 0) break;
    if (open > cursor) {
      out.push({ kind: "text", value: text.slice(cursor, open) });
    }
    out.push({ kind: "translation", value: text.slice(open + 2, close).trim() });
    cursor = close + 2;
  }
  if (cursor < text.length) {
    out.push({ kind: "text", value: text.slice(cursor) });
  }
  return out;
}

/** Click-to-reveal blurred span. Mirrors the live-mode "blur EN" behaviour
 *  so the student gets to read the target text first and only consults the
 *  translation when they actually need to. The global EN toggle in the
 *  composer flips `showTranslations` on the display context — when true,
 *  every span is unblurred regardless of its local revealed state. */
export function BlurredTranslation({ text }: { text: string }) {
  const { showTranslations } = useDisplay();
  const [locallyRevealed, setLocallyRevealed] = useState(false);
  const revealed = showTranslations || locallyRevealed;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        // When the global toggle is on, clicking individual spans is
        // a no-op — they're already shown. (Toggling here would flip
        // local state but the global override would keep it visible
        // anyway, which is just confusing.)
        if (!showTranslations) setLocallyRevealed((v) => !v);
      }}
      className={cn(
        "rounded-sm border-b border-dotted border-foreground/40 px-0.5 transition-all",
        !revealed && "blur-[3px] hover:blur-[1.5px] cursor-pointer select-none",
      )}
      title={
        showTranslations
          ? "Translations shown — click EN to blur all"
          : revealed
            ? "Click to blur"
            : "Click to reveal translation"
      }
    >
      {text}
    </button>
  );
}

export function ChatMarkdown(props: ChatMarkdownProps) {
  return (
    <Suspense
      fallback={
        <pre className="whitespace-pre-wrap font-sans text-[14.5px] leading-relaxed text-foreground/95">
          {props.text}
        </pre>
      }
    >
      <ChatMarkdownImpl {...props} />
    </Suspense>
  );
}
