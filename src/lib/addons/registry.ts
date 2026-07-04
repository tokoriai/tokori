/**
 * Runtime store of discovered addons.
 *
 * Follows the same observable-cache pattern as dict-availability:
 * one in-flight promise, one invalidator, many subscribers. Addon
 * discovery is a Tauri-only operation (reads the app data folder)
 * and is a no-op under HOSTED — the cloud build doesn't have a
 * filesystem for users to drop folders into.
 *
 * STAGE 1 (current): discovery + manifest validation + UI listing
 * + enable/disable persistence. The entry point JS is NOT loaded
 * yet — that requires a sandboxed evaluation surface (Web Worker
 * with a Blob URL, or an isolated iframe) and an explicit user
 * permission flow. Marked as TODOs below; the public shape is
 * already what Stage 2 will produce.
 */
import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { HOSTED } from "@/lib/build-flags";
import { getSetting, setSetting } from "@/lib/db";
import { parseManifest, type AddonManifest } from "./manifest";

export type AddonStatus = "valid" | "invalid";

export type DiscoveredAddon = {
  /** Folder name on disk (under <app-data>/addons/). May differ from
   *  the manifest id — id is the canonical key. */
  folder: string;
  /** Absolute folder path. Used by the "Reveal in file manager"
   *  button. Empty when not applicable (cloud build). */
  path: string;
  status: AddonStatus;
  /** Populated when status === "valid". */
  manifest: AddonManifest | null;
  /** Populated when status === "invalid" — the validator's reason. */
  error: string | null;
  /** User toggled the addon on. Persisted via getSetting/setSetting. */
  enabled: boolean;
};

let cache: Promise<DiscoveredAddon[]> | null = null;
const listeners = new Set<() => void>();

/** Load (or return cached) discovery result. */
export function listAddons(): Promise<DiscoveredAddon[]> {
  if (!cache) {
    cache = discover().catch(() => [] as DiscoveredAddon[]);
  }
  return cache;
}

/** Bust the cache and wake every subscribed hook. Call after the
 *  user clicks "Reload addons" or toggles enable/disable. */
export function invalidateAddonCache(): void {
  cache = null;
  for (const fn of listeners) fn();
}

/** React subscriber. Returns `null` while the first scan is in
 *  flight so the UI doesn't flash "no addons" before discovery
 *  resolves. */
export function useAddons(): DiscoveredAddon[] | null {
  const [items, setItems] = useState<DiscoveredAddon[] | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const onInvalidate = () => setRevision((r) => r + 1);
    listeners.add(onInvalidate);
    return () => {
      listeners.delete(onInvalidate);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listAddons().then((list) => {
      if (!cancelled) setItems(list);
    });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  return items;
}

/** Persist an enable/disable toggle. Setting key is auto-namespaced
 *  so two addons can't collide on the same id without showing it. */
export async function setAddonEnabled(id: string, enabled: boolean): Promise<void> {
  await setSetting(addonEnabledKey(id), enabled ? "1" : "0");
  invalidateAddonCache();
}

export async function isAddonEnabled(id: string): Promise<boolean> {
  const v = await getSetting(addonEnabledKey(id));
  return v === "1";
}

function addonEnabledKey(id: string): string {
  return `addon.${id}.enabled`;
}

async function discover(): Promise<DiscoveredAddon[]> {
  // The cloud build has no filesystem for the user to drop folders
  // into. We resolve to an empty list rather than throw so the UI
  // can render its "addons are desktop-only" notice without errors.
  if (HOSTED) return [];

  if (!isTauri()) return [];

  type RawAddon = {
    folder: string;
    path: string;
    manifestText: string | null;
    readError: string | null;
  };
  const raw = await invoke<RawAddon[]>("list_addons").catch(() => [] as RawAddon[]);

  const out: DiscoveredAddon[] = [];
  for (const r of raw) {
    if (!r.manifestText) {
      out.push({
        folder: r.folder,
        path: r.path,
        status: "invalid",
        manifest: null,
        error: r.readError ?? "Missing manifest.json",
        enabled: false,
      });
      continue;
    }
    const parsed = parseManifest(r.manifestText);
    const enabled = parsed.ok ? await isAddonEnabled(parsed.manifest.id) : false;
    out.push({
      folder: r.folder,
      path: r.path,
      status: parsed.ok ? "valid" : "invalid",
      manifest: parsed.ok ? parsed.manifest : null,
      error: parsed.ok ? null : parsed.error,
      enabled,
    });
  }
  return out;
}
