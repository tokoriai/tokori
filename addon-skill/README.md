# tokori-addon — an agent skill for building Tokori addons

This folder is a reusable **agent skill**: point your coding agent at
`SKILL.md` and ask it to build a [Tokori](https://tokori.ai) addon. It knows
the manifest schema and every plugin contract, and scaffolds a *validated*
addon straight into your Tokori addons folder — you only need the installed
desktop app, not Tokori's source.

## Install into your coding agent

Copy the folder into wherever your agent discovers skills:

```sh
# from a clone of this repo
cp -r addon-skill <your-agent-skills-dir>/tokori-addon
```

(or copy `SKILL.md`, `reference.md`, and `templates/` into that folder by
hand). Your agent picks it up next session. Then:

> Use the tokori-addon skill to build an addon that imports my Pleco export.

## Use it from any agent

`SKILL.md` is self-contained — point your agent at it (or paste it as an
instruction prompt) and describe the addon you want. `reference.md` holds the
full contract for all four addon kinds.

## What's here

| File | Purpose |
| --- | --- |
| `SKILL.md` | The agent's playbook: find the folder → pick a kind → scaffold → validate → hand off. |
| `reference.md` | Frozen manifest schema + TypeScript contracts for `study` / `translate` / `vocab-import` / `card-enrichment`. |
| `templates/vocab-import/` | A complete, runnable example: `manifest.json`, `entry.js`, `sample.md`, and `test.mjs` (`node test.mjs` to test the parser). |

## Test what you build

`vocab-import` parsers are pure functions, so you can test them with plain Node
before the app's Stage-2 execution lands:

```sh
cd templates/vocab-import
node test.mjs
```

See the full guide at [tokori.ai/docs → Addons](https://docs.tokori.ai/guides/addons).
