# Local HTTP API

Tokori runs a small read/write HTTP server on `127.0.0.1:53210`
whenever the desktop app is open. It exists so external tools
(MCP clients, custom scripts) can read your
workspace and write vocabulary without going through the UI.

## Auth

Every request needs a bearer token:

```http
Authorization: Bearer <token>
```

The token is generated on first launch and stored at:

| OS | Path |
| --- | --- |
| Linux / macOS | `~/.tokori/api-token` |
| Windows | `%USERPROFILE%/.tokori/api-token` |

If the file goes missing, restart the app — it'll regenerate.

A read-only mode is available — pass `?readonly=1` (or the header
`X-Tokori-ReadOnly: 1`) and the server will reject `POST` /
mutating verbs with `403`.

## Base URL

```
http://127.0.0.1:53210/v1
```

Every route below is prefixed with `/v1`. The version segment
lets us evolve the API without breaking older clients.

## CORS

Allowed origins:

- `http://localhost:*`
- `https://localhost:*`
- `https://tokori.ai`

Anything else is denied at preflight.

## Endpoints

| Method | Path | Purpose | Detail |
| --- | --- | --- | --- |
| `GET` | `/v1/health` | Liveness | [→](#health) |
| `GET` | `/v1/workspaces` | List workspaces | [→](/reference/workspaces) |
| `GET` | `/v1/workspaces/:id/vocab` | List vocab | [→](/reference/vocab) |
| `POST` | `/v1/workspaces/:id/vocab` | Create / upsert vocab | [→](/reference/vocab) |
| `GET` | `/v1/workspaces/:id/collections` | List collections | [→](/reference/vocab#collections) |
| `POST` | `/v1/workspaces/:id/collections` | Create collection | |
| `POST` | `/v1/workspaces/:id/collections/import` | Bulk import | |
| `GET` | `/v1/collections/:id/words` | List words in collection | |
| `POST` | `/v1/collections/:id/words` | Add to collection | |
| `GET` | `/v1/dict/search` | Search dictionaries | [→](/reference/dict) |
| `GET` | `/v1/remote/info` | Pairing probe (mobile) | [→](/reference/remote) |
| `POST` | `/v1/chat/stream` | Stream a chat completion (SSE) | [→](/reference/remote) |

### Health

```http
GET /v1/health
```

```json
{
  "status": "ok",
  "service": "tokori",
  "version": "0.1.0"
}
```

Liveness check. Doesn't require auth.

### Error format

```json
{
  "error": "string error code",
  "message": "human-readable explanation"
}
```

Common codes: `unauthorized`, `not_found`, `read_only`,
`bad_request`. See [Errors](/reference/errors) for the full list.

## MCP companion

The `mcp-server/` directory ships a tiny MCP server that wraps
this API and surfaces it to any MCP client.
See its own README for setup.
