---
name: tokori-addon
description: Build a Tokori desktop-app addon (study mode, translate engine, vocab importer, or card enricher) by scaffolding a validated addon folder directly into the user's Tokori addons directory. Use when someone wants to create, develop, or "vibe code" a Tokori addon, extend the Tokori language-learning app with a custom plugin, or asks how to add a study mode / vocabulary importer / translation engine to Tokori.
---

# Build a Tokori addon

Tokori is a local-first desktop language-tutor app. It loads addons the way Anki
does: a folder dropped into the app's `addons/` directory shows up next to the
built-in plugins. This skill scaffolds a **valid addon straight into that
folder**, so a user who only has the installed app (not its source) can extend
Tokori without touching any code.

> **Status — read this first.** The shipping build *discovers, validates, lists,
> and enable/disable-toggles* addons. It does **not execute** their JS yet —
> sandboxed execution (Stage 2) is a future release. A well-formed addon you
> create now appears in **Settings → Addons**, and its enabled state persists; it
> begins running the moment Stage 2 ships, with no migration. So: build to the
> contract and it's future-proof. Tell the user this so "it's listed but not
> running yet" is expected, not a bug.

## Step 1 — Find the addons folder (write HERE, never into a code repo)

Fastest path: in the app, **Settings → Addons → Open addons folder**. Otherwise,
by OS — the app identifier is `ai.tokori.desktop`:

| OS | Addons folder |
| --- | --- |
| Linux | `~/.local/share/ai.tokori.desktop/addons/` |
| macOS | `~/Library/Application Support/ai.tokori.desktop/addons/` |
| Windows | `%APPDATA%\ai.tokori.desktop\addons\` |

Create it if missing. **Each addon is one subfolder.** The folder name is free —
the canonical identifier is the `id` field inside `manifest.json`. Do all your
work inside the new subfolder; do not modify the Tokori app itself.

## Step 2 — Pick a kind

| `kind` | What it does | entry.js default export | Difficulty |
| --- | --- | --- | --- |
| `vocab-import` | Parse a text/CSV file into vocab rows | `{ meta, parse(text) → ImportRow[] }` — **pure, no IO** | ⭐ easiest |
| `translate` | Translate a batch of words/phrases | `{ meta, translate(req) → Promise<string[]> }` | ⭐⭐ |
| `card-enrichment` | Fill in card fields (example, cloze, audio…) via the host `ctx` | `{ meta, run(draft, ctx) → Promise<CardPatch> }` | ⭐⭐⭐ |
| `study` | A full study mode with its own React UI | `{ meta, StudyView }` (React component) | ⭐⭐⭐⭐ |

When the user is vague, **default to `vocab-import`** — it's a pure function, the
easiest to get right, and the fastest to demo. Full contracts for every kind are
in **`reference.md`** (read it before writing the entry point).

## Step 3 — Scaffold the addon

Create two files in the new subfolder (copy from `templates/<kind>/` and adapt):

1. **`manifest.json`** — see the schema in `reference.md`. Required: `id`, `name`,
   `version` (semver), `description`, `kind`, `entry`.
2. **The entry point** (e.g. `entry.js`) — an **ES module** whose **`default`
   export** matches the contract for the chosen `kind`.

### Non-negotiable rules for the entry point
- It is a plain ES module: `export default { ... }`. No bundler step required.
- **No imports from the Tokori app, no `fetch`/DOM/Node APIs, no `require`.**
  `vocab-import` parsers must be pure functions of their text input. The other
  kinds get everything they need from the `ctx` object the host passes in (see
  `reference.md`) — that is the only trust boundary.
- `meta.id` (in the entry) and `manifest.id` should match and never change once
  shipped — they're the persisted install key.

## Step 4 — Validate before declaring done

Check the manifest against these rules (the app rejects violations and shows the
reason in Settings → Addons):
- `id`: `^[a-z][a-z0-9-]{2,63}$` (lowercase kebab-case, starts with a letter).
- `version`: semver, e.g. `1.0.0` or `2.1.3-beta.1`.
- `kind`: exactly one of `study`, `translate`, `vocab-import`, `card-enrichment`.
- `entry`: a relative path inside the folder — no `..`, no leading `/`.
- `manifest.json` is valid JSON; the entry file actually exists at `entry`.

For `vocab-import`, also run the parser. The template ships `test.mjs` +
`sample.md` — copy both into the addon folder and run `node test.mjs`; it
imports the entry point, runs `parse()` over the sample, prints the rows, and
exits non-zero if any row is missing a `word`. (Addon execution inside the app
is Stage 2, so this Node harness is the way to test logic today.)

## Step 5 — Hand off

Tell the user: reopen **Settings → Addons** (or restart the app) — the new addon
appears with its name + description and an enable toggle. Remind them execution
lands in Stage 2 (see the status note above). If validation failed, the app
shows the exact reason there.

## Where to go deeper
- `reference.md` — full manifest schema + the TypeScript contract for all four kinds.
- `templates/vocab-import/` — a complete, working example to copy.
