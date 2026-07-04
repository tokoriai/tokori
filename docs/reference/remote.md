# Remote chat

Two endpoints on the desktop's [local HTTP API](/reference/api) power
the [phone-uses-PC-chat flow](/guides/remote-pc):

- `GET /v1/remote/info` — pairing probe
- `POST /v1/chat/stream` — Server-Sent Events stream of a completion

Both are bearer-token authed against the standard
`~/.tokori/api-token`. They're reachable from outside the loopback
only when the user has stood up a tunnel agent (Cloudflare Tunnel,
Tailscale Funnel, etc.) — the API server itself binds to
`127.0.0.1:53210`.

## `GET /v1/remote/info`

Cheap probe used by the mobile client to validate a pasted pairing
payload. Cheap enough to call on every "Test connection" tap.

### Request

```http
GET /v1/remote/info HTTP/1.1
Authorization: Bearer <token>
```

### Response

```json
{
  "service": "tokori",
  "version": "0.1.0",
  "hostname": "flo-laptop",
  "providerConfigured": true,
  "workspaces": 3
}
```

| Field                | Type    | Meaning                                                                                       |
| -------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `service`            | string  | Always `"tokori"`. Used by the phone to spot pasted URLs pointing at the wrong service.       |
| `version`            | string  | Desktop app version. Surface as "Connected to flo-laptop (Tokori 0.1.0)".                     |
| `hostname`           | string  | The PC's hostname (best-effort: `$HOSTNAME` or `$COMPUTERNAME`, falls back to `"tokori-desktop"`). |
| `providerConfigured` | boolean | `false` when the desktop's active provider is missing, deleted, or Tokori Cloud.              |
| `workspaces`         | int     | Count of workspaces on the desktop. Cosmetic — helps users confirm they paired the right PC.  |

### Errors

| Status | Code              | Reason                                  |
| ------ | ----------------- | --------------------------------------- |
| `401`  | `auth.invalid_token` | Bearer doesn't match the stored token.  |
| `401`  | `auth.missing_token` | No `Authorization` header.              |

## `POST /v1/chat/stream`

Runs a chat completion against the desktop's **currently-active
provider** and streams the deltas as Server-Sent Events. The caller
does not pass provider config — keys never leave the PC.

### Request

```http
POST /v1/chat/stream HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "messages": [
    { "role": "system", "content": "You are a Mandarin tutor." },
    { "role": "user", "content": "What does 麻烦 mean?" }
  ]
}
```

| Field      | Type     | Notes                                                                                                                   |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `messages` | array    | Standard OpenAI-style roles (`system` / `user` / `assistant`) and `content` strings. The desktop normalizes per-provider. |

### Response

`text/event-stream`. Each event is a single `data:` line carrying a
JSON object, terminated by `\n\n`. A keep-alive comment (`: `) fires
every 15 seconds so the tunnel doesn't drop idle connections.

#### Event shapes

```text
data: {"type":"token","delta":"hello"}

data: {"type":"token","delta":" world"}

data: {"type":"done","content":"hello world"}
```

| Type    | Payload                              | Meaning                                                                                                           |
| ------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `token` | `{ "delta": string }`                | Append to the in-flight reply. May fire many times.                                                                |
| `done`  | `{ "content": string }`              | Final terminator. `content` is the full assembled reply (useful for clients that lost some `token` events).      |
| `error` | `{ "message": string }`              | Provider or transport failure. Terminal — no more events follow.                                                  |

A stream always ends with exactly one `done` **or** `error`. After
either, the server closes the connection.

#### Thinking blocks (Ollama only)

When the active provider is Ollama and the model exposes a thinking
trace (e.g. DeepSeek-R1, Qwen3 thinking variants), the trace is
wrapped in `<think>…</think>` and streamed alongside content. Clients
that don't care can strip everything between the tags; the desktop
chat view renders them as a collapsible panel.

### Errors

| Status | Code                  | When                                                                                                      |
| ------ | --------------------- | --------------------------------------------------------------------------------------------------------- |
| `401`  | `auth.*`              | Same as `/v1/remote/info`.                                                                                |
| `412`  | `chat.no_provider`    | No active provider, the row is missing, or the active provider is Tokori Cloud (use the cloud API instead). |

Error responses are JSON (not SSE):

```json
{
  "error": {
    "code": "chat.no_provider",
    "message": "Active provider is Tokori Cloud. Switch to a local provider (Ollama / OpenAI / Anthropic / Gemini / Minimax) to enable remote PC chat.",
    "request_id": "a1b2c3d4e5f60718"
  }
}
```

## Minimal client (curl)

Probe first:

```bash
TOKEN=$(cat ~/.tokori/api-token)
curl -sH "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:53210/v1/remote/info
```

Then stream:

```bash
curl -N -sH "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        --data '{"messages":[{"role":"user","content":"Say hi."}]}' \
        http://127.0.0.1:53210/v1/chat/stream
```

`curl -N` disables buffered output so you see deltas as they arrive.

## Minimal client (TypeScript)

The mobile app's transport — copy/paste-able into any other client
that wants the same wire shape.

```ts
async function streamRemoteChat(args: {
  url: string;     // e.g. "https://your-tunnel.trycloudflare.com"
  token: string;
  messages: { role: string; content: string }[];
  onToken: (delta: string) => void;
}): Promise<string> {
  const res = await fetch(`${args.url}/v1/chat/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.token}`,
      accept: "text/event-stream",
    },
    body: JSON.stringify({ messages: args.messages }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        const ev = JSON.parse(json);
        if (ev.type === "token") {
          full += ev.delta;
          args.onToken(ev.delta);
        } else if (ev.type === "done") {
          return full;
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }
    }
  }
  return full;
}
```

## Security model

There is no per-route ACL beyond the bearer token — the same one that
unlocks the rest of the local API. If the token leaks, the holder can:

- read/write everything the local API exposes (workspaces, vocab,
  collections, dictionaries);
- spend your active provider's quota by sending chat completions.

Rotate by restarting the local API (Settings → Stop → Start). The
token is regenerated and the old one becomes invalid immediately.

The desktop trusts the tunnel agent to handle TLS. Cloudflare Tunnel
and Tailscale Funnel both terminate HTTPS for you. If you point the
phone directly at `http://192.168.x.y:53210` on the LAN, traffic is
plaintext — fine for home, don't do it on shared WiFi.
