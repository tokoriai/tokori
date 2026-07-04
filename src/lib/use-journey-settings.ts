/**
 * React hook around the per-workspace journey settings persisted in
 * the settings table. Mirrors the pattern used by other settings
 * hooks (chinese-config, profile-context): batch-load the keys on
 * mount, expose a `set` function that persists + invalidates.
 *
 * Why a hook (vs. consuming the pure helpers directly): the Journey
 * widget + tab both want to live-render the parsed snapshot, AND
 * react to mutations from the Journey tab. A hook gives us
 * subscription semantics without duplicating the parse logic at
 * each call site.
 *
 * Storage layout — see `learning-journey.ts` for the key prefix:
 *   journey.<wsId>.targetLevelId         string | null
 *   journey.<wsId>.deadline              string (epoch seconds) | null
 *   journey.<wsId>.weeklyMinutesTarget   string (number) | null
 *   journey.<wsId>.milestoneOverrides    JSON: { [levelId]: epoch }
 */

import { useCallback, useEffect, useState } from "react";
import { getSettings, setSetting } from "./db";
import {
  journeySettingKey,
  journeySettingKeys,
  parseJourneySettings,
  type JourneySettings,
} from "./learning-journey";

const EMPTY: JourneySettings = {
  targetLevelId: null,
  deadline: null,
  weeklyMinutesTarget: null,
  manualOverrides: {},
};

type JourneySettingsValue = {
  settings: JourneySettings;
  ready: boolean;
  setTargetLevelId: (levelId: string | null) => Promise<void>;
  setDeadline: (epochSeconds: number | null) => Promise<void>;
  setWeeklyMinutesTarget: (minutes: number | null) => Promise<void>;
  setMilestoneOverride: (
    levelId: string,
    completedAt: number | null,
  ) => Promise<void>;
};

export function useJourneySettings(workspaceId: number): JourneySettingsValue {
  const [settings, setSettings] = useState<JourneySettings>(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void getSettings(journeySettingKeys(workspaceId)).then((raw) => {
      if (cancelled) return;
      setSettings(parseJourneySettings(workspaceId, raw));
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const persist = useCallback(
    async (name: string, value: string | null) => {
      const key = journeySettingKey(workspaceId, name);
      // The settings table stores strings; null clears the value.
      await setSetting(key, value ?? "");
    },
    [workspaceId],
  );

  const setTargetLevelId = useCallback(
    async (levelId: string | null) => {
      setSettings((prev) => ({ ...prev, targetLevelId: levelId }));
      await persist("targetLevelId", levelId);
    },
    [persist],
  );

  const setDeadline = useCallback(
    async (epochSeconds: number | null) => {
      setSettings((prev) => ({ ...prev, deadline: epochSeconds }));
      await persist("deadline", epochSeconds != null ? String(epochSeconds) : null);
    },
    [persist],
  );

  const setWeeklyMinutesTarget = useCallback(
    async (minutes: number | null) => {
      setSettings((prev) => ({ ...prev, weeklyMinutesTarget: minutes }));
      await persist("weeklyMinutesTarget", minutes != null ? String(minutes) : null);
    },
    [persist],
  );

  const setMilestoneOverride = useCallback(
    async (levelId: string, completedAt: number | null) => {
      const next: Record<string, number> = { ...settings.manualOverrides };
      if (completedAt == null) {
        delete next[levelId];
      } else {
        next[levelId] = completedAt;
      }
      setSettings((prev) => ({ ...prev, manualOverrides: next }));
      await persist(
        "milestoneOverrides",
        Object.keys(next).length > 0 ? JSON.stringify(next) : null,
      );
    },
    [settings.manualOverrides, persist],
  );

  return {
    settings,
    ready,
    setTargetLevelId,
    setDeadline,
    setWeeklyMinutesTarget,
    setMilestoneOverride,
  };
}
