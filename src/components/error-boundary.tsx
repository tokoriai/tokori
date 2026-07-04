/**
 * App-level error boundary.
 *
 * React 19 will only catch render-time exceptions if a class boundary
 * is in the tree above them. Without one, an exception thrown during
 * a render — e.g. a rare malformed message that crashes the markdown
 * parser, or a context value that briefly became `null` mid-update —
 * blanks the whole webview because React tears the tree down to the
 * root and replaces it with nothing. The user sees a white window
 * and has to restart the app.
 *
 * This boundary catches such exceptions, logs them, and renders a
 * recoverable banner with a "Try again" button that clears the error
 * state so the tree re-mounts. It is *not* a catch-all for async
 * errors (those still go to console / toast); just for synchronous
 * render-phase exceptions.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Scoped boundary used by individual streaming surfaces (chat
 * bubbles, the AI sidebar, the reader's tutoring panel) to keep a
 * mid-render exception from collapsing the whole tree onto the app-
 * wide recovery screen.
 *
 * Why this is needed: ReactMarkdown + remark-gfm + our own tokenizer
 * are robust most of the time, but during streaming the bubble runs
 * against PARTIAL markdown (unclosed code fences, half-built tables,
 * mid-tag `<thi`). Rare but real edge-cases throw, and the throw
 * propagates all the way up. With this boundary in place the bubble
 * just falls back to a plain `<pre>` until the next token arrives —
 * which usually completes the partial syntax — and the boundary
 * re-renders cleanly. `resetKey` is the lever for that: change it
 * (e.g. text length, message id) and the boundary remounts.
 */
type ScopedProps = {
  children: ReactNode;
  /** Element / fn to render in place of `children` after a render
   *  exception. Keeping it a render-prop lets each call site decide
   *  what graceful degradation looks like — plaintext for chat, an
   *  inline placeholder elsewhere. */
  fallback: (error: Error, retry: () => void) => ReactNode;
  /** When this value changes, the boundary clears the error and
   *  re-attempts the render. We key on `String(resetKey)` so anything
   *  cheap-to-stringify works (length counters, message ids, etc.). */
  resetKey?: unknown;
};

export class ScopedErrorBoundary extends Component<ScopedProps, State> {
  constructor(props: ScopedProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[ScopedErrorBoundary] caught render-time exception", error, info);
  }

  componentDidUpdate(prev: ScopedProps): void {
    // Reset on key change. Used for streaming bubbles — the next
    // token usually completes the partial markdown and the render
    // succeeds.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  reset = () => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}

export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Loud console log so a dev tail shows what the crash was. In
    // production we'd ship this to telemetry; for now stderr is the
    // single source of truth.
    console.error("[AppErrorBoundary] caught render-time exception", error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background p-8 text-foreground">
        <div className="max-w-lg space-y-3 text-center">
          <h1 className="font-serif text-2xl tracking-tight">
            Something broke while rendering.
          </h1>
          <p className="text-[13px] text-muted-foreground">
            The app caught a render-time error before the webview could blank.
            Click below to retry — this almost always fixes it. If it keeps
            happening, the error message below has the details.
          </p>
          <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/30 px-3 py-2 text-left font-mono text-[11.5px] leading-snug text-muted-foreground">
            {error.message || String(error)}
          </pre>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md border border-border bg-card px-4 py-2 text-[13px] font-medium hover:bg-accent/60"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-foreground px-4 py-2 text-[13px] font-medium text-background hover:opacity-90"
          >
            Reload window
          </button>
        </div>
      </div>
    );
  }
}
