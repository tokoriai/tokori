import { describe, expect, it } from "vitest";
import {
  pitchKind,
  pitchMora,
  pitchPattern,
  splitMora,
} from "@/lib/pitch";

describe("pitch — splitMora", () => {
  it("treats each base kana as its own mora", () => {
    expect(splitMora("たべる")).toEqual(["た", "べ", "る"]);
  });

  it("attaches small kana digraphs to the preceding mora (きょう = 2)", () => {
    expect(splitMora("きょう")).toEqual(["きょ", "う"]);
    expect(splitMora("にゅうがく")).toEqual(["にゅ", "う", "が", "く"]);
  });

  it("counts the moraic nasal ん as its own mora", () => {
    expect(splitMora("にほんご")).toEqual(["に", "ほ", "ん", "ご"]);
  });

  it("counts the geminate っ as its own mora", () => {
    expect(splitMora("がっこう")).toEqual(["が", "っ", "こ", "う"]);
  });

  it("counts the long-vowel mark ー as its own mora (katakana)", () => {
    expect(splitMora("コーヒー")).toEqual(["コ", "ー", "ヒ", "ー"]);
  });

  it("handles a mixed kana sequence", () => {
    expect(splitMora("ぎゅうにゅう")).toEqual(["ぎゅ", "う", "にゅ", "う"]);
  });
});

describe("pitch — pitchPattern", () => {
  it("heiban (accent=0) — first mora low, rest high", () => {
    expect(pitchPattern(3, 0)).toEqual(["low", "high", "high"]);
    expect(pitchPattern(4, 0)).toEqual(["low", "high", "high", "high"]);
  });

  it("atamadaka (accent=1) — first high, rest low", () => {
    expect(pitchPattern(3, 1)).toEqual(["high", "low", "low"]);
  });

  it("nakadaka (1 < accent < moraCount) — rise then drop after position N", () => {
    // accent=2 over 3 mora: L-H-L
    expect(pitchPattern(3, 2)).toEqual(["low", "high", "low"]);
    // accent=3 over 5 mora: L-H-H-L-L
    expect(pitchPattern(5, 3)).toEqual(["low", "high", "high", "low", "low"]);
  });

  it("odaka (accent=moraCount) — looks like heiban within the word, drop comes on the next particle", () => {
    // accent=3 over 3 mora: L-H-H (within-word pattern matches heiban)
    expect(pitchPattern(3, 3)).toEqual(["low", "high", "high"]);
  });

  it("treats a negative / NaN accent as heiban (defensive)", () => {
    expect(pitchPattern(2, -1)).toEqual(["low", "high"]);
    expect(pitchPattern(2, Number.NaN)).toEqual(["low", "high"]);
  });
});

describe("pitch — pitchMora", () => {
  it("tags each mora with its pitch for a known word", () => {
    // 食べる (たべる) is heiban (accent=0)
    expect(pitchMora("たべる", 0)).toEqual([
      { mora: "た", pitch: "low" },
      { mora: "べ", pitch: "high" },
      { mora: "る", pitch: "high" },
    ]);
  });

  it("respects digraphs in the mora split (きょう, accent=1 = atamadaka)", () => {
    expect(pitchMora("きょう", 1)).toEqual([
      { mora: "きょ", pitch: "high" },
      { mora: "う", pitch: "low" },
    ]);
  });

  it("returns mora with null pitch when accent data is missing", () => {
    expect(pitchMora("こんにちは", null)).toEqual([
      { mora: "こ", pitch: null },
      { mora: "ん", pitch: null },
      { mora: "に", pitch: null },
      { mora: "ち", pitch: null },
      { mora: "は", pitch: null },
    ]);
  });
});

describe("pitch — pitchKind", () => {
  it("classifies the four standard categories", () => {
    expect(pitchKind(3, 0)).toBe("heiban");
    expect(pitchKind(3, 1)).toBe("atamadaka");
    expect(pitchKind(3, 2)).toBe("nakadaka");
    expect(pitchKind(3, 3)).toBe("odaka");
  });
});
