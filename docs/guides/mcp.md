# MCP server

Tokori ships an MCP server (`mcp-server/`) that exposes your local
workspaces, vocabulary, collections, and dictionaries to any
[Model Context Protocol](https://modelcontextprotocol.io/) client.
Wire it into Codex, opencode, Cursor, or any other MCP-aware tool and
your agent can add words, build collections, scrape vocabulary from
articles, and audit your study queue — all against your local SQLite,
no cloud round-trip.

This guide covers install and client wiring. There's also a bundled
skill that teaches the agent *when* to reach for the tools — covered
at the end.

## Prerequisites

- **Tokori desktop app** running, with the local API enabled
  (Settings → Local API → Start). The app writes a bearer token to
  `~/.tokori/api-token` (Windows: `C:\Users\<you>\.tokori\api-token`).
- **Node.js ≥ 20** on the same machine — the MCP server is a stdio
  process spawned by your client.

## Build the server

```bash
git clone https://github.com/tokoriai/tokori.git
cd tokori/mcp-server
npm install
npm run build
```

This compiles `dist/index.js`. Note the **absolute path** — every client
config below needs it.

## Wire it into your client

### Config-based clients

Most clients read an `mcpServers` JSON config. Point it at the built
`dist/index.js` using the **absolute path**:

```json
{
  "mcpServers": {
    "tokori": {
      "command": "node",
      "args": ["/absolute/path/to/tokori/mcp-server/dist/index.js"]
    }
  }
}
```

Drop that into your client's MCP config file — consult your client's
docs for the exact path — then restart the client and run its MCP tool
list. You should see the Tokori tools.

### Codex (OpenAI Codex CLI)

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.tokori]
command = "node"
args = ["/absolute/path/to/tokori/mcp-server/dist/index.js"]
```

Restart Codex. The tools will appear in the same `/mcp` view.

### opencode

Edit `~/.config/opencode/opencode.json` (or the project-local
`opencode.json`):

```json
{
  "mcp": {
    "tokori": {
      "type": "local",
      "command": ["node", "/absolute/path/to/tokori/mcp-server/dist/index.js"],
      "enabled": true
    }
  }
}
```

Restart opencode and verify with the MCP tool list.

## Optional — the bundled skill

Tokori ships a skill that teaches the agent *when* to call the tools
and *how* to phrase results. It lives at `mcp-server/SKILL.md`.

For agents that read a `skills/` directory, copy it in:

```bash
mkdir -p <your-agent-skills-dir>/tokori
cp mcp-server/SKILL.md <your-agent-skills-dir>/tokori/
```

Restart your agent. It now reaches for the Tokori MCP tools
automatically when you ask it to "add words", "build a collection",
"scrape vocab from this article", etc.

No skill directory? Paste the SKILL.md contents into your agent's
system prompt or project-instructions file.

## Available tools

| Tool                       | What it does                                                              |
| -------------------------- | ------------------------------------------------------------------------- |
| `list_workspaces`          | List all workspaces (id, target/native lang, name).                       |
| `list_vocab`               | List vocab in a workspace, optional status / substring filter.            |
| `list_collections`         | List collections in a workspace.                                          |
| `list_collection_words`    | List the words inside one collection.                                     |
| `search_dict`              | Look up words in the installed dictionary for a language.                 |
| `create_vocab`             | Add a word; idempotent on `(workspace_id, word)`.                         |
| `create_collection`        | Create an empty collection.                                               |
| `add_words_to_collection`  | Append words (by id, or upsert + link) to an existing collection.         |
| `import_collection`        | One-shot: create a new collection AND populate it with a batch of words.  |
| `health`                   | `{ status, service, version }` — verify the app is running.               |

Every tool maps 1-to-1 to a route in the local HTTP API
(see [API reference](/reference/api)) so anything you can do via the
MCP server, you can also script directly with `curl`.

## Worked examples

### Add a single word

> "Add 餐馆 to my Chinese workspace, in the Restaurants collection."

The agent calls `list_workspaces`, then `list_collections` to find the
right ids, then `create_vocab` with `collection_id` set.

### Scrape an article into a new collection

> "Pull every Chinese word out of this article and save them as a
> collection called 'Beijing 2026 trip'."

The agent extracts the words (and asks `search_dict` to fill in
readings/glosses), then calls `import_collection` once with the full
batch — returning `{ added: 47, existed: 8, skipped: 0 }`.

### Audit the review queue

> "What's in my Japanese review queue?"

`list_vocab` with `status: "review"`. The agent summarises the count
and the next-due items.

## Environment overrides (rarely needed)

- `TOKORI_API_URL` — override the API base URL. Defaults to
  `http://127.0.0.1:53210`.
- `TOKORI_API_TOKEN` — skip reading `~/.tokori/api-token`. Useful for
  CI or sandboxed test rigs.

## Troubleshooting

**`network.unreachable`** — the desktop app isn't running or the local
API is stopped. Open Tokori → Settings → Local API → Start.

**`auth.invalid_token`** — the token at `~/.tokori/api-token` doesn't
match what the running app expects. The app rotates the token if the
file is deleted/empty; restart the app to regenerate, then restart the
MCP server so it re-reads the file.

**Tools missing from `/mcp`** — confirm your client lists `tokori` as
running. If it crashed on startup, the stderr lands in your client's
MCP log.

## Next steps

- [Develop with a coding agent](/guides/develop-with-an-agent) —
  use the same MCP surface to read your live vocab while writing new
  study modes or reader plugins.
- [Local HTTP API reference](/reference/api) — the same surface,
  unwrapped, if you'd rather drive it from a shell script.
