import { describe, expect, it } from "vitest";
import { FREE_PACKS } from "@/lib/free-packs";

describe("FREE_PACKS registry", () => {
  it("has unique ids", () => {
    const ids = FREE_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every id starts with the 'free:' prefix", () => {
    for (const p of FREE_PACKS) {
      expect(p.id).toMatch(/^free:/);
    }
  });

  it("every entry has a language and a non-zero preview vocab count", () => {
    for (const p of FREE_PACKS) {
      expect(p.language).toMatch(/^[a-z]{2}$/);
      expect(p.preview.vocabCount).toBeGreaterThan(0);
    }
  });
});

describe("FREE_PACKS — lazy loading", () => {
  for (const entry of FREE_PACKS) {
    it(`${entry.id} loads + matches its declared shape`, async () => {
      const pack = await entry.load();
      expect(pack.schema).toBe("tokori-pack/v1");
      expect(pack.id).toBe(entry.id);
      expect(pack.language).toBe(entry.language);
      expect(pack.collections.length).toBeGreaterThan(0);

      // The registry's declared `preview.vocabCount` should roughly
      // match the size of the largest ("all") collection. Packs are
      // free to ship multiple collections (greetings, numbers, …)
      // and the "all" deck isn't always first — find by size.
      const largest = pack.collections.reduce(
        (a, b) => (b.words.length > a.words.length ? b : a),
        pack.collections[0],
      );
      expect(largest.words.length).toBeGreaterThan(0);
      const declared = entry.preview.vocabCount;
      expect(largest.words.length).toBeGreaterThanOrEqual(declared - 20);
      expect(largest.words.length).toBeLessThanOrEqual(declared + 50);

      // Every word entry has the required headword + gloss fields.
      for (const c of pack.collections) {
        for (const w of c.words) {
          expect(typeof w.word).toBe("string");
          expect(w.word.length).toBeGreaterThan(0);
          expect(typeof w.gloss === "string" && w.gloss.length > 0).toBe(true);
        }
      }
    });
  }
});
