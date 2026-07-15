import { Children, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Upload } from "lucide-react";
import {
  BlurredTranslation,
  splitOnTranslations,
  type ChatMarkdownProps,
} from "@/components/chat-markdown";
import { ScopedErrorBoundary } from "@/components/error-boundary";
import { PassageCard } from "@/components/passage-card";
import { Tokenized } from "@/components/tokenized";
import { VocabTable } from "@/components/vocab-table";
import { AnalyzerSourceProvider } from "@/lib/analyzer-source-context";
import { plainTextOf } from "@/lib/plain-text";
import { useChatActions } from "@/lib/chat-actions-context";
import type { LanguageCode } from "@/lib/languages";
import { cn } from "@/lib/utils";

/**
 * The actual markdown renderer behind `ChatMarkdown`. Lives in its own
 * module (default export, loaded via `lazy()` in chat-markdown.tsx) so
 * react-markdown + remark stay out of the eager entry chunk —
 * chat-markdown.tsx is shared by enough lazy views that the bundler
 * hoists it into the entry, and it must stay cheap there.
 */

/** Walk children, replacing string nodes with Tokenized so click-to-define
 *  still works inside markdown. Strings containing `(( ))` runs get split
 *  so the translation portion renders as a blurred reveal.
 *
 *  `streaming=true` skips the Tokenized wrapper and renders raw text — during
 *  a live stream the text grows fast and re-tokenising every batch hammers the
 *  dict lookups (in HOSTED, a `/api/v1/dict/batch-lookup` flood). The main
 *  chat view streams via the lightweight `StreamingText`; this flag is for the
 *  study AI drawer's inline streaming preview. Finished bubbles run the full
 *  pipeline once. */
function tokenizeChildren(
  children: ReactNode,
  lang: LanguageCode,
  streaming = false,
): ReactNode {
  return Children.map(children, (child, i) => {
    if (typeof child === "string") {
      const parts = splitOnTranslations(child);
      if (parts.length === 1 && parts[0].kind === "text") {
        return streaming ? child : <Tokenized key={i} text={child} lang={lang} />;
      }
      return (
        <span key={i}>
          {parts.map((p, j) =>
            p.kind === "translation" ? (
              <BlurredTranslation key={j} text={p.value} />
            ) : streaming ? (
              <span key={j}>{p.value}</span>
            ) : (
              <Tokenized key={j} text={p.value} lang={lang} />
            ),
          )}
        </span>
      );
    }
    return child;
  });
}

/** Walk a React tree and concatenate all string text nodes — used to copy code-block contents. */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    // ReactElement
    return extractText(
      (node as { props: { children?: ReactNode } }).props.children,
    );
  }
  return "";
}

/** A `<pre>` block with a hover-only copy-to-clipboard button. Used for CSV, code, etc. */
function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const actions = useChatActions();
  const text = extractText(children);
  // Try to surface the language label from the inner <code className="language-xyz">.
  const lang = (() => {
    const c = children as { props?: { className?: string } } | undefined;
    const cn = c?.props?.className ?? "";
    const m = cn.match(/language-(\S+)/);
    return m ? m[1].toLowerCase() : null;
  })();
  // A ```vocab block renders as an interactive vocabulary table (word +
  // reading + meaning, with save / add-to-list actions) rather than code.
  if (lang === "vocab") {
    return <VocabTable raw={text} />;
  }
  // A ```passage block is a generated reading text — serif card with
  // click-to-define words, TTS, and an Add-to-Reader action.
  if (lang === "passage") {
    return <PassageCard raw={text} />;
  }
  const isCsv = lang === "csv" || lang === "tsv";

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silently no-op */
    }
  }

  return (
    <div className="group/code relative my-2 overflow-hidden rounded-md bg-muted">
      {lang && (
        <div className="flex items-center justify-between border-b border-border/40 bg-muted/60 px-3 py-1 text-[10.5px] font-mono uppercase tracking-wider text-muted-foreground">
          <span>{lang}</span>
        </div>
      )}
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1.5">
        {isCsv && actions && (
          <button
            type="button"
            onClick={() => actions.importCsv(text)}
            className={cn(
              "flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 transition-all",
              "shadow-sm hover:bg-emerald-500/15 hover:text-emerald-600 dark:hover:text-emerald-200",
            )}
            title="Import these rows into vocabulary"
          >
            <Upload className="size-3" />
            Import to vocab
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-all",
            "bg-background/80 text-muted-foreground shadow-sm border border-border",
            "opacity-0 group-hover/code:opacity-100 hover:text-foreground",
            isCsv && actions && "opacity-100",
          )}
          title="Copy"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="size-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5">{children}</pre>
    </div>
  );
}

export default function ChatMarkdownImpl({
  text,
  lang,
  streaming = false,
}: ChatMarkdownProps) {
  // The whole message in plain text, for the analyzer-source context:
  // markdown splits the reply into per-fragment Tokenized runs, so a
  // popover's local sourceText can be a single bolded word — too small
  // to extract a sentence from, let alone page through them.
  const analyzerSource = useMemo(() => plainTextOf(text), [text]);
  return (
    // Scoped boundary so a render-time exception inside ReactMarkdown
    // / remark-gfm / Tokenized doesn't collapse the whole bubble (and
    // by extension the whole study sidebar / chat view) onto the
    // top-level recovery screen. The boundary resets on text change so a
    // transient parse blowup clears itself; worst case the user sees one
    // frame of plaintext before the structured render comes back.
    <ScopedErrorBoundary
      // Quantise the reset key so a render throw isn't retried on every
      // tiny text change.
      resetKey={Math.floor(text.length / 256)}
      fallback={(_err, retry) => (
        <div className="space-y-1">
          <pre className="whitespace-pre-wrap font-sans text-[14.5px] leading-relaxed text-foreground/95">
            {text}
          </pre>
          <button
            type="button"
            onClick={retry}
            className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 hover:text-foreground"
            title="Retry markdown render"
          >
            (showing as plain text — click to retry)
          </button>
        </div>
      )}
    >
    <AnalyzerSourceProvider text={analyzerSource}>
    <div className="markdown-chat space-y-2 text-[14.5px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{tokenizeChildren(children, lang, streaming)}</p>,
          li: ({ children }) => <li>{tokenizeChildren(children, lang, streaming)}</li>,
          h1: ({ children }) => (
            <h1 className="mt-2 text-[18px] font-semibold tracking-tight">
              {tokenizeChildren(children, lang, streaming)}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-2 text-[16.5px] font-semibold tracking-tight">
              {tokenizeChildren(children, lang, streaming)}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-1.5 text-[15px] font-semibold tracking-tight">
              {tokenizeChildren(children, lang, streaming)}
            </h3>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold">
              {tokenizeChildren(children, lang, streaming)}
            </strong>
          ),
          em: ({ children }) => <em>{tokenizeChildren(children, lang, streaming)}</em>,
          td: ({ children }) => (
            <td className="border border-border/60 px-2 py-1 align-top">
              {tokenizeChildren(children, lang, streaming)}
            </td>
          ),
          th: ({ children }) => (
            <th className="border border-border/60 bg-muted/40 px-2 py-1 text-left font-medium">
              {tokenizeChildren(children, lang, streaming)}
            </th>
          ),
          ul: ({ children }) => (
            <ul className="list-disc space-y-0.5 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-0.5 pl-5">{children}</ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 italic text-foreground/80">
              {children}
            </blockquote>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-3 border-border" />,
          // Inline code stays as code; block code is rendered through `pre` below.
          code: ({ children, className, ...props }) => {
            const isBlock = /language-/.test(className ?? "");
            if (isBlock) {
              return (
                <code
                  className={cn(
                    "block whitespace-pre font-mono text-[12.5px] leading-relaxed",
                    className,
                  )}
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-muted/70 px-1 py-0.5 font-mono text-[0.88em]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[13.5px]">{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
    </AnalyzerSourceProvider>
    </ScopedErrorBoundary>
  );
}
