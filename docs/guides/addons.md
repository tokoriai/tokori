# Addons

Tokori supports addons in the same shape Anki does: drop a folder into your `addons/` directory, restart, and your custom study mode (or translate engine, or vocab importer) shows up alongside the built-ins.

> **Status: preview.** Discovery, manifest validation, and the enable/disable UI are live in the current build. Actually executing an addon's JS in a sandbox is gated on a future release. Enabling an addon today persists your choice so it activates the moment Stage 2 ships — no migration needed.

## Where addons live

| OS | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/ai.tokori.desktop/addons/` |
| Linux | `~/.local/share/ai.tokori.desktop/addons/` |
| Windows | `%APPDATA%\ai.tokori.desktop\addons\` |

Easiest way to open it: **Settings → Addons → Open addons folder**.

Each addon is one subfolder. The folder name is yours to choose — the canonical identifier is the `id` field inside `manifest.json`.

## Manifest

Every addon needs a `manifest.json` at the folder root:

```json
{
  "id": "hsk-cloze-quiz",
  "name": "HSK cloze quiz",
  "version": "1.0.0",
  "description": "Cloze-style review for HSK vocab.",
  "kind": "study",
  "entry": "index.js",
  "author": "you@example.com",
  "homepage": "https://github.com/you/hsk-cloze-quiz",
  "license": "MIT",
  "minAppVersion": "0.1.0"
}
```

### Required fields

| Field | Rule |
| --- | --- |
| `id` | Lowercase kebab-case, 3-64 chars, starts with a letter. **This is the stable identifier** — persisted in user settings, used as the registry key. Don't rename it once published. |
| `name` | Display name shown in pickers. |
| `version` | Semver (e.g. `1.0.0`, `2.1.3-beta.1`). |
| `description` | One-line pitch. |
| `kind` | One of `study`, `translate`, `vocab-import`, `card-enrichment`. Picks which built-in registry the addon plugs into. |
| `entry` | Relative path to the JS entry point inside the folder (e.g. `index.js`, `dist/main.js`). Must stay inside the addon folder — no `..`, no absolute paths. |

### Optional fields

| Field | Rule |
| --- | --- |
| `author` | Free-form. |
| `homepage` | URL — surfaced as a "More info" link. |
| `license` | SPDX-style string (`MIT`, `Apache-2.0`, …). |
| `minAppVersion` | Tokori semver this addon was tested against. Mismatches show a warning but don't block load. |

## Authoring an addon

The contract you implement depends on `kind`:

- **`kind: "study"`** → default-export a `StudyPlugin` from your entry point. See [Plugin SDK](./plugins.md) for the full shape and a worked example.
- **`kind: "translate"`** → default-export a `TranslateEngine` (`src/lib/translate/api.ts`).
- **`kind: "vocab-import"`** → default-export a `VocabImportPlugin` (`src/lib/vocab-import/api.ts`).

In other words, an addon is *exactly* the same code as an in-tree plugin — there's no separate addon API to learn. The only differences are (a) where the file lives and (b) the manifest.

Minimal study addon, expanded:

```text
addons/
└── hsk-cloze-quiz/
    ├── manifest.json
    └── index.js          ← bundled, ESM, default-exports a StudyPlugin
```

`index.js` should be pre-bundled — Tokori doesn't run a TypeScript / JSX compiler on addon load. Use the same toolchain you'd use for an npm package: tsc or esbuild, target ES2022, output ESM, externalise `react` / `@tokori/*`. (A `vocab-import` parser needs no build step — plain ESM `.js` is fine.)

## Build an addon with an AI agent

You don't have to hand-write the manifest and entry point. Tokori ships a reusable **agent skill** that knows the manifest schema and every plugin contract, and scaffolds a *validated* addon straight into your addons folder. It works with any coding agent that can read a `SKILL.md` (Codex, Cursor, …) — and you only need the installed app, not Tokori's source.

The skill lives in the repo at [`addon-skill/`](https://github.com/tokoriai/tokori/tree/main/addon-skill).

### Install it into your coding agent

```sh
# from a clone of the Tokori repo
cp -r addon-skill <your-agent-skills-dir>/tokori-addon
```

(or copy `SKILL.md`, `reference.md`, and `templates/` into that folder by hand). Your agent auto-discovers it on the next session. Then describe what you want:

> Use the tokori-addon skill to build an addon that imports my Pleco flashcard export.

It locates your addons folder, picks the right `kind`, scaffolds `manifest.json` + `entry.js`, validates them, and tells you to reopen **Settings → Addons**.

### Use it with Codex or another agent

`SKILL.md` is a self-contained instruction file — point your agent at `addon-skill/SKILL.md` (or paste its contents as an instruction prompt), then describe the addon. `reference.md` in the same folder has the full contract for all four kinds.

## Testing your addon

Two layers, because addon **execution** is still gated (Stage 2):

**1. Does Tokori accept it?** *(works today)* — Open **Settings → Addons** (hit **Rescan** if needed). A valid addon appears with its name + description and an enable toggle. An invalid manifest shows the exact reason instead — that's your validation feedback loop.

**2. Does the logic do what you think?** *(works today, for pure kinds)* — A `vocab-import` parser is a pure function, so you can run it with plain Node — no app, no Stage 2 required. The example addon ships a one-file harness:

```sh
cd ~/.local/share/ai.tokori.desktop/addons/markdown-vocab-list   # (macOS/Windows paths above)
node test.mjs
```

That imports `entry.js`, runs `parse()` over `sample.md`, prints the rows, and exits non-zero if any row is missing a `word`. Copy `test.mjs` + `sample.md` into your own addon and point them at your input. For `translate` / `card-enrichment` addons, call the exported `translate()` / `run()` the same way (stub the request / `ctx` object).

**3. End-to-end inside the app** arrives with Stage 2 — at that point an enabled `vocab-import` addon shows up as a source in the vocab import dialog, and you test by importing a real file.

## What addons can and can't do

Stage-1 contract (what we'll commit to forwards):

- **Can:** register a study mode, translate engine, or vocab importer; persist per-addon settings via the standard `usePluginSetting` helper; read the user's vocab snapshot through the `ctx` capability object.
- **Can't:** make arbitrary network calls (use the provided `callAi` shim instead); read other addons' state; reach into `db.ts` directly; install Rust commands; modify other plugins' behaviour.

The capability surface is the same `ctx` that in-tree plugins receive — see [Plugin SDK](./plugins.md). That's the only allowed coupling to the host app, and the only API stability promise we make for addon authors.

## Removing an addon

Delete the folder. Tokori re-scans on next launch or when you press **Rescan** in Settings → Addons. The per-addon `enabled` flag is left behind in user settings (cheap) so reinstalling the same id restores your prior toggle.

## Security model

Addons are local-only — Tokori has no online catalogue, no auto-update, no script that pulls JS from a third party. You install an addon by deliberately copying a folder. That's intentional: the trust boundary is the user putting files on their own disk, the same boundary every desktop app uses.

When Stage 2 lands, the addon entry point will execute inside a sandbox (Web Worker + `Blob` URL, or an isolated iframe) so it can't reach the DOM, the filesystem, or the network outside of the capability surface in `ctx`. Today, with execution off, an addon's code never runs at all.

## How discovery works internally

For contributors curious about the plumbing:

- `src-tauri/src/commands.rs::list_addons` enumerates `<app-data>/addons/*/manifest.json` and ships each `manifest.json` text back to the frontend (no Rust-side validation — the rule lives in one place).
- `src/lib/addons/manifest.ts` parses + validates each manifest.
- `src/lib/addons/registry.ts` caches the result, exposes `useAddons()`, and persists `enabled` flags via `db.getSetting/setSetting`.
- `src/components/settings/addons-section.tsx` is the UI.

Stage 2 will add a loader that pulls each enabled addon's `entry` JS through a sandbox and merges the exported plugin into the matching built-in registry (`STUDY_PLUGINS`, `TRANSLATE_ENGINES`, …). At that point the public surface — the manifest, the per-kind plugin contracts — won't change.
