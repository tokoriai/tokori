import { describe, expect, it } from "vitest";
import {
  glossMatch,
  normaliseReading,
  rankSearchHits,
} from "@/lib/dict-search-rank";
import type { DictEntry } from "@/lib/db";

function entry(word: string, gloss: string, reading = ""): DictEntry {
  return { word, altWord: null, reading, gloss, pitchAccent: null };
}

describe("normaliseReading", () => {
  it("strips tone marks, tone digits, and spaces", () => {
    expect(normaliseReading("nǐ hǎo")).toBe("nihao");
    expect(normaliseReading("ni3 hao3")).toBe("nihao");
    expect(normaliseReading("ni hao")).toBe("nihao");
  });

  it("handles null/empty", () => {
    expect(normaliseReading(null)).toBe("");
    expect(normaliseReading("")).toBe("");
  });
});

describe("glossMatch", () => {
  it("a whole sense equal to the query is an exact-sense match", () => {
    expect(glossMatch("eye; CL:隻|只[zhi1]", "eye")).toEqual({
      kind: "exact-sense",
      senseIndex: 0,
    });
  });

  it("finds the best match across senses and reports its index", () => {
    // sense 0 "eye socket" is only word-initial; sense 1 "eye" is exact.
    expect(glossMatch("eye socket; eye", "eye")).toEqual({
      kind: "exact-sense",
      senseIndex: 1,
    });
  });

  it("a sense that starts with the query word is word-initial", () => {
    expect(glossMatch("eye socket; vision", "eye")).toEqual({
      kind: "word-initial",
      senseIndex: 0,
    });
  });

  it("the query standing as its own word (not sense-initial) is a word match", () => {
    expect(glossMatch("apple of one's eye", "eye")).toEqual({
      kind: "word",
      senseIndex: 0,
    });
  });

  it("the query inside a larger word is only a substring match", () => {
    expect(glossMatch("eyebrow", "eye").kind).toBe("substring");
    expect(glossMatch("eyelash", "eye").kind).toBe("substring");
    // plural — "eye" is not a whole word inside "eyes".
    expect(glossMatch("eyes", "eye").kind).toBe("substring");
  });

  it("prefers a later whole-word sense over an earlier substring sense", () => {
    expect(glossMatch("eyebrow; the eye of the storm", "eye")).toEqual({
      kind: "word",
      senseIndex: 1,
    });
  });

  it("reports none when the query is absent from the gloss", () => {
    expect(glossMatch("to look; to watch", "eye").kind).toBe("none");
  });

  it("matches multi-word queries", () => {
    expect(glossMatch("to go; to walk", "to go")).toEqual({
      kind: "exact-sense",
      senseIndex: 0,
    });
  });

  it("treats CC-CEDICT '/'-style separators as sense boundaries too", () => {
    expect(glossMatch("eye/socket", "eye")).toEqual({
      kind: "exact-sense",
      senseIndex: 0,
    });
  });
});

describe("rankSearchHits — meaning search", () => {
  it("floats the precise noun above substring and buried-sense matches", () => {
    // The reported bug: searching "eye" in Chinese buried 眼睛 among
    // everything whose gloss merely contained the substring "eye".
    const entries = [
      entry("眉毛", "eyebrow"),
      entry("盯", "to stare; to fix one's eyes on"),
      entry("眼睛", "eye; CL:隻|只[zhi1]"),
      entry("目", "eye; item; section; list"),
      entry("看", "to look; to see"),
    ];
    const ranked = rankSearchHits(entries, "eye", "eye", true, 10).map(
      (e) => e.word,
    );
    // Exact-sense matches (目, 眼睛) come first, shorter headword first;
    // substring hits (眉毛, 盯) next; the non-match (看) last.
    expect(ranked).toEqual(["目", "眼睛", "眉毛", "盯", "看"]);
    // The core regression guard: the everyday word is at the very top,
    // not buried.
    expect(ranked.indexOf("眼睛")).toBeLessThan(2);
    expect(ranked.indexOf("眼睛")).toBeLessThan(ranked.indexOf("眉毛"));
  });

  it("ranks an exact-sense match above a word-initial one regardless of length", () => {
    const entries = [
      entry("眼镜", "eyeglasses; spectacles"), // substring
      entry("眼神", "eye expression; meaningful glance"), // word-initial
      entry("眼", "eye; small hole"), // exact-sense, sense 0
    ];
    const ranked = rankSearchHits(entries, "eye", "eye", true, 10).map(
      (e) => e.word,
    );
    expect(ranked[0]).toBe("眼");
    expect(ranked.indexOf("眼神")).toBeLessThan(ranked.indexOf("眼镜"));
  });
});

describe("rankSearchHits — headword & reading searches are unaffected", () => {
  it("an exact headword beats a prefix beats a meaning-only hit", () => {
    const entries = [
      entry("眼睛", "eye"), // 眼-prefix → primary 1
      entry("龙眼", "longan; dragon eye"), // gloss-only "eye" but query is 眼
      entry("眼", "eye; small hole"), // exact word → primary 0
    ];
    const ranked = rankSearchHits(entries, "眼", "眼", false, 10).map(
      (e) => e.word,
    );
    expect(ranked).toEqual(["眼", "眼睛", "龙眼"]);
  });

  it("pinyin reading matches outrank gloss matches", () => {
    const entries = [
      entry("你好", "hello", "nǐ hǎo"), // reading prefix → primary 3
      entry("你", "you; your", "nǐ"), // reading exact → primary 2
      entry("泥", "mud; clay", "ní"), // reading exact → primary 2
    ];
    const ranked = rankSearchHits(entries, "ni", "ni", true, 10).map(
      (e) => e.word,
    );
    // Both exact-reading single-char words come before the 2-char prefix.
    expect(ranked.indexOf("你好")).toBe(2);
    expect(ranked.slice(0, 2).sort()).toEqual(["你", "泥"]);
  });
});
