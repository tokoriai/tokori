# Contributing

Tokori is AGPL-3.0-licensed and accepts external contributions. This page
is the developer-facing companion to the project's
[CONTRIBUTING.md](https://github.com/tokoriai/tokori/blob/main/CONTRIBUTING.md);
it covers the conceptual side of working in the codebase. Read the
root file for the mechanics (clone, build, PR checklist).

## Where to start

If you don't have a change in mind yet, good entry points:

- Issues tagged [`good first issue`](https://github.com/tokoriai/tokori/labels/good%20first%20issue)
  on GitHub — small, contained, well-defined.
- Adding a language that isn't bundled yet — the registries make this
  a one-file change. See [Workspaces & languages](/guides/workspaces).
- Writing a study plugin — see the [Plugin SDK](/guides/plugins).
- Documentation. Always.

## How the code is organised

A short orientation; the full tour is in
[Architecture](/guides/architecture).

```
src/
  components/           UI (React 19 + shadcn/ui + Tailwind 4)
    views/              Top-level tab views
    settings/           Settings tabs
    ui/                 shadcn primitives (auto-generated)
    dashboard/          Dashboard panels
    study/              Flashcard / SRS surfaces
  lib/                  Everything that isn't a component
    dictionaries/       Registry + per-format parsers + lemmatizer
    study/plugins/      Built-in study plugins (Vocab Recall, Sentence Mining, …)
    addons/             Stage-1 addon loader (manifest validation)
    db.ts               SQLite + cloud REST bridge (HOSTED-gated)
    cloud-client.ts     Cloud REST client (HOSTED only)
    fsrs.ts             FSRS-5 implementation
    provider-context.tsx Active LLM provider + streaming
  index.css             Tailwind + theme tokens
src-tauri/
  src/commands.rs       Tauri IPC handlers (chat, dict, OCR, addons, …)
  src/api_server.rs     Local HTTP API on 127.0.0.1:53210
  src/providers.rs      LLM streaming pipeline (Ollama / OpenAI / …)
  src/lib.rs            Entry, migrations, plugin registration
mcp-server/             MCP companion (Node, agent-facing)
test/                   Vitest suite (not co-located)
docs/                   This site
```

## Coding conventions

- **No `any`.** Reach for discriminated unions or `unknown` + a type
  guard.
- **`import type` for type-only imports.** `verbatimModuleSyntax: true`
  is on, so the build fails otherwise.
- **Path alias `@/*` → `src/*`.** Use it; relative `../../..` paths get
  unreadable fast.
- **Comments explain *why*, not *what*.** A well-named function with
  a 3-line implementation doesn't need a docstring; a 30-line function
  with a non-obvious invariant does.
- **No new dependencies without justification.** Tokori already has
  most of what you'll need; if you reach for a package, say in the PR
  description what it gives us that the existing ones don't.
- **`HOSTED` is a build-time constant.** Cloud-only code paths live
  inside `if (HOSTED) { … }` so terser dead-strips them out of the
  desktop bundle. Don't route desktop calls through the cloud "for
  consistency" — desktop stays local-first.

## Adding a new language

The dictionary + language registries are flat data — adding a language
is a one-file-each change.

1. Add an entry to `LANGUAGE_PROFILES` in
   `src/lib/language-profiles.ts` (ISO code, names, glyph, locale,
   tokenizer choice, TTS sample).
2. If the language ships a packaged dictionary, add an entry to
   `DICTIONARY_PACKS` in `src/lib/dictionaries/registry.ts` and point
   `recommendedDict` at its `id`.
3. If the dict needs a new wire format, add the format string to
   `DictFormat`, add a `match` arm in
   `src-tauri/src/commands.rs::dict_fetch_lang`, and write the
   `parse_<format>` function next to the existing parsers.

The workspace picker, settings, click-to-define popover, dashboard
greeting, and TTS pick up the new language automatically.

## Adding a study plugin

Plugins live under `src/lib/study/plugins/`. The contract is in
[Plugin SDK](/guides/plugins). Short version: export a `StudyPlugin`
with a `StudyView` React component, register it in
`src/lib/study/registry.ts`. The host hands you `ctx` for all data
access — never reach into `db.ts` directly.

The same contract is the user-installable
[addon](/guides/addons) contract.

## Tests

Vitest suite at `test/`. Not co-located — see `vitest.config.ts` for
why. The bar:

- Reducers, hooks, parsers, ranking functions → tests required.
- UI components with trivial wiring → tests optional.
- Anything you'd be sad to break silently → tests required.

Run `npm test` before opening a PR. CI runs the same set on every
push.

## What we look for in a PR

- One focused change per PR.
- Surrounding style preserved; no drive-by reformats.
- New non-trivial logic comes with tests.
- No dead code, no `console.log`, no commented-out blocks.
- User-facing changes come with a doc update.

## Reporting bugs and security issues

Bugs and feature requests go on
[GitHub issues](https://github.com/tokoriai/tokori/issues). Use the
templates — empty issues are hard to triage.

Security issues do **not** go on public issues. See
[SECURITY.md](https://github.com/tokoriai/tokori/blob/main/SECURITY.md).
