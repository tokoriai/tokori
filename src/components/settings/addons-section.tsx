/**
 * Settings → Addons.
 *
 * STAGE 1: discovers folders under `<app-data>/addons/<name>/`,
 * validates their `manifest.json`, and lets the user toggle each one
 * on/off. Stage 2 (runtime JS execution in a sandbox) will pick up
 * the enabled list and load the addon's entry point. The contract an
 * addon author writes against is the existing `StudyPlugin` /
 * `TranslateEngine` / `VocabImportPlugin` shape — see
 * `docs/guides/addons.md`.
 */
import { useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ExternalLink,
  FolderOpen,
  Plug,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  invalidateAddonCache,
  setAddonEnabled,
  useAddons,
  type DiscoveredAddon,
} from "@/lib/addons/registry";
import { loadEnabledAddons, useAddonLoadStatuses } from "@/lib/addons/loader";
import { HOSTED } from "@/lib/build-flags";
import { cn } from "@/lib/utils";

export function AddonsSection() {
  // Split into an inner component so the desktop body's hooks always run
  // unconditionally — this wrapper just picks which to render (no hooks).
  if (HOSTED) return <HostedAddonsNotice />;
  return <AddonsSectionInner />;
}

function AddonsSectionInner() {
  const addons = useAddons();
  const [revealing, setRevealing] = useState(false);

  async function reveal() {
    if (!isTauri()) return;
    setRevealing(true);
    try {
      await invoke("reveal_addons_dir");
    } finally {
      setRevealing(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Addons</h2>
        <p className="text-[13px] text-muted-foreground">
          Drop a folder under <code className="rounded bg-muted px-1 text-[12px]">addons/</code>{" "}
          to add a new study mode, translate engine, or vocab importer.
          Each folder needs a <code className="rounded bg-muted px-1 text-[12px]">manifest.json</code>.{" "}
          <a
            href="https://github.com/tokoriai/tokori/blob/main/docs/guides/addons.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
          >
            Addon authoring guide <ExternalLink className="size-3" />
          </a>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void reveal()} disabled={revealing}>
          <FolderOpen className="size-3.5" /> Open addons folder
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => invalidateAddonCache()}
        >
          <RefreshCw className="size-3.5" /> Rescan
        </Button>
      </div>

      {addons === null ? (
        <p className="text-[12.5px] text-muted-foreground">Scanning…</p>
      ) : addons.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="space-y-2">
          {addons.map((a) => (
            <AddonRow key={a.folder} addon={a} />
          ))}
        </ul>
      )}

      <StageTwoNotice />
    </div>
  );
}

function AddonRow({ addon }: { addon: DiscoveredAddon }) {
  const loadStatuses = useAddonLoadStatuses();
  const loadStatus = addon.manifest
    ? loadStatuses.find((s) => s.id === addon.manifest!.id)
    : undefined;

  async function toggle(next: boolean) {
    if (!addon.manifest) return;
    await setAddonEnabled(addon.manifest.id, next);
    // Re-sync the sandbox so the change takes effect without a restart:
    // enabling loads the addon into a worker, disabling tears it down.
    await loadEnabledAddons();
  }

  if (addon.status === "invalid") {
    return (
      <li className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
        <div className="flex items-start gap-2 text-[13px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="font-medium text-foreground">{addon.folder}</p>
            <p className="text-[12px] text-destructive">{addon.error}</p>
          </div>
        </div>
      </li>
    );
  }

  const m = addon.manifest!;
  return (
    <li
      className={cn(
        "rounded-xl border bg-card px-4 py-3 transition-colors",
        addon.enabled ? "border-foreground/30" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Plug className="size-3.5 text-muted-foreground" />
            <span className="font-medium">{m.name}</span>
            <Badge variant="outline" className="text-[10px]">{m.kind}</Badge>
            <Badge variant="outline" className="text-[10px]">v{m.version}</Badge>
            {m.license && (
              <Badge variant="outline" className="text-[10px]">{m.license}</Badge>
            )}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{m.description}</p>
          {m.author && (
            <p className="mt-0.5 text-[11px] text-muted-foreground/80">by {m.author}</p>
          )}
          {addon.enabled && loadStatus && (
            <p
              className={cn(
                "mt-1 text-[11px]",
                loadStatus.state === "loaded"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-amber-600 dark:text-amber-400",
              )}
            >
              {loadStatus.state === "loaded"
                ? "● Loaded and active"
                : `● ${loadStatus.error ?? "Failed to load"}`}
            </p>
          )}
        </div>
        <Switch
          checked={addon.enabled}
          onCheckedChange={(v) => void toggle(v)}
        />
      </div>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-6 text-center text-[13px] text-muted-foreground">
      No addons installed yet. Open the addons folder above and drop a
      folder with a <code className="rounded bg-muted px-1 text-[12px]">manifest.json</code>{" "}
      inside to add one.
    </div>
  );
}

function StageTwoNotice() {
  return (
    <div className="rounded-md border border-border bg-card/60 px-3 py-2.5 text-[12px] text-muted-foreground">
      <span className="font-medium text-foreground">Preview feature.</span>{" "}
      Discovery and enable/disable are wired up; actually running an
      addon's code requires a sandboxed evaluation surface that lands
      in a future release. Enabling an addon now persists your choice
      so it activates the moment Stage 2 ships.
    </div>
  );
}

function HostedAddonsNotice() {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Addons</h2>
        <p className="text-[13px] text-muted-foreground">
          Addons are a desktop-only feature — they live in a folder on
          your machine. Install the Tokori desktop app to author or
          install one.
        </p>
      </div>
    </div>
  );
}
