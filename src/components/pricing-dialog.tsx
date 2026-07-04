/**
 * Pro tier overview dialog.
 *
 * Shows the headline price + feature list. "See plans" routes to the
 * marketing pricing page (tokori.ai/pricing) where Stripe Checkout
 * will live once billing is wired. Pro users see "Manage subscription"
 * instead, which opens the Stripe billing portal — that flow stays
 * in-app because it relies on a server-issued portal session URL.
 */

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock,
  Cloud,
  Headphones,
  Loader2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useCloud } from "@/lib/cloud-context";
import { openExternalUrl } from "@/lib/open-url";
import { cn } from "@/lib/utils";

const PRO_FEATURES: { icon: React.ComponentType<{ className?: string }>; text: string }[] = [
  {
    icon: Cloud,
    text: "Cloud backup of your vocab, decks, and chat history",
  },
  {
    icon: Headphones,
    text: "Mobile companion app (coming soon)",
  },
  {
    icon: Clock,
    text: "Cancel any time. Local features always free.",
  },
];

export function PricingDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { account, isPro, createPortalUrl } = useCloud();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state each open.
  useEffect(() => {
    if (open) {
      setError(null);
      setBusy(false);
    }
  }, [open]);

  async function openPricing() {
    // Checkout lives on the marketing pricing page (tokori.ai/pricing).
    // Once Stripe is wired there the page will own the upgrade flow
    // end-to-end; until then the link surfaces the tier breakdown so
    // users aren't stuck behind an in-app button that goes nowhere.
    setError(null);
    setBusy(true);
    try {
      await openExternalUrl("https://tokori.ai/pricing");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openPortal() {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      const url = await createPortalUrl();
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    if (busy) return;
    onClose();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4" />
              Tokori Pro
            </DialogTitle>
            <DialogDescription>
              Optional. The local app — vocab, flashcards, reader, chat with
              your own keys — works fully without a subscription.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="rounded-2xl border border-border bg-muted/20 px-5 py-4">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  From
                </span>
                <span className="font-serif text-3xl tracking-tight">$8</span>
                <span className="text-[12px] text-muted-foreground">
                  per month · cancel anytime
                </span>
                {isPro && (
                  <Badge
                    variant="secondary"
                    className="ml-auto bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  >
                    Active
                  </Badge>
                )}
              </div>
              <ul className="mt-3 space-y-1.5 text-[13px]">
                {PRO_FEATURES.map((f, i) => {
                  const Icon = f.icon;
                  return (
                    <li key={i} className="flex items-start gap-2">
                      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <span>{f.text}</span>
                    </li>
                  );
                })}
              </ul>
            </div>

            {isPro && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2.5 text-[12.5px]",
                  "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
                )}
              >
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                <span>
                  You&apos;re Pro. Manage payment method, invoices, or cancel
                  anytime via the billing portal.
                </span>
              </div>
            )}

            {error && (
              <p className="text-[12px] text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={handleClose} disabled={busy}>
              Close
            </Button>
            {isPro ? (
              <Button onClick={openPortal} disabled={busy}>
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                Manage subscription
              </Button>
            ) : (
              <Button onClick={openPricing} disabled={busy}>
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                See plans →
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
