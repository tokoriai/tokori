/**
 * Pair-request approval dialog.
 *
 * The local API server (`src-tauri/src/api_server.rs`) accepts
 * unauthenticated `POST /v1/pair/request` calls from clients that don't
 * have a token yet — typically the Tokori Companion browser extension.
 * The handler emits `tokori:pair-request` with the request id and the
 * client's name, then long-polls (60s) waiting for an answer. This
 * component listens for that event and renders a modal so the user can
 * approve or deny in-app, then routes the decision back via the
 * `pair_resolve` Tauri command.
 */

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Puzzle, ShieldCheck, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface PairRequest {
  id: string;
  client: string;
  createdAt: number;
}

export function PairRequestDialog() {
  const [pending, setPending] = useState<PairRequest | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const unlisten = await listen<{ id: string; client: string; created_at: number }>(
          "tokori:pair-request",
          (e) => {
            if (cancelled) return;
            setPending({
              id: e.payload.id,
              client: e.payload.client,
              createdAt: e.payload.created_at,
            });
          },
        );
        off = unlisten;
      } catch {
        // Not running under Tauri (browser dev mode) — fine.
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // Auto-close after 60s so a missed dialog doesn't sit there forever
  // (the backend has already timed out at that point).
  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(() => setPending(null), 60_000);
    return () => window.clearTimeout(t);
  }, [pending]);

  async function resolve(approved: boolean) {
    if (!pending || resolving) return;
    setResolving(true);
    try {
      await invoke("pair_resolve", { id: pending.id, approved });
    } catch (e) {
      console.error("pair_resolve failed:", e);
    } finally {
      setResolving(false);
      setPending(null);
    }
  }

  return (
    <Dialog open={pending != null} onOpenChange={(open) => !open && resolve(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-2 flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <Puzzle className="size-6" />
          </div>
          <DialogTitle>Approve pairing?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{pending?.client}</span>{" "}
            wants to connect to your local Tokori app. Approve only if you triggered this
            from a Tokori-aware extension or CLI on this computer.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            Approval shares the same bearer token shown in Settings → Local API. The
            client can read your workspaces, vocab, and dictionaries until you sign it
            out. The token never leaves this machine.
          </span>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => resolve(false)}
            disabled={resolving}
          >
            <X className="mr-1.5 size-4" /> Deny
          </Button>
          <Button onClick={() => resolve(true)} disabled={resolving}>
            {resolving ? "Approving…" : "Approve & share token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
