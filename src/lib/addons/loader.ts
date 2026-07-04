/**
 * Addon loader (Stage 2).
 *
 * Reads each enabled addon's entry JS off disk (via the `read_addon_entry`
 * Tauri command), runs it inside a per-addon sandbox worker (see
 * `sandbox-worker.ts` — no DOM, no IPC), validates its default export, and
 * registers the result into the matching built-in registry. Today that's
 * `vocab-import` only; other kinds are reported as "not loadable yet" so
 * the Addons UI can say so honestly.
 *
 * Desktop-only: HOSTED has no filesystem of user addons, and a non-Tauri
 * (browser dev) build has no `read_addon_entry` command — both resolve to
 * "no addons loaded" without throwing.
 *
 * Re-entrant: `loadEnabledAddons()` terminates the previous generation of
 * workers before spawning the new one, so toggling an addon on/off in
 * Settings re-syncs cleanly.
 */

import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { HOSTED } from "@/lib/build-flags";
import { setAddonImporters } from "@/lib/vocab-import/registry";
import type { ImportRow, VocabImporter } from "@/lib/vocab-import/api";
import { normalizeRows, sanitizeImporterMeta } from "./import-normalize";
import { listAddons, type DiscoveredAddon } from "./registry";

const LOAD_TIMEOUT_MS = 8_000;
const PARSE_TIMEOUT_MS = 8_000;

export type AddonLoadState = "loaded" | "error";
export type AddonLoadStatus = {
  id: string;
  folder: string;
  kind: string;
  state: AddonLoadState;
  error?: string;
};

// ── Observable status store (same pattern as registry.ts) ────────────
let statuses: AddonLoadStatus[] = [];
const statusListeners = new Set<() => void>();

function publish(next: AddonLoadStatus[]): void {
  statuses = next;
  for (const fn of statusListeners) fn();
}

/** React hook: live per-addon load status for the Settings UI. */
export function useAddonLoadStatuses(): AddonLoadStatus[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    statusListeners.add(fn);
    return () => {
      statusListeners.delete(fn);
    };
  }, []);
  return statuses;
}

// ── Worker lifecycle ─────────────────────────────────────────────────
// One worker per loaded addon id, retained so a reload can terminate it.
const workers = new Map<string, Worker>();

function spawnWorker(): Worker {
  return new Worker(new URL("./sandbox-worker.ts", import.meta.url), {
    type: "module",
  });
}

/** Load one vocab-import addon into a worker; resolve with an importer
 *  whose `parse` round-trips through that worker. Rejects (and tears the
 *  worker down) on load failure or timeout. */
function loadVocabImporter(
  addon: DiscoveredAddon,
  source: string,
): Promise<VocabImporter> {
  const manifest = addon.manifest!;
  return new Promise<VocabImporter>((resolve, reject) => {
    const worker = spawnWorker();
    let settled = false;
    const loadTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error("addon load timed out"));
    }, LOAD_TIMEOUT_MS);

    let nextReq = 0;
    const pending = new Map<
      number,
      { resolve: (r: ImportRow[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
    >();

    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as Record<string, unknown>;
      switch (m.type) {
        case "loaded": {
          if (settled) return;
          settled = true;
          clearTimeout(loadTimer);
          workers.set(manifest.id, worker);
          const meta = sanitizeImporterMeta(m.meta, manifest);
          resolve({
            meta,
            parse: (text: string) =>
              new Promise<ImportRow[]>((res, rej) => {
                const reqId = nextReq++;
                const timer = setTimeout(() => {
                  pending.delete(reqId);
                  rej(new Error("addon parse timed out"));
                }, PARSE_TIMEOUT_MS);
                pending.set(reqId, { resolve: res, reject: rej, timer });
                worker.postMessage({ type: "parse", reqId, text });
              }),
          });
          break;
        }
        case "load-error": {
          if (settled) return;
          settled = true;
          clearTimeout(loadTimer);
          worker.terminate();
          reject(new Error(String(m.error ?? "addon failed to load")));
          break;
        }
        case "parse-result": {
          const p = pending.get(m.reqId as number);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(m.reqId as number);
            p.resolve(normalizeRows(m.rows));
          }
          break;
        }
        case "parse-error": {
          const p = pending.get(m.reqId as number);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(m.reqId as number);
            p.reject(new Error(String(m.error ?? "addon parse failed")));
          }
          break;
        }
      }
    };

    worker.onerror = (err: ErrorEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimer);
      worker.terminate();
      reject(new Error(err.message || "addon worker crashed"));
    };

    worker.postMessage({
      type: "load",
      id: manifest.id,
      kind: manifest.kind,
      source,
    });
  });
}

/**
 * (Re)load every enabled addon. Terminates the previous worker generation,
 * loads the current enabled set, and re-registers the resulting importers.
 * Safe to call repeatedly (startup + after each enable/disable toggle).
 */
export async function loadEnabledAddons(): Promise<void> {
  if (HOSTED || !isTauri()) {
    setAddonImporters([]);
    publish([]);
    return;
  }

  for (const w of workers.values()) w.terminate();
  workers.clear();

  const all = await listAddons();
  const enabled = all.filter(
    (a) => a.enabled && a.status === "valid" && a.manifest,
  );

  const importers: VocabImporter[] = [];
  const nextStatuses: AddonLoadStatus[] = [];

  for (const addon of enabled) {
    const m = addon.manifest!;
    if (m.kind !== "vocab-import") {
      // Worker harness only validates+runs vocab-import so far. Surface
      // the others as a clear "not yet" rather than silently ignoring.
      nextStatuses.push({
        id: m.id,
        folder: addon.folder,
        kind: m.kind,
        state: "error",
        error: `Running "${m.kind}" addons isn't supported yet — vocab-import only for now.`,
      });
      continue;
    }
    try {
      const source = await invoke<string>("read_addon_entry", {
        folder: addon.folder,
        entry: m.entry,
      });
      const importer = await loadVocabImporter(addon, source);
      importers.push(importer);
      nextStatuses.push({ id: m.id, folder: addon.folder, kind: m.kind, state: "loaded" });
    } catch (err) {
      nextStatuses.push({
        id: m.id,
        folder: addon.folder,
        kind: m.kind,
        state: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  setAddonImporters(importers);
  publish(nextStatuses);
}
