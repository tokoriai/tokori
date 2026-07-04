# Use your PC's chat from your phone

The Tokori desktop app can act as a chat backend for the mobile app
over the internet. Your phone sends messages through a tunnel you set
up on your PC; the desktop runs the completion against whichever
provider you've configured (Ollama, OpenAI, Anthropic, Gemini, Minimax)
and streams the reply back. API keys never leave the PC.

This is the same posture as remote dev-machine pairing — phone is the
keyboard, PC does the work.

## When this is the right tool

- You run a **local model** (Ollama with a 7B+) on a workstation and
  want to study on the train without lugging the laptop.
- You pay for **API tokens by usage** and want all calls to bill to the
  one provider key on your desktop instead of a duplicate mobile copy.
- You want **chat parity** between desktop and phone without standing
  up your own server.

It is **not** a substitute for sync — your phone still talks to
`api.tokori.ai` for the rest of its data (vocab, library, sessions).
This feature only relays *chat* through the desktop.

## Architecture, briefly

```
 ┌──────────┐    HTTPS    ┌────────────────┐    loopback    ┌────────────┐
 │  Tokori  │ ─────────▶  │  cloudflared / │ ─────────────▶ │  Tokori    │
 │  Mobile  │             │  Tailscale     │                │  Desktop   │
 │          │ ◀───────── │  tunnel agent  │ ◀───────────── │  api_server│
 └──────────┘    SSE      └────────────────┘                └─────┬──────┘
                                                                  │
                                                            local provider
                                                            (Ollama / OpenAI /
                                                             Anthropic / …)
```

Two endpoints power it:

- `GET /v1/remote/info` — pairing probe, used by the phone to validate
  the URL + token.
- `POST /v1/chat/stream` — Server-Sent Events; reads the desktop's
  currently-active provider and streams the completion back.

Both are under the existing local API server (bearer-token authed,
loopback bind). The tunnel agent is what makes them reachable from the
phone — Tokori doesn't ship a relay service.

See [Reference → Remote chat](/reference/remote) for the wire-level
shape.

## Setup (10 minutes)

### 1. Start the desktop's local API

On the PC: **Settings → Local API → Start**.

The card shows the bind address (`127.0.0.1:53210` by default) and a
bearer token. If you've ever set up the [MCP server](/guides/mcp),
this is the same token — no new secret to manage.

### 2. Pick a provider

Mobile chat will run on whatever provider is **active** on the desktop.
Open **Settings → Providers**, add one, click **Use** to make it
active. Any of these work:

- **Ollama** (best for "no API bills"). Make sure the daemon is running
  on the PC.
- **OpenAI / Anthropic / Gemini / Minimax** with your own key. Cheaper
  than paying for cloud + mobile separately.

If your active provider is **Tokori Cloud**, the mobile endpoint will
refuse to serve and tell you why — cloud chat is brokered through
`api.tokori.ai` directly, no point round-tripping through your
desktop.

### 3. Expose the PC with a tunnel

The desktop API listens on loopback only. To let your phone reach it,
run a tunnel agent on the PC. We recommend **Cloudflare Tunnel** for
the easiest start; **Tailscale Funnel** is a great alternative if
you're already on Tailscale.

#### Cloudflare Tunnel (free, no account for v0)

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/),
then:

```bash
cloudflared tunnel --url http://127.0.0.1:53210
```

It prints a public URL like `https://salt-fish-bottle-9742.trycloudflare.com`.
Copy it.

::: warning Ephemeral URLs
Quick tunnels rotate every time you re-run cloudflared. Fine for
trying it out; for a permanent setup, run `cloudflared tunnel login`
and create a **named tunnel** — the URL stays stable across restarts.
See [Cloudflare's named-tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/).
:::

#### Tailscale Funnel (stable URL, no public exposure surface)

If your PC is on a [Tailscale](https://tailscale.com/) net:

```bash
tailscale funnel 53210
```

This gives you `https://<machine>.<tailnet>.ts.net`, with TLS
terminated by Tailscale. The URL is stable as long as the machine
stays in the tailnet.

#### LAN only

Same WiFi, no internet exposure? Bind a LAN IP via your router's
DHCP reservation and point the phone at `http://192.168.x.y:53210`
directly. Skips the tunnel entirely. No HTTPS — fine for home, don't
do it on coffee-shop WiFi.

### 4. Generate the pairing payload

Back in desktop **Settings → Local API → Remote access from Tokori
Mobile**:

1. Paste the tunnel URL into "Paste the tunnel URL".
2. The "Pairing payload" panel below renders a JSON blob:

   ```json
   {
     "url": "https://salt-fish-bottle-9742.trycloudflare.com",
     "token": "p7K9_…"
   }
   ```

3. **Copy** it.

The blob is the URL + token in one piece so you don't need to type
either by hand on the phone.

### 5. Pair the phone

On mobile: **More → Connect to PC → Paste**, then **Save & connect**.
The app pings `/v1/remote/info`; on success it shows your desktop's
hostname.

You can now toggle "Use PC for chat" without unpairing — the config
sticks, the switch just controls whether the Chat tab routes through
the PC or stays cloud-only.

### 6. Chat

The mobile **Chat** tab now streams from your PC. Each message round-
trips: phone → tunnel → desktop → provider → desktop → tunnel → phone.

## Security

::: tip Treat the pairing payload like a password
Anyone with the `{url, token}` blob can talk to your PC and use your
provider quota. Don't paste it into a public Slack.
:::

Token rotation: **Settings → Local API → Stop, then Start** generates a
fresh token. The phone will need a new pairing payload. The old one
becomes useless the moment the server restarts.

Authentication is a constant-time bearer compare — same as the rest of
the local API. There is **no IP allow-list** (your tunnel URL is the
moat). If you need stricter scoping, run a named cloudflared tunnel
behind an Access policy, or use Tailscale Funnel which already gates
on identity.

## Troubleshooting

**Phone says "Can't reach the desktop"**

- Is the desktop's local API actually running? (Settings → Local API
  shows a green "Running" pill.)
- Did the cloudflared tunnel terminate? Quick tunnels die when you
  close the terminal. Re-run it and update the pairing payload (the
  URL changes).
- Hit the tunnel URL from a browser: `https://your-tunnel/v1/health`
  should return `{"status":"ok",…}`. If that fails, the tunnel is
  down. If it succeeds but the app still can't reach it, your bearer
  token is stale — re-pair.

**Phone says "No active provider on the desktop"**

The desktop's active provider is `null` or set to Tokori Cloud. Open
Settings → Providers on the desktop and pick a local one (Ollama,
OpenAI, Anthropic, Gemini, Minimax).

**Phone says "Active provider is Tokori Cloud"**

Switch the desktop's active provider to a non-cloud option. Cloud
calls don't go through the desktop relay — they hit `api.tokori.ai`
directly from the phone.

**Replies are slow on Ollama**

The first request after starting Ollama loads the model into VRAM —
expect ~5–20s of cold-start, then subsequent messages stream
immediately. The desktop pre-warms Ollama on provider switch; if you
just rebooted, send one message in the desktop chat first to prime
the cache.

**Chat works but I want history persisted**

v0 mobile chat is **ephemeral** — messages live in memory until you
leave the screen. Persisted history is on the roadmap; it'll route
through the cloud's `chats` table the same way the desktop's chat
view does.

## Limits in v0

- **No QR scan** for pairing — paste-only. Adding it is a one-screen
  swap, just hasn't shipped yet.
- **No mobile push notifications** when a long-running completion
  finishes. If the screen sleeps mid-stream, the connection closes
  and you lose the unflushed remainder. Keep the app foregrounded
  for now.
- **Cloudflared quick tunnels are ephemeral.** Named tunnels or
  Tailscale Funnel give you a stable URL.
- **One provider at a time.** The desktop's *active* provider is what
  runs; switching it in desktop Settings instantly changes what the
  phone uses on the next message.
- **No streaming history rewrite.** If you switch providers
  mid-conversation, the next reply might surprise you because the new
  model didn't see the previous turns it can now read.
