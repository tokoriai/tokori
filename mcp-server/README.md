# tokori-mcp

A Model Context Protocol (MCP) server that exposes the local Tokori API to
any MCP-aware client (coding agents, AI editors) so an agent can read and
write your language-learning workspaces, vocabulary, collections, and
dictionaries.

> Local-first by design — all traffic stays on `127.0.0.1`, gated by the
> bearer token the desktop app writes to `~/.tokori/api-token` on first launch.

## Prerequisites

1. **Tokori desktop app** running, with the local API enabled (Settings →
   Local API → Start). The app writes the bearer token to
   `~/.tokori/api-token` (Windows: `C:\Users\<you>\.tokori\api-token`).
2. **Node.js ≥ 20**.

## Install

From the repo root:

```bash
cd mcp-server
npm install
npm run build
```

This compiles the server to `mcp-server/dist/index.js`.

## Wire it into your MCP client

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

Drop that into your client's MCP config file (see your client's docs for
the location), then restart the client. You should see the Tokori tools
listed.

For per-client config (Codex, opencode, Cursor, …), see the
[MCP install reference](../docs/guides/mcp.md) and the
[Develop with a coding agent](../docs/guides/develop-with-an-agent.md) guide.

## Tools

| Tool                       | What it does                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `list_workspaces`          | List all workspaces (id, target/native lang, name).                                     |
| `list_vocab`               | List vocab in a workspace, optional status / substring filter.                          |
| `list_collections`         | List collections in a workspace.                                                        |
| `list_collection_words`    | List the words inside one collection.                                                   |
| `search_dict`              | Look up words in the installed dictionary for a language.                               |
| `create_vocab`             | Add a word; idempotent on (workspace_id, word).                                         |
| `create_collection`        | Create an empty collection.                                                             |
| `add_words_to_collection`  | Append words (by id, or upsert + link) to an existing collection.                       |
| `import_collection`        | One-shot: create a new collection AND populate it with a batch of words.                |
| `health`                   | `{ status: 'ok', service, version }` — handy to verify the app is running.              |

## Environment overrides (rarely needed)

- `TOKORI_API_URL` — point at a non-default bind. Defaults to
  `http://127.0.0.1:53210`.
- `TOKORI_API_TOKEN` — skip reading `~/.tokori/api-token`. Useful for CI or
  a sandboxed test rig.

## Common workflows

See [`SKILL.md`](./SKILL.md) — give it to your coding agent as a skill (or
paste it into the system prompt) so the agent learns *when* to reach for
these tools and gets a few worked examples.

## Troubleshooting

**`network.unreachable`** — desktop app isn't running or the local API is
stopped. Open Tokori → Settings → Local API → Start.

**`auth.invalid_token`** — the token at `~/.tokori/api-token` doesn't match
what the running app expects. The app rotates the token if the file is
deleted/empty; restart the app to regenerate, then restart the MCP server
so it re-reads the file.

**Tools missing in `/mcp`** — confirm your client lists `tokori` as
running. If it crashed on startup, the stderr lands in your client's MCP
log; check there for the underlying error.
