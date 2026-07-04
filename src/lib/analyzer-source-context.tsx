import { createContext, useContext, type ReactNode } from "react";

/**
 * Full plain-text source for the sentence analyzer.
 *
 * Markdown rendering splits an assistant reply into many small string
 * fragments — every **bold** boundary and every `((translation))` run
 * starts a new `Tokenized` instance — so a word popover's own
 * `sourceText` can be as short as the clicked word itself. The analyzer
 * then had no sentence to show (it fell back to the bare word) and
 * nothing to page through.
 *
 * Surfaces that render fragmented text (ChatMarkdown) provide the whole
 * message here, markdown-stripped; the popover maps its fragment back
 * into it before firing the analyzer event. Null where the popover's
 * own `sourceText` already IS the full text (reader prose, study
 * cards), which then behaves exactly as before.
 */
const AnalyzerSourceContext = createContext<string | null>(null);

export function AnalyzerSourceProvider({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  return (
    <AnalyzerSourceContext.Provider value={text}>
      {children}
    </AnalyzerSourceContext.Provider>
  );
}

export function useAnalyzerSource(): string | null {
  return useContext(AnalyzerSourceContext);
}
