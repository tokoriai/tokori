import { describe, expect, it } from "vitest";
import {
  detectFormat,
  parseCustomDict,
} from "@/lib/dictionaries/custom-import";

describe("detectFormat", () => {
  it("trusts the file extension first", () => {
    expect(detectFormat("my.json", "ignored")).toBe("json");
    expect(detectFormat("my.tsv", "ignored")).toBe("tsv");
    expect(detectFormat("my.csv", "ignored")).toBe("csv");
  });

  it("falls back to content when the extension is missing", () => {
    expect(detectFormat("noext", "[\n  {}\n]")).toBe("json");
    expect(detectFormat("noext", "{ \"a\": \"b\" }")).toBe("json");
    expect(detectFormat("noext", "word\tgloss\nfoo\tbar")).toBe("tsv");
    expect(detectFormat("noext", "word,gloss\nfoo,bar")).toBe("csv");
  });
});

describe("parseCustomDict", () => {
  it("parses a JSON array of {word, gloss, reading?}", () => {
    const out = parseCustomDict(
      "x.json",
      JSON.stringify([
        { word: "你好", reading: "nǐ hǎo", gloss: "hello" },
        { word: "再见", gloss: "goodbye" },
      ]),
    );
    expect(out).toEqual([
      { word: "你好", altWord: null, reading: "nǐ hǎo", gloss: "hello" },
      { word: "再见", altWord: null, reading: null, gloss: "goodbye" },
    ]);
  });

  it("parses a flat JSON object as word→gloss", () => {
    const out = parseCustomDict("x.json", '{"hola":"hello","adiós":"bye"}');
    expect(out).toEqual([
      { word: "hola", altWord: null, reading: null, gloss: "hello" },
      { word: "adiós", altWord: null, reading: null, gloss: "bye" },
    ]);
  });

  it("parses 2-column CSV without a header", () => {
    const out = parseCustomDict("x.csv", "hola,hello\nadiós,bye");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ word: "hola", altWord: null, reading: null, gloss: "hello" });
  });

  it("parses 3-column TSV with reading in the middle", () => {
    const out = parseCustomDict("x.tsv", "你好\tnǐ hǎo\thello\n再见\t\tgoodbye");
    expect(out).toEqual([
      { word: "你好", altWord: null, reading: "nǐ hǎo", gloss: "hello" },
      { word: "再见", altWord: null, reading: null, gloss: "goodbye" },
    ]);
  });

  it("folds extra columns into the gloss with semicolons", () => {
    const out = parseCustomDict("x.csv", "foo,bar,baz1,baz2");
    expect(out[0].gloss).toBe("baz1; baz2");
  });

  it("ignores comment lines and blanks", () => {
    const out = parseCustomDict(
      "x.csv",
      "# a comment\n\nhola,hello\n# another\nadiós,bye",
    );
    expect(out).toHaveLength(2);
  });

  it("throws when JSON is neither array nor object", () => {
    expect(() => parseCustomDict("x.json", '"just a string"')).toThrow();
  });
});
