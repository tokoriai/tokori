/**
 * Build-time feature flags.
 *
 * One toggle drives the difference between the desktop app
 * (Tauri-bundled, BYOK providers, full feature set) and the hosted
 * web app (`app.tokori.ai`, Tokori-Cloud-only, paywalled).
 *
 * The flag is a Vite env var so terser can dead-code-eliminate any
 * branch behind a constant comparison: anything inside `if (HOSTED)
 * { ... }` or `if (!HOSTED) { ... }` is fully removed from the
 * other build's bundle. That's how we keep the hosted JS lean — no
 * shipping the FastEmbed bindings, the PDF-import path, or the
 * knowledge-FTS module to a hosted user who can't use them anyway.
 *
 * Builds:
 *   npm run build           — desktop (Tauri / static demo). HOSTED=false.
 *   npm run build:hosted    — web/cloud. HOSTED=true. dist-hosted/.
 *
 * Dev:
 *   npm run dev             — desktop dev (browser fallback).
 *   npm run dev:hosted      — hosted dev (auth gate + paywall + cloud provider).
 *
 * If you add new flag-gated behaviour, prefer reading HOSTED at the
 * top of the relevant module so the bundler can prove the dead
 * branch — `if (HOSTED) doX()` not `runtime ? doX() : doY()`.
 */

export const HOSTED: boolean =
  import.meta.env.VITE_HOSTED_MODE === "1" ||
  import.meta.env.VITE_HOSTED_MODE === "true";

/** Convenience: app surface name for copy. The desktop is "Tokori",
 *  hosted is also "Tokori" but with a "Cloud" suffix in places where
 *  the user benefits from knowing they're on the web variant. */
export const APP_NAME = "Tokori";
export const APP_SURFACE: "desktop" | "hosted" = HOSTED ? "hosted" : "desktop";

/**
 * Cloud API origin for every cross-module HTTP client
 * (cloud-context, cloud-client, cloud-dict, tts edge proxy).
 * Centralised here so the four call sites can't drift apart.
 *
 * Resolution (first match wins):
 *   1. `VITE_API_SAME_ORIGIN=1` — the cloud-served bundle (`app:build`
 *      sets this). Forces an empty base so `fetch("/api/...")` hits
 *      whatever host the page is on. This MUST win over an explicit
 *      base URL: the hosted SPA is served from its own origin
 *      (app.tokori.ai), so a stray `VITE_CLOUD_API_BASE_URL` left in a
 *      dev `.env.local` can't be allowed to point it cross-origin —
 *      the document CSP (`connect-src 'self'`) would block every API
 *      call, and there is no CORS between the hosts by design.
 *   2. `VITE_CLOUD_API_BASE_URL` — explicit absolute base for builds
 *      that are NOT same-origin (e.g. desktop dev in a browser hitting
 *      the remote API). An empty string here also forces same-origin.
 *   3. Vite dev → `http://localhost:3001`. Covers desktop dev (Tauri
 *      webview) and `dev:hosted` (Vite on 5173) — neither has the
 *      cloud API in scope, so both cross over to the Next dev server.
 *   4. Else (desktop prod) → `https://tokori.ai`.
 */
const PROD_CLOUD_API_BASE = "https://tokori.ai";
const ENV_CLOUD_API_BASE = import.meta.env?.VITE_CLOUD_API_BASE_URL as
  | string
  | undefined;
const CLOUD_API_SAME_ORIGIN = import.meta.env?.VITE_API_SAME_ORIGIN === "1";
export const CLOUD_API_BASE: string = CLOUD_API_SAME_ORIGIN
  ? ""
  : ENV_CLOUD_API_BASE != null
    ? ENV_CLOUD_API_BASE
    : import.meta.env?.DEV
      ? "http://localhost:3001"
      : PROD_CLOUD_API_BASE;
