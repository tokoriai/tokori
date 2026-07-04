# Develop with a coding agent

Tokori is built to be hacked on. The plugin SDK, the local HTTP API,
and the bundled MCP server compose into a comfortable loop for
extending the app with the help of a coding agent — Codex, opencode,
Cursor, or anything else that speaks MCP.

This guide assumes you've already wired up the
[Tokori MCP server](/guides/mcp). If you haven't, do that first — every
recipe below relies on the agent being able to read your live workspace.

## The loop

1. Open the cloned repo in your terminal.
2. Launch your agent.
3. Ask it to *do* something — write a study plugin, add a reader
   feature, scrape vocab from a source.
4. The agent reads your live state via the MCP tools, edits files in
   `src/`, and tells you what to test.
5. You hit `npm run tauri dev`, try it, give feedback. Loop.

The MCP server is what makes step 4 useful: the agent doesn't need to
guess what your data looks like, it can call `list_workspaces`,
`list_collections`, `list_vocab` and *see*.

## Recipe 1 — write a new study plugin

Plugins live under `src/lib/study/plugins/`. The contract is in
[Plugin SDK](/guides/plugins) — short version: export a `StudyPlugin`
with a `StudyView` React component, register it in
`src/lib/study/registry.ts`.

A productive prompt looks like this:

> "I want a new study plugin for the Reverse Cloze drill — show the
> sentence with one word blanked out, the user types the missing word.
> Pull example sentences from existing vocab entries' `cardNotes`
> field. Use `ctx.reviewVocab` for grading. Look at
> `src/lib/study/plugins/vocab-recall.tsx` for the lifecycle pattern.
> Also call `list_vocab` for my Chinese workspace so you know what
> words I have."

The agent will read the existing plugin, sample your live vocab via
MCP, draft the new plugin, and walk you through registering it.

## Recipe 2 — bulk-curate a collection

You don't need to write code at all to use the MCP surface. With the
Tokori MCP server installed, just *ask*:

> "Pull every Chinese word from this Wikipedia article that I don't
> already know, fill in pinyin and English glosses from CC-CEDICT, and
> save them as a collection called 'Beijing Subway System'."

The agent will:

1. Fetch the article (web tool or pasted text).
2. Tokenise into Chinese words.
3. Call `list_vocab` with `q` to skip what you already have.
4. Call `search_dict` per remaining word to fill readings/glosses.
5. Call `import_collection` once with the full batch.

Counts from the response are the source of truth — the agent reports
`{ added, existed, skipped }` so you know what actually changed.

## Recipe 3 — extend the local HTTP API

The MCP server is a thin proxy over the local HTTP API in
`src-tauri/src/api_server.rs`. To expose a new capability to the agent
you change two files in lockstep:

1. Add the route in `api_server.rs` under `/v1/`.
2. Add a matching tool in `mcp-server/src/index.ts` (and a typed
   wrapper in `mcp-server/src/api.ts`).

A productive prompt:

> "Add a `/v1/workspaces/:id/vocab/:vid` PATCH endpoint that updates
> the `gloss` and `front_extra` fields. Mirror it as an `update_vocab`
> tool in `mcp-server/src/index.ts`. Match the validation pattern used
> by `create_vocab`."

The agent edits both surfaces, you `cargo check` + `npm run build` in
the two directories, restart the desktop app + the MCP server, and the
new tool appears in your MCP client.

## Recipe 4 — debug a bug with live state

> "When I open the character detail page for 餐, the stroke order
> panel never loads. Look at `src/components/character-detail.tsx`
> and tell me where the loader is. Also call `list_vocab` for my
> Chinese workspace and find a word containing 餐 — I want to test
> against a real entry."

The agent has the code, your live data, and the codebase conventions
all in one place. Most "hunt the bug" sessions collapse to a 5-minute
exchange.

## What the agent should always do

- **Use `npm run dev`** for fast UI iteration; switch to
  `npm run tauri dev` only when touching Rust.
- **Run `npm run build` + `cargo check`** before declaring a feature
  done.
- **Run `npm test`** if it touched anything in `src/lib/`.

## What the agent should never do

- Mutate your DB without asking. The MCP server intentionally exposes
  *no* delete endpoints — if the agent wants to clean up a botched
  import, it should ask you to delete the collection from the desktop
  UI.
- Fabricate readings or glosses. If `search_dict` returns nothing,
  leave the field empty.
- Hard-code provider keys. Provider config flows through the
  `ChatProvider` abstraction; never write a provider URL or key into
  a plugin.

## Next steps

- [Plugin SDK reference](/guides/plugins) — every method on `ctx`,
  the lifecycle, and the helpers used by the built-in plugins.
- [Architecture overview](/guides/architecture) — where things live
  and why.
- [Local HTTP API reference](/reference/api) — the surface the MCP
  server wraps.
