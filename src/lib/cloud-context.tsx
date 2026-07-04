import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getSetting, resetFallbackStore, setSetting } from "./db";
import { HOSTED } from "./build-flags";

/**
 * Tokori Cloud account state.
 *
 * Sign-in flow is magic-link, talked to via the tokori-cloud
 * Next.js backend:
 *
 *   1. User taps "Sign in with email" — we POST /api/auth/request {email}.
 *   2. Backend emails a 6-digit code (valid 10 min).
 *   3. User pastes the code — we POST /api/auth/verify {email, code}.
 *   4. Backend returns `{ token, user }`. We persist locally and start
 *      using it as a Bearer header for /api/v1/* requests.
 *
 * Cloud is OPTIONAL. Everything else in the app — local AI via Ollama,
 * BYOK for OpenAI / Anthropic / Gemini, vocabulary, decks, reader,
 * etc. — works with no account. The cloud account unlocks managed AI
 * (later), pack purchases, and Pro features (sync, mobile).
 */

// Cloud backend base URL. Single source of truth lives in
// `build-flags.ts` so every module that talks to the cloud
// (cloud-context, cloud-client, cloud-dict, tts edge proxy) sees
// the same value. See the long comment on CLOUD_API_BASE there.
import { CLOUD_API_BASE as API_BASE } from "./build-flags";

export type CloudUser = {
  id: number;
  email: string;
  /** Unix seconds — first time this account completed onboarding on
   *  any client. Null = never onboarded; this device should run the
   *  picker. Set = some other device already onboarded; this device
   *  skips its picker. Server-authoritative cross-device flag. */
  onboardedAt?: number | null;
};

export type CloudSubscription = {
  /** Stripe-mirrored status. We treat 'active' / 'trialing' as Pro. */
  status: string;
  /** Convenience boolean computed server-side. The desktop's gates
   *  read this directly so the client never has to interpret status
   *  strings. */
  isPro: boolean;
  /** Strict variant: a *paid* (non-trial) active Pro subscription.
   *  False during the initial 3-day signup trial and during a Stripe
   *  `trialing` window. Surfaced separately so freebie entitlements
   *  (Pro-included packs) can gate on real revenue. */
  isPaidPro?: boolean;
  /** Unix seconds — used to surface "renews on…" / "ends on…" copy. */
  currentPeriodEnd?: number;
  /** Set when the user requested a cancel; entitlement still valid
   *  until currentPeriodEnd. */
  cancelAtPeriodEnd?: boolean;
  /** Stripe price id, useful when we add tiers (Pro / Pro annual). */
  priceId?: string;
  /** Server-validated signup-trial countdown. Null once the trial is
   *  over or for users who never had one. The server computes these
   *  against its own clock so the UI doesn't rely on the device
   *  clock being correct (and so the entitlement check + the visible
   *  badge can never disagree). */
  trialEndsAt?: number | null;
  trialDaysRemaining?: number | null;
  trialSecondsRemaining?: number | null;
  /** True when this account is eligible to activate the 3-day
   *  signup trial — i.e. it has never had one. Set on accounts
   *  that signed up from the desktop app to top up tokens (trial
   *  deferred) and on accounts created before the trial existed.
   *  Drives the "Start free trial" CTA on the hosted PaywallScreen
   *  and stays false once the trial has been used (expired). */
  canStartTrial?: boolean;
};

export type CloudAccount = {
  user: CloudUser;
  /** Bearer token. Persisted verbatim; the server stores only its hash. */
  token: string;
  /** Server-resolved subscription state. May lag a checkout by a
   *  webhook hop — refreshAccount() is called on a poll after Stripe. */
  subscription: CloudSubscription;
};

// ── Store types ────────────────────────────────────────────────────
// The catalogs are public (anyone can call /api/v1/store/{packs,tokens})
// — buying still requires auth. Mirrors the Cloud's PACKS / TOKEN_BUNDLES
// shape; keep these in sync when adding fields server-side.

export type TokenBundle = {
  id: string;
  label: string;
  credits: number;
  priceCents: number;
  description?: string;
};

export type StorePack = {
  id: string;
  name: string;
  description: string;
  language: string;
  priceCents: number;
  /** Server-set flag: when true, an active *paid* (not trial) Pro
   *  subscription is enough to install this pack — no one-time
   *  purchase needed. The download endpoint enforces this for real;
   *  the client uses it to swap the Buy button for Install. */
  includedWithPro?: boolean;
  meta?: { wordCount?: number; chapterCount?: number; author?: string };
};

export type Balance = {
  tokenBalance: number;
  /** Server-side flag: true when balance is non-zero but below the
   *  low-balance threshold. Drives the "running low" visual hint
   *  before the gate slams shut at zero. */
  lowBalance?: boolean;
  /** Threshold the server used. Echoed so the client can render
   *  "X / Y" hints if it wants. */
  lowBalanceThreshold?: number;
  packGrants: { packId: string; grantedAt: number }[];
};

type CloudContextValue = {
  account: CloudAccount | null;
  loading: boolean;
  /** Convenience flag: account exists AND subscription.isPro is true. */
  isPro: boolean;
  /** Magic-link step 1 — email a 6-digit code. `turnstileToken` is the
   *  Cloudflare captcha solution when the widget is configured; the
   *  server gate is fail-open when its secret is unset. */
  requestCode: (
    email: string,
    turnstileToken?: string | null,
  ) => Promise<{ expiresInSeconds: number }>;
  /** Magic-link step 2 — exchange code for a session token + user. */
  verifyCode: (email: string, code: string) => Promise<CloudAccount>;
  /** OAuth callback adoption — same shape verifyCode produces, but
   *  the token is handed to us by the server-side redirect rather
   *  than minted via a code exchange in the browser. Used by the
   *  HostedGate URL-fragment picker after a Google/Discord round-
   *  trip. */
  adoptToken: (input: {
    token: string;
    userId: number;
    email?: string | null;
  }) => Promise<CloudAccount>;
  /** Drop the local session. The server-side row is GC'd on TTL. */
  signOut: () => Promise<void>;
  /** Re-fetch the user + subscription from the cloud. Cheap; safe to
   *  call on tab focus or after returning from a Stripe checkout. */
  refreshAccount: () => Promise<void>;
  /** Activate the 3-day signup trial for an account that hasn't
   *  used it yet. The hosted PaywallScreen renders a CTA that
   *  calls this when `subscription.canStartTrial` is true.
   *  Idempotent — the server short-circuits if a trial is already
   *  set. Throws if no account is signed in or the request fails. */
  startTrial: () => Promise<void>;
  /** POST /api/v1/account/onboarded — mark this account as having
   *  completed onboarding on at least one client. Idempotent on the
   *  server (set-once-on-null). Patches local state so a subsequent
   *  device reading the cloud-cached account sees the timestamp
   *  without a round-trip. */
  markOnboarded: () => Promise<void>;
  /** Build a Stripe Checkout URL on the server, return it for the
   *  caller to open in the browser. */
  createCheckoutUrl: () => Promise<string>;
  /** Build a Stripe Billing Portal URL — manage payment / cancel. */
  createPortalUrl: () => Promise<string>;
  // ── Store ────────────────────────────────────────────────────────
  /** Cached AI-token balance + owned-pack list. Refreshed via
   *  refreshBalance() on dialog open + after every checkout. */
  balance: Balance | null;
  /** Re-fetch balance + grants. */
  refreshBalance: () => Promise<void>;
  /** Public catalog fetches. Don't require auth. */
  fetchTokenBundles: () => Promise<TokenBundle[]>;
  fetchStorePacks: () => Promise<StorePack[]>;
  /** Returns a Checkout URL for a token bundle, OR null when the
   *  cloud is running in dev-grant mode (CLOUD_DEV_MODE=1) — in that
   *  case the credits have already been added server-side and the
   *  caller should refresh the balance instead of opening a URL. */
  buyTokens: (bundleId: string) => Promise<{ url: string | null; granted: boolean }>;
  /** Returns a Checkout URL for a pack, OR null in dev-grant mode
   *  (same shape rationale as `buyTokens`). Throws with
   *  code === "already_owned" if the user already owns this pack. */
  buyPack: (packId: string) => Promise<{ url: string | null; granted: boolean }>;
  /** Stream the pack JSON the user owns. Throws if no grant. */
  downloadPack: (packId: string) => Promise<unknown>;
  /** Base URL of the cloud — exposed so external callers don't have
   *  to re-derive it. */
  apiBase: string;
  /** Cloud chat tier — `fast` is the cheap text model (MiniMax-Text-01,
   *  shown as "Fast"), `advanced` is the flagship reasoning model
   *  (MiniMax-M3, shown as "Smart"). The cloud route picks the actual
   *  MiniMax model id and the tier-aware credit rate from this; the
   *  client only ever sees the friendly label. Persisted to localStorage. */
  tier: CloudTier;
  setTier: (t: CloudTier) => void;
};

export type CloudTier = "fast" | "advanced";

const CloudContext = createContext<CloudContextValue | null>(null);

const KEY = "cloud.account";
const TIER_KEY = "cloud.tier";

export function CloudProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<CloudAccount | null>(null);
  // Cloud chat tier (fast vs advanced). Persisted in localStorage so
  // a user who picks "advanced" once stays there until they flip
  // back. Default is "fast" — cheap, snappy model is the right
  // first-time-user experience; the pricier reasoning model is opt-
  // in.
  const [tier, setTierState] = useState<CloudTier>(() => {
    if (typeof window === "undefined") return "fast";
    const v = window.localStorage.getItem(TIER_KEY);
    return v === "advanced" ? "advanced" : "fast";
  });
  const setTier = useCallback((t: CloudTier) => {
    setTierState(t);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TIER_KEY, t);
    }
  }, []);
  const [loading, setLoading] = useState(true);
  // Token balance + owned-pack list. Lazy: not fetched until something
  // (StoreDialog, settings panel) actually wants it.
  const [balance, setBalance] = useState<Balance | null>(null);

  useEffect(() => {
    let cancelled = false;
    // localStorage is checked first: cloud-client's `cloudAuthToken`
    // reads from there to attach the bearer to outbound requests, so
    // the two reads must agree. On desktop the canonical store is
    // SQLite (via setSetting), so we fall through to it when the
    // localStorage cache hasn't been seeded yet (fresh install /
    // post-clear). The desktop sign-in path below mirrors writes to
    // both so subsequent reads hit localStorage fast.
    void (async () => {
      // Helper: given a persisted account, re-fetch /api/v1/account so
      // the subscription state we expose to the tree is up-to-date.
      // A trial that expired between sessions, a renewal that landed
      // overnight, an admin-side cancellation — all surface here
      // before AuthGate evaluates `isPro`. Cheap (one GET) and gates
      // the "subscribed users see app, expired users see paywall"
      // decision on real data instead of cached state.
      async function publish(parsed: CloudAccount) {
        if (cancelled) return;
        try {
          const acct = await getJson("/api/v1/account", parsed.token);
          const refreshed: CloudAccount = {
            user: (acct.user as CloudUser) ?? parsed.user,
            token: parsed.token,
            subscription:
              (acct.subscription as CloudSubscription) ?? parsed.subscription,
          };
          if (cancelled) return;
          setAccount(refreshed);
          await persistAccount(refreshed);
        } catch {
          // Offline boot — keep whatever the persisted blob said.
          // AuthGate will read that; if the cached state was Pro the
          // user gets a brief grace period until network returns.
          if (!cancelled) setAccount(parsed);
        }
      }

      try {
        const fromLs = localStorage.getItem(KEY);
        if (fromLs) {
          try {
            const parsed = JSON.parse(fromLs) as CloudAccount;
            if (parsed?.token && !cancelled) {
              await publish(parsed);
              setLoading(false);
              return;
            }
          } catch {
            /* corrupt LS blob; fall through to setting */
          }
        }
      } catch {
        /* private mode — skip */
      }
      try {
        const raw = await getSetting(KEY);
        if (cancelled || !raw) return;
        try {
          const parsed = JSON.parse(raw) as CloudAccount;
          if (parsed?.token && parsed?.user?.email) {
            // Seed localStorage so future cloudAuthToken() calls hit
            // synchronously without the round-trip through SQLite.
            try {
              localStorage.setItem(KEY, raw);
            } catch {
              /* ignore quota / private mode */
            }
            await publish(parsed);
          }
        } catch {
          /* ignore corrupt blob */
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the account blob to both SQLite (the canonical store for
  // legacy backup/restore + boot recovery) AND localStorage (so the
  // pure-module `cloudAuthToken()` in cloud-client.ts can read the
  // bearer synchronously). Single seam — every write goes through
  // here so the two stores can't drift.
  async function persistAccount(next: CloudAccount | null): Promise<void> {
    if (next == null) {
      await setSetting(KEY, "");
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    const blob = JSON.stringify(next);
    await setSetting(KEY, blob);
    try {
      localStorage.setItem(KEY, blob);
    } catch {
      /* ignore quota / private mode */
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  // We deliberately don't auto-retry on network errors; the UI surfaces
  // the message and lets the user try again. Auto-retrying on a 5xx
  // can mask real outages and confuse rate-limit logic.
  async function postJson(path: string, body: unknown, token?: string) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data && typeof data === "object" && (data as { error?: string }).error) ||
        `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data as Record<string, unknown>;
  }

  async function getJson(path: string, token: string) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data && typeof data === "object" && (data as { error?: string }).error) ||
        `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data as Record<string, unknown>;
  }

  const requestCode = useCallback(
    async (email: string, turnstileToken?: string | null) => {
      // `source` decides whether the verify step grants the 3-day
      // trial. HOSTED users (signing up on app.tokori.ai) get it
      // immediately; desktop users (signing in to top up tokens)
      // skip the trial so it stays available for when they later
      // visit the web app. Single seam — every magic-link request
      // from this client tags itself the same way.
      const source = HOSTED ? "web" : "desktop";
      const r = await postJson("/api/auth/request", {
        email,
        source,
        turnstileToken,
      });
      const expires = typeof r.expires_in === "number" ? r.expires_in : 600;
      return { expiresInSeconds: expires };
    },
    [],
  );

  const verifyCode = useCallback(async (email: string, code: string) => {
    const r = await postJson("/api/auth/verify", { email, code });
    const token = r.token as string;
    const user = r.user as CloudUser;
    if (!token || !user?.email) {
      throw new Error("Verification succeeded but the response was malformed.");
    }
    // Wipe the in-memory store before publishing the new account so
    // the incoming user starts with a clean slate. Covers the
    // "switch accounts on the same tab" path — without it, the
    // previous user's workspaces / vocab would still be in `fb`
    // until a full page reload.
    if (HOSTED) resetFallbackStore();
    // Fetch the authoritative subscription state INLINE before we
    // expose the account to the rest of the tree. Otherwise AuthGate
    // sees `account && !isPro` and flashes the paywall screen for one
    // render frame before the async refresh lands. Block the sign-in
    // button for the ~200 ms it takes instead — the button is already
    // in a busy state, the user sees one spinner not two screens.
    const fallback: CloudAccount = {
      user,
      token,
      subscription: { status: "none", isPro: false },
    };
    let resolved = fallback;
    try {
      const acct = await getJson("/api/v1/account", token);
      resolved = {
        user: (acct.user as CloudUser) ?? user,
        token,
        subscription: (acct.subscription as CloudSubscription) ?? fallback.subscription,
      };
    } catch {
      /* network blip — fall through with the conservative default; the
       *  PaywallScreen poller will catch up on the next interval. */
    }
    setAccount(resolved);
    await persistAccount(resolved);
    return resolved;
  }, []);

  const adoptToken = useCallback(
    async (input: { token: string; userId: number; email?: string | null }) => {
      // Same inline-confirmation pattern as verifyCode — see the
      // comment there for why we don't expose the account before
      // /api/v1/account resolves. Also wipe the in-memory store so
      // an OAuth sign-in switches users cleanly.
      if (HOSTED) resetFallbackStore();
      const fallback: CloudAccount = {
        user: { id: input.userId, email: input.email ?? "" },
        token: input.token,
        subscription: { status: "none", isPro: false },
      };
      let resolved = fallback;
      try {
        const acct = await getJson("/api/v1/account", input.token);
        resolved = {
          user: (acct.user as CloudUser) ?? fallback.user,
          token: input.token,
          subscription:
            (acct.subscription as CloudSubscription) ?? fallback.subscription,
        };
      } catch {
        /* keep the conservative default */
      }
      setAccount(resolved);
      await persistAccount(resolved);
      return resolved;
    },
    [],
  );

  const signOut = useCallback(async () => {
    const token = account?.token;
    setAccount(null);
    await persistAccount(null);
    // Wipe the hosted in-memory store so the next user that signs in
    // on this tab doesn't inherit the outgoing user's workspaces /
    // vocab / chats. The fallback store is process-scoped (no IPC,
    // no disk) so we have to reset it explicitly — localStorage
    // alone isn't enough. Desktop builds short-circuit since their
    // canonical store is SQLite.
    if (HOSTED) resetFallbackStore();
    // Best-effort: kill the server session + clear the shared
    // `.tokori.ai` cookie so the marketing site (and the app
    // subdomain) also reflect the sign-out. `credentials: "include"`
    // sends the cookie; the Bearer header covers the desktop path
    // where the cookie may be absent. Never block sign-out on it.
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      });
    } catch {
      /* offline / network — the local session is already cleared */
    }
  }, [account]);

  const refreshAccount = useCallback(async () => {
    if (!account) return;
    try {
      const r = await getJson("/api/v1/account", account.token);
      const next: CloudAccount = {
        user: (r.user as CloudUser) ?? account.user,
        token: account.token,
        subscription:
          (r.subscription as CloudSubscription) ?? account.subscription,
      };
      setAccount(next);
      await persistAccount(next);
    } catch {
      // Network failure — keep local state. The user can retry from
      // Settings → Cloud → Refresh.
    }
  }, [account]);

  const startTrial = useCallback(async () => {
    if (!account) throw new Error("Sign in first.");
    const r = await postJson("/api/v1/account/start-trial", {}, account.token);
    // The endpoint returns the same shape as /api/v1/account, so
    // patch the local state directly instead of waiting for a
    // refresh round-trip. The PaywallScreen flips to children on
    // the next render once `isPro` reads true.
    const sub = r.subscription as CloudSubscription | undefined;
    if (sub) {
      const next: CloudAccount = {
        ...account,
        subscription: sub,
      };
      setAccount(next);
      await persistAccount(next);
    } else {
      // Fallback: server returned something unexpected; do a full
      // refresh so we don't ship stale state.
      await refreshAccount();
    }
  }, [account, refreshAccount]);

  const markOnboarded = useCallback(async () => {
    if (!account) return;
    if (account.user.onboardedAt != null) return; // Already set — skip RPC.
    try {
      const r = await postJson(
        "/api/v1/account/onboarded",
        {},
        account.token,
      );
      const ts =
        typeof r.onboardedAt === "number"
          ? r.onboardedAt
          : Math.floor(Date.now() / 1000);
      const next: CloudAccount = {
        ...account,
        user: { ...account.user, onboardedAt: ts },
      };
      setAccount(next);
      await persistAccount(next);
    } catch {
      // Best-effort. If the network is down, the next refreshAccount()
      // will re-read the server value and re-attempt on the next
      // local onboarding-completion event.
    }
  }, [account]);

  const createCheckoutUrl = useCallback(async () => {
    if (!account) throw new Error("Sign in first.");
    const r = await postJson("/api/billing/checkout", {}, account.token);
    // Dev-grant short-circuit. When CLOUD_DEV_MODE=1 server-side, the
    // backend writes a synthetic Subscription row directly and signals
    // it via `devGranted: true`. We refresh the account so the UI
    // flips to isPro=true without bouncing through Stripe's hosted
    // page. Returning null tells the caller "no URL to open — already
    // applied".
    if (r.devGranted === true) {
      await refreshAccount();
      return "";
    }
    const url = r.url as string;
    if (!url) throw new Error("Checkout endpoint returned no URL.");
    return url;
  }, [account, refreshAccount]);

  const createPortalUrl = useCallback(async () => {
    if (!account) throw new Error("Sign in first.");
    const r = await postJson("/api/billing/portal", {}, account.token);
    const url = r.url as string;
    if (!url) throw new Error("Portal endpoint returned no URL.");
    return url;
  }, [account]);

  // ── Store helpers ─────────────────────────────────────────────────
  // The catalog endpoints are public (no Bearer required) so a curious
  // visitor can browse without signing up; the buy / download paths
  // require auth and a webhook-confirmed grant respectively.

  const refreshBalance = useCallback(async () => {
    if (!account) return;
    try {
      const r = await getJson("/api/v1/me/balance", account.token);
      setBalance({
        tokenBalance:
          typeof r.tokenBalance === "number" ? r.tokenBalance : 0,
        packGrants: Array.isArray(r.packGrants)
          ? (r.packGrants as Balance["packGrants"])
          : [],
      });
    } catch {
      // Network failure — leave the cached balance alone.
    }
  }, [account]);

  const fetchTokenBundles = useCallback(async (): Promise<TokenBundle[]> => {
    const r = await fetch(`${API_BASE}/api/v1/store/tokens`);
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const msg = (data && typeof data === "object" && (data as { error?: string }).error) || "Catalog fetch failed";
      throw new Error(msg);
    }
    return (data.bundles as TokenBundle[]) ?? [];
  }, []);

  const fetchStorePacks = useCallback(async (): Promise<StorePack[]> => {
    const r = await fetch(`${API_BASE}/api/v1/store/packs`);
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const msg = (data && typeof data === "object" && (data as { error?: string }).error) || "Catalog fetch failed";
      throw new Error(msg);
    }
    return (data.packs as StorePack[]) ?? [];
  }, []);

  const buyTokens = useCallback(
    async (
      bundleId: string,
    ): Promise<{ url: string | null; granted: boolean }> => {
      if (!account) throw new Error("Sign in first.");
      const r = await postJson(
        "/api/billing/checkout/tokens",
        { bundleId },
        account.token,
      );
      // Dev-grant path: server already credited the balance and
      // returned `{ url: null, granted: true }`. Refresh in the
      // background so the next render shows the new balance.
      if (r.granted === true) {
        void refreshBalance();
        return { url: null, granted: true };
      }
      const url = r.url as string;
      if (!url) throw new Error("Checkout endpoint returned no URL.");
      return { url, granted: false };
    },
    // refreshBalance is stable (defined with useCallback below) but
    // we don't want to thread the dependency cycle — the call is
    // fire-and-forget and reading a slightly stale ref is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account],
  );

  const buyPack = useCallback(
    async (
      packId: string,
    ): Promise<{ url: string | null; granted: boolean }> => {
      if (!account) throw new Error("Sign in first.");
      const res = await fetch(`${API_BASE}/api/billing/checkout/pack`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${account.token}`,
        },
        body: JSON.stringify({ packId }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        // Special-case "already owned" so the caller can short-circuit
        // straight into the download flow instead of opening checkout.
        const code = (data as { code?: string }).code;
        const msg =
          (data as { error?: string }).error ||
          `Checkout failed (${res.status})`;
        const err = new Error(msg) as Error & { code?: string };
        if (code) err.code = code;
        throw err;
      }
      // Dev-grant path: PackGrant already written. Refresh balance
      // so the owned-pack list updates locally.
      if (data.granted === true) {
        void refreshBalance();
        return { url: null, granted: true };
      }
      const url = data.url as string;
      if (!url) throw new Error("Checkout endpoint returned no URL.");
      return { url, granted: false };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account],
  );

  const downloadPack = useCallback(
    async (packId: string): Promise<unknown> => {
      if (!account) throw new Error("Sign in first.");
      const r = await fetch(
        `${API_BASE}/api/v1/packs/${encodeURIComponent(packId)}/download`,
        { headers: { authorization: `Bearer ${account.token}` } },
      );
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(text || `Download failed (${r.status})`);
      }
      return r.json();
    },
    [account],
  );

  const value = useMemo<CloudContextValue>(
    () => ({
      account,
      loading,
      isPro: !!account?.subscription?.isPro,
      requestCode,
      verifyCode,
      adoptToken,
      signOut,
      refreshAccount,
      startTrial,
      markOnboarded,
      createCheckoutUrl,
      createPortalUrl,
      balance,
      refreshBalance,
      fetchTokenBundles,
      fetchStorePacks,
      buyTokens,
      buyPack,
      downloadPack,
      apiBase: API_BASE,
      tier,
      setTier,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, loading, balance, tier],
  );

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

export function useCloud(): CloudContextValue {
  const ctx = useContext(CloudContext);
  if (!ctx) throw new Error("useCloud must be used inside CloudProvider");
  return ctx;
}
