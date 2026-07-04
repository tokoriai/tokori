/**
 * Chat-provider runtime.
 *
 * One `ChatProvider` interface, three implementations:
 *
 *   • `RustChatProvider`  — desktop BYOK (Ollama / OpenAI / Anthropic /
 *                            Gemini / Minimax). Delegates to the Rust
 *                            `chat_send` Tauri command which dispatches
 *                            through `src-tauri/src/providers.rs`'s
 *                            `ChatProvider` trait.
 *   • `CloudChatProvider` — managed Tokori Cloud proxy. Speaks the
 *                            OpenAI-compatible SSE shape, carries the
 *                            cloud session bearer, surfaces the
 *                            mid-stream credit guard as
 *                            `InsufficientCloudCreditsError`.
 *   • `MockChatProvider`  — `npm run dev` (no Tauri) and the marketing
 *                            site demo iframe. Calls `mock-ai.ts` so
 *                            both surfaces get plausible replies
 *                            without a real backend.
 *
 * `resolveChatProvider(cfg, cloud)` picks the right one given the
 * current active provider config + cloud account. The React context
 * (`provider-context.tsx`) is just a thin wrapper that resolves once
 * per `sendChat` call.
 *
 * Why split this out: the previous `sendChat` lived inside the React
 * context as a ~70-line function with three inlined branches and two
 * helper functions (warm-up, cloud SSE parser) further down the file.
 * Extracting the dispatch lets each provider live next to its own
 * quirks (Ollama warm-up, cloud credit guard) without polluting the
 * top-level chat router.
 */

import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { ProviderConfig } from "./db";

// ── Public surface ─────────────────────────────────────────────────────

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/** Streaming events the Rust side emits. Mirrors `ChatEvent` in
 *  `src-tauri/src/providers.rs`; kept in sync by hand because they're
 *  on either side of the Tauri IPC boundary. */
export type ChatEvent =
  | { type: "token"; delta: string }
  | { type: "done"; content: string }
  | { type: "error"; message: string };

export type ChatStreamArgs = {
  messages: ChatMessage[];
  /** Called once per token delta the upstream produces. The runtime
   *  also accumulates the full reply and resolves with it. */
  onToken: (delta: string) => void;
  /** Called exactly once when the stream finishes cleanly. Receives
   *  the full assembled reply text. */
  onDone?: (full: string) => void;
  /** Called when an error event lands mid-stream OR the underlying
   *  promise rejects. The promise rejects too — handlers should not
   *  rely on `onError` alone to know about failure. */
  onError?: (message: string) => void;
};

/** The single abstraction every chat backend implements. Mirrors the
 *  Rust trait at `src-tauri/src/providers.rs::ChatProvider`. */
export interface ChatProvider {
  /** Stable id for telemetry/logging. Matches the Rust trait's
   *  `id()` return so the two sides agree on the same dictionary. */
  readonly id: string;
  /** Stream a chat and resolve with the full reply text. */
  send(args: ChatStreamArgs): Promise<string>;
}

/** Thrown by the cloud provider when the proxy returns 402 OR emits a
 *  `insufficient_balance_midstream` SSE event. The chat view catches
 *  this specifically and surfaces a "buy more credits" prompt that
 *  opens the StoreDialog. Generic provider errors don't warrant that
 *  affordance, so keep this distinct. */
export class InsufficientCloudCreditsError extends Error {
  balance: number;
  constructor(balance: number, message?: string) {
    super(
      message ??
        "Out of Tokori Cloud credits. Buy more under Settings → Cloud → Store.",
    );
    this.name = "InsufficientCloudCreditsError";
    this.balance = balance;
  }
}

/** Minimum slice of the cloud-context the cloud provider needs. Kept
 *  narrow so this module doesn't import the full React context (which
 *  would couple it to React lifecycles and make testing harder). */
export type CloudCtx = {
  account: {
    token: string;
    user: { id: number; email: string };
  } | null;
  tier: "fast" | "advanced";
  apiBase: string;
  refreshBalance: () => Promise<void>;
};

// ── Wire-format conversion ─────────────────────────────────────────────

/** Convert the frontend's persisted `ProviderConfig` (camelCase, DB
 *  shape) to the Rust enum's expected JSON (snake_case, tagged with
 *  `kind`). Lives next to the dispatcher because both Rust + cloud
 *  providers are routed through here. Cloud is intentionally absent —
 *  it never crosses the Tauri boundary. */
function toRustConfig(p: ProviderConfig): unknown {
  switch (p.kind) {
    case "ollama":
      return {
        kind: "ollama",
        host: p.host ?? "http://localhost:11434",
        model: p.model,
      };
    case "openai":
      return {
        kind: "openai",
        api_key: p.apiKey ?? "",
        model: p.model,
        base_url: p.baseUrl ?? null,
      };
    case "anthropic":
      return { kind: "anthropic", api_key: p.apiKey ?? "", model: p.model };
    case "gemini":
      return { kind: "gemini", api_key: p.apiKey ?? "", model: p.model };
    case "minimax":
      return {
        kind: "minimax",
        api_key: p.apiKey ?? "",
        model: p.model,
        base_url: p.baseUrl ?? null,
      };
    case "qwen":
      // DashScope's chat surface is OpenAI-compatible — reuse the Rust
      // OpenAI provider with the DashScope base URL. `baseUrl` may be
      // overridden to the mainland-China endpoint
      // (https://dashscope.aliyuncs.com/compatible-mode/v1); keys are
      // region-bound, so the row's URL is the source of truth.
      return {
        kind: "openai",
        api_key: p.apiKey ?? "",
        model: p.model,
        base_url:
          p.baseUrl ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      };
    case "tokori-cloud":
      // Cloud requests never reach Rust — `resolveChatProvider`
      // routes them to `CloudChatProvider` first. Reaching this arm
      // means a caller is mis-using the runtime.
      throw new Error("tokori-cloud cannot be routed through Rust");
  }
}

/** Public re-export so callers that build a provider config to test
 *  it (Settings → AI → "Test connection") can ship it across the
 *  Tauri boundary without re-doing the snake-case conversion. */
export function rustProviderConfig(p: ProviderConfig): unknown {
  return toRustConfig(p);
}

// ── RustChatProvider ───────────────────────────────────────────────────

class RustChatProvider implements ChatProvider {
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  get id(): string {
    return this.config.kind;
  }

  send(args: ChatStreamArgs): Promise<string> {
    const { messages, onToken, onDone, onError } = args;
    return new Promise<string>((resolve, reject) => {
      const channel = new Channel<ChatEvent>();
      let full = "";
      channel.onmessage = (event: ChatEvent) => {
        if (event.type === "token") {
          full += event.delta;
          onToken(event.delta);
        } else if (event.type === "error") {
          onError?.(event.message);
        }
        // `done` is intentionally ignored here — the IPC promise's
        // own resolved value carries the full reply, and we want a
        // single resolution path.
      };
      invoke<string>("chat_send", {
        config: toRustConfig(this.config),
        messages,
        onEvent: channel,
      })
        .then((reply) => {
          onDone?.(reply || full);
          resolve(reply || full);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          onError?.(msg);
          reject(err);
        });
    });
  }
}

// ── CloudChatProvider ──────────────────────────────────────────────────

class CloudChatProvider implements ChatProvider {
  readonly id = "tokori-cloud";
  private readonly cloud: CloudCtx;

  constructor(cloud: CloudCtx) {
    this.cloud = cloud;
  }

  async send(args: ChatStreamArgs): Promise<string> {
    // `onToken` / `onDone` are forwarded to `readCloudStream` via the
    // `args` object below; only the messages + `onError` are
    // consumed locally for the pre-stream auth / error response.
    const { messages, onError } = args;
    const account = this.cloud.account;
    if (!account) {
      const msg = "Sign in under Settings → Cloud first.";
      onError?.(msg);
      throw new Error(msg);
    }
    const url = `${this.cloud.apiBase}/api/ai/v1/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${account.token}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        messages,
        stream: true,
        // Cloud chat tier — `fast` (cheap text model) or `advanced`
        // (pricier reasoning model). The cloud route maps this to
        // the actual upstream model id and applies the tier-aware
        // credit rate. Defaults to `fast` server-side when omitted.
        tier: this.cloud.tier,
      }),
    });
    if (!res.ok || !res.body) {
      const data = (await res
        .json()
        .catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 402) {
        const balance = typeof data.balance === "number" ? data.balance : 0;
        // Best-effort refresh so the Settings card reflects reality
        // even when the user closes the chat without retrying.
        void this.cloud.refreshBalance().catch(() => {});
        const err = new InsufficientCloudCreditsError(balance);
        onError?.(err.message);
        throw err;
      }
      const errMsg =
        (typeof data.message === "string" && data.message) ||
        (typeof data.error === "string" && data.error) ||
        `Cloud chat failed (${res.status})`;
      onError?.(errMsg);
      throw new Error(errMsg);
    }
    return readCloudStream(res.body, args, this.cloud);
  }
}

/** Parse the cloud's OpenAI-compatible SSE stream into token deltas.
 *  Extracted so the provider class stays compact and so the parser
 *  can be unit-tested in isolation later (the cancel-on-DONE behaviour
 *  has bitten us once already). */
async function readCloudStream(
  body: ReadableStream<Uint8Array>,
  args: ChatStreamArgs,
  cloud: CloudCtx,
): Promise<string> {
  const { onToken, onDone, onError } = args;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let endOfStream = false;
  try {
    while (!endOfStream) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") {
            // Hard end-of-stream. We MUST break out and cancel the
            // reader (in the finally below) — without that, MiniMax
            // and similar upstreams hold the keep-alive open and
            // the client sits in reader.read() forever even though
            // every token has already arrived.
            endOfStream = true;
            break;
          }
          try {
            const parsed = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
              error?: string;
              message?: string;
              balance?: number;
            };
            // Mid-stream credit guard from the cloud route. Surface
            // as the same typed error a 402 would produce so the
            // UI's catch path is unified.
            if (parsed.error === "insufficient_balance_midstream") {
              const msg =
                parsed.message ||
                "Stopped mid-reply — you ran out of credits. Buy more to continue.";
              void cloud.refreshBalance().catch(() => {});
              const err = new InsufficientCloudCreditsError(
                parsed.balance ?? 0,
                msg,
              );
              onError?.(msg);
              throw err;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              full += delta;
              onToken(delta);
            }
          } catch (err) {
            if (err instanceof InsufficientCloudCreditsError) throw err;
            // heartbeat / partial JSON — ignore
          }
        }
        if (endOfStream) break;
      }
    }
  } finally {
    // Cancel the reader so the underlying HTTP connection can close
    // promptly. Without this, a stream that emitted [DONE] still
    // keeps its socket alive until the OS / upstream times out —
    // fine in theory, but it leaks file descriptors over a long
    // session.
    try {
      void reader.cancel();
    } catch {
      /* already closed */
    }
    // Whether the stream ended naturally or the user disconnected,
    // the cloud has already debited — refresh the balance so the UI
    // knows.
    void cloud.refreshBalance().catch(() => {});
  }
  onDone?.(full);
  return full;
}

// ── MockChatProvider ───────────────────────────────────────────────────

class MockChatProvider implements ChatProvider {
  readonly id = "mock";

  async send(args: ChatStreamArgs): Promise<string> {
    const { messages, onToken, onDone } = args;
    const { mockReply, streamMockReply } = await import("./mock-ai");
    const reply = mockReply(messages);
    let full = "";
    await streamMockReply(reply, (delta) => {
      full += delta;
      onToken(delta);
    });
    onDone?.(full);
    return full;
  }
}

// ── Dispatcher ─────────────────────────────────────────────────────────

/** Pick the right `ChatProvider` for the current active config + cloud
 *  account. Priority:
 *
 *   1. `tokori-cloud` config + signed-in cloud account → CloudChatProvider.
 *   2. Not in a Tauri context (`npm run dev`, demo iframe) → MockChatProvider.
 *   3. Real provider config in a Tauri context → RustChatProvider.
 *   4. No config at all → throw, since there's nothing reasonable to
 *      route to.
 *
 *  The cloud branch comes first so the HOSTED build (`isTauri() === false`
 *  but `cfg.kind === "tokori-cloud"`) routes to the real cloud chat
 *  rather than the mock. */
export function resolveChatProvider(
  cfg: ProviderConfig | null,
  cloud: CloudCtx,
): ChatProvider {
  if (cfg?.kind === "tokori-cloud" && cloud.account) {
    return new CloudChatProvider(cloud);
  }
  if (!isTauri()) {
    return new MockChatProvider();
  }
  if (!cfg) {
    throw new Error("No active provider");
  }
  return new RustChatProvider(cfg);
}
