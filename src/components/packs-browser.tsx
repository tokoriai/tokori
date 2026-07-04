/**
 * Paid-pack catalog browser. Used in three places:
 *
 *   1. Store dialog ("Content packs" tab) — full catalog.
 *   2. Pack import dialog ("Browse" tab) — filtered to the active
 *      workspace's target language.
 *   3. Onboarding ("Add some vocab" step) — same filter as (2), shown
 *      inline as part of first-run setup.
 *
 * The buy + redeem flows are identical across surfaces:
 *   - Unsigned in → "Sign in" CTA.
 *   - Signed in + unowned → "Buy" opens Stripe Checkout in a new tab,
 *     then polls balance until the grant lands.
 *   - Signed in + owned → "Redeem" downloads the JSON and hands the
 *     parsed pack back to the caller via `onRedeem` so the standard
 *     PackImportDialog activation flow runs.
 */

import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Eye, Loader2, Package, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCloud, type StorePack } from "@/lib/cloud-context";
import { validatePack, type Pack } from "@/lib/pack-import";
import { openExternalUrl } from "@/lib/open-url";
import { cn } from "@/lib/utils";
import { PackPreviewDialog } from "@/components/pack-preview-dialog";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export function PacksBrowser({
  filterLang,
  emptyMessage,
  onRedeem,
  onSignInRequested,
}: {
  /** When set, only packs matching this ISO 639-1 code are shown.
   *  Used by the workspace-scoped surfaces (import dialog, onboarding)
   *  so a user with a Korean workspace doesn't see HSK packs. */
  filterLang?: string;
  /** Override the "nothing matches" message — useful for surfaces
   *  where the filter context is implicit (e.g. "No paid packs for
   *  Spanish yet."). */
  emptyMessage?: string;
  /** Called after a successful download + validate. The caller is
   *  expected to layer a PackImportDialog so the buyer gets the same
   *  activation prefs as the free-pack flow. */
  onRedeem: (pack: Pack) => void;
  /** Caller controls the sign-in modal. We surface a button that
   *  triggers it when the user clicks Buy without an account. */
  onSignInRequested: () => void;
}) {
  const {
    account,
    balance,
    refreshBalance,
    fetchStorePacks,
    buyPack,
    downloadPack,
    apiBase,
  } = useCloud();
  const [packs, setPacks] = useState<StorePack[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Preview state. Paid packs only — we show the catalog-level
  // metadata (description + counts). Full contents are gated by
  // purchase; once redeemed, the parsed Pack flows through onRedeem
  // into PackImportDialog which has its own activation-prefs UI.
  const [previewStore, setPreviewStore] = useState<StorePack | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  function stopPolling() {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setWaiting(null);
    setCheckoutUrl(null);
  }

  useEffect(() => () => stopPolling(), []);

  // Public endpoint — no auth required. We fetch once on mount and
  // keep the result; users rarely buy multiple packs in one session.
  useEffect(() => {
    void fetchStorePacks()
      .then(setPacks)
      .catch(() => setPacks([]));
    if (account) void refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ownedPackIds = new Set((balance?.packGrants ?? []).map((g) => g.packId));

  async function startRedeem(packId: string) {
    try {
      const json = (await downloadPack(packId)) as unknown;
      const validated = validatePack(json);
      if (!validated.ok) {
        toast.error(`Pack file looks invalid: ${validated.error}`);
        return;
      }
      onRedeem(validated.pack as Pack);
    } catch (err) {
      toast.error(
        `Couldn't download pack: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function buy(pack: StorePack) {
    if (!account) {
      onSignInRequested();
      return;
    }
    setError(null);
    setBusy(pack.id);
    try {
      const result = await buyPack(pack.id);
      // Dev-grant path (CLOUD_DEV_MODE=1): credit is already written
      // server-side, no Stripe URL. Refresh and fall through to the
      // owned-redeem flow on next render.
      if (result.granted) {
        await refreshBalance();
        setBusy(null);
        return;
      }
      const url = result.url!;
      try {
        await openExternalUrl(url);
      } catch (err) {
        console.warn("openExternalUrl failed", err);
      }
      setCheckoutUrl(url);
      setWaiting(pack.id);
      pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
      pollTimerRef.current = window.setInterval(async () => {
        if (Date.now() > pollDeadlineRef.current) {
          stopPolling();
          setError(
            "Didn't see a payment yet. If checkout succeeded, close and reopen the dialog.",
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
      const code = (err as { code?: string }).code;
      if (code === "already_owned") {
        toast(`You already own "${pack.name}". Redeeming now.`);
        await startRedeem(pack.id);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(null);
    }
  }

  // When the user's grants list updates while we're waiting on a
  // specific pack, treat that as fulfilment landing and jump straight
  // into the redeem dialog.
  useEffect(() => {
    if (!waiting || !balance) return;
    if (balance.packGrants.some((g) => g.packId === waiting)) {
      const packId = waiting;
      stopPolling();
      toast.success("Pack purchased — pick your activation options.");
      void startRedeem(packId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balance, waiting]);

  const isPaidPro = !!account?.subscription?.isPaidPro;
  const filtered =
    packs == null
      ? null
      : filterLang
        ? packs.filter((p) => p.language === filterLang)
        : packs;

  // Sort by entitlement so the cheapest-to-install options land at the
  // top. Order: free → Pro-included (when the user has paid Pro and can
  // install one-click) → owned → other paid. Within each tier the
  // server's order is preserved.
  function entitlementTier(p: StorePack): number {
    if (p.priceCents === 0) return 0;
    if (!!p.includedWithPro && isPaidPro) return 1;
    if (ownedPackIds.has(p.id)) return 2;
    return 3;
  }
  const visiblePaid =
    filtered == null
      ? null
      : [...filtered].sort((a, b) => entitlementTier(a) - entitlementTier(b));

  if (visiblePaid == null) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 inline size-4 animate-spin" />
        Loading packs…
      </p>
    );
  }
  const webStoreUrl = `${apiBase}/packs`;
  function openWebStore() {
    void openExternalUrl(webStoreUrl).catch((err) => {
      console.warn("openExternalUrl failed", err);
      toast.error("Couldn't open the browser — visit tokori.ai/packs to purchase.");
    });
  }
  // A pack the user can install right now without paying: free,
  // already owned, or covered by their paid-Pro subscription. Drives
  // the "Ready to install" vs "Available to purchase" split below.
  const installableNow = (p: StorePack) =>
    p.priceCents === 0 ||
    ownedPackIds.has(p.id) ||
    (!!p.includedWithPro && isPaidPro);

  if (visiblePaid.length === 0) {
    return (
      <div className="space-y-3">
        <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-[12.5px] text-muted-foreground">
          {emptyMessage ?? "No content packs available here yet."}
        </p>
        <WebStoreLine onOpen={openWebStore} />
      </div>
    );
  }

  const ready = visiblePaid.filter(installableNow);
  const toBuy = visiblePaid.filter((p) => !installableNow(p));

  const renderRow = (p: StorePack) => (
    <PackRow
      key={p.id}
      pack={p}
      isFree={p.priceCents === 0}
      owned={ownedPackIds.has(p.id)}
      // Pro-included entitlement: server enforces it on download; we
      // use the same flag for UI affordance so trial users see Buy and
      // paid Pro users see Install. The download endpoint re-validates,
      // so a fudged client flag wouldn't unlock the file.
      proCovered={!!p.includedWithPro && isPaidPro}
      installable={installableNow(p)}
      hasAccount={!!account}
      disabled={busy != null}
      loadingThis={busy === p.id}
      onPreview={() => setPreviewStore(p)}
      onInstall={() => void startRedeem(p.id)}
      onBuy={() => void buy(p)}
    />
  );

  return (
    <div className="space-y-4">
      {/* What the user can pull in right now — free, owned, or
          Pro-covered. This is the "your available content" surface the
          signed-in buyer expects after purchasing. */}
      {ready.length > 0 && (
        <section className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Ready to install
          </p>
          {ready.map(renderRow)}
        </section>
      )}

      {/* Still need buying. The header carries a quick jump to the web
          store for people who'd rather check out in a real browser. */}
      {toBuy.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Available to purchase
            </p>
            <button
              type="button"
              onClick={openWebStore}
              className="inline-flex items-center gap-1 text-[11.5px] font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
            >
              Buy on the web
              <ExternalLink className="size-3" />
            </button>
          </div>
          {toBuy.map(renderRow)}
        </section>
      )}

      <WebStoreLine onOpen={openWebStore} />

      {waiting && (
        <CheckoutWaitingPanel
          url={checkoutUrl}
          message="Stripe Checkout should have opened in your browser. If nothing happened, click the link below."
        />
      )}
      {error && <p className="text-[12px] text-destructive">{error}</p>}

      <PackPreviewDialog
        storePack={previewStore}
        primaryAction={
          previewStore
            ? previewStore.priceCents === 0 ||
              ownedPackIds.has(previewStore.id) ||
              (!!previewStore.includedWithPro && isPaidPro)
              ? {
                  label: ownedPackIds.has(previewStore.id)
                    ? "Redeem"
                    : "Install",
                  disabled: busy != null,
                  onClick: () => {
                    const id = previewStore.id;
                    setPreviewStore(null);
                    void startRedeem(id);
                  },
                }
              : {
                  label: account ? "Buy" : "Sign in to buy",
                  disabled: busy != null,
                  onClick: () => {
                    const store = previewStore;
                    setPreviewStore(null);
                    if (store) void buy(store);
                  },
                }
            : undefined
        }
        onClose={() => setPreviewStore(null)}
      />
    </div>
  );
}

/** One catalog row: icon + body on the left, a fixed-width price +
 *  action cluster on the right. The cluster is `shrink-0` and the body
 *  is `min-w-0 flex-1`, so a long title or description never squeezes
 *  the price/buttons (the previous layout let the two right-hand
 *  groups collapse into each other and drift out of alignment). */
function PackRow({
  pack,
  isFree,
  owned,
  proCovered,
  installable,
  hasAccount,
  disabled,
  loadingThis,
  onPreview,
  onInstall,
  onBuy,
}: {
  pack: StorePack;
  isFree: boolean;
  owned: boolean;
  proCovered: boolean;
  installable: boolean;
  hasAccount: boolean;
  /** Any pack in the browser is mid-buy — disables every action. */
  disabled: boolean;
  /** This specific pack's Buy is in flight — swaps its icon for a spinner. */
  loadingThis: boolean;
  onPreview: () => void;
  onInstall: () => void;
  onBuy: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-card px-4 py-3",
        owned
          ? "border-emerald-500/30 bg-emerald-500/5"
          : proCovered
            ? "border-indigo-500/30 bg-indigo-500/5"
            : "border-border",
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Package className="size-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 truncate font-medium">{pack.name}</p>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {pack.language}
          </Badge>
          {isFree && !owned && (
            <Badge
              variant="secondary"
              className="shrink-0 text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            >
              Free
            </Badge>
          )}
          {pack.includedWithPro && !owned && (
            <Badge
              variant="secondary"
              className="shrink-0 text-[10px] bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
            >
              {proCovered ? "Included with Pro" : "Pro"}
            </Badge>
          )}
          {owned && (
            <Badge
              variant="secondary"
              className="shrink-0 text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            >
              Owned
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-[12px] text-muted-foreground line-clamp-2">
          {pack.description}
        </p>
        {pack.meta && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {[
              pack.meta.author && `by ${pack.meta.author}`,
              pack.meta.wordCount &&
                `${pack.meta.wordCount.toLocaleString()} words`,
              pack.meta.chapterCount && `${pack.meta.chapterCount} chapters`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <div className="text-right leading-none">
          {isFree ? (
            <span className="font-serif text-lg text-emerald-700 dark:text-emerald-300">
              Free
            </span>
          ) : proCovered ? (
            // Paid-Pro entitlement: install is free, but the struck-
            // through real price keeps the subscription's value visible.
            <span className="inline-flex items-baseline gap-1.5">
              <span className="font-serif text-lg text-indigo-700 dark:text-indigo-300">
                Free
              </span>
              <span className="text-[11px] text-muted-foreground line-through">
                ${(pack.priceCents / 100).toFixed(2)}
              </span>
            </span>
          ) : (
            <span className="font-serif text-lg">
              ${(pack.priceCents / 100).toFixed(2)}
              <span className="ml-1 font-sans text-[11px] text-muted-foreground">
                USD
              </span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={onPreview}
            disabled={disabled}
            aria-label="Preview pack contents"
          >
            <Eye className="size-3.5" />
            Preview
          </Button>
          {installable ? (
            <Button
              size="sm"
              variant={owned ? "outline" : "default"}
              onClick={onInstall}
              disabled={disabled}
            >
              <Download className="size-3.5" />
              {owned ? "Redeem" : "Install"}
            </Button>
          ) : (
            <Button size="sm" onClick={onBuy} disabled={disabled}>
              {loadingThis ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {hasAccount ? "Buy" : "Sign in to buy"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Footer explainer: people can purchase in a real browser, then the
 *  pack shows up here to install whenever they're signed in. Closes the
 *  loop the user asked for (buy on the web → install in the app). */
function WebStoreLine({ onOpen }: { onOpen: () => void }) {
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      Prefer your browser?{" "}
      <button
        type="button"
        onClick={onOpen}
        className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
      >
        Open the full store on tokori.ai
      </button>
      . Packs bought there can be downloaded on the site, or installed here
      automatically whenever you&apos;re signed in.
    </p>
  );
}

/** Renders the spinner + a clickable Stripe Checkout link. In a Tauri
 *  webview, anchor clicks with target=_blank route reliably to the
 *  system browser; window.open does not — so the visible link is the
 *  dependable click-out, with the implicit window.open as a
 *  convenience layer. Exported so the tokens flow (in store-dialog)
 *  can use the same panel. */
export function CheckoutWaitingPanel({
  url,
  message,
}: {
  url: string | null;
  message: string;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-card px-3 py-2.5 text-[12.5px] text-muted-foreground">
      <p>
        <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
        Waiting for Stripe to confirm your payment…
      </p>
      {url && (
        <>
          <p>{message}</p>
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-accent"
          >
            Open Stripe Checkout
            <span aria-hidden>→</span>
          </a>
        </>
      )}
    </div>
  );
}
