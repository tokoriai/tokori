import { useEffect, useRef } from "react";

/**
 * Cloudflare Turnstile widget — spam protection on the hosted-app
 * magic-link sign-in (mirrors the marketing site's widget). Renders
 * only when a site key is configured; the cloud's `verifyTurnstile`
 * is fail-open without its secret, so the feature is a no-op until both
 * halves are set. `onToken(null)` fires on expiry/error.
 *
 * Explicit render so it survives React mount/unmount: the script loads
 * once, the widget renders into our ref and is removed on unmount.
 */

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
  reset: (id?: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Turnstile script failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function Turnstile({
  siteKey,
  onToken,
  theme = "auto",
  resetKey = 0,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  theme?: "auto" | "light" | "dark";
  /** Bump to force a fresh challenge — Turnstile tokens are single-use,
   *  so re-render the widget after a failed submit consumed the token. */
  resetKey?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;
    void loadScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => {
        onTokenRef.current(null);
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          /* already gone */
        }
        widgetId.current = null;
      }
    };
  }, [siteKey, theme, resetKey]);

  return <div ref={containerRef} className="flex justify-center" />;
}
