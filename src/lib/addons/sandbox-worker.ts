/**
 * Addon sandbox worker (Stage 2).
 *
 * Runs inside a dedicated Web Worker: no `window`, no DOM, no Tauri IPC
 * injected. An addon's entry module is loaded here from a Blob URL and can
 * only reach the host app through the postMessage protocol below — that is
 * the trust boundary for untrusted, user-installed addon code.
 *
 * One worker instance per loaded addon (so addons can't see each other's
 * module state). Protocol:
 *   host → worker  { type: "load", id, kind, source }
 *                  { type: "parse", reqId, text }        (vocab-import)
 *   worker → host  { type: "loaded", id, meta }
 *                  { type: "load-error", id, error }
 *                  { type: "parse-result", reqId, rows }
 *                  { type: "parse-error", reqId, error }
 *
 * Note on `import()`: the CSP grants `script-src 'self' blob:`, so importing
 * an addon module from a Blob URL is permitted. `@vite-ignore` stops Vite
 * from trying to resolve the runtime URL at build time.
 */

type LoadMsg = { type: "load"; id: string; kind: string; source: string };
type ParseMsg = { type: "parse"; reqId: number; text: string };
type InMsg = LoadMsg | ParseMsg;

// `self` is the worker global at runtime; tsc sees the DOM `self`. Cast
// through `unknown` so this file compiles under the app's DOM lib without
// pulling in the WebWorker lib.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  postMessage: (message: unknown) => void;
};

let addon: { parse?: (t: string) => unknown; meta?: unknown } | null = null;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Strip `meta` down to the structured-cloneable fields. Anything else
 *  (e.g. an `icon` React component) can't cross the worker boundary and
 *  isn't needed host-side anyway. */
function cloneableMeta(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== "object") return {};
  const m = meta as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    "id",
    "name",
    "description",
    "fileExt",
    "supportedLangs",
    "excludedLangs",
  ]) {
    const v = m[key];
    if (v !== undefined && typeof v !== "function") out[key] = v;
  }
  return out;
}

ctx.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;

  if (msg.type === "load") {
    try {
      const url = URL.createObjectURL(
        new Blob([msg.source], { type: "text/javascript" }),
      );
      let mod: { default?: unknown };
      try {
        mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
      } finally {
        URL.revokeObjectURL(url);
      }
      const def = mod.default;
      if (!def || typeof def !== "object") {
        throw new Error("addon must `export default` an object");
      }
      if (
        msg.kind === "vocab-import" &&
        typeof (def as { parse?: unknown }).parse !== "function"
      ) {
        throw new Error("a vocab-import addon must export a parse() function");
      }
      addon = def as typeof addon;
      ctx.postMessage({
        type: "loaded",
        id: msg.id,
        meta: cloneableMeta((def as { meta?: unknown }).meta),
      });
    } catch (err) {
      ctx.postMessage({ type: "load-error", id: msg.id, error: errMsg(err) });
    }
    return;
  }

  if (msg.type === "parse") {
    try {
      if (!addon?.parse) throw new Error("addon not loaded");
      const rows = await addon.parse(msg.text);
      // `rows` are plain ImportRow objects → structured-cloneable. If a
      // buggy addon returns something with functions, postMessage throws
      // and we report it as a parse error rather than crashing the host.
      ctx.postMessage({ type: "parse-result", reqId: msg.reqId, rows });
    } catch (err) {
      ctx.postMessage({
        type: "parse-error",
        reqId: msg.reqId,
        error: errMsg(err),
      });
    }
  }
};
