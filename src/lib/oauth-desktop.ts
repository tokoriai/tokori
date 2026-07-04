/**
 * Desktop OAuth orchestrator — the "click Sign in → browser opens →
 * desktop says ✓" flow used by the gh CLI, gcloud, and now
 * Tokori. Pairs with two Rust routes on the local API server:
 *
 *   GET /oauth/callback   — returns a tiny HTML bouncer page that
 *                            parses the cloud's redirect (query +
 *                            fragment) and POSTs the result back.
 *   POST /oauth/finish    — validates the state and emits a
 *                            `tokori:oauth-complete` Tauri event.
 *
 * The `oauth_begin` Tauri command on the Rust side mints `state` +
 * the loopback redirect URL; this module just opens the browser and
 * waits for the event. Keeps the secret-ish state inside Rust so the
 * frontend never has to know how to generate a CSPRNG token.
 *
 * Flow timeline (the wait is 60s — long enough for a slow signup,
 * short enough that an abandoned tab doesn't leak a listener):
 *
 *     ┌──────────┐ openExternalUrl(start_url) ┌─────────┐
 *     │ desktop  │ ──────────────────────────►│ browser │
 *     │  this    │                            └────┬────┘
 *     │  module  │                                 │ user signs in
 *     │          │ tokori:oauth-complete           │
 *     │          │ ◄─── (Tauri event from Rust ─── ▼
 *     │          │     once browser hits           ┌─────────┐
 *     │          │     loopback callback)          │  cloud  │
 *     └──────────┘                                 └─────────┘
 *
 * On success we resolve with the parsed token + user; the caller
 * (`cloud-section.tsx`) hands it to `cloud.adoptToken(...)`, which
 * is the same surface the hosted-build OAuth path already uses.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CLOUD_API_BASE } from "@/lib/build-flags";
import { openExternalUrl } from "@/lib/open-url";

export type OAuthProvider = "google" | "discord";

export type OAuthResult = {
  token: string;
  userId: number;
  email: string | null;
};

/** Begin a desktop OAuth sign-in for the given provider. Returns a
 *  Promise that resolves with the cloud session token + user id when
 *  the loopback callback completes, or rejects if the user cancels /
 *  the flow times out after 60 seconds.
 *
 *  Caller responsibilities:
 *   - Render a "signing in…" affordance while the promise is pending.
 *   - On success, call `cloud.adoptToken(result)` so the rest of the
 *     app sees the new session.
 *   - On rejection, surface a friendly message (timeout vs cancel vs
 *     server error all read the same to the user — "couldn't sign
 *     you in, try again"). */
export async function signInWithProvider(
  provider: OAuthProvider,
): Promise<OAuthResult> {
  if (!isTauri()) {
    throw new Error("Desktop OAuth is only available in the Tauri build.");
  }

  // Rust mints state + the loopback URL so the entropy stays
  // server-side (the frontend can't accidentally re-use a weak
  // random source).
  const begin = (await invoke("oauth_begin")) as {
    state: string;
    redirect: string;
  };

  // The cloud's `/api/auth/oauth/<provider>/start` accepts a
  // `redirect` param when it passes `isLoopbackRedirect`. We don't
  // need to send the state separately — it's embedded in the
  // redirect URL's query, and the cloud preserves it verbatim when
  // bouncing the browser back at us.
  //
  // The callback's trial-grant decision is inferred from the
  // redirect (loopback → desktop signup → no immediate trial), so
  // a separate `source` param isn't strictly required here — but
  // it's harmless and keeps the wire shape symmetric with the
  // magic-link path.
  const base = CLOUD_API_BASE || "";
  const startUrl =
    `${base}/api/auth/oauth/${provider}/start` +
    `?redirect=${encodeURIComponent(begin.redirect)}`;

  // Attach the listener BEFORE opening the browser AND wait for the
  // registration to land — `listen()` is async and a cached-session
  // sign-in can fire the event in well under the time it takes for
  // the registration round-trip. Wiring then opening is the only
  // race-free ordering.
  const completion = waitForCompletion(begin.state);
  await completion.attached;
  await openExternalUrl(startUrl);
  return completion.result;
}

type Pending = {
  /** Resolves once the Tauri listener is fully registered. */
  attached: Promise<void>;
  /** Resolves with the parsed OAuth result, or rejects on timeout /
   *  listener error. */
  result: Promise<OAuthResult>;
};

/** Subscribe to the one-shot `tokori:oauth-complete` Tauri event,
 *  filtering on the state we just minted so a stale completion from
 *  an earlier session doesn't satisfy this one. Times out after 60
 *  seconds — long enough for a fresh OAuth signup (email
 *  confirmation, name entry on the provider), short enough that the
 *  listener doesn't pin memory if the user just walks away. */
function waitForCompletion(expectedState: string): Pending {
  let resolveResult!: (r: OAuthResult) => void;
  let rejectResult!: (err: Error) => void;
  const result = new Promise<OAuthResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  let unlisten: UnlistenFn | null = null;
  const timer = setTimeout(() => {
    if (unlisten) unlisten();
    rejectResult(new Error("Sign-in timed out — try again."));
  }, 60_000);

  const attached = listen<{
    state: string;
    token: string;
    user_id: number;
    email: string | null;
    expires_at: number | null;
  }>("tokori:oauth-complete", (event) => {
    const payload = event.payload;
    // Ignore stale completions whose state doesn't match ours —
    // the user could have cancelled an earlier flow and started a
    // new one before the broker pruned the old state.
    if (payload.state !== expectedState) return;
    clearTimeout(timer);
    if (unlisten) unlisten();
    resolveResult({
      token: payload.token,
      userId: payload.user_id,
      email: payload.email,
    });
  }).then(
    (u) => {
      unlisten = u;
    },
    (err) => {
      clearTimeout(timer);
      rejectResult(new Error(`Failed to attach OAuth listener: ${err}`));
      // Re-throw so the awaiter in signInWithProvider sees the
      // failure too instead of waiting for the timeout.
      throw err;
    },
  );

  return { attached, result };
}
