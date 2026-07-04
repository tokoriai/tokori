# Contributing to Tokori

Thanks for wanting to help. This document covers the practical bits:
how to get the app running locally, what we expect in a PR, and where
to ask questions.

## Ground rules

- By contributing, you agree to release your work under the project's
  [AGPL-3.0-or-later license](./LICENSE).
- Interactions on issues, PRs, and any community channel are governed
  by the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Security issues do **not** go in public issues — see
  [SECURITY.md](./SECURITY.md).

## Setting up a dev environment

You need:

- Node 20 or newer
- Rust stable (1.85+) with `cargo fmt` and `cargo clippy`
- Tauri's platform dependencies — <https://tauri.app/start/prerequisites/>

```sh
git clone https://github.com/tokoriai/tokori.git
cd tokori
npm install
```

Two dev modes:

```sh
npm run tauri dev   # full desktop app (slow first compile, ~500 crates)
npm run dev         # browser-only UI on http://localhost:5173
```

`npm run dev` is the right call for most UI work — fast HMR, no Rust
recompile. Reach for `tauri dev` when you're changing IPC, providers,
or anything that talks to SQLite or the local HTTP API.

## Project layout

A short orientation; the [architecture guide](./docs/guides/architecture.md)
has the full tour.

```
src/                    React 19 + TypeScript frontend
  components/           UI (shadcn/ui + Tailwind 4)
  lib/                  State, providers, dict, FSRS, sync
src-tauri/              Rust shell (Tauri 2)
  src/commands.rs       Tauri IPC handlers
  src/api_server.rs     Local HTTP API
  src/providers.rs      LLM streaming pipeline
mcp-server/             MCP companion (Node, agent-facing)
docs/                   VitePress site
test/                   Vitest suite (not co-located — see vitest.config.ts)
```

## Before you open a PR

Run the checks locally:

```sh
npm test                                    # Vitest unit tests
npm run build                               # tsc -b && vite build
npm run lint
( cd src-tauri && cargo fmt --all -- --check )
( cd src-tauri && cargo clippy --all-targets -- -D warnings )
```

CI runs the same set on every push.

If you added non-trivial pure logic (a parser, a sort/filter helper, a
reducer, a ranking function), add a test under `test/`. UI components
don't need tests for trivial wiring, but reducers, hooks, and parsers
do.

## What we look for in a PR

- **One focused change per PR.** A feature, a bug fix, a refactor —
  not all three.
- **Match the surrounding style.** No new linters or formatters; no
  reformatting unrelated code.
- **No `any`.** Prefer discriminated unions over escape hatches.
- **No dead code.** Remove unused imports, commented-out blocks, and
  debug logs before requesting review.
- **Comments explain *why*, not *what*.** Well-named identifiers do
  the *what*.
- **No new dependencies without a reason.** If you reach for a new
  package, say in the PR description what it gives us that the
  existing ones don't.

## Adding a new language

The dictionary + language registries are the single source of truth.
The [architecture guide](./docs/guides/architecture.md) has the full
recipe; the short version:

1. Add an entry to `LANGUAGE_PROFILES` in `src/lib/language-profiles.ts`.
2. If the language ships a packaged dictionary, add an entry to
   `DICTIONARY_PACKS` in `src/lib/dictionaries/registry.ts` and point
   `recommendedDict` at its `id`.
3. If the dict needs a new wire format, add the format string to
   `DictFormat`, add a `match` arm in
   `src-tauri/src/commands.rs::dict_fetch_lang`, and write the
   `parse_<format>` function next to the existing parsers.

The workspace picker, settings, click-to-define popover, dashboard
greeting, and TTS pick up the new language automatically.

## Adding a study plugin or addon

Study plugins live under `src/lib/study/plugins/`. The contract is
documented in [docs/guides/plugins.md](./docs/guides/plugins.md).

Addons are the user-installable equivalent, documented in
[docs/guides/addons.md](./docs/guides/addons.md). The manifest schema
is frozen; the in-tree plugin contracts are the addon contracts.

## Commit messages

Short, imperative subject line. Body optional but appreciated for
non-trivial changes — explain the *why*, link issues, mention any
gotchas a reviewer should know about.

## Questions

Open a [discussion](https://github.com/tokoriai/tokori/discussions) for
broader questions; open an [issue](https://github.com/tokoriai/tokori/issues)
for concrete bugs or feature requests.
