import { describe, expect, it } from "vitest";
import { parseVocabBlock } from "@/lib/vocab-block";

describe("parseVocabBlock", () => {
  it("parses three-column rows", () => {
    const raw = "苹果 | píngguǒ | apple\n香蕉 | xiāngjiāo | banana";
    expect(parseVocabBlock(raw)).toEqual([
      { word: "苹果", reading: "píngguǒ", meaning: "apple" },
      { word: "香蕉", reading: "xiāngjiāo", meaning: "banana" },
    ]);
  });

  it("parses two-column rows with a blank reading", () => {
    const raw = "Haus | house\nKatze | cat";
    expect(parseVocabBlock(raw)).toEqual([
      { word: "Haus", reading: "", meaning: "house" },
      { word: "Katze", reading: "", meaning: "cat" },
    ]);
  });

  it("skips blank lines and trims cells", () => {
    const raw = "\n  食べる  |  たべる  |  to eat  \n\n";
    expect(parseVocabBlock(raw)).toEqual([
      { word: "食べる", reading: "たべる", meaning: "to eat" },
    ]);
  });

  it("tolerates markdown-table pipes and separator rows", () => {
    const raw = [
      "| Word | Reading | Meaning |",
      "|------|---------|---------|",
      "| 水 | shuǐ | water |",
    ].join("\n");
    expect(parseVocabBlock(raw)).toEqual([
      { word: "水", reading: "shuǐ", meaning: "water" },
    ]);
  });

  it("skips a header row but keeps real words named like labels", () => {
    // Header row dropped...
    expect(parseVocabBlock("word | reading | meaning\n犬 | いぬ | dog")).toEqual([
      { word: "犬", reading: "いぬ", meaning: "dog" },
    ]);
    // ...but a genuine entry whose other cells aren't labels survives.
    expect(parseVocabBlock("word | wɜːd | a unit of language")).toEqual([
      { word: "word", reading: "wɜːd", meaning: "a unit of language" },
    ]);
  });

  it("returns an empty list for empty / whitespace input", () => {
    expect(parseVocabBlock("")).toEqual([]);
    expect(parseVocabBlock("   \n  \n")).toEqual([]);
  });
});
