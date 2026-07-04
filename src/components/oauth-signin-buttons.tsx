/**
 * Desktop OAuth sign-in buttons (Google / Discord).
 *
 * Shared by Settings → Cloud and the magic-link sign-in dialog so the
 * "Continue with <provider>" affordance — and the loopback handshake
 * behind it — live in exactly one place. Uses the desktop OAuth
 * orchestrator (`signInWithProvider`): it opens the system browser,
 * waits for the local API server's loopback callback, and resolves
 * with a session token we adopt via the cloud context.
 *
 * Desktop only by design — the loopback flow needs the Tauri shell and
 * the local API server. The hosted build uses a redirect/URL-fragment
 * flow instead (see auth-gate.tsx), so callers gate this behind
 * `!HOSTED`. In a non-Tauri preview, `signInWithProvider` rejects with
 * a friendly "only available in the Tauri build" message, surfaced as
 * a toast.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCloud } from "@/lib/cloud-context";
import { signInWithProvider, type OAuthProvider } from "@/lib/oauth-desktop";

export function OAuthSignInButtons({
  onSignedIn,
  disabled,
}: {
  /** Fired once a provider sign-in is fully adopted into the cloud
   *  context. Lets a host dialog dismiss itself / resume a purchase. */
  onSignedIn?: () => void;
  /** Disable the buttons while the host is mid-flow (e.g. an email
   *  verification is in progress in the same dialog). */
  disabled?: boolean;
}) {
  const cloud = useCloud();
  // `busy` doubles as a busy flag AND a "which provider is spinning"
  // hint so the two buttons can't race each other.
  const [busy, setBusy] = useState<OAuthProvider | null>(null);

  async function handleProvider(p: OAuthProvider) {
    if (busy) return;
    setBusy(p);
    try {
      const result = await signInWithProvider(p);
      await cloud.adoptToken({
        token: result.token,
        userId: result.userId,
        email: result.email ?? undefined,
      });
      toast.success(`Signed in${result.email ? ` as ${result.email}` : ""}.`);
      onSignedIn?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Sign-in failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        className="w-full justify-center gap-2"
        onClick={() => void handleProvider("google")}
        disabled={disabled || busy != null}
      >
        {busy === "google" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <GoogleMark className="size-4" />
        )}
        Continue with Google
      </Button>
      <Button
        variant="outline"
        className="w-full justify-center gap-2"
        onClick={() => void handleProvider("discord")}
        disabled={disabled || busy != null}
      >
        {busy === "discord" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <DiscordMark className="size-4" />
        )}
        Continue with Discord
      </Button>
    </div>
  );
}

/** Tiny inline brand marks — kept inline to avoid pulling brand icons
 *  (lucide dropped theirs; we draw the Google "G" by hand). Sized via
 *  Tailwind so they line up with a Lucide icon in the same row. */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 18" aria-hidden className={className}>
      <path
        fill="#4285F4"
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
      />
    </svg>
  );
}

function DiscordMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="#5865F2">
      <path d="M20.317 4.369A19.79 19.79 0 0 0 16.557 3l-.012.01a13.74 13.74 0 0 0-.61 1.247 18.27 18.27 0 0 0-5.487 0A12.683 12.683 0 0 0 9.83 3.01L9.82 3a19.78 19.78 0 0 0-3.76 1.369C2.236 9.054 1.13 13.626 1.676 18.13a19.9 19.9 0 0 0 6.072 3.057.07.07 0 0 0 .076-.026 14.19 14.19 0 0 0 1.226-1.99.07.07 0 0 0-.04-.097 13.15 13.15 0 0 1-1.871-.886.07.07 0 0 1-.008-.117c.126-.094.252-.192.371-.292a.07.07 0 0 1 .073-.01c3.927 1.79 8.18 1.79 12.061 0a.07.07 0 0 1 .074.009c.12.1.245.198.371.293a.07.07 0 0 1-.006.116c-.598.349-1.222.645-1.872.886a.07.07 0 0 0-.04.097c.36.696.772 1.36 1.225 1.99a.07.07 0 0 0 .076.026 19.84 19.84 0 0 0 6.073-3.058c.625-5.296-.74-9.823-3.397-13.76ZM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.175 1.095 2.157 2.42 0 1.333-.955 2.418-2.157 2.418Zm7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.175 1.095 2.156 2.42 0 1.333-.946 2.418-2.156 2.418Z" />
    </svg>
  );
}
