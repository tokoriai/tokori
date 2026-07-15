# Media (Immersion watch library)

The Immersion tab's watch library — videos, series, podcasts with
progress — is exposed over the [local API](/reference/api) so the
Companion extension, the MCP server, and your own scripts can queue
media and report watch progress.

Media items are `library_items` rows with a watch/listen `kind`
(`video` | `series` | `podcast`) — the same table the Library uses for
books, and the same rows the app's cloud sync carries. There is no
separate store to keep in sync.

## Canonical media keys

The by-URL endpoints match links by a **canonical key**, so
`youtu.be/ID`, `youtube.com/watch?v=ID&t=42s`, and
`m.youtube.com/watch?v=ID` all resolve to the same item:

| Key | Source |
| --- | --- |
| `yt:<videoId>` | YouTube watch / shorts / live / embed / youtu.be |
| `yt:pl:<listId>` | YouTube playlist page |
| `nf:<id>` | Netflix `/watch/<id>` or `/title/<id>` |
| `sp:<type>:<id>` | Spotify episode / show |
| `ap:<showId>[:<ep>]` | Apple Podcasts |
| `vimeo:<id>`, `bili:<id>` | Vimeo, Bilibili |
| `web:<host>/<path>` | Everything else (query/fragment dropped) |

## The item shape

```json
{
  "id": 12,
  "workspace_id": 1,
  "kind": "video",
  "title": "Slow Chinese — Ep. 12",
  "author": "Slow Chinese",
  "source": "https://www.youtube.com/watch?v=…",
  "total_units": 22,
  "unit_label": "minutes",
  "completed_units": 9,
  "total_seconds": 540,
  "status": "active",
  "cover_url": null,
  "notes": null,
  "created_at": 1783600000,
  "updated_at": 1783600400
}
```

Progress semantics: single videos track **minutes**
(`completed_units` = furthest minute watched, `total_units` = length);
series/podcasts track **episodes**. `total_seconds` accrues actual
watch/listen time either way. Statuses: `planned` (the queue) →
`active` → `finished`, plus `paused` and `dropped`.

## `GET /v1/workspaces/:id/media`

Query params: `status`, `kind`, `limit` (default 200, max 500).
Returns `{ "data": [item…] }`, most recently touched first.

## `POST /v1/workspaces/:id/media`

```json
{
  "title": "Slow Chinese — Ep. 12",
  "url": "https://youtu.be/…",
  "kind": "video",
  "author": "Slow Chinese",
  "total_units": 22,
  "status": "planned"
}
```

- **Idempotent on the canonical URL**: re-adding a link that's already
  on the list returns the existing row with `200` instead of creating
  a duplicate (`201` for a new row).
- `kind` is inferred from the URL when omitted (playlist → `series`,
  Spotify/Apple → `podcast`, else `video`); `status` defaults to
  `planned`; `unit_label` defaults per kind.

## `PATCH /v1/media/:id`

Partial update. Absolute fields (`title`, `author`, `source`, `kind`,
`status`, `total_units`, `completed_units`, `total_seconds`,
`unit_label`, `notes`) or **relative bumps** — `delta_units: 1` marks
one more episode/minute done, `delta_seconds` adds tracked time —
mutually exclusive with their absolute counterparts. Empty-string
`author`/`source` clears the field. Only media-kind rows are reachable
(`404` otherwise), and `kind` must stay a media kind.

## `GET /v1/media/lookup?url=…&workspace_id=…`

Read-only probe: `{ "matched": true, "item": {…} }` or
`{ "matched": false }`. The Companion uses this to badge YouTube's
action bar ("✓ Tokori") without writing anything.

## `POST /v1/media/progress`

The playback beat — how the Companion advances a list item while you
watch:

```json
{
  "url": "https://www.youtube.com/watch?v=…",
  "workspace_id": 1,
  "position_secs": 754,
  "duration_secs": 1320,
  "delta_secs": 30,
  "ended": false
}
```

Soft no-match by design: URLs that aren't on the list answer
`200 { "matched": false }` — clients report speculatively for whatever
is playing, and only library members accrue progress. On a match:

- `delta_secs` (clamped to 1 h/beat) adds to `total_seconds`;
- for minute-tracked items, `duration_secs` fills/expands the length
  and `position_secs` advances the **furthest-watched** minute
  (scrubbing backwards never loses progress);
- `ended: true` or a position ≥ 90 % of the duration marks the item
  `finished` (rewatching never un-finishes); any beat promotes a
  `planned`/`dropped` item to `active`.

Returns `{ "matched": true, "item": {…} }` with the updated row.

## MCP tools

The MCP server exposes this surface as `list_media`, `add_media`, and
`update_media` — see `mcp-server/SKILL.md` for agent-facing patterns
(building a level-appropriate watch queue, logging progress with
deltas).
