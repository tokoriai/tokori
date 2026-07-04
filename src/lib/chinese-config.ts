/**
 * Per-workspace Chinese-specific configuration.
 *
 * Stored in the same settings k/v table as the rest of the
 * per-workspace state, namespaced by workspace id so different
 * Chinese workspaces (e.g. a Mandarin and a Cantonese learner)
 * keep separate preferences.
 *
 * Two knobs today:
 *   - `script` — `simplified` | `traditional`. Drives which form of
 *     a dictionary headword the UI prefers when the entry carries
 *     both. Default is simplified, which matches the vast majority
 *     of HSK / mainland-textbook learners.
 *   - `toneColors` — { 1..5: "#rrggbb" }. Drives the global
 *     `[data-tone="N"]` styles via CSS vars at runtime so every
 *     pinyin syllable in the app re-colours instantly when the
 *     user tweaks the picker. Defaults mirror Pleco's classic
 *     palette (red/orange/green/blue/neutral) — the same scheme
 *     most Chinese-learning apps lean on, so users can compare
 *     across tools without having to relearn the cue.
 *
 * Add a new field:
 *   1. Add to `ChineseConfig` + `DEFAULTS`.
 *   2. Add to `KEY` so persistence works.
 *   3. Surface it in `ChineseSection`.
 */

import { useCallback, useEffect, useState } from "react";
import { getSetting, getSettings, setSetting } from "./db";

export type ChineseScript = "simplified" | "traditional";

export type ToneColors = {
  /** Tone marks 1..4. Tone 5 = neutral / unmarked. */
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
};

export type ChineseConfig = {
  script: ChineseScript;
  toneColors: ToneColors;
};

/** Pleco's classic palette. Picked over the previous oklch defaults
 *  because they're what every Chinese learner has already trained
 *  their eye on — a tone-3 syllable here is the same green as in
 *  Pleco / Du Chinese / Hello Chinese. Hex form so the colour
 *  picker can round-trip without parsing. */
export const PLECO_TONE_COLORS: ToneColors = {
  1: "#e53935", // red
  2: "#fb8c00", // orange
  3: "#43a047", // green
  4: "#1e88e5", // blue
  5: "#9e9e9e", // neutral grey
};

export const DEFAULTS: ChineseConfig = {
  script: "simplified",
  toneColors: PLECO_TONE_COLORS,
};

const KEY = (workspaceId: number, field: keyof ChineseConfig) =>
  `workspace.${workspaceId}.chinese.${field}`;

export async function loadChineseConfig(
  workspaceId: number,
): Promise<ChineseConfig> {
  const got = await getSettings([
    KEY(workspaceId, "script"),
    KEY(workspaceId, "toneColors"),
  ]);
  return {
    script: parseScript(got[KEY(workspaceId, "script")]),
    toneColors: parseToneColors(got[KEY(workspaceId, "toneColors")]),
  };
}

export async function saveChineseField<K extends keyof ChineseConfig>(
  workspaceId: number,
  field: K,
  value: ChineseConfig[K],
): Promise<void> {
  const serialised =
    field === "toneColors"
      ? JSON.stringify(value as ToneColors)
      : String(value);
  await setSetting(KEY(workspaceId, field), serialised);
}

function parseScript(raw: string | null | undefined): ChineseScript {
  return raw === "traditional" ? "traditional" : "simplified";
}

function parseToneColors(raw: string | null | undefined): ToneColors {
  if (!raw) return PLECO_TONE_COLORS;
  try {
    const parsed = JSON.parse(raw) as Partial<ToneColors>;
    return {
      1: typeof parsed[1] === "string" ? parsed[1] : PLECO_TONE_COLORS[1],
      2: typeof parsed[2] === "string" ? parsed[2] : PLECO_TONE_COLORS[2],
      3: typeof parsed[3] === "string" ? parsed[3] : PLECO_TONE_COLORS[3],
      4: typeof parsed[4] === "string" ? parsed[4] : PLECO_TONE_COLORS[4],
      5: typeof parsed[5] === "string" ? parsed[5] : PLECO_TONE_COLORS[5],
    };
  } catch {
    return PLECO_TONE_COLORS;
  }
}

/** Apply tone colours to the global CSS vars `--tone-1..5`. The
 *  stylesheet (`index.css`) reads these vars from `[data-tone="N"]`
 *  selectors, so every Pinyin syllable in the app re-paints when
 *  this runs. Idempotent — calling repeatedly with the same values
 *  is fine. */
export function applyToneColorsToDocument(colors: ToneColors): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (let i = 1 as 1 | 2 | 3 | 4 | 5; i <= 5; i++) {
    root.style.setProperty(`--tone-${i}`, colors[i as 1 | 2 | 3 | 4 | 5]);
  }
}

/** Read the workspace's Chinese config and apply tone colours to
 *  the document. Re-applies whenever `workspaceId` changes (the
 *  user might have multiple Chinese workspaces) or the persisted
 *  settings flip (custom picker save fires `tokori:chinese-colors`
 *  on the window, which we listen for so saves take effect without
 *  a route change).
 *
 *  Returns the current config + a setter so a settings panel can
 *  show it AND drive saves through the same surface. */
export function useChineseConfig(workspaceId: number | null): {
  config: ChineseConfig;
  saveField: <K extends keyof ChineseConfig>(
    field: K,
    value: ChineseConfig[K],
  ) => Promise<void>;
  loading: boolean;
} {
  const [config, setConfig] = useState<ChineseConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) {
      setConfig(DEFAULTS);
      applyToneColorsToDocument(DEFAULTS.toneColors);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadChineseConfig(workspaceId).then((c) => {
      if (cancelled) return;
      setConfig(c);
      applyToneColorsToDocument(c.toneColors);
      setLoading(false);
    });
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<ChineseConfig>).detail;
      if (!detail) return;
      setConfig(detail);
      applyToneColorsToDocument(detail.toneColors);
    };
    window.addEventListener("tokori:chinese-config-changed", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("tokori:chinese-config-changed", onChange);
    };
  }, [workspaceId]);

  const saveField = useCallback(
    async <K extends keyof ChineseConfig>(
      field: K,
      value: ChineseConfig[K],
    ): Promise<void> => {
      if (!workspaceId) return;
      await saveChineseField(workspaceId, field, value);
      setConfig((prev) => {
        const next = { ...prev, [field]: value };
        if (field === "toneColors") {
          applyToneColorsToDocument(next.toneColors);
        }
        // Broadcast so every mounted `useChineseConfig` consumer
        // (and any plain non-React code that wants to subscribe)
        // re-syncs without a route change.
        window.dispatchEvent(
          new CustomEvent<ChineseConfig>("tokori:chinese-config-changed", {
            detail: next,
          }),
        );
        return next;
      });
    },
    [workspaceId],
  );

  return { config, saveField, loading };
}

/** Hook for surfaces that just need the script preference (e.g.
 *  dictionary lookup, header rendering) and don't want the cost of
 *  threading toneColors through. Reads on mount, no settings hook
 *  needed. */
export async function loadChineseScript(
  workspaceId: number,
): Promise<ChineseScript> {
  const raw = await getSetting(`workspace.${workspaceId}.chinese.script`);
  return parseScript(raw);
}
