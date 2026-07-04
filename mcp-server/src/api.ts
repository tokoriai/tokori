// Thin HTTP client for the local Tokori API. Reads the bearer token off
// disk (the desktop app writes it to ~/.tokori/api-token on first launch),
// targets the loopback bind, and surfaces friendly errors when the app
// isn't running so the client can ask the user to start it instead of
// returning an opaque ECONNREFUSED.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE = process.env.TOKORI_API_URL || "http://127.0.0.1:53210";

function tokenPath(): string {
  return join(homedir(), ".tokori", "api-token");
}

function readToken(): string {
  // Env override is mostly for CI / scripted setups; the user-flow is the
  // file written by the desktop app's `api_server_start` command.
  if (process.env.TOKORI_API_TOKEN) return process.env.TOKORI_API_TOKEN.trim();
  const p = tokenPath();
  if (!existsSync(p)) {
    throw new Error(
      `Tokori API token not found at ${p}. Open the Tokori desktop app and start the local API from Settings → Local API, or set TOKORI_API_TOKEN.`,
    );
  }
  const t = readFileSync(p, "utf8").trim();
  if (!t) throw new Error(`API token file at ${p} is empty.`);
  return t;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = DEFAULT_BASE + path;
  const token = readToken();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Most common cause: app isn't running, or the local API was stopped
    // from Settings. Surface the actionable cause rather than the raw
    // fetch error.
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      0,
      "network.unreachable",
      `Could not reach Tokori at ${DEFAULT_BASE} (${msg}). Is the desktop app running with the local API enabled?`,
    );
  }
  const text = await resp.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON response — treat the raw text as the error message.
    }
  }
  if (!resp.ok) {
    const e =
      (json as { error?: { code?: string; message?: string } })?.error ?? {};
    throw new ApiError(
      resp.status,
      e.code ?? `http.${resp.status}`,
      e.message ?? text ?? `HTTP ${resp.status}`,
    );
  }
  return json;
}

// ── Typed wrappers ──────────────────────────────────────────────────────

export type Workspace = {
  id: number;
  target_lang: string;
  native_lang: string;
  name: string;
  goal_level: string | null;
  created_at: number;
  updated_at: number;
};
export type VocabEntry = {
  id: number;
  workspace_id: number;
  word: string;
  reading: string | null;
  gloss: string | null;
  status: string;
  added_at: number;
};
export type Collection = {
  id: number;
  workspace_id: number;
  name: string;
  description: string | null;
  is_default: number;
  source: string;
  preset_id: string | null;
  parent_collection_id: number | null;
  created_at: number;
  updated_at: number;
};
export type DictEntry = {
  word: string;
  alt_word: string | null;
  reading: string | null;
  gloss: string;
};
type Page<T> = { data: T[]; next_cursor?: string };

export async function listWorkspaces(): Promise<Workspace[]> {
  const r = (await request("GET", "/v1/workspaces")) as Page<Workspace>;
  return r.data;
}

export async function listVocab(
  workspaceId: number,
  opts: { status?: string; q?: string; limit?: number } = {},
): Promise<VocabEntry[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.q) params.set("q", opts.q);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const r = (await request(
    "GET",
    `/v1/workspaces/${workspaceId}/vocab${qs ? `?${qs}` : ""}`,
  )) as Page<VocabEntry>;
  return r.data;
}

export async function createVocab(
  workspaceId: number,
  body: {
    word: string;
    reading?: string;
    gloss?: string;
    collection_id?: number;
    source?: string;
    // Mining fields — the local API accepts these as of the
    // composer/extension parity work. Each is optional; a minimal
    // `{word}` request still works.
    kind?: "vocab" | "sentence" | "writing";
    front_extra?: string;
    card_notes?: string;
    image_data?: string;
    audio_data?: string;
    audio_mime?: string;
  },
): Promise<{ id: number; existed: boolean; word: string }> {
  return (await request("POST", `/v1/workspaces/${workspaceId}/vocab`, body)) as {
    id: number;
    existed: boolean;
    word: string;
  };
}

export async function listCollections(workspaceId: number): Promise<Collection[]> {
  const r = (await request(
    "GET",
    `/v1/workspaces/${workspaceId}/collections`,
  )) as Page<Collection>;
  return r.data;
}

export async function createCollection(
  workspaceId: number,
  body: { name: string; description?: string; parent_collection_id?: number },
): Promise<Collection> {
  return (await request(
    "POST",
    `/v1/workspaces/${workspaceId}/collections`,
    body,
  )) as Collection;
}

export async function listCollectionWords(collectionId: number): Promise<VocabEntry[]> {
  const r = (await request(
    "GET",
    `/v1/collections/${collectionId}/words`,
  )) as Page<VocabEntry>;
  return r.data;
}

export async function addWordsToCollection(
  collectionId: number,
  body: {
    vocab_ids?: number[];
    words?: { word: string; reading?: string; gloss?: string }[];
  },
): Promise<{ added: number; skipped: number; existed: number }> {
  return (await request(
    "POST",
    `/v1/collections/${collectionId}/words`,
    body,
  )) as { added: number; skipped: number; existed: number };
}

export async function importCollection(
  workspaceId: number,
  body: {
    name: string;
    description?: string;
    words: { word: string; reading?: string; gloss?: string }[];
  },
): Promise<{
  collection: Collection;
  added: number;
  existed: number;
  skipped: number;
}> {
  return (await request(
    "POST",
    `/v1/workspaces/${workspaceId}/collections/import`,
    body,
  )) as {
    collection: Collection;
    added: number;
    existed: number;
    skipped: number;
  };
}

export async function searchDict(
  lang: string,
  q: string,
  limit = 25,
): Promise<DictEntry[]> {
  const params = new URLSearchParams({ lang, q, limit: String(limit) });
  const r = (await request("GET", `/v1/dict/search?${params}`)) as Page<DictEntry>;
  return r.data;
}

export async function health(): Promise<{ status: string; service: string; version: string }> {
  return (await request("GET", "/v1/health")) as {
    status: string;
    service: string;
    version: string;
  };
}
