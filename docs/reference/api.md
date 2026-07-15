# Local HTTP API

Tokori runs a small read/write HTTP server on `127.0.0.1:53210`
whenever the desktop app is open (Settings → Local API, or
auto-start). It exists so external tools — the MCP server, the
Companion browser extension, the mobile app, custom scripts — can
read your workspace and write vocabulary, sessions, and media
without going through the UI.

## Auth

Every request (except `GET /v1/health` and `POST /v1/pair/request`)
needs a bearer token:

```http
Authorization: Bearer <token>
```

The token is generated on first launch and stored at:

| OS | Path |
| --- | --- |
| Linux / macOS | `~/.tokori/api-token` |
| Windows | `%USERPROFILE%/.tokori/api-token` |

If the file goes missing, restart the app — it'll regenerate.

Clients that can't read the file (browser extensions) obtain the same
token through the [pairing flow](#pairing): `POST /v1/pair/request`
long-polls while the desktop shows an approval dialog; approval
returns the token.

## Base URL

```
http://127.0.0.1:53210/v1
```

Every route below is prefixed with `/v1`. The version segment lets us
evolve the API without breaking older clients. (A separate
unauthenticated `/oauth/*` nest serves the sign-in loopback pages —
internal to the app's cloud login, not part of this API.)

## CORS

Allowed origins:

- `http://localhost:*` / `http://127.0.0.1:*` / `https://localhost:*`
- `https://tokori.ai`
- `chrome-extension://*`, `moz-extension://*`, `safari-web-extension://*`

Anything else is denied at preflight. The bearer token is what
actually protects the API — the server binds to loopback only.

## Endpoints

| Method | Path | Purpose | Detail |
| --- | --- | --- | --- |
| `GET` | `/v1/health` | Liveness (no auth) | [→](#health) |
| `POST` | `/v1/pair/request` | Ask the user to approve a client (no auth) | [→](#pairing) |
| `GET` | `/v1/workspaces` | List workspaces | [→](/reference/workspaces) |
| `GET` | `/v1/workspaces/:id/vocab` | List vocab | [→](/reference/vocab) |
| `POST` | `/v1/workspaces/:id/vocab` | Create / upsert vocab (incl. mined cards) | [→](/reference/vocab) |
| `POST` | `/v1/vocab/status` | Set a word's SRS status | [→](/reference/vocab) |
| `GET` | `/v1/workspaces/:id/collections` | List collections | [→](/reference/vocab#collections) |
| `POST` | `/v1/workspaces/:id/collections` | Create collection | |
| `POST` | `/v1/workspaces/:id/collections/import` | Bulk import (collection + words) | |
| `GET` | `/v1/collections/:id/words` | List words in collection | |
| `POST` | `/v1/collections/:id/words` | Add to collection | |
| `GET` | `/v1/workspaces/:id/media` | List the immersion watch library | [→](/reference/media) |
| `POST` | `/v1/workspaces/:id/media` | Add media (idempotent on URL) | [→](/reference/media) |
| `PATCH` | `/v1/media/:id` | Update media / bump progress | [→](/reference/media) |
| `GET` | `/v1/media/lookup` | Match a URL against the library | [→](/reference/media) |
| `POST` | `/v1/media/progress` | Playback beat (position/duration) | [→](/reference/media) |
| `POST` | `/v1/workspaces/:id/sessions` | Log a completed study session | [→](#sessions) |
| `POST` | `/v1/workspaces/:id/sessions/start` | Start a LIVE session row | [→](#sessions) |
| `POST` | `/v1/sessions/:id/heartbeat` | Refresh a live session | [→](#sessions) |
| `POST` | `/v1/sessions/:id/finish` | Close a live session | [→](#sessions) |
| `GET` | `/v1/dict/search` | Search dictionaries | [→](/reference/dict) |
| `POST` | `/v1/tokenize` | Segment target-language text (jieba for zh) | |
| `POST` | `/v1/translate` | Translate text via the configured engine | |
| `POST` | `/v1/ai/explain` | One-shot AI explanation (word/sentence) | |
| `POST` | `/v1/ocr` | OCR an image via the desktop engine | [→](#ocr) |
| `GET` | `/v1/remote/info` | Pairing probe (mobile) | [→](/reference/remote) |
| `POST` | `/v1/chat/stream` | Stream a chat completion (SSE) | [→](/reference/remote) |

### Health

```http
GET /v1/health
```

```json
{ "status": "ok", "service": "tokori", "version": "0.1.0" }
```

Liveness check. Doesn't require auth.

### Pairing

```http
POST /v1/pair/request
{ "client": "my-tool" }
```

Long-polls up to 60 s while the desktop shows an approval dialog.
Approval returns `{ "token": "…", "device_name": "…" }` — the same
persistent bearer token as the on-disk file. Denial → `403
pair.denied`; timeout → `408 pair.timeout`. This is how the Companion
extension authenticates.

### Sessions

Immersion-time tracking. `POST /v1/workspaces/:id/sessions` logs a
finished session in one shot:

```json
{ "kind": "video", "duration_secs": 900, "when": 1783600000, "notes": "Peppa Pig E3" }
```

For live tracking (the Companion's ⏱ timer), start a row with
`POST /v1/workspaces/:id/sessions/start` `{ "kind": "video" }` →
`201 { "id": … }`, keep it fresh with
`POST /v1/sessions/:id/heartbeat` `{ "duration_secs": <total accrued> }`
(total, not a delta), and close it with
`POST /v1/sessions/:id/finish` `{ "duration_secs": …, "notes": "<label>" }`.
The row is always closed as of its last write, so a crashed client
loses at most one heartbeat interval. Live session state is also
mirrored to the desktop UI's sidebar timer chip.

### OCR

```http
POST /v1/ocr
{ "image_b64": "<base64 PNG/JPEG>", "lang": "zh" }
```

→ `{ "lines": ["…", "…"] }`. Runs the desktop's PaddleOCR engine
(zh / ja / ko models + a Latin fallback; models download lazily on the
first call per language and stay cached). The Companion's player page
uses this to recognize burned-in subtitles from video frames.

### Error format

```json
{
  "error": {
    "code": "validation.empty_title",
    "message": "human-readable explanation",
    "request_id": "16-hex-chars"
  }
}
```

The `request_id` is echoed in the `X-Tokori-Request-Id` header.
Common code families: `auth.*` (401), `validation.*` (400),
`not_found.*` (404), `internal.*` (500). See
[Errors](/reference/errors) for the full list.

## MCP companion

The `mcp-server/` directory ships a tiny MCP server that wraps this
API and surfaces it to any MCP client — including `list_media` /
`add_media` / `update_media` for the immersion watch library. See its
own README for setup and `mcp-server/SKILL.md` for agent-facing usage.
