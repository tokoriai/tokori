// Local API control panel.
//
// The Tauri side (`api_server_start/stop/status`) already runs an axum
// server on 127.0.0.1:53210 with bearer-token auth — this exposes the
// UI to start/stop it, surfaces the bind address + token for MCP
// configs, and offers an opt-in "auto-start on app launch" toggle. The
// toggle is persisted as a marker file the Rust setup() hook reads
// before the webview is up.

import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Loader2,
  Power,
  PowerOff,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type StartedInfo = { addr: string; token: string };

export function LocalApiSection() {
  const [running, setRunning] = useState<boolean | null>(null);
  const [info, setInfo] = useState<StartedInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  // null while the preference is still being read from Rust — keeps the
  // Switch from flashing the wrong state during the first paint.
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [copied, setCopied] = useState<
    "token" | "config-desktop" | "config-code" | null
  >(null);

  // Probe status on mount + whenever the user might have toggled it
  // elsewhere. The status command is cheap (a mutex check), no IPC churn.
  async function refresh() {
    if (!isTauri()) {
      setRunning(false);
      return;
    }
    try {
      const r = await invoke<boolean>("api_server_status");
      setRunning(r);
      // If the server is already running (e.g. autostart fired during
      // setup), pull the bind address + token so the card can render
      // the bearer-token row immediately rather than waiting for a
      // manual Start.
      if (r && !info) {
        try {
          const probe = await invoke<{ running: boolean; addr: string; token: string }>(
            "api_server_info",
          );
          setInfo({ addr: probe.addr, token: probe.token });
        } catch {
          /* token read failed — leave info null; the Start path will repopulate */
        }
      }
    } catch (err) {
      setRunning(false);
      toast.error("Couldn't read API status", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  useEffect(() => {
    void refresh();
    if (!isTauri()) {
      setAutostart(false);
      return;
    }
    void invoke<boolean>("api_server_get_autostart")
      .then((v) => setAutostart(v))
      .catch(() => setAutostart(false));
  }, []);

  async function toggleAutostart(next: boolean) {
    if (!isTauri()) return;
    const prev = autostart;
    setAutostart(next);
    try {
      await invoke<void>("api_server_set_autostart", { enabled: next });
      toast.success(
        next ? "Local API will start on app launch" : "Auto-start disabled",
      );
    } catch (err) {
      setAutostart(prev);
      toast.error("Couldn't save preference", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function start() {
    if (!isTauri()) return;
    setBusy(true);
    try {
      const r = await invoke<StartedInfo>("api_server_start");
      setInfo(r);
      setRunning(true);
      toast.success(`Local API listening on ${r.addr}`);
    } catch (err) {
      toast.error("Couldn't start local API", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!isTauri()) return;
    setBusy(true);
    try {
      await invoke<void>("api_server_stop");
      setInfo(null);
      setRunning(false);
      toast.success("Local API stopped");
    } catch (err) {
      toast.error("Couldn't stop local API", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function copy(
    text: string,
    kind: "token" | "config-desktop" | "config-code",
  ) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1200);
    } catch (err) {
      toast.error("Couldn't copy", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  // The MCP server lives in a separate clone of the repo, so we can't
  // resolve its absolute path from inside the desktop bundle. Show a
  // generic placeholder the user replaces with their own path.
  const mcpPath = "/path/to/tokori/mcp-server/dist/index.js";
  const configDesktop = JSON.stringify(
    { mcpServers: { tokori: { command: "node", args: [mcpPath] } } },
    null,
    2,
  );

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="font-serif text-2xl tracking-tight">Local API</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          A loopback HTTP server that exposes your workspaces, vocabulary, and collections to
          external tools. The bundled MCP server uses this so MCP clients can
          read &amp; write your data.
        </p>
      </header>

      {/* Status + power button */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex size-9 items-center justify-center rounded-full",
                running
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {running ? <Power className="size-4" /> : <PowerOff className="size-4" />}
            </div>
            <div>
              <div className="font-medium text-[14px]">
                {running === null ? "Checking…" : running ? "Running" : "Stopped"}
              </div>
              <div className="text-[12px] text-muted-foreground">
                {running
                  ? `Bound to ${info?.addr ?? "127.0.0.1:53210"} (loopback only)`
                  : "External tools can't reach this app until you start the server."}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void refresh()}
              title="Refresh status"
              disabled={busy}
            >
              <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
            </Button>
            {running ? (
              <Button onClick={() => void stop()} disabled={busy} variant="outline">
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PowerOff className="size-3.5" />}
                Stop
              </Button>
            ) : (
              <Button onClick={() => void start()} disabled={busy}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Power className="size-3.5" />}
                Start
              </Button>
            )}
          </div>
        </div>

        {/* Auto-start preference. Persisted as a marker file in
            ~/.tokori/ so the Rust setup() hook can read it before the
            webview comes up. Affects subsequent launches; the current
            session keeps whatever state Start/Stop has put it in. */}
        <div className="mt-4 flex items-start justify-between gap-4 border-t border-border pt-4">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Start automatically on app launch</div>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Boot the loopback API as soon as Tokori opens, so external tools (coding agents, the
              browser extension) can connect without you opening Settings first.
            </p>
          </div>
          <Switch
            checked={!!autostart}
            disabled={autostart === null || busy}
            onCheckedChange={(v) => void toggleAutostart(v)}
            aria-label="Auto-start local API on app launch"
          />
        </div>

        {/* Bearer token — shown only after the user has started the server
            in this session. The token also lives at ~/.tokori/api-token, so
            the MCP server reads it from disk automatically; this card is
            for ad-hoc curl / Postman use. */}
        {info?.token && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="mb-1 text-[11.5px] uppercase tracking-wider text-muted-foreground">
              Bearer token
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded border border-border bg-muted/40 px-2 py-1.5 font-mono text-[12px]">
                {showToken ? info.token : "•".repeat(Math.min(info.token.length, 32))}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowToken((s) => !s)}
              >
                {showToken ? "Hide" : "Show"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void copy(info.token, "token")}
              >
                {copied === "token" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                Copy
              </Button>
            </div>
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              Also stored at <code>~/.tokori/api-token</code> — the bundled MCP server reads it
              from there, so you usually don't need to copy it manually.
            </p>
          </div>
        )}
      </div>

      {/* Wiring instructions */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-1 flex items-center gap-2 font-medium text-[14px]">
          <Terminal className="size-4" />
          Connect an MCP client
        </h3>
        <p className="mb-3 text-[12px] text-muted-foreground">
          The bundled MCP server lives at <code>{mcpPath}</code>. Build it once with
          <code> npm install &amp;&amp; npm run build</code> in <code>mcp-server/</code>, then:
        </p>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-medium">Add to your client's MCP config</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copy(configDesktop, "config-desktop")}
            >
              {copied === "config-desktop" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              Copy
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed">
{configDesktop}
          </pre>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Drop this into your MCP client's config file (see your client's docs for the
            location), then restart the client.
          </p>
        </div>

        <p className="mt-4 text-[11.5px] text-muted-foreground">
          The MCP server only works while this local API is running. If your client
          reports <code> network.unreachable</code>, come back here and start the server.
        </p>
      </div>

      {/* Mobile remote access (tunnel + QR pairing) lives on its own
          Settings page — see `remote-access-section.tsx`. This page
          stays focused on the local API itself + MCP wiring. */}
    </div>
  );
}
