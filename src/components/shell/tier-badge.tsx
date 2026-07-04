import type { CloudSubscription } from "@/lib/cloud-context";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Variant = "pill" | "settings";

/** Account-tier badge. Three rendered states:
 *    · Stripe `trialing` → amber "Trial · Nd" countdown.
 *    · Paid (active, non-trial) Pro → solid "Pro".
 *    · Anything else → nothing.
 *
 *  Two visual variants share the same logic so the sidebar pill and
 *  the Settings → Cloud card can't drift apart. */
export function TierBadge({
  subscription,
  variant,
}: {
  subscription: CloudSubscription | undefined | null;
  variant: Variant;
}) {
  if (!subscription) return null;

  if (subscription.status === "trialing") {
    const label = trialLabel(subscription);
    const title = subscription.trialEndsAt
      ? `Trial ends ${new Date(subscription.trialEndsAt * 1000).toLocaleString()}`
      : undefined;
    if (variant === "pill") {
      return (
        <span
          className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300"
          title={title}
        >
          {label}
        </span>
      );
    }
    return (
      <Badge
        variant="secondary"
        className={cn(
          "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        )}
        title={title}
      >
        {label}
      </Badge>
    );
  }

  if (subscription.isPaidPro) {
    if (variant === "pill") {
      return (
        <span className="shrink-0 rounded-full border border-indigo-500/30 bg-indigo-500/15 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
          Pro
        </span>
      );
    }
    return (
      <Badge
        variant="secondary"
        className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      >
        Pro
      </Badge>
    );
  }

  return null;
}

function trialLabel(sub: CloudSubscription): string {
  const daysLeft = trialDaysLeft(sub);
  const secsLeft = sub.trialSecondsRemaining;
  if (daysLeft == null) return "Trial";
  if (daysLeft <= 0) return "Trial · ends today";
  if (daysLeft === 1) {
    if (secsLeft != null && secsLeft < 86_400) {
      return `Trial · ${Math.max(1, Math.ceil(secsLeft / 3600))}h`;
    }
    return "Trial · 1d";
  }
  return `Trial · ${daysLeft}d`;
}

/** Days left on the signup trial. Prefers the server-computed value;
 *  falls back to a client compute against currentPeriodEnd so the
 *  badge keeps working against older API responses. */
function trialDaysLeft(sub: CloudSubscription): number | null {
  if (typeof sub.trialDaysRemaining === "number") {
    return sub.trialDaysRemaining;
  }
  if (sub.currentPeriodEnd) {
    return Math.max(
      0,
      Math.ceil((sub.currentPeriodEnd * 1000 - Date.now()) / 86_400_000),
    );
  }
  return null;
}
