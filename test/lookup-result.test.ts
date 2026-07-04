import { describe, expect, it } from "vitest";
import {
  EXAMPLES_DELIMITER,
  fromDict,
  parseGlossWithExamples,
} from "@/lib/lookup-result";
import type { DictEntry } from "@/lib/db";

const entry = (over: Partial<DictEntry> = {}): DictEntry => ({
  word: "歩く",
  altWord: null,
  reading: "あるく",
  gloss: "to walk",
  ...over,
});

describe("parseGlossWithExamples", () => {
  it("returns the gloss unchanged when there's no examples marker", () => {
    expect(parseGlossWithExamples("to walk; to go on foot")).toEqual({
      gloss: "to walk; to go on foot",
      examples: [],
    });
  });

  it("splits the gloss from an examples block and parses em-dash pairs", () => {
    const gloss =
      `to walk${EXAMPLES_DELIMITER}毎日歩く — I walk every day\n公園を歩く — to walk in the park`;
    const parsed = parseGlossWithExamples(gloss);
    expect(parsed.gloss).toBe("to walk");
    expect(parsed.examples).toEqual([
      { target: "毎日歩く", native: "I walk every day" },
      { target: "公園を歩く", native: "to walk in the park" },
    ]);
  });

  it("falls back to hyphen separators and tolerates target-only lines", () => {
    const gloss = `door${EXAMPLES_DELIMITER}- la puerta - the door\n- una puerta`;
    const parsed = parseGlossWithExamples(gloss);
    expect(parsed.gloss).toBe("door");
    expect(parsed.examples).toEqual([
      { target: "la puerta", native: "the door" },
      { target: "una puerta", native: "" },
    ]);
  });
});

describe("fromDict", () => {
  it("maps a plain dict row, defaulting pitchAccent to null", () => {
    expect(fromDict(entry())).toEqual({
      reading: "あるく",
      gloss: "to walk",
      traditional: null,
      examples: undefined,
      inflectionOf: undefined,
      pitchAccent: null,
    });
  });

  it("carries the traditional form (altWord) through for CC-CEDICT rows", () => {
    const result = fromDict(
      entry({ word: "学习", altWord: "學習", reading: "xué xí", gloss: "to study" }),
    );
    expect(result.traditional).toBe("學習");
  });

  it("carries pitch accent and inflectionOf through", () => {
    const result = fromDict(
      entry({ pitchAccent: 2, inflectionOf: "歩く", word: "歩いた" }),
    );
    expect(result.pitchAccent).toBe(2);
    expect(result.inflectionOf).toBe("歩く");
  });

  it("extracts examples embedded in the gloss column", () => {
    const result = fromDict(
      entry({ gloss: `to walk${EXAMPLES_DELIMITER}毎日歩く — I walk every day` }),
    );
    expect(result.gloss).toBe("to walk");
    expect(result.examples).toEqual([
      { target: "毎日歩く", native: "I walk every day" },
    ]);
  });
});
