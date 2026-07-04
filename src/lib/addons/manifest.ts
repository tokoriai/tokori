/**
 * Addon manifest schema and validator.
 *
 * An addon is a folder under the app's data directory containing one
 * `manifest.json` plus its source files. The manifest is the only
 * thing Tokori reads at discovery time — the entry point isn't loaded
 * until the user explicitly enables the addon. That separation keeps
 * untrusted code dormant on disk until the user opts in.
 *
 * Stable id contract: `manifest.id` is what we persist in user
 * settings ("addon.<id>.enabled") and what registries key on. Author
 * rebrandings are allowed; id changes break installs.
 *
 * Adding a new addon kind: extend `AddonKind`, add the matching
 * contract import in the registry loader, and update the validator
 * below.
 */

/** Public types — what an addon author imports. */
export type AddonKind =
  | "study"
  | "translate"
  | "vocab-import"
  | "card-enrichment";

export type AddonManifest = {
  /** Stable kebab-case id. Persisted as the install key. */
  id: string;
  /** Display name shown in Settings → Addons. */
  name: string;
  /** Semver. Used for "addon out of date for current Tokori" hints. */
  version: string;
  /** One-line pitch shown under the name. */
  description: string;
  /** What kind of registry the addon plugs into. */
  kind: AddonKind;
  /** Path (relative to the addon folder) of the JS entry point. */
  entry: string;
  /** Author byline. Free-form. */
  author?: string;
  /** Homepage / repo URL — surfaced as a "More info" link. */
  homepage?: string;
  /** SPDX license string, e.g. "MIT", "Apache-2.0". */
  license?: string;
  /** Minimum Tokori version this addon was tested against. We don't
   *  block load on a mismatch; we just warn in the UI. */
  minAppVersion?: string;
};

export type ManifestParseResult =
  | { ok: true; manifest: AddonManifest }
  | { ok: false; error: string };

/** ID rule: lowercase, kebab-cased, ascii — same shape we use for
 *  built-in plugin ids so the union is well-formed. */
const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const ALLOWED_KINDS: ReadonlySet<AddonKind> = new Set([
  "study",
  "translate",
  "vocab-import",
  "card-enrichment",
]);

/** Parse + validate raw JSON text. Returns a discriminated result so
 *  callers can surface the failure reason in the Addons UI instead of
 *  silently dropping the entry. */
export function parseManifest(text: string): ManifestParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Manifest must be a JSON object." };
  }
  const m = raw as Record<string, unknown>;

  const id = m.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    return {
      ok: false,
      error: "`id` must be a kebab-case string (e.g. \"hsk-spaced-quiz\").",
    };
  }

  const name = m.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, error: "`name` must be a non-empty string." };
  }

  const version = m.version;
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    return { ok: false, error: "`version` must follow semver (e.g. \"1.0.0\")." };
  }

  const description = m.description;
  if (typeof description !== "string") {
    return { ok: false, error: "`description` must be a string." };
  }

  const kind = m.kind;
  if (typeof kind !== "string" || !ALLOWED_KINDS.has(kind as AddonKind)) {
    return {
      ok: false,
      error: `\`kind\` must be one of: ${[...ALLOWED_KINDS].join(", ")}.`,
    };
  }

  const entry = m.entry;
  if (typeof entry !== "string" || entry.length === 0) {
    return { ok: false, error: "`entry` must be a non-empty path string." };
  }
  // Entry stays inside the addon directory — no traversal, no
  // absolute paths. We don't enforce extension since both .js and
  // .mjs are valid.
  if (entry.includes("..") || entry.startsWith("/") || entry.startsWith("\\")) {
    return { ok: false, error: "`entry` must be a relative path inside the addon folder." };
  }

  const optionalString = (key: string): string | undefined => {
    const v = m[key];
    return typeof v === "string" ? v : undefined;
  };

  return {
    ok: true,
    manifest: {
      id,
      name: name.trim(),
      version,
      description: description.trim(),
      kind: kind as AddonKind,
      entry,
      author: optionalString("author"),
      homepage: optionalString("homepage"),
      license: optionalString("license"),
      minAppVersion: optionalString("minAppVersion"),
    },
  };
}
