# Design patterns in Tokori

A short tour of the patterns the codebase reaches for. Pointers to canonical files so new contributors can copy the shape rather than invent one.

## 1. Registry pattern

A flat, declarative array that catalogues every concrete instance of an extensible concept. The UI consumes the registry — never inlines the data.

| Concept | Registry | Lookup helpers |
| --- | --- | --- |
| Languages | `src/lib/language-profiles.ts` → `LANGUAGE_PROFILES` | `profileFor(code)` |
| Dictionary packs | `src/lib/dictionaries/registry.ts` → `DICTIONARY_PACKS` | `packsForLanguage`, `packById` |
| Level scales | `src/lib/level.ts` → `SCALE_TABLES` | `scaleFor`, `levelsFor`, `levelsForScale` |
| Study plugins | `src/lib/study/registry.ts` → `STUDY_PLUGINS` | `pluginsForLanguage`, `pluginById` |
| Translate engines | `src/lib/translate/registry.ts` → `TRANSLATE_ENGINES` | `engineByKind` |
| Vocab importers | `src/lib/vocab-import/registry.ts` | `importerById` |
| Free vocab packs | `src/lib/free-packs.ts` → `FREE_PACKS` | `packsForLanguage` |
| Lemmatizers | `src/lib/dictionaries/lemmatizer.ts` → `LEMMATIZERS` | `lemmaCandidates` |

**Why:** adding a new instance is one diff in one file. No discovery, no DI, no plugin manager. The TypeScript compiler enforces the contract.

## 2. Strategy pattern

Each registry entry conforms to a uniform contract — the host calls a uniform method without caring which concrete strategy is behind it.

- **`StudyPlugin`** (`src/lib/study/api.ts`) — every flashcard mode (Anki classic, Vocab Recall, Sentence Mining, …) implements `{ meta, StudyView, Settings? }`.
- **`TranslateEngine`** (`src/lib/translate/api.ts`) — every provider (Google free, DeepL, AI-passthrough) implements `{ meta, translate() }`.
- **`VocabImportPlugin`** (`src/lib/vocab-import/api.ts`) — every importer (Anki, CSV, Pleco, …) implements the same parse/import shape.
- **`Lemmatizer`** (`src/lib/dictionaries/lemmatizer.ts`) — per-language rule function `(word) => string[]`.

**Why:** the analyzer / picker / installer doesn't grow a giant `switch (kind)` block. Adding a strategy = drop a file + register; the host learns nothing new.

## 3. Capability injection (the `ctx` object)

Plugins receive a curated context object instead of reaching into module globals. The host owns DB / IPC / TTS; the plugin sees a stable surface.

- `StudyContext` (`src/lib/study/api.ts`) — `ctx.workspace`, `ctx.vocab`, `ctx.dueVocab`, `ctx.reviewVocab`, `ctx.speak`, `ctx.onSessionEnd`, …
- Translate engines get a similar shape — `config`, `callAi` shim, `getProvider` resolver — so the engine never calls `db.ts` directly.

**Why:** the host can swap implementations under the plugin (e.g. local SQLite vs cloud REST) without the plugin noticing. Same shape, two storage backends.

## 4. Façade

`src/lib/db.ts` is a single namespace fronting two completely different storage backends:

- Desktop → `tauri-plugin-sql` against on-disk SQLite.
- HOSTED → cloud HTTP via `src/lib/cloud-client.ts`.

Callers write `await listVocab(workspaceId)` and don't think about which backend ran. The `if (HOSTED) {…}` branch lives once, inside the façade.

**Why:** the rest of the app (200+ call sites) doesn't have to know whether it's local or hosted. The build-time `HOSTED` flag lets terser dead-strip the cloud branch out of the desktop bundle and vice versa.

## 5. Observable cache / pub-sub

A module-level cache + invalidation + listener set, so any subscriber re-resolves after a mutation without manual wiring.

Canonical example: `src/lib/dict-availability.ts` — one in-flight `Promise<Set<string>>`, `invalidateDictionaryAvailabilityCache()` to bust + notify, `useHasDictionary(lang)` as the React subscriber.

Same pattern in `provider-context`, `workspace-context`, `cloud-context`.

**Why:** one source of truth, many subscribers, no prop-drilling. A successful install elsewhere in the app flips every popover from "no dict" to "set up" without a reload.

## 6. Pipeline / cascading fallback

A composed sequence where each stage only runs if the previous missed.

- **`lookupDict`** (`src/lib/db.ts`) — exact → case-insensitive → lemmatizer.
- **CC-CEDICT fetch** (`src-tauri/src/commands.rs`) — mirror chain, first to respond wins.
- **Translate label resolution** (`src/components/sentence-analyzer-modal.tsx`) — user default → first config → `FALLBACK_ENGINE`.

**Why:** each stage is small and testable, the cheap path stays cheap, and adding a new fallback is appending one step.

## 7. Tri-state for not-yet-known booleans

Async signals return `T | null` where `null` means "still loading" — the UI uses it to suppress flashing.

Example: `useHasDictionary(lang): boolean | null`. The popover renders the "install" hint only when `has === false`, not on every initial render.

**Why:** Tokori's engineering bar calls this out — boolean flags returned from async hooks should include a `null` 'not-yet-known' tri-state. Loading states must not flash.

## 8. Build-time feature flags

`HOSTED` from `src/lib/build-flags.ts` is a constant — `import.meta.env.VITE_HOSTED_MODE === "true"`. Used inside `if (HOSTED) {…}` blocks that terser dead-strips out of the *other* build.

**Why:** one source tree, two binaries, no runtime config check. Verified by post-build `grep cloud-client dist/assets/index-*.js` returning zero hits on the desktop bundle.

## 9. Stable-id contract for persistence

Anything that lands in user data references a stable, kebab-case id that survives display-name changes. Display labels are derived from the id at render time.

- Pack id `cc-cedict`, not display name "CC-CEDICT".
- Plugin id `vocab-recall`, not "Vocab Recall".
- Scale id `jlpt`, not "JLPT".

**Why:** rebrandings happen. The DB shouldn't care.

## When to reach for which

- New extensible concept → registry + strategy.
- Two backends, one consumer → façade.
- Cross-cutting "is X true right now?" → observable cache + tri-state hook.
- "Try this, then this, then this" lookup → pipeline.

If you can't find the matching pattern, ask in the issue — adding a *seventh* shape is usually worse than reusing one of these.
