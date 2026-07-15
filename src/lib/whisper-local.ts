/**
 * Local Whisper model registry — observable cache over the Rust
 * `whisper_local_*` commands (whisper_local.rs).
 *
 * Same cache + invalidator pattern as the dictionary/addon registries:
 * one module-level source of truth, React hooks subscribe, mutations
 * call the Tauri command then invalidate. Everything no-ops outside
 * Tauri (hosted build / browser dev), so `useLocalWhisperReady()` is
 * safely false there and resolveSttEngine never picks "local".
 */

import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSetting, setSetting } from "./db";

export type WhisperModelInfo = {
  id: string;
  label: string;
  blurb: string;
  bytes: number;
  downloaded: boolean;
  downloading: boolean;
};

export type WhisperDlProgress = {
  model: string;
  received: number;
  total: number;
  done: boolean;
  error: string | null;
};

/** Settings key holding the user's preferred local model id. */
const MODEL_SETTING_KEY = "whisper.local.model";

let cache: WhisperModelInfo[] | null = null;
let inflight: Promise<WhisperModelInfo[]> | null = null;
const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) fn();
}

export async function listLocalWhisperModels(
  force = false,
): Promise<WhisperModelInfo[]> {
  if (!isTauri()) return [];
  if (cache && !force) return cache;
  if (!inflight) {
    inflight = invoke<WhisperModelInfo[]>("whisper_local_models")
      .then((models) => {
        cache = models;
        notify();
        return models;
      })
      .catch(() => cache ?? [])
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function invalidateLocalWhisperModels(): void {
  cache = null;
  void listLocalWhisperModels(true);
}

export function useLocalWhisperModels(): {
  models: WhisperModelInfo[];
  loading: boolean;
} {
  const [models, setModels] = useState<WhisperModelInfo[]>(cache ?? []);
  const [loading, setLoading] = useState(cache == null && isTauri());
  useEffect(() => {
    const sync = () => {
      setModels(cache ?? []);
      setLoading(false);
    };
    subscribers.add(sync);
    void listLocalWhisperModels().then(sync);
    return () => {
      subscribers.delete(sync);
    };
  }, []);
  return { models, loading };
}

/** True once at least one model is on disk — the "can the local engine
 *  run at all?" gate that resolveSttEngine consumes. */
export function useLocalWhisperReady(): boolean {
  const { models } = useLocalWhisperModels();
  return models.some((m) => m.downloaded);
}

/** The model dictation should use: the Settings pick when it's
 *  actually on disk, otherwise the first downloaded model. Null when
 *  nothing is downloaded. `force` bypasses the registry cache — the
 *  voice-ask popup runs in its own webview whose cache can't see a
 *  model the main window downloaded after the popup was created. */
export async function activeLocalWhisperModel(
  force = false,
): Promise<string | null> {
  const models = await listLocalWhisperModels(force);
  const downloaded = models.filter((m) => m.downloaded);
  if (downloaded.length === 0) return null;
  const preferred = await getSetting(MODEL_SETTING_KEY).catch(() => null);
  return downloaded.find((m) => m.id === preferred)?.id ?? downloaded[0].id;
}

export async function setActiveLocalWhisperModel(id: string): Promise<void> {
  await setSetting(MODEL_SETTING_KEY, id);
  // The registry itself didn't change, but active-model badges derive
  // from it — poke subscribers so they re-resolve.
  notify();
}

export async function downloadLocalWhisperModel(id: string): Promise<void> {
  // Optimistic flag so every subscriber (Settings card, dictation
  // buttons) sees the spinner immediately, not after the first
  // progress event.
  if (cache) {
    cache = cache.map((m) => (m.id === id ? { ...m, downloading: true } : m));
    notify();
  }
  try {
    await invoke("whisper_local_download", { model: id });
  } finally {
    invalidateLocalWhisperModels();
  }
}

export async function deleteLocalWhisperModel(id: string): Promise<void> {
  await invoke("whisper_local_delete", { model: id });
  invalidateLocalWhisperModels();
}

/** Subscribe to download progress (`tokori:whisper-dl`). Returns an
 *  unsubscribe; safe to call outside Tauri (no-op). */
export function onWhisperDlProgress(
  handler: (p: WhisperDlProgress) => void,
): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let disposed = false;
  void listen<WhisperDlProgress>("tokori:whisper-dl", (e) => {
    handler(e.payload);
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
