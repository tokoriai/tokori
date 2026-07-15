/**
 * The Immersion ↔ Library split.
 *
 * Immersion is not a new data model — it's a lens over `library_items`
 * (same table, same sync kind, same cloud routes, same pack
 * idempotency on `source`). What separates the two views is the kind:
 * watch/listen media lives in Immersion, print lives in Library. This
 * module is the single source of truth for that split so the two views
 * can never both claim (or both orphan) a kind.
 */

import type { LibraryItem, LibraryKind } from "@/lib/db";

export const MEDIA_KINDS = ["video", "series", "podcast"] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

export function isMediaKind(kind: LibraryKind): kind is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(kind);
}

export function isMediaItem(item: Pick<LibraryItem, "kind">): boolean {
  return isMediaKind(item.kind);
}

/** Progress denominators differ per medium: a single video counts
 *  minutes, episodic media count episodes. Mirrored by the local API's
 *  `create_media` defaults (api_server.rs) — keep the two in sync. */
export const MEDIA_DEFAULT_UNIT: Record<MediaKind, string> = {
  video: "minutes",
  series: "episodes",
  podcast: "episodes",
};

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  video: "Video",
  series: "Series",
  podcast: "Podcast",
};
