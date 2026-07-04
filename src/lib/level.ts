// Level systems per language. Each language's "native" scale is the
// one learners and certificates use in practice — HSK 3.0 (post-2021)
// for Chinese, JLPT (N5→N1) for Japanese, TOPIK (1→6) for Korean,
// CEFR (A1→C2) for everything else. All scales expose the same shape
// so the dashboard renders identically; the user can override the
// auto-pick in Settings → Level.

import type { LanguageCode } from "./languages";

export type LevelInfo = {
  id: string;
  label: string;
  /** Vocabulary threshold for the level. */
  minVocab: number;
};

const HSK_LEVELS: LevelInfo[] = [
  { id: "HSK 1", label: "Foundational", minVocab: 0 },
  { id: "HSK 2", label: "Basic", minVocab: 500 },
  { id: "HSK 3", label: "Pre-intermediate", minVocab: 1272 },
  { id: "HSK 4", label: "Intermediate", minVocab: 2245 },
  { id: "HSK 5", label: "Upper-intermediate", minVocab: 3245 },
  { id: "HSK 6", label: "Advanced", minVocab: 4316 },
  { id: "HSK 7-9", label: "Mastery", minVocab: 5456 },
];

const CEFR_LEVELS: LevelInfo[] = [
  { id: "A1", label: "Beginner", minVocab: 0 },
  { id: "A2", label: "Elementary", minVocab: 500 },
  { id: "B1", label: "Intermediate", minVocab: 1500 },
  { id: "B2", label: "Upper-intermediate", minVocab: 3000 },
  { id: "C1", label: "Advanced", minVocab: 6000 },
  { id: "C2", label: "Mastery", minVocab: 10_000 },
];

// JLPT vocabulary targets are unofficial — the test never publishes a
// canonical list. These match the widely-cited "Jonathan's JLPT
// resources" estimates that most textbooks (Genki, Tobira, Minna no
// Nihongo) align with.
const JLPT_LEVELS: LevelInfo[] = [
  { id: "N5", label: "Foundational", minVocab: 0 },
  { id: "N4", label: "Elementary", minVocab: 800 },
  { id: "N3", label: "Pre-intermediate", minVocab: 3750 },
  { id: "N2", label: "Upper-intermediate", minVocab: 6000 },
  { id: "N1", label: "Advanced", minVocab: 10_000 },
];

// TOPIK has six levels grouped into TOPIK I (1-2, beginner) and
// TOPIK II (3-6, intermediate→advanced). Vocab targets follow the
// National Institute of Korean Language guidelines.
const TOPIK_LEVELS: LevelInfo[] = [
  { id: "TOPIK 1", label: "Beginner", minVocab: 0 },
  { id: "TOPIK 2", label: "Elementary", minVocab: 2000 },
  { id: "TOPIK 3", label: "Pre-intermediate", minVocab: 3000 },
  { id: "TOPIK 4", label: "Upper-intermediate", minVocab: 6000 },
  { id: "TOPIK 5", label: "Advanced", minVocab: 10_000 },
  { id: "TOPIK 6", label: "Mastery", minVocab: 15_000 },
];

export type ScaleKind = "hsk" | "jlpt" | "topik" | "cefr" | "custom";

const SCALE_TABLES: Record<Exclude<ScaleKind, "custom">, LevelInfo[]> = {
  hsk: HSK_LEVELS,
  jlpt: JLPT_LEVELS,
  topik: TOPIK_LEVELS,
  cefr: CEFR_LEVELS,
};

/**
 * Rough "immersion hours to advance one level" per scale. Used by the
 * Learning Journey to compute a per-milestone `hoursTarget` alongside
 * the vocab threshold. Numbers reflect commonly-cited textbook +
 * curriculum estimates and are documented in `docs/guides/study-guide.md`
 * so the user can see where they come from. The journey's "hours
 * needed to reach level N" is `(N's index in the scale) × HOURS_PER_LEVEL[scale]`.
 *
 * These are deliberately ballpark — Tokori's level formula caps
 * immersion's contribution at 1500 h, so any number much bigger than
 * that stops moving the score. The Coach uses these to spot
 * imbalance, not to enforce a quota.
 */
export const HOURS_PER_LEVEL: Record<Exclude<ScaleKind, "custom">, number> = {
  hsk: 120,
  jlpt: 180,
  topik: 150,
  cefr: 200,
};

/** Custom scales don't have a baked-in hours estimate — fall back to
 *  the CEFR pacing as a reasonable default. The Journey UI surfaces
 *  this as "estimated" so the user knows it's a heuristic. */
const CUSTOM_HOURS_PER_LEVEL = HOURS_PER_LEVEL.cefr;

export function hoursPerLevel(scale: ScaleKind): number {
  return scale === "custom"
    ? CUSTOM_HOURS_PER_LEVEL
    : HOURS_PER_LEVEL[scale];
}

const LANG_TO_SCALE: Partial<Record<LanguageCode, ScaleKind>> = {
  zh: "hsk",
  ja: "jlpt",
  ko: "topik",
};

export function scaleFor(lang: LanguageCode): ScaleKind {
  return LANG_TO_SCALE[lang] ?? "cefr";
}

export function levelsFor(lang: LanguageCode): LevelInfo[] {
  const scale = scaleFor(lang);
  // The "custom" arm is unreachable at runtime (scaleFor never returns it)
  // but narrows ScaleKind so SCALE_TABLES — which has no "custom" key —
  // can be indexed safely. Keep it.
  return scale === "custom" ? CEFR_LEVELS : SCALE_TABLES[scale];
}

/** Return the canonical level list for a given scale id. Callers that
 *  want "custom" must thread their own list (the registry can't store
 *  user overrides). Used by the dashboard's scale picker so changing
 *  the scale immediately swaps the manual-level + goal options. */
export function levelsForScale(
  scale: ScaleKind,
  fallback: LevelInfo[] = CEFR_LEVELS,
): LevelInfo[] {
  return scale === "custom" ? fallback : SCALE_TABLES[scale];
}

const SCALE_LABELS: Record<ScaleKind, string> = {
  hsk: "HSK",
  jlpt: "JLPT",
  topik: "TOPIK",
  cefr: "CEFR",
  custom: "Custom",
};

export function scaleLabel(scale: ScaleKind): string {
  return SCALE_LABELS[scale] ?? "CEFR";
}

export type ComputedLevel = {
  scale: ScaleKind;
  current: LevelInfo;
  next: LevelInfo;
  goal: LevelInfo;
  /** vocab + 1.5 × min(hours, 1500), or the user's manual score
   *  override when one is set. */
  score: number;
  /** progress 0..1 toward `next`. */
  progress: number;
  /** progress 0..1 toward the goal. */
  goalProgress: number;
  toNext: number;
  toGoal: number;
  /** True when either the level or score on this object came from a
   *  user override rather than the auto formula. The dashboard uses
   *  this to label the card "Manual" instead of "Estimated". */
  manualOverride: boolean;
};

export type LevelOverrides = {
  manualLevelId?: string | null;
  manualScore?: number | null;
  /** Force a specific scale instead of the auto pick from the
   *  workspace's language. "custom" requires `customLevels`. */
  scale?: ScaleKind | "custom" | null;
  /** User-defined level rungs. Only consulted when scale === "custom".
   *  Sorted by minVocab ascending before use. */
  customLevels?: LevelInfo[] | null;
};

export function computeLevel(
  lang: LanguageCode,
  vocabKnown: number,
  immersionHours: number,
  goalLevelId?: string | null,
  overrides?: LevelOverrides,
): ComputedLevel {
  // Scale resolution:
  //   - explicit override (HSK / CEFR / custom) wins.
  //   - "custom" with no/empty customLevels falls back to auto so the
  //     UI never blanks out.
  //   - otherwise scaleFor(lang).
  const customLevels = overrides?.customLevels && overrides.customLevels.length > 0
    ? [...overrides.customLevels].sort((a, b) => a.minVocab - b.minVocab)
    : null;
  let scale: ScaleKind = scaleFor(lang);
  let levels: LevelInfo[] = levelsFor(lang);
  if (
    overrides?.scale === "hsk" ||
    overrides?.scale === "jlpt" ||
    overrides?.scale === "topik" ||
    overrides?.scale === "cefr"
  ) {
    scale = overrides.scale;
    levels = SCALE_TABLES[overrides.scale];
  } else if (overrides?.scale === "custom" && customLevels) {
    scale = "custom";
    levels = customLevels;
  }
  // A manual score replaces the auto formula entirely. The user's
  // intent is "the system thinks I have N words, but I actually score
  // N differently" — we don't try to mix the two, that ends up
  // confusing.
  const autoScore =
    Math.max(0, vocabKnown) + Math.min(Math.max(0, immersionHours), 1500) * 1.5;
  const score =
    overrides?.manualScore != null && Number.isFinite(overrides.manualScore)
      ? Math.max(0, overrides.manualScore)
      : autoScore;

  let current = levels[0];
  let next = levels[1] ?? levels[0];
  for (let i = 0; i < levels.length; i++) {
    if (score >= levels[i].minVocab) {
      current = levels[i];
      next = levels[i + 1] ?? levels[i];
    }
  }

  // A manual current-level override wins over the score-derived
  // bucket. We still keep `next` consistent with the override so
  // "X to next level" remains meaningful.
  if (overrides?.manualLevelId) {
    const manual = levels.find((l) => l.id === overrides.manualLevelId);
    if (manual) {
      current = manual;
      const idx = levels.findIndex((l) => l.id === manual.id);
      next = levels[idx + 1] ?? manual;
    }
  }

  const goal =
    levels.find((l) => l.id === goalLevelId) ??
    next ??
    levels[levels.length - 1];

  const range = Math.max(1, next.minVocab - current.minVocab);
  const progress =
    next === current ? 1 : Math.min(1, Math.max(0, (score - current.minVocab) / range));
  const goalRange = Math.max(1, goal.minVocab);
  const goalProgress =
    goal === current ? 1 : Math.min(1, Math.max(0, score / goalRange));
  const toNext = Math.max(0, next.minVocab - score);
  const toGoal = Math.max(0, goal.minVocab - score);
  const manualOverride =
    !!overrides?.manualLevelId ||
    (overrides?.manualScore != null && Number.isFinite(overrides.manualScore));

  return {
    scale,
    current,
    next,
    goal,
    score,
    progress,
    goalProgress,
    toNext,
    toGoal,
    manualOverride,
  };
}
