import { describe, expect, it } from "vitest";
import { detailCaps, strokeOrderChars } from "@/lib/dict-detail";

describe("detailCaps", () => {
  it("Chinese: pinyin + stroke order + compounds + stroke sidebar", () => {
    expect(detailCaps("zh")).toEqual({
      readingKind: "pinyin",
      strokeOrder: true,
      grammar: false,
      compounds: true,
      sidebar: "stroke",
    });
  });

  it("Japanese: furigana + stroke order, no compounds", () => {
    expect(detailCaps("ja")).toEqual({
      readingKind: "furigana",
      strokeOrder: true,
      grammar: false,
      compounds: false,
      sidebar: "stroke",
    });
  });

  it("Korean: romaja + pronunciation sidebar, no stroke order", () => {
    expect(detailCaps("ko")).toEqual({
      readingKind: "romaja",
      strokeOrder: false,
      grammar: false,
      compounds: false,
      sidebar: "pronunciation",
    });
  });

  it("German / Spanish: no reading, AI grammar + glance sidebar", () => {
    const de = detailCaps("de");
    expect(de).toEqual({
      readingKind: "none",
      strokeOrder: false,
      grammar: true,
      compounds: false,
      sidebar: "glance",
    });
    expect(detailCaps("es")).toEqual(de);
  });

  it("unknown / back-compat languages get safe bare defaults", () => {
    const bare = {
      readingKind: "none",
      strokeOrder: false,
      grammar: false,
      compounds: false,
      sidebar: "none",
    };
    expect(detailCaps("en")).toEqual(bare);
    expect(detailCaps("fr")).toEqual(bare);
    expect(detailCaps("xx")).toEqual(bare);
  });
});

describe("strokeOrderChars", () => {
  it("keeps Chinese hanzi", () => {
    expect(strokeOrderChars("学校")).toEqual(["学", "校"]);
    expect(strokeOrderChars("你好")).toEqual(["你", "好"]);
  });

  it("keeps Japanese kanji but drops kana", () => {
    expect(strokeOrderChars("食べる")).toEqual(["食"]);
    expect(strokeOrderChars("学校")).toEqual(["学", "校"]);
    expect(strokeOrderChars("こんにちは")).toEqual([]);
    expect(strokeOrderChars("カタカナ")).toEqual([]);
  });

  it("drops hangul and Latin entirely", () => {
    expect(strokeOrderChars("한국")).toEqual([]);
    expect(strokeOrderChars("Haus")).toEqual([]);
    expect(strokeOrderChars("casa")).toEqual([]);
  });

  it("extracts only the ideographs from a mixed string", () => {
    expect(strokeOrderChars("A学b")).toEqual(["学"]);
    expect(strokeOrderChars("読む man")).toEqual(["読"]);
  });

  it("returns an empty list for empty input", () => {
    expect(strokeOrderChars("")).toEqual([]);
  });
});
