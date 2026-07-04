/**
 * Sign-in dialog. Two ways in, no passwords:
 *   - OAuth (Google / Discord) via the desktop loopback flow — one tap,
 *     surfaced on the email step (desktop only; see OAuthSignInButtons).
 *   - Magic link: email step (POST /auth/request) → code step
 *     (POST /auth/verify), trading the 6-digit code for a Bearer token.
 *
 * Either path ends in CloudProvider persisting the session, so callers
 * (e.g. the onboarding "Sign in to buy" flow) get the same result
 * regardless of which the user picks.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowRight, KeyRound, Loader2, Mail } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OAuthSignInButtons } from "@/components/oauth-signin-buttons";
import { useCloud } from "@/lib/cloud-context";
import { HOSTED } from "@/lib/build-flags";

export function CloudSignInDialog({
  open,
  onClose,
  onSignedIn,
}: {
  open: boolean;
  onClose: () => void;
  onSignedIn?: () => void;
}) {
  const { requestCode, verifyCode } = useCloud();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Reset on each open so leftover state from a prior partial flow
  // doesn't confuse the user. The email field stays in case they
  // re-open and want the same account.
  useEffect(() => {
    if (!open) return;
    setStep("email");
    setCode("");
    setBusy(false);
    setError(null);
  }, [open]);

  // Auto-focus the code input when we transition. Saves a click for
  // users who already have the email open in another window.
  useEffect(() => {
    if (step === "code") {
      const t = window.setTimeout(() => codeInputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
  }, [step]);

  async function submitEmail() {
    if (busy) return;
    setError(null);
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    try {
      await requestCode(trimmed);
      setEmail(trimmed);
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    if (busy) return;
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setError("The code is 6 digits.");
      return;
    }
    setBusy(true);
    try {
      await verifyCode(email, code.trim());
      toast.success(`Signed in as ${email}`);
      onSignedIn?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await requestCode(email);
      toast.success("New code sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === "email" ? (
              <Mail className="size-4" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {step === "email" ? "Sign in to Tokori" : "Enter your code"}
          </DialogTitle>
          <DialogDescription>
            {step === "email"
              ? "We'll email a 6-digit code. No password, no provider sign-in. Cloud is optional — local features keep working without it."
              : `We sent a code to ${email}. It expires in 10 minutes.`}
          </DialogDescription>
        </DialogHeader>

        {step === "email" ? (
          <div className="grid gap-3 py-2">
            {/* SSO first — one tap beats waiting for an email. Desktop
                only: the loopback OAuth flow needs the Tauri shell, and
                the hosted build signs in before this dialog is ever
                reachable. */}
            {!HOSTED && (
              <>
                <OAuthSignInButtons
                  disabled={busy}
                  onSignedIn={() => {
                    onSignedIn?.();
                    onClose();
                  }}
                />
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
                    or continue with email
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              </>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="cloud-email">Email</Label>
              <Input
                id="cloud-email"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitEmail();
                  }
                }}
                placeholder="you@example.com"
                disabled={busy}
              />
            </div>
            {error && (
              <p className="text-[12px] text-destructive">{error}</p>
            )}
          </div>
        ) : (
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="cloud-code">Verification code</Label>
              <Input
                id="cloud-code"
                ref={codeInputRef}
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitCode();
                  }
                }}
                placeholder="123456"
                className="text-center font-mono tracking-[0.4em] text-lg"
                disabled={busy}
              />
              <button
                type="button"
                onClick={resendCode}
                className="mt-0.5 text-left text-[11.5px] text-muted-foreground hover:text-foreground"
                disabled={busy}
              >
                Didn&apos;t arrive? Send a new code.
              </button>
            </div>
            {error && (
              <p className="text-[12px] text-destructive">{error}</p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {step === "code" && (
            <Button
              variant="ghost"
              onClick={() => setStep("email")}
              disabled={busy}
              className="mr-auto"
            >
              Use a different email
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={step === "email" ? submitEmail : submitCode}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ArrowRight className="size-3.5" />
            )}
            {step === "email" ? "Send code" : "Verify"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
