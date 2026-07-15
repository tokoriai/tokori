import { describe, expect, it } from "vitest";
import {
  canonicalMediaKey,
  mediaThumbnail,
  mediaUrlsMatch,
  mediaUrlWithResume,
  parseMediaUrl,
} from "@/lib/media/url";

/**
 * Canonical-key vectors — the shared contract with the Rust twin
 * (`src-tauri/src/media_url.rs`, `#[cfg(test)] mod tests`). A key
 * change here must land there too, or the extension's by-URL progress
 * reports stop matching what the frontend stored.
 */
const KEY_VECTORS: Array<[url: string, key: string]> = [
  // YouTube — one video, many spellings
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "yt:dQw4w9WgXcQ"],
  ["https://youtu.be/dQw4w9WgXcQ?t=42", "yt:dQw4w9WgXcQ"],
  ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxyz", "yt:dQw4w9WgXcQ"],
  ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "yt:dQw4w9WgXcQ"],
  ["youtube.com/shorts/dQw4w9WgXcQ/", "yt:dQw4w9WgXcQ"],
  ["https://www.youtube.com/live/dQw4w9WgXcQ?feature=share", "yt:dQw4w9WgXcQ"],
  ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "yt:dQw4w9WgXcQ"],
  ["https://www.youtube.com/playlist?list=PLabcDEF123", "yt:pl:PLabcDEF123"],
  // Channel page has no video id — generic key, still branded YouTube
  ["https://www.youtube.com/@somechannel/videos", "web:youtube.com/@somechannel/videos"],
  // Netflix
  ["https://www.netflix.com/watch/81091393?trackId=14170286", "nf:81091393"],
  ["https://www.netflix.com/title/80057281", "nf:80057281"],
  // Spotify (locale prefixes alias the same show)
  ["https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk", "sp:episode:4rOoJ6Egrf8K2IrywzwOMk"],
  ["https://open.spotify.com/intl-de/show/2mTUnDkuKUkhiueKcVWoP0?si=abc", "sp:show:2mTUnDkuKUkhiueKcVWoP0"],
  // Apple Podcasts — show vs specific episode (`i` param)
  ["https://podcasts.apple.com/us/podcast/some-show/id123456789?i=1000634", "ap:123456789:1000634"],
  ["https://podcasts.apple.com/de/podcast/some-show/id123456789", "ap:123456789"],
  // Vimeo / Bilibili
  ["https://vimeo.com/76979871", "vimeo:76979871"],
  ["https://www.bilibili.com/video/BV1GJ411x7h7?p=2", "bili:BV1GJ411x7h7"],
  // Generic web — query/fragment/trailing slash are volatile; a
  // non-default port is identity (self-hosted servers)
  ["https://example.com/shows/my-show/", "web:example.com/shows/my-show"],
  ["example.com/a?q=1#frag", "web:example.com/a"],
  ["localhost:8096/web/index.html", "web:localhost:8096/web/index.html"],
  ["HTTPS://WWW.EXAMPLE.COM/Mixed/Case", "web:example.com/Mixed/Case"],
];

describe("canonicalMediaKey", () => {
  it.each(KEY_VECTORS)("%s → %s", (url, key) => {
    expect(canonicalMediaKey(url)).toBe(key);
  });

  it("returns null for things that aren't web URLs", () => {
    expect(canonicalMediaKey("")).toBeNull();
    expect(canonicalMediaKey("   ")).toBeNull();
    expect(canonicalMediaKey("My Great Show")).toBeNull();
    expect(canonicalMediaKey("mailto:x@y.example")).toBeNull();
    expect(canonicalMediaKey("file:///tmp/x.mp4")).toBeNull();
    expect(canonicalMediaKey("spotify:episode:abc")).toBeNull();
  });

  it("rejects malformed YouTube video ids rather than minting bogus keys", () => {
    // Query id with illegal chars falls through to the generic key.
    expect(canonicalMediaKey("https://www.youtube.com/watch?v=bad id!")).toBe(
      "web:youtube.com/watch",
    );
  });
});

describe("parseMediaUrl", () => {
  it("suggests kinds by medium", () => {
    expect(parseMediaUrl("https://youtu.be/dQw4w9WgXcQ")?.suggestedKind).toBe("video");
    expect(parseMediaUrl("https://www.youtube.com/playlist?list=PL1")?.suggestedKind).toBe("series");
    expect(parseMediaUrl("https://www.netflix.com/title/80057281")?.suggestedKind).toBe("series");
    expect(parseMediaUrl("https://www.netflix.com/watch/81091393")?.suggestedKind).toBe("video");
    expect(parseMediaUrl("https://open.spotify.com/show/2mTUnDkuKUkhiueKcVWoP0")?.suggestedKind).toBe("podcast");
    expect(parseMediaUrl("https://mypodcasthost.com/feed/123")?.suggestedKind).toBe("podcast");
    expect(parseMediaUrl("https://example.com/clip")?.suggestedKind).toBe("video");
  });

  it("labels the big providers by name and the rest by host", () => {
    expect(parseMediaUrl("https://youtu.be/dQw4w9WgXcQ")?.providerLabel).toBe("YouTube");
    expect(parseMediaUrl("https://www.netflix.com/watch/1")?.providerLabel).toBe("Netflix");
    expect(parseMediaUrl("https://vimeo.com/76979871")?.providerLabel).toBe("Vimeo");
    expect(parseMediaUrl("https://blog.example.org/video/9")?.providerLabel).toBe("blog.example.org");
  });

  it("keeps the YouTube badge on non-video YouTube pages", () => {
    const parsed = parseMediaUrl("https://www.youtube.com/@somechannel");
    expect(parsed?.provider).toBe("youtube");
    expect(parsed?.providerLabel).toBe("YouTube");
  });
});

describe("mediaThumbnail", () => {
  it("derives the YouTube poster across URL spellings", () => {
    expect(mediaThumbnail("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    );
    expect(mediaThumbnail("youtube.com/shorts/dQw4w9WgXcQ/")).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    );
  });

  it("has no poster for playlists, other providers, or junk", () => {
    expect(mediaThumbnail("https://www.youtube.com/playlist?list=PL1")).toBeNull();
    expect(mediaThumbnail("https://www.netflix.com/watch/81091393")).toBeNull();
    expect(mediaThumbnail("not a url")).toBeNull();
  });
});

describe("mediaUrlWithResume", () => {
  it("decorates YouTube links with a resume timestamp past 30s", () => {
    expect(mediaUrlWithResume("https://youtu.be/dQw4w9WgXcQ", 754)).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s",
    );
  });

  it("leaves early positions, playlists, and other providers alone", () => {
    expect(mediaUrlWithResume("https://youtu.be/dQw4w9WgXcQ", 10)).toBe(
      "https://youtu.be/dQw4w9WgXcQ",
    );
    expect(mediaUrlWithResume("https://youtu.be/dQw4w9WgXcQ", null)).toBe(
      "https://youtu.be/dQw4w9WgXcQ",
    );
    expect(mediaUrlWithResume("https://www.youtube.com/playlist?list=PL1", 500)).toBe(
      "https://www.youtube.com/playlist?list=PL1",
    );
    expect(mediaUrlWithResume("https://www.netflix.com/watch/81091393", 500)).toBe(
      "https://www.netflix.com/watch/81091393",
    );
  });
});

describe("mediaUrlsMatch", () => {
  it("matches the same video across URL spellings", () => {
    expect(
      mediaUrlsMatch(
        "https://youtu.be/dQw4w9WgXcQ",
        "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=99s",
      ),
    ).toBe(true);
  });

  it("distinguishes different content and tolerates junk", () => {
    expect(mediaUrlsMatch("https://youtu.be/dQw4w9WgXcQ", "https://youtu.be/oHg5SJYRHA0")).toBe(false);
    expect(mediaUrlsMatch("not a url", "https://youtu.be/dQw4w9WgXcQ")).toBe(false);
    expect(mediaUrlsMatch(null, undefined)).toBe(false);
  });
});
