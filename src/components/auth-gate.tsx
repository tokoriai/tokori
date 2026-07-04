/**
 * AuthGate — top-level wrapper for the hosted build.
 *
 * In hosted mode (`HOSTED === true`), the app must not mount until:
 *   1. the user is signed in to the Tokori Cloud, AND
 *   2. they have an active Pro subscription.
 *
 * Until both are true we render a sign-in / paywall screen. Once
 * both are satisfied, children mount and the app behaves like
 * normal — except every AI call routes through the synthesised
 * `tokori-cloud` provider (handled in provider-context).
 *
 * In desktop mode (`HOSTED === false`), this component is a pass-
 * through. The flag is a build-time constant so the entire
 * component is dead-code-eliminated from the desktop bundle.
 *
 * Auth flows offered:
 *   - Magic-link sign-in (email → 6-digit code).
 *   - Anonymous trial (no email; recovery key shown once and
 *     stored in localStorage). Anon users still need Pro to use
 *     AI — the paywall covers them too.
 *
 * State machine:
 *   1. loading  → spinner
 *   2. !account → render sign-in form
 *   3. account && !isPro → render paywall (Subscribe CTA)
 *   4. account && isPro  → render children
 */

import { useEffect, useState } from "react";
import { Download, Loader2, Mail, Sparkles, Lock, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Turnstile } from "@/components/turnstile";
import { useCloud } from "@/lib/cloud-context";
import { HOSTED, APP_NAME } from "@/lib/build-flags";
import { isDemoRequested } from "@/lib/demo-seed";
import { resetSyncQueue, setSyncAuth } from "@/lib/sync-queue";

// Cloudflare Turnstile site key (public, Vite-inlined at build). Unset
// → widget skipped; the cloud captcha gate is fail-open without its
// secret, so there's no captcha until both halves are configured.
const TURNSTILE_SITE_KEY = import.meta.env?.VITE_TURNSTILE_SITE_KEY as
  | string
  | undefined;

type Step = "email" | "code";

export function AuthGate({ children }: { children: React.ReactNode }) {
  // Desktop build: skip the gate entirely. The constant comparison
  // lets terser strip everything below from the desktop bundle.
  if (!HOSTED) return <>{children}</>;

  // Marketing demo iframe (?demo=1): the bundle is the same hosted
  // build as app.tokori.ai, but visitors are landing on a public
  // landing page — we can't ask them to sign in / pay before they
  // even see what the product does. Render the seeded demo data
  // straight through. The provider list is still pinned to the
  // synthesised cloud row, but its API calls won't actually fire
  // since there's no token (the demo is read-only sample data).
  if (isDemoRequested()) return <>{children}</>;

  return <HostedGate>{children}</HostedGate>;
}

function HostedGate({ children }: { children: React.ReactNode }) {
  const cloud = useCloud();

  // OAuth pickup. The server-side callback redirects here with
  // `#token=...&user_id=...&email=...` in the URL fragment (not the
  // query string — fragments don't land in server logs or Referer
  // headers). Read once, hand to the cloud context, strip the
  // fragment so a reload doesn't re-adopt a stale token.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash || !hash.includes("token=")) return;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const token = params.get("token");
    const userIdRaw = params.get("user_id");
    const userId = userIdRaw ? Number(userIdRaw) : NaN;
    const email = params.get("email");
    if (!token || !Number.isInteger(userId)) return;
    void cloud.adoptToken({ token, userId, email });
    // Clear the fragment so a refresh doesn't reuse the token. The
    // history entry stays — replaceState keeps the back button sane.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hosted variant uses an in-memory `fb` store inside db.ts that
  // doesn't survive a page refresh. So on every successful sign-in
  // (or reload while signed in), pull every cloud row to seed `fb`,
  // then arm the sync queue so future mutations push back. `seeded`
  // gates the children — without it, the app would boot empty for
  // ~500ms while the pull finishes and momentarily render the
  // "no workspaces" empty state.
  const [seeded, setSeeded] = useState(false);
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    if (!cloud.account) {
      // Signed out — drop any pending dirty rows so the next user
      // doesn't push them under their token, and reset the gate so
      // the next sign-in re-pulls.
      resetSyncQueue();
      setSeeded(false);
      return;
    }
    if (!cloud.isPro) return;
    if (seeded || seeding) return;
    const apiBase = cloud.apiBase;
    const token = cloud.account.token;
    setSeeding(true);
    // HOSTED users live entirely on the cloud — there's no local
    // SQLite to seed, so the regular `useWorkspace` / `listVocab`
    // reads on the way to the dashboard pull what they need on
    // demand. (Desktop pulls happen through the sync v2 engine in
    // Settings → Cloud / auto-sync, never through this gate.)
    resetSyncQueue();
    setSyncAuth({ apiBase, token });
    setSeeded(true);
    setSeeding(false);
  }, [cloud.account?.token, cloud.isPro, cloud.apiBase, seeded, seeding]);

  // Initial cloud-state load. The CloudProvider has its own loading
  // flag for the first session-restore attempt.
  if (cloud.loading) {
    return <FullScreenSpinner label={`Loading ${APP_NAME}…`} />;
  }

  if (!cloud.account) {
    return <SignInScreen />;
  }

  if (!cloud.isPro) {
    return <PaywallScreen />;
  }

  if (!seeded) {
    return <FullScreenSpinner label="Syncing your library…" />;
  }

  return <>{children}</>;
}

// ── Sign-in screen ────────────────────────────────────────────────

function SignInScreen() {
  const cloud = useCloud();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // Turnstile captcha (only when a site key is configured).
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  async function onSendCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      toast.error("Please complete the captcha first.");
      return;
    }
    setBusy(true);
    try {
      await cloud.requestCode(email.trim(), captchaToken);
      setStep("code");
      toast.success("Check your inbox for the 6-digit code.");
    } catch (err) {
      // Single-use token spent — re-challenge so a retry has a fresh one.
      setCaptchaToken(null);
      setCaptchaReset((n) => n + 1);
      toast.error("Couldn't send code", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await cloud.verifyCode(email.trim(), code.trim());
      // CloudProvider updates state — HostedGate flips to paywall or app.
    } catch (err) {
      toast.error("Couldn't verify", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenteredCard>
      <Brand />
      {step === "email" && (
        <>
          <h1 className="mt-6 font-serif text-2xl font-semibold tracking-tight">
            Sign in to {APP_NAME}
          </h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">
            We&apos;ll email a 6-digit code. No passwords, no setup.
          </p>
          <form onSubmit={onSendCode} className="mt-5 space-y-3">
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="email"
                required
                autoFocus
                inputMode="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-10 pl-9"
              />
            </div>
            {TURNSTILE_SITE_KEY && (
              <Turnstile
                siteKey={TURNSTILE_SITE_KEY}
                onToken={setCaptchaToken}
                resetKey={captchaReset}
              />
            )}
            <Button
              type="submit"
              disabled={
                busy || !email.trim() || (!!TURNSTILE_SITE_KEY && !captchaToken)
              }
              className="w-full gap-1.5"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
              Send code
            </Button>
          </form>
          <p className="mt-3 text-[11.5px] text-muted-foreground">
            By continuing, you agree to the terms of service. We only use your
            email to send sign-in codes and account notices.
          </p>
          <OAuthDivider />
          <OAuthButtons />
          <p className="mt-3 text-[11.5px] text-muted-foreground">
            New accounts get a 3-day trial with starter credits — no card
            needed.
          </p>
        </>
      )}

      {step === "code" && (
        <>
          <h1 className="mt-6 font-serif text-2xl font-semibold tracking-tight">
            Enter your code
          </h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">
            We sent a 6-digit code to <span className="font-medium">{email}</span>.
            It expires in 10 minutes.
          </p>
          <form onSubmit={onVerify} className="mt-5 space-y-3">
            <Input
              required
              autoFocus
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="h-12 text-center text-2xl tracking-[0.5em] tabular-nums"
            />
            <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Verify"}
            </Button>
          </form>
          <button
            type="button"
            onClick={() => setStep("email")}
            className="mt-3 text-[12px] text-muted-foreground hover:text-foreground"
          >
            ← Use a different email
          </button>
        </>
      )}

    </CenteredCard>
  );
}

// ── Paywall ───────────────────────────────────────────────────────

function PaywallScreen() {
  const cloud = useCloud();
  const [busy, setBusy] = useState<"subscribe" | "trial" | null>(null);
  // Read once on render — used to swap the primary CTA between
  // "Start free trial" (eligible) and "Subscribe" (trial already
  // consumed). Server-computed; the desktop billing-only signup
  // flow leaves `canStartTrial = true` so the user lands here
  // with an actionable trial offer the first time they visit the
  // hosted app.
  const canStartTrial =
    cloud.account?.subscription?.canStartTrial === true;

  // Auto-poll: after the user opens checkout in a new tab and comes
  // back, we need to detect the new Pro subscription. Cheap poll
  // every 6 seconds for up to ~5 min covers the typical Stripe →
  // webhook → cloud lag.
  useEffect(() => {
    let stopped = false;
    let count = 0;
    const id = window.setInterval(() => {
      if (stopped) return;
      count += 1;
      void cloud.refreshAccount().catch(() => {});
      if (count > 50) window.clearInterval(id);
    }, 6000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubscribe() {
    if (busy) return;
    setBusy("subscribe");
    try {
      // Go straight to Stripe Checkout for the Pro subscription. The
      // 6-second account poll above flips this screen to unlocked once
      // the webhook confirms the subscription, so we just open the
      // hosted checkout in a new tab and let the user come back.
      const url = await cloud.createCheckoutUrl();
      // Dev-grant short-circuit: createCheckoutUrl already refreshed the
      // account and returns "" — the gate re-renders into Pro on its
      // own, nothing to open.
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      // Checkout unreachable (e.g. Stripe price id not configured yet).
      // Fall back to the account page — it offers the same Subscribe
      // action off the shared session cookie, so a signed-in user still
      // has a real way to pay rather than dead-ending on /pricing (where
      // a trial-active account reads as Pro and only shows "Open Tokori").
      window.open("https://tokori.ai/account", "_blank", "noopener,noreferrer");
      toast.error("Couldn't open checkout", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  async function onStartTrial() {
    if (busy) return;
    setBusy("trial");
    try {
      await cloud.startTrial();
      toast.success("Trial started", {
        description: "3 days of free cloud access — no card needed.",
      });
      // No navigation needed: cloud.startTrial patched the in-context
      // subscription, so HostedGate re-evaluates and renders children.
    } catch (err) {
      toast.error("Couldn't start trial", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <CenteredCard>
      <Brand />
      <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Lock className="size-3" />
        {canStartTrial ? "Activate to continue" : "Pro required"}
      </div>
      <h1 className="mt-4 font-serif text-2xl font-semibold tracking-tight">
        {canStartTrial ? "Start your free trial." : "One last step."}
      </h1>
      <p className="mt-1.5 text-[13.5px] text-muted-foreground">
        {canStartTrial ? (
          <>
            3 days of full cloud access — no card needed. {APP_NAME} Cloud
            is part of {APP_NAME} Pro, starting at $8 / month once the
            trial ends; you can subscribe any time before then, or just
            let it lapse.
          </>
        ) : (
          <>
            {APP_NAME} Cloud is part of {APP_NAME} Pro — starting at $8 /
            month. Cancel any time. Your sign-in is already set; just
            unlock access below.
          </>
        )}
      </p>
      <ul className="mt-5 space-y-2 text-[13px] text-muted-foreground">
        {[
          "Hosted AI tutor — no API keys to set up",
          "Cloud backup of vocab + decks across devices",
          "Mobile companion app (coming soon)",
        ].map((line) => (
          <li key={line} className="flex gap-2">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 text-foreground/70" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {canStartTrial ? (
        <>
          <Button
            onClick={() => void onStartTrial()}
            disabled={busy != null}
            className="mt-5 w-full gap-1.5"
          >
            {busy === "trial" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            Start free 3-day trial
          </Button>
          <button
            type="button"
            onClick={() => void onSubscribe()}
            disabled={busy != null}
            className="mt-2 w-full text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {busy === "subscribe"
              ? "Opening checkout…"
              : "Skip the trial — subscribe now ($8 / mo) →"}
          </button>
        </>
      ) : (
        <Button
          onClick={() => void onSubscribe()}
          disabled={busy != null}
          className="mt-5 w-full gap-1.5"
        >
          {busy === "subscribe" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowRight className="size-4" />
          )}
          Subscribe — $8 / mo
        </Button>
      )}

      {/* Free alternative — the desktop app runs everything locally
          with the user's own AI keys, no subscription required. We
          surface it explicitly on the paywall so a user who doesn't
          want to pay doesn't bounce off the product entirely. Same
          link on the trial banner; clicking opens the download page
          in a new tab. */}
      <div className="mt-4 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-[12px] text-muted-foreground">
        <p className="font-medium text-foreground">Not ready to subscribe?</p>
        <p className="mt-0.5 leading-relaxed">
          The desktop app is{" "}
          <span className="font-medium text-foreground">free forever</span> —
          runs locally on your machine, you bring your own AI keys (OpenAI,
          Anthropic, Ollama, …) and pay only your provider.
        </p>
        <a
          href="https://tokori.ai/download"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-accent"
        >
          <Download className="size-3.5" />
          Get the free desktop app
        </a>
      </div>

      <button
        type="button"
        onClick={() => void cloud.signOut()}
        className="mt-3 text-[12px] text-muted-foreground hover:text-foreground"
      >
        Sign out
      </button>
      <p className="mt-3 text-[11px] text-muted-foreground/80">
        After paying, leave the checkout tab open until you see the success
        page — this screen unlocks automatically.
      </p>
    </CenteredCard>
  );
}

// ── Layout primitives ─────────────────────────────────────────────

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen w-full place-items-center bg-background px-6 py-12">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-7 shadow-sm">
        {children}
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <BrandSvg className="size-7" />
      <span className="font-serif text-lg font-semibold tracking-tight">{APP_NAME}</span>
    </div>
  );
}

function BrandSvg({ className }: { className?: string }) {
  // Inlined cockatoo silhouette — kept in sync with the favicon +
  // marketing logo (docs/public/favicon.svg) so the gate carries the
  // current brand mark without depending on an external asset path.
  // `currentColor` + the evenodd eye-hole keep it transparent and
  // theme-aware (black on light, white on dark, no background fill).
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      fillRule="evenodd"
      role="img"
      aria-label={APP_NAME}
      className={className}
    >
      {/* Crest: 5 swept-back feathers, leftmost shortest. */}
      <path d="M22 22 L18 4 L26 18 Z" />
      <path d="M27 19 L28 2 L34 18 Z" />
      <path d="M33 18 L46 6 L40 22 Z" />
      <path d="M40 22 L56 14 L46 28 Z" />
      <path d="M44 28 L60 26 L48 34 Z" />
      {/* Head + body; eye cut as a transparent hole via evenodd. */}
      <path d="M16 32 C 16 23 23 18 32 18 C 42 18 49 25 49 33 C 49 37 47 40 45 42 C 48 48 53 53 58 56 L 58 60 L 28 60 C 19 60 13 53 13 44 C 13 38 14 34 16 32 Z M 26 28 a 2.5 2.5 0 1 0 5 0 a 2.5 2.5 0 1 0 -5 0 Z" />
      {/* Beak: hooked, pointing forward-down from the lower-front. */}
      <path d="M16 33 L 5 35 Q 3 37 5 39 Q 7 41 11 41 L 18 39 Z" />
    </svg>
  );
}

// ── OAuth buttons ─────────────────────────────────────────────────
//
// One <a> per provider, pointing at the cloud's start route. The
// route writes the CSRF state cookie + redirects to Google/Discord,
// which redirects back to /api/auth/oauth/{provider}/callback,
// which mints a session and redirects here with the token in the
// URL fragment (picked up by HostedGate). No JS state on this end.

function OAuthDivider() {
  return (
    <div className="mt-5 flex items-center gap-2 text-[10.5px] uppercase tracking-wider text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      <span>or</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function OAuthButtons() {
  const cloud = useCloud();
  // The OAuth routes live on the cloud origin (api.tokori.ai in
  // prod, localhost:3001 in dev). cloud.apiBase already resolves
  // that for us — same value the auth/billing POSTs use.
  //
  // Crucially, pass `redirect` back to THIS app's path. The cloud
  // callback falls back to "/" (the marketing homescreen) when no
  // redirect is given — and the homescreen has no token-pickup, so
  // the bearer token in the URL fragment is silently dropped: the
  // user bounces to the homescreen and their previous session
  // lingers. Returning to our own path lets HostedGate adopt the
  // token (switching users cleanly). The marketing sign-in form
  // already does this; the in-app buttons were the gap.
  const startUrl = (provider: "google" | "discord"): string => {
    // Absolute origin + path. Same-origin /app resolves to the apex
    // path on the cloud; on the app subdomain (app.tokori.ai) it's an
    // absolute URL the cloud's safeRedirect allowlists, so the callback
    // lands the token back on THIS origin instead of the marketing apex.
    const back =
      typeof window !== "undefined"
        ? window.location.origin + window.location.pathname
        : "/app";
    return `${cloud.apiBase}/api/auth/oauth/${provider}/start?redirect=${encodeURIComponent(back)}`;
  };
  return (
    <div className="mt-4 grid grid-cols-2 gap-2">
      <a
        href={startUrl("google")}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-accent"
      >
        <GoogleIcon className="size-4" />
        Google
      </a>
      <a
        href={startUrl("discord")}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border bg-[#5865F2] px-3 text-sm font-medium text-white transition-colors hover:bg-[#4752c4]"
      >
        <DiscordIcon className="size-4" />
        Discord
      </a>
    </div>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20.5H24v7h11.3c-1.6 4.6-6 7.5-11.3 7.5-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 8 3.1l5-5C33.3 6.5 28.9 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5c10.7 0 19.5-8.4 19.5-19.5 0-1.2-.1-2.4-.3-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l5.7 4.2C13.6 15.3 18.4 12 24 12c3 0 5.8 1.1 8 3.1l5-5C33.3 6.5 28.9 4.5 24 4.5 16.3 4.5 9.7 8.7 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 43.5c4.7 0 9-1.6 12.3-4.4l-5.7-4.8c-2 1.4-4.4 2.2-6.6 2.2-5.2 0-9.6-3-11.3-7.4l-5.6 4.3C9.6 39.2 16.3 43.5 24 43.5z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20.5H24v7h11.3c-.8 2.2-2.2 4.1-4 5.5l5.7 4.8c-.4.4 6-4.4 6-13.4 0-1.2-.1-2.4-.3-3.4z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3a13.4 13.4 0 0 0-.62 1.27 18.46 18.46 0 0 0-5.58 0A13.7 13.7 0 0 0 9.732 3a19.74 19.74 0 0 0-3.762 1.37C2.84 8.94 1.99 13.39 2.41 17.78a19.93 19.93 0 0 0 6.07 3.06 14.65 14.65 0 0 0 1.3-2.11 12.95 12.95 0 0 1-2.05-.98c.17-.13.34-.26.5-.4a14.18 14.18 0 0 0 12.16 0c.16.14.33.27.5.4a12.95 12.95 0 0 1-2.06.98c.39.74.83 1.45 1.3 2.11a19.9 19.9 0 0 0 6.08-3.06c.5-5.18-.85-9.6-3.6-13.41ZM9.32 15.4c-1.2 0-2.18-1.1-2.18-2.45 0-1.35.96-2.46 2.18-2.46s2.2 1.11 2.18 2.46c0 1.35-.96 2.45-2.18 2.45Zm5.36 0c-1.2 0-2.18-1.1-2.18-2.45 0-1.35.96-2.46 2.18-2.46s2.2 1.11 2.18 2.46c0 1.35-.96 2.45-2.18 2.45Z" />
    </svg>
  );
}

function FullScreenSpinner({ label }: { label: string }) {
  return (
    <div className="grid min-h-screen w-full place-items-center bg-background">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {label}
      </div>
    </div>
  );
}

