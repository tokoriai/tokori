/**
 * Media-link metadata probe for the Immersion add dialog: paste a
 * link, get title / channel / length back so the user doesn't type
 * what the page already knows.
 *
 * Desktop: the `media_probe` Tauri command (commands.rs) fetches
 * YouTube oEmbed + the watch page's `lengthSeconds` in Rust — the
 * webview can't fetch youtube.com cross-origin. Browser / hosted:
 * noembed.com (a CORS-friendly oEmbed proxy) supplies title + channel
 * only; no duration there.
 *
 * Best-effort everywhere: null just means "nothing prefilled".
 */

import { invoke, isTauri } from "@tauri-apps/api/core";

export type MediaProbe = {
  title: string | null;
  author: string | null;
  durationSecs: number | null;
};

export async function probeMediaUrl(url: string): Promise<MediaProbe | null> {
  if (isTauri()) {
    try {
      return await invoke<MediaProbe>("media_probe", { url });
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(
      `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      title?: string;
      author_name?: string;
      error?: string;
    };
    if (json.error) return null;
    return {
      title: json.title?.trim() || null,
      author: json.author_name?.trim() || null,
      durationSecs: null,
    };
  } catch {
    return null;
  }
}
