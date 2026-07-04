// Stroke / median data loader for HanziWriter.
//
// Desktop (Tauri): served from `src-tauri/assets/hanzi-writer-data/` via
// the `hanzi_stroke` command — no internet required.
// Hosted demo (no Tauri): falls back to the jsDelivr CDN. The bundled
// dataset is ~47MB, which we don't want to ship to the in-browser demo,
// so the demo keeps the CDN dependency. The desktop build is fully
// offline.

import { invoke, isTauri } from "@tauri-apps/api/core";

export type StrokeData = {
  strokes: string[];
  medians: number[][][];
};

const CACHE = new Map<string, Promise<StrokeData | null>>();

export function loadStrokeData(char: string): Promise<StrokeData | null> {
  const cached = CACHE.get(char);
  if (cached) return cached;
  const promise = isTauri() ? loadFromTauri(char) : loadFromCdn(char);
  CACHE.set(char, promise);
  return promise;
}

async function loadFromTauri(char: string): Promise<StrokeData | null> {
  try {
    const data = await invoke<StrokeData | null>("hanzi_stroke", { char });
    return data ?? null;
  } catch {
    return null;
  }
}

async function loadFromCdn(char: string): Promise<StrokeData | null> {
  try {
    const r = await fetch(
      `https://cdn.jsdelivr.net/npm/hanzi-writer-data@latest/${encodeURIComponent(char)}.json`,
    );
    if (!r.ok) return null;
    return (await r.json()) as StrokeData;
  } catch {
    return null;
  }
}
