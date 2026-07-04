/**
 * Dashboard banner for hosted users on the signup trial.
 *
 *   · Hidden in the desktop build (HOSTED=false, full dead-code-elim).
 *   · Hidden once the user has paid Pro (subscription is no longer
 *     in the `trialing` state).
 *   · Hidden once the user dismisses it for this trial window. The
 *     dismissal is keyed on `currentPeriodEnd` so a *new* trial (rare:
 *     re-grant by an admin) would surface a fresh banner; the same
 *     trial only ever bothers the user once.
 *   · Shows days-remaining + a "See plans" CTA that opens Stripe
 *     Checkout for the Pro subscription directly (via the cloud's
 *     /api/billing/checkout). Falls back to the marketing pricing page
 *     if checkout isn't reachable.
 */

import { useEffect, useState } from "react";
import { Download, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCloud } from "@/lib/cloud-context";
import { HOSTED } from "@/lib/build-flags";

const DISMISS_KEY_PREFIX = "trial-banner.dismissed:";

export function TrialBanner() {
  // Desktop build: nothing to render. The constant comparison lets
  // terser strip the whole component from the desktop bundle.
  if (!HOSTED) return null;
  return <HostedTrialBanner />;
}

function HostedTrialBanner() {
  const cloud = useCloud();
  const sub = cloud.account?.subscription;
  const trialEnd = sub?.status === "trialing" ? sub.currentPeriodEnd : null;

  // Dismissal is keyed by the trial's end-timestamp so any subsequent
  // trial (re-issued, extended, etc.) renders fresh instead of
  // inheriting the previous dismissal.
  const dismissKey = trialEnd != null ? `${DISMISS_KEY_PREFIX}${trialEnd}` : null;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined" || !dismissKey) return false;
    try {
      return localStorage.getItem(dismissKey) === "1";
    } catch {
      return false;
    }
  });
  // If the trial end changes (e.g. an admin re-issues the trial), the
  // dismissed flag is stale — reset it so the new trial banner can
  // show. Cheap effect; depends only on the key string.
  useEffect(() => {
    if (typeof window === "undefined" || !dismissKey) return;
    try {
      setDismissed(localStorage.getItem(dismissKey) === "1");
    } catch {
      /* private mode — non-fatal */
    }
  }, [dismissKey]);

  if (!trialEnd || dismissed) return null;

  // Prefer the server-validated countdown — it can't drift with the
  // device clock, and it matches the same value the entitlement
  // checks on the backend use. Older API responses (or a stale
  // cached account blob) fall back to a client-side compute against
  // currentPeriodEnd so we never render nothing.
  const daysLeft =
    typeof sub?.trialDaysRemaining === "number"
      ? sub.trialDaysRemaining
      : Math.max(
          0,
          Math.ceil((trialEnd * 1000 - Date.now()) / 86_400_000),
        );

  function dismiss() {
    setDismissed(true);
    if (dismissKey) {
      try {
        localStorage.setItem(dismissKey, "1");
      } catch {
        /* private mode — banner just comes back on reload, acceptable */
      }
    }
  }

  // Go straight to Stripe Checkout. On any failure (e.g. Stripe price
  // not configured yet) fall back to the marketing pricing page so the
  // CTA always lands somewhere useful.
  async function onSeePlans() {
    try {
      const url = await cloud.createCheckoutUrl();
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      window.open("https://tokori.ai/pricing", "_blank", "noopener,noreferrer");
    }
  }

  const headline =
    daysLeft === 0
      ? "Your trial ends today."
      : daysLeft === 1
        ? "Your trial ends tomorrow."
        : `${daysLeft} days left on your Pro trial.`;

  return (
    <div className="relative flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 to-orange-500/5 px-4 py-3 pr-10">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-amber-500/20 text-amber-700 dark:text-amber-300">
        <Sparkles className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{headline}</p>
        <p className="text-[12px] text-muted-foreground">
          Keep your AI tutor, multi-device sync, and Pro-included content
          packs — subscribe to lock it in. Or use the{" "}
          <a
            href="https://tokori.ai/download"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            desktop app
          </a>{" "}
          — it's free forever, runs locally, bring your own AI keys.
        </p>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        <Button size="sm" onClick={() => void onSeePlans()}>
          <Sparkles className="size-3.5" />
          See plans — from $8 / mo
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a
            href="https://tokori.ai/download"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Download className="size-3.5" />
            Get desktop
          </a>
        </Button>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss trial banner"
        className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
