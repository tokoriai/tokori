/**
 * Pure normalisers for data crossing the addon sandbox boundary.
 *
 * Addon code is untrusted, so everything it returns is treated as
 * unknown-shaped until coerced here: importer metadata and parsed rows
 * both pass through these functions before the host uses them. Kept
 * dependency-free (no Worker, no React) so they're unit-testable and so
 * importing them never spins up a worker.
 */

import type { LanguageCode } from "../languages";
import type { ImportRow, VocabImporterMeta } from "../vocab-import/api";

function trimmedOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

/**
 * Coerce an addon's declared importer metadata into a valid
 * `VocabImporterMeta`, falling back to the manifest for missing/invalid
 * fields. `id` defaults to the manifest id (the canonical install key),
 * and file extensions are normalised to drop any leading dot.
 */
export function sanitizeImporterMeta(
  raw: unknown,
  manifest: { id: string; name: string; description: string },
): VocabImporterMeta {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof m.id === "string" && m.id.trim() ? m.id.trim() : manifest.id,
    name:
      typeof m.name === "string" && m.name.trim() ? m.name.trim() : manifest.name,
    description:
      typeof m.description === "string" ? m.description : manifest.description,
    fileExt: (stringArray(m.fileExt) ?? []).map((e) => e.replace(/^\.+/, "")),
    supportedLangs: stringArray(m.supportedLangs) as LanguageCode[] | undefined,
    excludedLangs: stringArray(m.excludedLangs) as LanguageCode[] | undefined,
  };
}

/**
 * Coerce whatever an addon's `parse` returned into clean `ImportRow[]`.
 * Drops non-objects and rows without a non-empty `word`; nulls out blank
 * optional fields. Defensive against a buggy or hostile addon.
 */
export function normalizeRows(raw: unknown): ImportRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const word = typeof o.word === "string" ? o.word.trim() : "";
    if (!word) continue;
    const source =
      typeof o.source === "string" && o.source.trim() ? o.source.trim() : undefined;
    out.push({
      word,
      altWord: trimmedOrNull(o.altWord),
      reading: trimmedOrNull(o.reading),
      gloss: trimmedOrNull(o.gloss),
      ...(source ? { source } : {}),
    });
  }
  return out;
}
