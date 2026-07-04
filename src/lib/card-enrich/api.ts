/**
 * Card-enrichment pipeline contract.
 *
 * The card composer dialog (`src/components/card-composer-dialog.tsx`)
 * walks the user from `word` → fully-built flashcard by running a list
 * of `CardEnricher`s against an in-progress `CardDraft`. Each enricher
 * is a small, focused unit — "look up the dictionary", "generate an AI
 * cloze sentence", "synthesize TTS" — and returns a `CardPatch` the
 * composer merges into the draft.
 *
 * The contract is deliberately small so:
 *   - Built-in enrichers live as flat in-tree modules registered in
 *     `src/lib/card-enrich/registry.ts` (same shape as `STUDY_PLUGINS`).
 *   - Future addons (manifest `kind: "card-enrichment"`) implement
 *     this single interface and slot in without composer changes.
 *   - The Chrome extension's mining payload (after the API is extended
 *     to accept its mining fields) maps cleanly onto a `CardDraft` so
 *     the same enrichers can run server-side or extension-side later.
 *
 * Design rules an enricher MUST follow:
 *   - User input always wins. An enricher receives the current draft —
 *     if a field is already non-empty, do not overwrite it unless the
 *     user explicitly asked for a "regenerate" (the composer signals
 *     that intent with `force: true` in the future; for now, just skip
 *     non-empty fields).
 *   - Return only the fields you changed. Untouched fields stay
 *     undefined in the patch — the composer treats `undefined` as
 *     "no change", `null` as "explicitly clear".
 *   - Be resilient to context gaps. `ctx.sendChat` may be missing
 *     (no active provider); `ctx.synthesize` may throw (TTS unconfigured).
 *     Catch, log, and return an empty patch — never throw out of `run`.
 */

import type { ComponentType } from "react";
import type { ChatStreamArgs } from "../chat-providers";
import type { LanguageCode } from "../language-profiles";
import type { DictEntry, VocabEntry, VocabKind } from "../db";

/** The in-progress flashcard the composer is building or editing. The
 *  text + media fields mirror what the on-disk schema already stores
 *  (see `VocabEntry` in `src/lib/db.ts:191`). */
export type CardDraft = {
  workspaceId: number;
  targetLang: LanguageCode;
  nativeLang: LanguageCode;
  /** What the card is *about*. Required before any enricher runs. */
  word: string;
  kind: VocabKind;
  reading: string | null;
  gloss: string | null;
  /** Cloze sentence with `{{c1::word}}` markers. */
  frontExtra: string | null;
  cardNotes: string | null;
  /** Natural / native translation — kept distinct from `gloss`
   *  (Definition). A card can carry both. */
  translation: string | null;
  imageData: string | null; // data URL
  audioBytes: Uint8Array | null;
  audioMime: string | null;
};

/** A diff to merge into the draft. Undefined means "untouched"; null
 *  means "explicitly clear" (rarely used — most enrichers only set
 *  fields, never clear). */
export type CardPatch = Partial<
  Omit<CardDraft, "workspaceId" | "targetLang" | "nativeLang" | "word" | "kind">
>;

/** Capabilities an enricher can call. Wired up by the composer from
 *  the live React tree (`useProviderConfigs`, `useTTS`, `useWorkspace`).
 *  Passing everything through a single capability object means the
 *  enrichers stay framework-agnostic (no `useX` hooks inside an
 *  enricher) and are easy to unit-test by handing in stubs. */
export type EnricherContext = {
  /** Stream a chat against the active provider. Resolves with the full
   *  assembled reply text. Matches `ChatStreamArgs` from
   *  `src/lib/chat-providers.ts:52`. May be `null` when no provider is
   *  configured — enrichers that need it should return an empty patch
   *  and surface a toast via the composer instead of throwing. */
  sendChat: ((args: ChatStreamArgs) => Promise<string>) | null;

  /** Synthesize TTS audio bytes for a string. Returns ready-to-store
   *  bytes + MIME. Implementations dispatch through
   *  `src/lib/tts.ts:synthesizeBytes`. */
  synthesize: ((text: string, lang: LanguageCode) => Promise<{ bytes: Uint8Array; mime: string }>) | null;

  /** Look up an installed dictionary for the workspace language.
   *  Wraps `lookupDict` in `src/lib/db.ts:3462` — handles the same
   *  three-stage fallback (exact / case-insensitive / lemmatizer). */
  lookupDict: (lang: LanguageCode, word: string) => Promise<DictEntry | null>;

  /** Lazy snapshot of the user's known vocab. Used by `ai-cloze` to
   *  constrain the generated sentence to words the user has already
   *  seen. Returns a possibly-stale list — fine for prompt context. */
  knownVocab: () => Promise<VocabEntry[]>;

  /** Resolve a translate config the user has set up (Google free,
   *  DeepL, an AI-via-LLM engine, …). Some enrichers prefer translate
   *  over LLM for short, deterministic lookups. */
  translateFallback?: (
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    text: string,
  ) => Promise<string | null>;
};

/** Static metadata about an enricher. Drives composer UI: button
 *  label, icon, whether it auto-runs, which language families it
 *  applies to, and which draft fields it writes (so the composer can
 *  show a "✓ filled" indicator next to the form field). */
export type CardEnricherMeta = {
  /** Stable identifier. Used as a React key and as the addon-manifest
   *  reference for users who configure the order. */
  id: string;
  name: string;
  description: string;
  /** Optional lucide-react icon. Composer falls back to a generic
   *  sparkle if absent. */
  icon?: ComponentType<{ className?: string }>;
  /** Which draft fields this enricher writes. Drives the per-field
   *  "✓ filled by <enricher>" badge. */
  targets: ReadonlyArray<keyof CardPatch>;
  /** `auto` runs on word-set (debounced); `manual` requires a button
   *  click. Auto is best for cheap, deterministic enrichers
   *  (`dict-autoload`); manual for anything that costs money or takes
   *  more than ~500 ms (`ai-cloze`, `tts-audio`). */
  trigger: "auto" | "manual";
  /** Limit to specific target languages. Omitted or `"*"` means any. */
  languages?: ReadonlyArray<LanguageCode> | "*";
  /** Higher runs first when `Apply all` sweeps remaining enrichers.
   *  Defaults to 0. */
  priority?: number;
};

/** The single thing an enricher exports. The composer iterates over
 *  `CARD_ENRICHERS` and dispatches by `meta.trigger`. */
export type CardEnricher = {
  meta: CardEnricherMeta;
  run: (draft: CardDraft, ctx: EnricherContext) => Promise<CardPatch>;
};

/** Apply a patch to a draft, returning a new draft. `undefined`
 *  values in the patch leave the corresponding draft field
 *  unchanged; explicit `null` clears it. Exported so the composer
 *  and the enricher tests use the exact same merge semantics. */
export function applyPatch(draft: CardDraft, patch: CardPatch): CardDraft {
  const next: CardDraft = { ...draft };
  (Object.keys(patch) as Array<keyof CardPatch>).forEach((key) => {
    const value = patch[key];
    if (value !== undefined) {
      // Each field has its own type; cast through unknown so we don't
      // need a discriminated assignment per field. The patch type
      // already constrains the value shape per key.
      (next as Record<string, unknown>)[key] = value;
    }
  });
  return next;
}

/** Filter the enricher list to those that apply to a given language.
 *  Used by the composer to render the "Enrichment" column. */
export function enrichersForLanguage<E extends { meta: CardEnricherMeta }>(
  enrichers: ReadonlyArray<E>,
  lang: LanguageCode,
): E[] {
  return enrichers.filter((e) => {
    if (!e.meta.languages || e.meta.languages === "*") return true;
    return e.meta.languages.includes(lang);
  });
}
