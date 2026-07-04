/**
 * Built-in "first free pack" — bundled in the desktop binary so a
 * fresh install can seed a workspace offline with no network call.
 *
 * Only ONE pack lives here on purpose: the Chinese HSK 1 starter.
 * Everything else (other languages' starter packs, paid packs,
 * Pro-included packs) is served from the cloud catalog
 * (`/api/v1/store/packs`) and surfaced in the Browse tab of
 * PackImportDialog. Keeping a single offline-installable starter
 * means the binary stays small AND there's exactly one source of
 * truth for non-bundled packs (the server) — no client-side drift.
 *
 * The pack id starts with `free:` so the import path can branch on
 * "this is the bundled pack" vs "this came from the cloud store".
 */

import type { Pack } from "./pack-import";

export type FreePackEntry = {
  /** Stable id matching the pack JSON's `id` field. */
  id: string;
  title: string;
  /** Short marketing line shown under the title. */
  pitch: string;
  /** ISO-639-1 — used to gate by the active workspace's target language. */
  language: string;
  /** Tiny stat preview shown on the catalogue card. */
  preview: { vocabCount: number; chapterCount?: number };
  /** Lazy loader so a user who never opens the catalogue doesn't pay
   *  the JSON parse cost. */
  load: () => Promise<Pack>;
};

export const FREE_PACKS: FreePackEntry[] = [
  {
    id: "free:chinese-hsk1-new3",
    title: "HSK 1 (new HSK 3.0)",
    pitch:
      "All 506 vocabulary items at the new HSK 1 level (HSK 3.0), verified against the canonical word list, plus a 15-lesson beginner Chinese course. Free for everyone.",
    language: "zh",
    preview: { vocabCount: 506, chapterCount: 15 },
    load: async () => {
      // Vite will inline the JSON import at build time. The default
      // export is the parsed JSON object; we cast to Pack since we
      // know the schema matches.
      const mod = await import(
        "../../packs/chinese-hsk1-new3-free.json"
      );
      return (mod as { default: Pack }).default;
    },
  },
];

export function freePacksForLanguage(lang: string): FreePackEntry[] {
  return FREE_PACKS.filter((p) => p.language === lang);
}
