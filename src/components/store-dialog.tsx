/**
 * Store dialog — AI tokens (one-time top-up) + Content packs (one-time
 * purchases granting permanent access).
 *
 * Both flows follow the same shape:
 *   1. User taps Buy → we POST to the cloud, get a Stripe Checkout URL.
 *   2. We open the URL in the browser (Tauri webview honours target=_blank
 *      via window.open for external HTTPS URLs).
 *   3. We poll /api/v1/me/balance every 3s for up to 5 min.
 *   4. Once the webhook lands (token balance increases or pack appears
 *      in the grants list), we celebrate. For packs, we additionally
 *      stream the JSON down and hand it to PackImportDialog.
 *
 * If the user cancels Stripe or closes the browser, polling times out
 * and we surface a friendly retry message. The Stripe webhook remains
 * the source of truth either way.
 */

import { useEffect, useRef, useState } from "react";
import { Cloud, Coins, Loader2, Package } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useCloud, type TokenBundle } from "@/lib/cloud-context";
import { CloudSignInDialog } from "@/components/cloud-signin-dialog";
import { PackImportDialog } from "@/components/pack-import-dialog";
import {
  CheckoutWaitingPanel,
  PacksBrowser,
} from "@/components/packs-browser";
import type { Pack } from "@/lib/pack-import";
import { openExternalUrl } from "@/lib/open-url";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export function StoreDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { account, balance, refreshBalance, fetchTokenBundles } = useCloud();
  const [bundles, setBundles] = useState<TokenBundle[] | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  // When a buyer redeems (either right after a fresh purchase or by
  // clicking Import on an already-owned pack), we hand the parsed JSON
  // off to the same PackImportDialog the free-pack flow uses. Layering
  // it on top of the store dialog keeps the buyer's place — close the
  // redeem and they're back on the store, can buy something else, etc.
  const [redeemPack, setRedeemPack] = useState<Pack | null>(null);

  // Load token bundles on open. Public endpoint — no auth required.
  // We keep them cached on close so re-opening is instant. Pack
  // catalog is fetched by PacksBrowser itself.
  useEffect(() => {
    if (!open) return;
    void fetchTokenBundles()
      .then(setBundles)
      .catch(() => setBundles([]));
    if (account) void refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Cloud className="size-4" />
              Store
            </DialogTitle>
            <DialogDescription>
              Buy AI credits or content packs. Local features keep working
              without either — this is purely opt-in.
            </DialogDescription>
          </DialogHeader>

          {/* Balance summary — only shown when signed in. */}
          {account && balance && (
            <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
              <div>
                <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  AI credits
                </p>
                <p className="font-serif text-xl tabular-nums">
                  {balance.tokenBalance.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  Owned packs
                </p>
                <p className="font-serif text-xl">
                  {balance.packGrants.length}
                </p>
              </div>
            </div>
          )}

          <Tabs defaultValue="tokens" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="tokens" className="flex-1">
                <Coins className="size-3.5" />
                AI tokens
              </TabsTrigger>
              <TabsTrigger value="packs" className="flex-1">
                <Package className="size-3.5" />
                Content packs
              </TabsTrigger>
            </TabsList>

            <TabsContent value="tokens" className="mt-3">
              <TokensTab
                account={account}
                bundles={bundles}
                onSignInRequested={() => setSignInOpen(true)}
              />
            </TabsContent>

            <TabsContent value="packs" className="mt-3">
              <PacksBrowser
                onSignInRequested={() => setSignInOpen(true)}
                onRedeem={(pack) => {
                  // Close the store first — two Radix Dialogs stacked
                  // on each other compete for focus and pointer-events,
                  // which can leave the redeem modal invisible / inert.
                  // StoreDialog the component stays mounted (the parent
                  // always renders <StoreDialog open={...}>), so the
                  // redeemPack state survives this close and the
                  // PackImportDialog below shows up cleanly on its own.
                  onClose();
                  setRedeemPack(pack);
                }}
              />
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CloudSignInDialog
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
      />

      {/* Same dialog the free-pack flow uses — the buyer reviews
          counts, picks textbook activation, and chooses which
          standalone collections to include. We hand the already-parsed
          Pack directly, so the file picker and free-pack list are
          hidden. */}
      <PackImportDialog
        open={!!redeemPack}
        presetPack={redeemPack}
        presetTitle="Redeem your pack"
        onClose={() => setRedeemPack(null)}
        onImported={() => {
          setRedeemPack(null);
          onClose();
        }}
      />
    </>
  );
}

// ─── Tokens tab ──────────────────────────────────────────────────────────

function TokensTab({
  account,
  bundles,
  onSignInRequested,
}: {
  account: ReturnType<typeof useCloud>["account"];
  bundles: TokenBundle[] | null;
  onSignInRequested: () => void;
}) {
  const { buyTokens, refreshBalance } = useCloud();
  const [busy, setBusy] = useState<string | null>(null); // bundleId currently buying
  const [waiting, setWaiting] = useState(false);
  // Last issued Stripe Checkout URL. We render it as an explicit link
  // in the waiting state so the user always has a reliable click-out
  // (Tauri's webview silently swallows window.open for external HTTPS
  // — only anchor clicks reliably reach the system browser).
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollDeadlineRef = useRef<number>(0);
  const baselineBalanceRef = useRef<number>(0);

  function stopPolling() {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setWaiting(false);
    setCheckoutUrl(null);
  }

  useEffect(() => () => stopPolling(), []);

  async function buy(bundle: TokenBundle) {
    if (!account) {
      onSignInRequested();
      return;
    }
    setError(null);
    setBusy(bundle.id);
    try {
      // Snapshot the balance before opening checkout so we can detect
      // an increase as "fulfilment landed" — independent of which
      // bundle they actually clicked.
      await refreshBalance();
      const result = await buyTokens(bundle.id);
      // Dev-grant path (CLOUD_DEV_MODE=1 on the server): the credit
      // already happened — no URL to open, no polling needed. Skip
      // straight to the success state.
      if (result.granted) {
        await refreshBalance();
        setBusy(null);
        return;
      }
      const url = result.url!;
      // Route through the OS shell. tauri-plugin-opener handles this
      // inside the desktop; web preview falls back to window.open. The
      // link below remains as a manual click-out if the call fails for
      // any reason (plugin permission, popup blocker).
      try {
        await openExternalUrl(url);
      } catch (err) {
        console.warn("openExternalUrl failed", err);
      }
      setCheckoutUrl(url);
      setWaiting(true);
      pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
      // Track the balance snapshot via a closure on the polling timer:
      // we capture whatever the cloud-context already has, then watch
      // for the next refresh to bring back something larger.
      pollTimerRef.current = window.setInterval(async () => {
        if (Date.now() > pollDeadlineRef.current) {
          stopPolling();
          setError(
            "Didn't see a payment yet. If checkout succeeded, click Refresh.",
          );
          return;
        }
        try {
          await refreshBalance();
        } catch {
          /* keep polling */
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // Watch for the balance to actually increase (set by the polling
  // tick). We hold the baseline locally and toast once it overshoots.
  const { balance } = useCloud();
  useEffect(() => {
    if (!waiting) {
      baselineBalanceRef.current = balance?.tokenBalance ?? 0;
      return;
    }
    if (balance && balance.tokenBalance > baselineBalanceRef.current) {
      const gained = balance.tokenBalance - baselineBalanceRef.current;
      stopPolling();
      toast.success(`+${gained.toLocaleString()} credits added.`);
      baselineBalanceRef.current = balance.tokenBalance;
    }
  }, [balance, waiting]);

  if (bundles == null) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 inline size-4 animate-spin" />
        Loading bundles…
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {bundles.map((b) => (
        <div
          key={b.id}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Coins className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{b.label}</p>
            {b.description && (
              <p className="text-[12px] text-muted-foreground">
                {b.description}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="font-serif text-lg leading-none">
              ${(b.priceCents / 100).toFixed(2)}
            </p>
            <p className="text-[11px] text-muted-foreground">USD</p>
          </div>
          <Button
            size="sm"
            onClick={() => void buy(b)}
            disabled={busy != null}
          >
            {busy === b.id ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Buy
          </Button>
        </div>
      ))}
      {waiting && (
        <CheckoutWaitingPanel
          url={checkoutUrl}
          message="Stripe Checkout should have opened in your browser. If nothing happened, click the link below."
        />
      )}
      {error && (
        <p className="text-[12px] text-destructive">{error}</p>
      )}
    </div>
  );
}

