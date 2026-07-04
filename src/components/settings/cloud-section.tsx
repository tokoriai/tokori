import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Coins,
  ExternalLink,
  Loader2,
  Lock,
  Package,
  RefreshCw,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TierBadge } from "@/components/shell/tier-badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CloudSignInDialog } from "@/components/cloud-signin-dialog";
import { PricingDialog } from "@/components/pricing-dialog";
import { StoreDialog } from "@/components/store-dialog";
import { HOSTED } from "@/lib/build-flags";
import { openExternalUrl } from "@/lib/open-url";
import { triggerCloudRefresh } from "@/lib/cloud-refresh";
import { useCloud } from "@/lib/cloud-context";
import { OAuthSignInButtons } from "@/components/oauth-signin-buttons";
import { DemoLockedPanel } from "@/components/settings/demo-locked-panel";
import { isDemoRequested } from "@/lib/demo-seed";
import { useWorkspace } from "@/lib/workspace-context";
import {
  forceDownload,
  forceUpload,
  getLastSyncAt,
  syncNow,
  SyncAuthError,
  SyncProRequiredError,
  type SyncAuth,
  type SyncOutcome,
} from "@/lib/sync/engine";
import { getSetting, setSetting } from "@/lib/db";
import { AUTO_SYNC_KEY } from "@/lib/use-auto-sync";

/**
 * Settings → Cloud account section.
 *
 * Cloud is OPTIONAL. The local app — vocab, decks, reader, chat with
 * BYOK keys — works fully without a sign-in. Sign-in unlocks (later)
 * managed AI credits, pack purchases, and Pro features (sync, mobile).
 *
 * Sign-in is magic-link via the tokori-cloud Worker. The flow is
 * encapsulated in CloudSignInDialog; this section is just status +
 * affordances around it.
 *
 * Pricing / Pro signup lives in PricingDialog. The "Upgrade to Pro"
 * affordance only shows up here in Settings → Cloud — we deliberately
 * don't push it from the main app surface (no nag banners, no upsell
 * modals on launch).
 */
export function CloudSection() {
  const { account, loading, isPro, signOut, refreshAccount, balance, refreshBalance } =
    useCloud();
  const [signInOpen, setSignInOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // One refresh on mount when signed in, so a cancelled-or-renewed sub
  // shows up immediately instead of after the next tab focus. Same for
  // balance so the credit count is fresh when the user opens Settings.
  useEffect(() => {
    if (account) {
      void refreshAccount();
      void refreshBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.token]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading account…
      </div>
    );
  }

  // Demo mode (?demo=1 in the marketing iframe) — sign-in / Stripe /
  // backup buttons would all hit our cloud, which we don't want a
  // public iframe doing. Show a read-only placeholder instead.
  if (isDemoRequested()) {
    return <DemoLockedPanel kind="cloud" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Tokori Cloud</h2>
        <p className="text-[13px] text-muted-foreground">
          Optional. Sign in to (later) use credits-based AI without API keys
          and to manage paid content packs. The rest of the app — local
          Ollama, BYOK for OpenAI / Anthropic / Gemini, vocab, flashcards,
          reader — works fully without an account.
        </p>
      </div>

      {account ? (
        <SignedIn
          email={account.user.email}
          isPro={isPro}
          subscription={account.subscription}
          tokenBalance={balance?.tokenBalance ?? 0}
          ownedPackCount={balance?.packGrants.length ?? 0}
          onSignOut={signOut}
          onRefresh={async () => {
            setRefreshing(true);
            try {
              await Promise.all([refreshAccount(), refreshBalance()]);
            } finally {
              setRefreshing(false);
            }
          }}
          refreshing={refreshing}
          onOpenPricing={() => setPricingOpen(true)}
          onOpenStore={() => setStoreOpen(true)}
        />
      ) : (
        <SignedOut
          onOpenSignIn={() => setSignInOpen(true)}
          onOpenStore={() => setStoreOpen(true)}
        />
      )}

      {/* (Tokori Pro pitch card removed — keeping Settings → Cloud
          focused on the account state itself. Pricing lives on the
          marketing site; existing Pro subscribers still see a
          "Manage subscription" affordance inside SignedIn.) */}

      {/* Sync (desktop) / Multi-device refresh (hosted). Desktop runs
          the AnkiWeb-style exchange: push local changes, pull other
          devices'. Hosted has no local store — the same toggle drives
          auto-refresh of views from the cloud DB instead. AuthGate
          already covers the sign-in affordance in HOSTED; this is on
          top. */}
      {account && (
        HOSTED ? (
          <HostedSyncCard />
        ) : (
          <SyncCard onOpenPricing={() => setPricingOpen(true)} />
        )
      )}

      <div className="rounded-lg border border-dashed border-border bg-card/40 px-4 py-3 text-[12.5px] text-muted-foreground">
        <p className="font-medium text-foreground">Always free with your own keys.</p>
        <p className="mt-1">
          Cloud is just an alternative to setting up OpenAI, Anthropic, or
          Gemini keys yourself. If you've got those, you don't need this —
          local features and BYOK keep working forever.
        </p>
      </div>

      <CloudSignInDialog
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
      />
      <PricingDialog
        open={pricingOpen}
        onClose={() => setPricingOpen(false)}
      />
      <StoreDialog
        open={storeOpen}
        onClose={() => setStoreOpen(false)}
      />
    </div>
  );
}

function SignedOut({
  onOpenSignIn,
  onOpenStore,
}: {
  onOpenSignIn: () => void;
  onOpenStore: () => void;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <CloudOff className="size-4" />
        </div>
        <div>
          <p className="font-medium">Not signed in</p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Sign in to top up AI credits, buy content packs, or back up your
            library. Local features always work without an account — the
            free cloud trial is on{" "}
            <a
              href="https://app.tokori.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              app.tokori.ai
            </a>{" "}
            when you&apos;re ready.
          </p>
        </div>
      </div>

      {/* Stacked SSO buttons — one per provider, full width so they
          read as primary actions. Each opens a browser tab; the local
          API server's /oauth/callback receives the redirect and
          finishes the handshake. Shared with the magic-link sign-in
          dialog via OAuthSignInButtons. */}
      <OAuthSignInButtons />

      {/* Divider + email fallback. Magic-link stays as the always-on
          path for users who don't want a third-party identity tied to
          their account. */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
          or
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onOpenSignIn}>
          Sign in with email
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenStore}>
          <ShoppingBag className="size-3.5" />
          Browse store
        </Button>
      </div>
    </div>
  );
}

function SignedIn({
  email,
  isPro,
  subscription,
  tokenBalance,
  ownedPackCount,
  onSignOut,
  onRefresh,
  refreshing,
  onOpenPricing,
  onOpenStore,
}: {
  email: string;
  isPro: boolean;
  subscription: import("@/lib/cloud-context").CloudSubscription;
  tokenBalance: number;
  ownedPackCount: number;
  onSignOut: () => Promise<void>;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
  onOpenPricing: () => void;
  onOpenStore: () => void;
}) {
  const subscriptionDateLabel = formatSubscriptionDate(subscription);

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">Signed in</p>
              <TierBadge subscription={subscription} variant="settings" />
            </div>
            <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
              {email}
            </p>
            {subscriptionDateLabel && (
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                {subscriptionDateLabel}
              </p>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {/* Balance row — AI credits + owned pack count side by side. */}
      <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-background/40 p-3">
        <div className="flex items-center gap-2">
          <Coins className="size-3.5 text-muted-foreground" />
          <div>
            <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              AI credits
            </p>
            <p className="font-serif text-lg leading-tight tabular-nums">
              {tokenBalance.toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Package className="size-3.5 text-muted-foreground" />
          <div>
            <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              Owned packs
            </p>
            <p className="font-serif text-lg leading-tight">
              {ownedPackCount}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" variant="outline" onClick={onOpenStore}>
          <ShoppingBag className="size-3.5" />
          Store
        </Button>
        {isPro ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openExternalUrl("https://tokori.ai/account")}
          >
            Manage subscription
            <ExternalLink className="size-3" />
          </Button>
        ) : (
          <Button size="sm" onClick={onOpenPricing}>
            <Sparkles className="size-3.5" />
            Upgrade to Pro
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onSignOut()}
          className="ml-auto text-muted-foreground"
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}

// `ProCard` removed — its upgrade pitch + price badge belonged on
// the marketing site (tokori.ai/pricing), not in an open-source
// desktop's settings. Existing Pro subscribers retain access to
// billing controls via the "Manage subscription" button in `SignedIn`.

// ─── Sync card ──────────────────────────────────────────────────────────
//
// Pro-gated. One "Sync now" runs the full AnkiWeb-style exchange:
// push local changes + deletions, pull other devices'. First sync on
// an account that already has cloud data (both sides populated) asks
// Merge / Upload / Download; a force-upload elsewhere surfaces as a
// "download required" prompt (epoch mismatch). Everything is
// idempotent — safe to retry after any failure.

function SyncCard({ onOpenPricing }: { onOpenPricing: () => void }) {
  const { account, isPro, apiBase } = useCloud();
  const { active: workspace } = useWorkspace();
  const [busy, setBusy] = useState<"sync" | "upload" | "download" | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [autoSync, setAutoSync] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [epochOpen, setEpochOpen] = useState(false);
  const [confirmUpload, setConfirmUpload] = useState(false);
  const [confirmDownload, setConfirmDownload] = useState(false);

  useEffect(() => {
    void getLastSyncAt().then(setLastSync);
  }, [busy]); // refresh after each run

  // Reflect the persisted auto-sync setting on mount + after any
  // local toggle so the switch state stays truthful across reloads.
  useEffect(() => {
    void getSetting(AUTO_SYNC_KEY).then((raw) => {
      setAutoSync(raw === "1" || raw === "true");
    });
  }, []);

  async function toggleAutoSync(next: boolean) {
    setAutoSync(next);
    await setSetting(AUTO_SYNC_KEY, next ? "1" : "0");
    // Push the change to the auto-sync hook synchronously — replaces
    // the previous 5 s poll, which became GET-spam on HOSTED. Cheap
    // CustomEvent; the hook listens on window for this name.
    window.dispatchEvent(
      new CustomEvent<string>("tokori:auto-sync-changed", {
        detail: next ? "1" : "0",
      }),
    );
    if (next) {
      toast.success("Auto-sync on", {
        description: "Syncing every 5 minutes while you're signed in.",
      });
    } else {
      toast("Auto-sync off");
    }
  }

  const auth: SyncAuth | null = account
    ? { apiBase, token: account.token }
    : null;

  async function run(
    kind: "sync" | "upload" | "download",
    op: (a: SyncAuth) => Promise<SyncOutcome>,
  ) {
    if (!auth || !isPro || busy) return;
    setBusy(kind);
    try {
      const outcome = await op(auth);
      if (outcome.kind === "first-sync-choice") {
        setChoiceOpen(true);
        return;
      }
      if (outcome.kind === "epoch-mismatch") {
        setEpochOpen(true);
        return;
      }
      const s = outcome.summary;
      toast.success("Synced", {
        description:
          `${s.pushed} pushed · ${s.pulled} pulled · ${s.deleted} deleted` +
          (s.rejected > 0 ? ` · ${s.rejected} skipped` : ""),
      });
    } catch (err) {
      handleSyncError(err, "Sync failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card/40 p-5">
      <div className="flex items-center gap-2">
        <RefreshCw className="size-4 text-foreground/70" />
        <h3 className="text-sm font-semibold tracking-tight">Sync</h3>
        {!isPro && (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Lock className="size-2.5" />
            Pro
          </Badge>
        )}
      </div>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Push and pull your latest changes — vocabulary, reviews,
        collections, personal dictionary, chats, notes, and settings —
        across every device signed into this account.
      </p>

      {!isPro ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-background/40 px-3 py-2.5">
          <span className="text-[12px] text-muted-foreground">
            Cloud sync is part of Tokori Pro.
          </span>
          <Button size="sm" variant="outline" onClick={onOpenPricing}>
            Upgrade
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void run("sync", (a) => syncNow(a))}
              disabled={busy != null || !workspace}
              className="gap-1.5"
            >
              {busy === "sync" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Sync now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmUpload(true)}
              disabled={busy != null}
              className="gap-1.5 text-muted-foreground"
            >
              {busy === "upload" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CloudUpload className="size-3.5" />
              )}
              Upload
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDownload(true)}
              disabled={busy != null}
              className="gap-1.5 text-muted-foreground"
            >
              {busy === "download" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CloudDownload className="size-3.5" />
              )}
              Download
            </Button>
          </div>
          {/* Auto-sync toggle — Pro-gated by the outer `if (!isPro)`
              already. Runs syncNow() every 5 min while the app is
              open; the hook in App.tsx reads the same setting key
              and runs the scheduler. */}
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="min-w-0">
              <Label
                htmlFor="auto-sync"
                className="text-[12.5px] font-medium"
              >
                Auto-sync
              </Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Sync every 5 minutes while the app is open.
              </p>
            </div>
            <Switch
              id="auto-sync"
              checked={autoSync}
              onCheckedChange={(v) => void toggleAutoSync(!!v)}
            />
          </div>
          <div className="mt-2.5 text-[11.5px] text-muted-foreground">
            Last synced: {lastSync ? formatRelative(lastSync) : "never"}
          </div>
        </>
      )}

      {/* First sync with data on both sides — the Anki question. */}
      <AlertDialog open={choiceOpen} onOpenChange={setChoiceOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>First sync — choose a direction</AlertDialogTitle>
            <AlertDialogDescription>
              This device and the cloud both hold data that has never been
              synced together. Merge keeps everything from both sides
              (identical words, collections, and workspaces are matched up,
              newest edit wins). Or replace one side entirely.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-col">
            <AlertDialogAction
              onClick={() => void run("sync", (a) => syncNow(a, { acceptMerge: true }))}
            >
              Merge both sides (recommended)
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
              onClick={() => void run("upload", forceUpload)}
            >
              Upload — replace cloud with this device
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
              onClick={() => void run("download", forceDownload)}
            >
              Download — replace this device with cloud
            </AlertDialogAction>
            <AlertDialogCancel>Not now</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Another device force-uploaded — this copy must re-download. */}
      <AlertDialog open={epochOpen} onOpenChange={setEpochOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cloud data was replaced</AlertDialogTitle>
            <AlertDialogDescription>
              Another device uploaded a full replacement of your cloud
              data. To keep syncing, this device needs to download that
              copy — any local changes made since your last sync will be
              lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void run("download", forceDownload)}
            >
              Download and replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmUpload} onOpenChange={setConfirmUpload}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Upload, replacing cloud data?</AlertDialogTitle>
            <AlertDialogDescription>
              Wipes the account&apos;s cloud data and uploads everything
              from this device. Other devices will be asked to download
              the new copy on their next sync — their unsynced changes
              will be lost. Use the plain Sync button for everyday use.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run("upload", forceUpload)}>
              Upload
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDownload} onOpenChange={setConfirmDownload}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Download, replacing this device?</AlertDialogTitle>
            <AlertDialogDescription>
              Wipes this device&apos;s synced data — workspaces,
              vocabulary, reviews, collections, personal dictionary,
              chats, notes — and downloads the cloud copy. Unsynced local
              changes will be lost. Use the plain Sync button for
              everyday use.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void run("download", forceDownload)}
            >
              Download
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Hosted-build sync card. The cloud IS the data store here, so
 * there's no "back up local to cloud" action — but the same setting
 * key (`cloud.autoSync`) still has useful semantics: drive automatic
 * re-fetches when another device pushes new data to the same account.
 *
 * Two affordances:
 *   - Manual "Refresh from cloud" → fires `tokori:cloud-refresh`
 *     immediately. Views listening via `useCloudRefresh` re-fetch.
 *   - Auto-sync toggle → when on, the `useAutoSync` hook (mounted in
 *     App.tsx) fires the same refresh on tab focus and on a 5-min
 *     timer. Persists in the same setting key the desktop build uses
 *     so the user's intent travels with their account.
 */
function HostedSyncCard() {
  const [autoSync, setAutoSync] = useState(false);

  useEffect(() => {
    void getSetting(AUTO_SYNC_KEY).then((raw) => {
      setAutoSync(raw === "1" || raw === "true");
    });
  }, []);

  async function toggleAutoSync(next: boolean) {
    setAutoSync(next);
    await setSetting(AUTO_SYNC_KEY, next ? "1" : "0");
    window.dispatchEvent(
      new CustomEvent<string>("tokori:auto-sync-changed", {
        detail: next ? "1" : "0",
      }),
    );
    if (next) {
      toast.success("Auto-refresh on", {
        description:
          "Tokori will check the cloud every few minutes and on tab focus.",
      });
    } else {
      toast("Auto-refresh off");
    }
  }

  function handleManualRefresh() {
    triggerCloudRefresh();
    toast.success("Refreshing from cloud…");
  }

  return (
    <div className="rounded-xl border border-border bg-card/40 p-5">
      <div className="flex items-center gap-2">
        <CloudDownload className="size-4 text-foreground/70" />
        <h3 className="text-sm font-semibold tracking-tight">
          Multi-device sync
        </h3>
      </div>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Your data lives in the cloud — every page navigation reads the
        latest. Use the controls below when you've pushed changes from
        another device (desktop) and want this tab to pick them up
        without reloading.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleManualRefresh}
          className="gap-1.5"
        >
          <RefreshCw className="size-3.5" />
          Refresh from cloud
        </Button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-background/40 px-3 py-2">
        <div className="min-w-0">
          <Label
            htmlFor="auto-sync-hosted"
            className="text-[12.5px] font-medium"
          >
            Auto-refresh
          </Label>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Pull from the cloud every 5 minutes and on tab focus.
          </p>
        </div>
        <Switch
          id="auto-sync-hosted"
          checked={autoSync}
          onCheckedChange={(v) => void toggleAutoSync(!!v)}
        />
      </div>
    </div>
  );
}

function handleSyncError(err: unknown, fallback: string): void {
  if (err instanceof SyncProRequiredError) {
    toast.error("Pro required", {
      description: "Cloud backup is part of Tokori Pro.",
    });
    return;
  }
  if (err instanceof SyncAuthError) {
    toast.error("Sign in expired", {
      description: "Sign back in under Settings → Cloud and try again.",
    });
    return;
  }
  toast.error(fallback, {
    description: err instanceof Error ? err.message : String(err),
  });
}

function formatRelative(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}

/** Sub-line under the email in the SignedIn card. Trial users see
 *  "Trial ends on …"; paid Pros see "Renews on …" (or "Ends on …"
 *  if they cancelled). Returns null when there's nothing to show. */
function formatSubscriptionDate(
  sub: import("@/lib/cloud-context").CloudSubscription,
): string | null {
  if (sub.status === "trialing") {
    const ts = sub.trialEndsAt ?? sub.currentPeriodEnd;
    if (!ts) return null;
    return `Trial ends on ${new Date(ts * 1000).toLocaleDateString()}`;
  }
  if (sub.isPaidPro && sub.currentPeriodEnd) {
    const d = new Date(sub.currentPeriodEnd * 1000).toLocaleDateString();
    return sub.cancelAtPeriodEnd ? `Ends on ${d}` : `Renews on ${d}`;
  }
  return null;
}
