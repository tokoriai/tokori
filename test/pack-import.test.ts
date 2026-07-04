import { describe, expect, it } from "vitest";
import { readPackFile, validatePack, summarisePack } from "@/lib/pack-import";

describe("pack-import — validatePack", () => {
  const validPack = {
    schema: "tokori-pack/v1",
    id: "test-pack",
    name: "Test pack",
    language: "zh",
    collections: [
      {
        id: "c1",
        name: "Collection 1",
        words: [
          { word: "你好", reading: "nǐ hǎo", gloss: "hello" },
        ],
      },
    ],
    textbooks: [],
  };

  it("accepts a minimal well-formed pack", () => {
    const r = validatePack(validPack);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pack.id).toBe("test-pack");
      expect(r.pack.collections).toHaveLength(1);
    }
  });

  it("rejects non-objects", () => {
    expect(validatePack(null).ok).toBe(false);
    expect(validatePack("string").ok).toBe(false);
    expect(validatePack(42).ok).toBe(false);
    expect(validatePack([]).ok).toBe(false); // arrays-as-pack don't satisfy "must be an object"... actually they do.
  });

  it("rejects an unsupported schema", () => {
    const r = validatePack({ ...validPack, schema: "tokori-pack/v2" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unsupported pack schema/);
  });

  it("requires id, name, and language", () => {
    expect(validatePack({ ...validPack, id: "" }).ok).toBe(false);
    expect(validatePack({ ...validPack, name: "" }).ok).toBe(false);
    expect(validatePack({ ...validPack, language: "" }).ok).toBe(false);
  });

  it("rejects collections missing a name or words array", () => {
    const broken = {
      ...validPack,
      collections: [{ id: "c1" }],
    };
    expect(validatePack(broken).ok).toBe(false);

    const noWords = {
      ...validPack,
      collections: [{ id: "c1", name: "C1" }],
    };
    expect(validatePack(noWords).ok).toBe(false);
  });

  it("rejects textbooks missing a chapters array", () => {
    const broken = {
      ...validPack,
      textbooks: [{ title: "T1" }],
    };
    expect(validatePack(broken).ok).toBe(false);
  });

  it("normalises missing collections / textbooks to empty arrays", () => {
    const r = validatePack({
      schema: "tokori-pack/v1",
      id: "p",
      name: "P",
      language: "zh",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pack.collections).toEqual([]);
      expect(r.pack.textbooks).toEqual([]);
    }
  });
});

describe("pack-import — summarisePack", () => {
  it("counts collections, words, textbooks, chapters", () => {
    const r = validatePack({
      schema: "tokori-pack/v1",
      id: "p",
      name: "P",
      language: "zh",
      collections: [
        { id: "c1", name: "C1", words: [{ word: "a" }, { word: "b" }] },
        { id: "c2", name: "C2", words: [{ word: "c" }] },
      ],
      textbooks: [
        {
          title: "T1",
          chapters: [
            { title: "Ch 1" },
            { title: "Ch 2" },
            { title: "Ch 3" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = summarisePack(r.pack);
    expect(s.collectionCount).toBe(2);
    expect(s.collectionWordCount).toBe(3);
    expect(s.textbookCount).toBe(1);
    expect(s.textbookChapterCount).toBe(3);
  });
});

describe("pack-import — readPackFile", () => {
  const validPack = {
    schema: "tokori-pack/v1",
    id: "file-pack",
    name: "File pack",
    language: "de",
    collections: [{ id: "c1", name: "Lesson 1", words: [{ word: "Hund" }] }],
    textbooks: [],
  };

  function file(contents: string, name = "pack.json"): File {
    return new File([contents], name, { type: "application/json" });
  }

  it("reads, parses, and validates a well-formed file", async () => {
    const r = await readPackFile(file(JSON.stringify(validPack)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pack.id).toBe("file-pack");
  });

  it("reports a friendly error for non-JSON contents", async () => {
    const r = await readPackFile(file("not json at all {{{"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid JSON/i);
  });

  it("surfaces schema validation errors from validatePack", async () => {
    const r = await readPackFile(file(JSON.stringify({ schema: "nope" })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/schema/i);
  });
});
