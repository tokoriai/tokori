/**
 * Media-URL intelligence for the Immersion library.
 *
 * The watch list stores whatever link the user (or the Companion
 * extension) had in the address bar, but the same video hides behind
 * many spellings — `youtu.be/ID`, `youtube.com/watch?v=ID&t=42s`,
 * `m.youtube.com/…`. Progress reporting has to answer "is the thing
 * playing in the browser one of the items in my list?", so every URL
 * reduces to a **canonical media key**:
 *
 *   yt:<videoId>        YouTube video (watch / shorts / live / embed / youtu.be)
 *   yt:pl:<listId>      YouTube playlist page (list without a specific video)
 *   nf:<id>             Netflix /watch/<id> or /title/<id>
 *   sp:<type>:<id>      Spotify episode/show
 *   ap:<showId>[:<ep>]  Apple Podcasts (episode when the `i` param is present)
 *   vimeo:<id>          Vimeo video
 *   bili:<id>           Bilibili /video/<id>
 *   web:<host>/<path>   Everything else — lowercased host (www. stripped),
 *                       path without trailing slash, query + fragment dropped
 *
 * The Rust twin in `src-tauri/src/media_url.rs` implements the SAME
 * grammar for the local API's by-URL matching (`/v1/media/progress`,
 * `/v1/media/lookup`) — the two share the test vectors in
 * `test/media-url.test.ts`. Change one, change both.
 */

import type { MediaKind } from "./kinds";

export type MediaProvider =
  | "youtube"
  | "netflix"
  | "spotify"
  | "apple"
  | "vimeo"
  | "bilibili"
  | "web";

export type ParsedMediaUrl = {
  provider: MediaProvider;
  /** Canonical identity — equal keys mean "the same content". */
  key: string;
  /** Card-friendly source name: "YouTube", "Netflix", … else the bare host. */
  providerLabel: string;
  /** Best-guess kind for prefilling the add dialog. */
  suggestedKind: MediaKind;
};

const PROVIDER_LABEL: Record<Exclude<MediaProvider, "web">, string> = {
  youtube: "YouTube",
  netflix: "Netflix",
  spotify: "Spotify",
  apple: "Apple Podcasts",
  vimeo: "Vimeo",
  bilibili: "Bilibili",
};

/** YouTube ids are 11 chars today, but that's convention, not contract —
 *  accept the documented charset at plausible lengths. */
const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;

function parseHttpUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s) return null;
  // Scheme handling, mirrored by the Rust twin:
  //   "<scheme>://…"          → parse as-is, web schemes only
  //   "<word>:<non-digit>…"   → a schemeful non-web URI (mailto:, spotify:) — reject
  //   anything else           → the https:// the user didn't type
  // The digit test keeps bare "host:port/path" (colon + port) alive
  // without letting "mailto:x@y" masquerade as userinfo after prefixing.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
  if (!hasScheme && /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(s)) return null;
  try {
    const u = new URL(hasScheme ? s : `https://${s}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Hostname with the noise prefixes dropped: `www.` always, plus the
 *  mobile/music subdomains that alias the same content on the big
 *  providers. */
function coreHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
}

function pathSegments(u: URL): string[] {
  return u.pathname.split("/").filter(Boolean);
}

function youtubeKey(u: URL, host: string): string | null {
  const segs = pathSegments(u);
  if (host === "youtu.be") {
    const id = segs[0];
    return id && YT_ID.test(id) ? `yt:${id}` : null;
  }
  const v = u.searchParams.get("v");
  if (v && YT_ID.test(v)) return `yt:${v}`;
  const first = segs[0];
  if ((first === "shorts" || first === "live" || first === "embed") && segs[1] && YT_ID.test(segs[1])) {
    return `yt:${segs[1]}`;
  }
  // A playlist page only counts when no specific video is selected —
  // watch?v=…&list=… is a video (handled above), /playlist?list=… is
  // the series itself.
  const list = u.searchParams.get("list");
  if (first === "playlist" && list) return `yt:pl:${list}`;
  return null;
}

/**
 * Reduce a URL to its canonical media identity. Returns `null` for
 * strings that aren't http(s) URLs at all.
 */
export function parseMediaUrl(raw: string): ParsedMediaUrl | null {
  const u = parseHttpUrl(raw);
  if (!u) return null;
  const host = coreHost(u);
  const segs = pathSegments(u);

  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
    const key = youtubeKey(u, host);
    if (key) {
      return {
        provider: "youtube",
        key,
        providerLabel: PROVIDER_LABEL.youtube,
        suggestedKind: key.startsWith("yt:pl:") ? "series" : "video",
      };
    }
    // Channel pages, search results, … fall through to the generic key
    // below but keep the YouTube badge.
    return { provider: "youtube", key: genericKey(u), providerLabel: PROVIDER_LABEL.youtube, suggestedKind: "video" };
  }

  if (host === "netflix.com") {
    // /watch/<id> is a playing episode/film; /title/<id> is the landing
    // page people actually share — typically a show, hence "series".
    if ((segs[0] === "watch" || segs[0] === "title") && segs[1] && /^\d+$/.test(segs[1])) {
      return {
        provider: "netflix",
        key: `nf:${segs[1]}`,
        providerLabel: PROVIDER_LABEL.netflix,
        suggestedKind: segs[0] === "title" ? "series" : "video",
      };
    }
    return { provider: "netflix", key: genericKey(u), providerLabel: PROVIDER_LABEL.netflix, suggestedKind: "series" };
  }

  if (host === "open.spotify.com" || host === "spotify.com") {
    // Locale prefix (`/intl-de/…`) aliases the same content.
    const s = segs[0]?.startsWith("intl-") ? segs.slice(1) : segs;
    if ((s[0] === "episode" || s[0] === "show") && s[1]) {
      return {
        provider: "spotify",
        key: `sp:${s[0]}:${s[1]}`,
        providerLabel: PROVIDER_LABEL.spotify,
        suggestedKind: "podcast",
      };
    }
    return { provider: "spotify", key: genericKey(u), providerLabel: PROVIDER_LABEL.spotify, suggestedKind: "podcast" };
  }

  if (host === "podcasts.apple.com") {
    // …/podcast/<slug>/id<digits>[?i=<episode>]
    const idSeg = segs.find((seg) => /^id\d+$/.test(seg));
    if (idSeg) {
      const show = idSeg.slice(2);
      const episode = u.searchParams.get("i");
      return {
        provider: "apple",
        key: episode ? `ap:${show}:${episode}` : `ap:${show}`,
        providerLabel: PROVIDER_LABEL.apple,
        suggestedKind: "podcast",
      };
    }
    return { provider: "apple", key: genericKey(u), providerLabel: PROVIDER_LABEL.apple, suggestedKind: "podcast" };
  }

  if (host === "vimeo.com" && segs[0] && /^\d+$/.test(segs[0])) {
    return { provider: "vimeo", key: `vimeo:${segs[0]}`, providerLabel: PROVIDER_LABEL.vimeo, suggestedKind: "video" };
  }

  if (host === "bilibili.com" && segs[0] === "video" && segs[1]) {
    return { provider: "bilibili", key: `bili:${segs[1]}`, providerLabel: PROVIDER_LABEL.bilibili, suggestedKind: "video" };
  }

  return {
    provider: "web",
    key: genericKey(u),
    providerLabel: host,
    suggestedKind: /podcast/.test(host) ? "podcast" : "video",
  };
}

/** Fallback identity: host + path, everything volatile stripped.
 *  `URL.host` keeps a non-default port (self-hosted media servers)
 *  and drops :80/:443 — the Rust twin reproduces both. */
function genericKey(u: URL): string {
  const host = u.host.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  return `web:${host}${path}`;
}

/** Canonical key, or `null` when the string isn't an http(s) URL. */
export function canonicalMediaKey(raw: string): string | null {
  return parseMediaUrl(raw)?.key ?? null;
}

/** Poster/thumbnail for the card, derived from the link — YouTube's
 *  predictable CDN scheme covers the dominant case; other providers
 *  need API calls we don't make, so they fall back to the kind icon.
 *  (`library_items.cover_url`, when set, wins over this — see the
 *  Immersion card.) */
export function mediaThumbnail(raw: string): string | null {
  const key = canonicalMediaKey(raw);
  if (!key || !key.startsWith("yt:") || key.startsWith("yt:pl:")) return null;
  return `https://i.ytimg.com/vi/${key.slice(3)}/mqdefault.jpg`;
}

/** The item's URL decorated with a resume position where the provider
 *  supports one (YouTube `&t=`). Early positions (<30 s) and other
 *  providers open unchanged — a resume link into the first seconds is
 *  noise, and non-YouTube sites ignore or reject the param. */
export function mediaUrlWithResume(
  raw: string,
  positionSec: number | null | undefined,
): string {
  const key = canonicalMediaKey(raw);
  if (!key || !key.startsWith("yt:") || key.startsWith("yt:pl:")) return raw;
  if (!positionSec || positionSec < 30) return raw;
  return `https://www.youtube.com/watch?v=${key.slice(3)}&t=${Math.floor(positionSec)}s`;
}

/** Do two URLs point at the same content? Non-URLs never match. */
export function mediaUrlsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ka = canonicalMediaKey(a);
  return ka != null && ka === canonicalMediaKey(b);
}
