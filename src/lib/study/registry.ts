/**
 * Built-in study plugin registry.
 *
 * Adding a plugin:
 *   1. Drop a file in `src/lib/study/plugins/<your-plugin>.tsx` exporting
 *      a default `StudyPlugin`.
 *   2. Import it here and append to STUDY_PLUGINS.
 *   3. Optionally restrict via `meta.supportedLangs` so the picker hides it
 *      for irrelevant workspaces.
 *
 * Out of scope for this milestone: hot-loading user plugins from disk. The
 * type contract in `./api.ts` is already what an external plugin module would
 * import — once we add a "user plugins" folder, we can dynamically `import()`
 * each module and append it to this list at startup.
 */

import type { LanguageCode } from "../languages";
import { isPluginAvailable, type StudyPlugin } from "./api";
import hanziWriting from "./plugins/hanzi-writing";
import kaniwani from "./plugins/kaniwani";
import sentenceCards from "./plugins/sentence-cards";
import sentenceMining from "./plugins/sentence-mining";
import vocabRecall from "./plugins/vocab-recall";

// Drill mode (SRS-free practice) is no longer a standalone plugin — every
// plugin's prestart screen carries a "Drill without SRS" toggle, so the
// user can pick their preferred study UX and decide whether grades flow
// in one place. See `lib/study/prestart.tsx`.
//
// The old single-step "Spaced repetition" (anki-classic) mode was retired:
// Vocab Recall is the one spaced-repetition flow for every workspace.
export const STUDY_PLUGINS: StudyPlugin[] = [
  vocabRecall,     // universal — two-step recognition (reading → meaning); the SRS default everywhere
  sentenceCards,   // universal — AI sentence on front, translation on back
  sentenceMining,  // universal — cloze typing drill, FTS or AI sourced
  kaniwani,        // CJK only (zh, ja)
  hanziWriting,    // CJK only — drawing practice via HanziWriter
];

/** Plugins available for the active workspace target language. */
export function pluginsForLanguage(lang: LanguageCode): StudyPlugin[] {
  return STUDY_PLUGINS.filter((p) => isPluginAvailable(p, lang));
}

/** Plugins shown in the picker for a workspace — language-gated AND
 *  filtered by the per-workspace `hiddenPlugins` list. The Settings UI
 *  toggles ids in/out of that list. */
export function pluginsForWorkspace(
  lang: LanguageCode,
  hiddenPlugins: readonly string[] | Set<string>,
): StudyPlugin[] {
  const hiddenSet =
    hiddenPlugins instanceof Set ? hiddenPlugins : new Set(hiddenPlugins);
  return pluginsForLanguage(lang).filter((p) => !hiddenSet.has(p.meta.id));
}

export function pluginById(id: string): StudyPlugin | null {
  return STUDY_PLUGINS.find((p) => p.meta.id === id) ?? null;
}
