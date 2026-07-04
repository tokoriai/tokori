/**
 * Read-only placeholder shown in Settings when the app is running in
 * demo mode (`?demo=1` on the marketing iframe).
 *
 * Why locked: the public marketing iframe must not let visitors enter
 * API keys (would persist into the demo's in-memory store, then leak
 * into network requests if the demo's mock provider were ever
 * replaced) or sign in to the cloud (would create real auth rows for
 * a non-installer). Locking the affordances at the UI layer is enough
 * — the demo's `isTauri()` is false, so the underlying mutations
 * already no-op in the in-memory fallback, but we don't want the
 * affordance there at all.
 */

import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DemoLockedPanel({ kind }: { kind: "cloud" | "providers" }) {
  const meta =
    kind === "cloud"
      ? {
          title: "Tokori Cloud",
          headline: "Disabled in the live demo",
          body: "Sign-in, Pro upgrade, and cloud backup are turned off here. Install the desktop app to use the cloud (or skip it — every local feature works without an account).",
        }
      : {
          title: "Providers",
          headline: "Disabled in the live demo",
          body: "Adding API keys is disabled in the demo iframe so visitors can't accidentally store credentials in a shared session. Install the desktop app to plug in OpenAI, Anthropic, Gemini, or Ollama.",
        };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{meta.title}</h2>
      </div>
      <div className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-card/40 p-5">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/5 text-foreground/70">
          <Lock className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{meta.headline}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">{meta.body}</p>
          <Button
            asChild
            size="sm"
            variant="outline"
            className="mt-3"
          >
            <a href="/" target="_top">
              Back to landing
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
