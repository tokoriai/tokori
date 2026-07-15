import { describe, expect, it } from "vitest";
import { summarisePack, validatePack, type Pack } from "@/lib/pack-import";

function basePack(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "tokori-pack/v1",
    id: "test-pack",
    name: "Test pack",
    language: "zh",
    ...extra,
  };
}

describe("validatePack — media entries", () => {
  it("accepts a well-formed media list", () => {
    const res = validatePack(
      basePack({
        media: [
          {
            id: "show-1",
            kind: "series",
            title: "A Show",
            author: "Someone",
            url: "https://www.youtube.com/@someone",
            notes: "Watch this first.",
            episodes: [
              { position: 0, title: "Episode 1", vocab: [{ word: "你好" }] },
              { position: 1, title: "Episode 2" },
            ],
          },
          { id: "pod-1", kind: "podcast", title: "A Podcast" },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pack.media).toHaveLength(2);
  });

  it("treats a missing media field as an empty list", () => {
    const res = validatePack(basePack());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pack.media).toEqual([]);
  });

  it("rejects unknown media kinds", () => {
    const res = validatePack(
      basePack({ media: [{ id: "x", kind: "movie", title: "Nope" }] }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("kind");
  });

  it("rejects media entries without id or title", () => {
    const noId = validatePack(
      basePack({ media: [{ kind: "video", title: "T" }] }),
    );
    expect(noId.ok).toBe(false);
    const noTitle = validatePack(
      basePack({ media: [{ id: "x", kind: "video" }] }),
    );
    expect(noTitle.ok).toBe(false);
  });

  it("rejects malformed episodes", () => {
    const res = validatePack(
      basePack({
        media: [
          {
            id: "x",
            kind: "series",
            title: "T",
            episodes: [{ title: "missing position" }],
          },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("episode");
  });
});

describe("summarisePack — media counts", () => {
  it("counts items, episodes, and episode vocab", () => {
    const pack: Pack = {
      schema: "tokori-pack/v1",
      id: "p",
      name: "P",
      language: "zh",
      media: [
        {
          id: "a",
          kind: "series",
          title: "A",
          episodes: [
            { position: 0, title: "E1", vocab: [{ word: "一" }, { word: "二" }] },
            { position: 1, title: "E2" },
          ],
        },
        { id: "b", kind: "video", title: "B" },
      ],
    };
    const s = summarisePack(pack);
    expect(s.mediaCount).toBe(2);
    expect(s.mediaEpisodeCount).toBe(2);
    expect(s.mediaVocabCount).toBe(2);
  });

  it("reports zeros for packs without media", () => {
    const s = summarisePack({
      schema: "tokori-pack/v1",
      id: "p",
      name: "P",
      language: "zh",
    });
    expect(s.mediaCount).toBe(0);
    expect(s.mediaEpisodeCount).toBe(0);
    expect(s.mediaVocabCount).toBe(0);
  });
});
