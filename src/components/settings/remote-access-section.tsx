// Remote access — phone uses your PC's local model via a tunnel.
//
// Self-contained Settings page. Talks to the Rust side via:
//   • api_server_info        → running flag + addr + bearer token (so
//                              we can render the pairing QR even when
//                              the user hasn't toggled the server in
//                              this session yet)
//   • remote_tunnel_status   → cloudflared running flag + parsed URL
//   • remote_tunnel_start    → spawn cloudflared
//   • remote_tunnel_stop     → kill cloudflared
//   • remote_tunnel_installed → does Tokori have a managed cloudflared?
//   • remote_tunnel_install  → download cloudflared from GitHub
//
// Local API control (start/stop the loopback server) lives in its own
// Settings page so that section stays focused on MCP client
// wiring. This page assumes the local API is running and surfaces a
// CTA when it isn't.

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Cloud,
  Copy,
  Loader2,
  Smartphone,
  Square,
} from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type ServerInfo = { running: boolean; addr: string; token: string };
type TunnelStatus = {
  running: boolean;
  url: string | null;
  err: string | null;
};
type InstalledResult = { installed: boolean; path: string | null };
type DownloadResult = { path: string; bytes: number };

const TUNNEL_URL_KEY = "remote.tunnelUrl";

export function RemoteAccessSection() {
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus>({
    running: false,
    url: null,
    err: null,
  });
  const [installed, setInstalled] = useState<InstalledResult | null>(null);

  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [copied, setCopied] = useState<"pairing" | null>(null);

  // Manual URL override (Tailscale, named tunnels, LAN). Hidden behind a
  // disclosure on the page; persisted so the user doesn't retype.
  const [tunnelUrl, setTunnelUrl] = useState<string>(() => {
    try {
      return localStorage.getItem(TUNNEL_URL_KEY) ?? "";
    } catch {
      return "";
    }
  });

  function saveTunnelUrl(v: string) {
    setTunnelUrl(v);
    try {
      if (v) localStorage.setItem(TUNNEL_URL_KEY, v);
      else localStorage.removeItem(TUNNEL_URL_KEY);
    } catch {
      /* localStorage may be denied */
    }
  }

  async function refresh() {
    if (!isTauri()) return;
    try {
      const [info, status, inst] = await Promise.all([
        invoke<ServerInfo>("api_server_info"),
        invoke<TunnelStatus>("remote_tunnel_status"),
        invoke<InstalledResult>("remote_tunnel_installed"),
      ]);
      setServer(info);
      setTunnel(status);
      setInstalled(inst);
      if (status.url && status.url !== tunnelUrl) saveTunnelUrl(status.url);
    } catch (err) {
      console.warn("[remote-access] refresh failed", err);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startTunnel() {
    if (!isTauri() || !server?.running) return;
    setTunnelBusy(true);
    try {
      const s = await invoke<TunnelStatus>("remote_tunnel_start");
      setTunnel(s);
      if (s.url) saveTunnelUrl(s.url);
      toast.success("Tunnel up", {
        description: s.url
          ? "Pairing QR is ready below."
          : "Waiting for cloudflared to print a URL…",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTunnel({ running: false, url: null, err: msg });
      toast.error("Couldn't start tunnel", { description: msg });
    } finally {
      setTunnelBusy(false);
    }
  }

  async function stopTunnel() {
    if (!isTauri()) return;
    setTunnelBusy(true);
    try {
      await invoke<void>("remote_tunnel_stop");
      setTunnel({ running: false, url: null, err: null });
    } catch (err) {
      toast.error("Couldn't stop tunnel", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTunnelBusy(false);
    }
  }

  async function downloadCloudflared() {
    if (!isTauri()) return;
    setDownloading(true);
    try {
      const r = await invoke<DownloadResult>("remote_tunnel_install");
      setInstalled({ installed: true, path: r.path });
      toast.success("cloudflared installed", {
        description: `${(r.bytes / (1024 * 1024)).toFixed(1)} MB downloaded.`,
      });
    } catch (err) {
      toast.error("Download failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDownloading(false);
    }
  }

  async function copyPairing() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing);
      setCopied("pairing");
      setTimeout(() => setCopied((c) => (c === "pairing" ? null : c)), 1200);
    } catch (err) {
      toast.error("Couldn't copy", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const pairing = useMemo(() => {
    if (!server?.token || !tunnelUrl) return "";
    return JSON.stringify({
      url: tunnelUrl.replace(/\/$/, ""),
      token: server.token,
    });
  }, [server?.token, tunnelUrl]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="font-serif text-2xl tracking-tight">Remote access</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Run chat from your phone on this PC's local model. Your phone reaches
          your machine through a tunnel — your API keys never leave the
          desktop.
        </p>
      </header>

      {/* Server gate. The mobile pairing flow needs the local API
          listening — Remote access can't do anything until that's up.
          We don't start it implicitly; the user opted in to remote
          features by opening this page, but opting in to externally-
          reachable data routes is a separate decision they make on
          the Local API page. */}
      {server && !server.running && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-300">
          The local API isn't running yet. Open <strong>Settings → Local API</strong> and
          click <strong>Start</strong>; then come back here to pair your phone.
        </div>
      )}

      {/* Step 1 — tunnel */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-1 flex items-center gap-2 font-medium text-[14px]">
          <Cloud className="size-4" />
          1 · Start a tunnel
        </h3>
        <p className="mb-3 text-[12px] text-muted-foreground">
          Tokori spawns{" "}
          <a
            href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            cloudflared
          </a>{" "}
          for you and grabs the printed URL. We can download it on first use
          (~30 MB) — or use a copy you already have on PATH.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {installed && !installed.installed && !tunnel.running && (
            <Button
              variant="outline"
              onClick={() => void downloadCloudflared()}
              disabled={downloading}
              title="Downloads the right cloudflared binary for your OS from GitHub releases."
            >
              {downloading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Cloud className="size-3.5" />
              )}
              Download cloudflared (~30 MB)
            </Button>
          )}
          {tunnel.running ? (
            <Button
              variant="outline"
              onClick={() => void stopTunnel()}
              disabled={tunnelBusy}
            >
              {tunnelBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Square className="size-3.5" />
              )}
              Stop tunnel
            </Button>
          ) : (
            <Button
              onClick={() => void startTunnel()}
              disabled={tunnelBusy || !server?.running}
            >
              {tunnelBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Cloud className="size-3.5" />
              )}
              Start tunnel
            </Button>
          )}
          {tunnel.running && tunnel.url && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {tunnel.url.replace(/^https?:\/\//, "")}
            </span>
          )}
          {tunnel.running && !tunnel.url && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
              <Loader2 className="size-3 animate-spin" />
              Waiting for URL…
            </span>
          )}
        </div>

        {tunnel.err && (
          <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
            {tunnel.err}
          </p>
        )}

        <p className="mt-2 text-[11px] text-muted-foreground">
          Quick-tunnel URLs rotate every restart — fine for trying it out. For
          a stable URL, point a named cloudflared tunnel or Tailscale Funnel at{" "}
          <code>http://{server?.addr ?? "127.0.0.1:53210"}</code> and paste the
          URL into the override below.
        </p>

        <details className="group mt-3">
          <summary className="cursor-pointer text-[12px] font-medium marker:text-muted-foreground">
            Manual override <span className="text-muted-foreground font-normal">(use your own tunnel URL)</span>
          </summary>
          <input
            value={tunnelUrl}
            onChange={(e) => saveTunnelUrl(e.target.value.trim())}
            placeholder="https://your-tunnel.example.com"
            spellCheck={false}
            className="mt-2 block w-full rounded-md border border-input bg-background px-3 py-1.5 font-mono text-[12px] shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Auto-filled when you start the tunnel above. Edit only if you're
            using Tailscale Funnel, a named cloudflared tunnel, or your own
            reverse proxy.
          </p>
        </details>
      </div>

      {/* Step 2 — QR pairing */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-1 flex items-center gap-2 font-medium text-[14px]">
          <Smartphone className="size-4" />
          2 · Pair your phone
        </h3>
        <p className="mb-3 text-[12px] text-muted-foreground">
          Open Tokori Mobile → More → Connect to PC → Scan QR. The code carries
          the URL + token in one payload.
        </p>

        {pairing ? (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <div className="rounded-md border border-border bg-white p-3">
              <QRCodeSVG value={pairing} size={172} level="M" />
            </div>
            <div className="flex flex-col gap-2 text-[11.5px] text-muted-foreground">
              <span>
                Pairing payload (also copyable if your phone can't scan):
              </span>
              <Button size="sm" variant="outline" onClick={() => void copyPairing()}>
                {copied === "pairing" ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                Copy JSON
              </Button>
              {server?.token && (
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  Server: {server.addr} · token rotates on Local API restart.
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-[11.5px] text-muted-foreground">
            {server?.running
              ? "Start the tunnel above to generate the pairing QR."
              : "Start the local API + tunnel above to generate the pairing QR."}
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Anyone with the QR can talk to your PC. Treat it like a password — open
        Local API and stop/start the server to rotate the token if it leaks.
      </p>
    </div>
  );
}
