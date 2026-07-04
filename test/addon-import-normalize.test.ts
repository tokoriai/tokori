import { describe, expect, it } from "vitest";
import {
  normalizeRows,
  sanitizeImporterMeta,
} from "@/lib/addons/import-normalize";

const manifest = {
  id: "markdown-vocab-list",
  name: "Markdown vocab list",
  description: "from manifest",
};

describe("sanitizeImporterMeta", () => {
  it("uses the addon meta when present and strips leading dots from fileExt", () => {
    const meta = sanitizeImporterMeta(
      {
        id: "markdown-vocab-list",
        name: "MD list",
        description: "addon desc",
        fileExt: [".md", "txt"],
        supportedLangs: ["zh", "ja"],
      },
      manifest,
    );
    expect(meta.id).toBe("markdown-vocab-list");
    expect(meta.name).toBe("MD list");
    expect(meta.description).toBe("addon desc");
    expect(meta.fileExt).toEqual(["md", "txt"]);
    expect(meta.supportedLangs).toEqual(["zh", "ja"]);
  });

  it("falls back to the manifest for missing/invalid fields", () => {
    const meta = sanitizeImporterMeta({}, manifest);
    expect(meta.id).toBe(manifest.id);
    expect(meta.name).toBe(manifest.name);
    expect(meta.description).toBe(manifest.description);
    expect(meta.fileExt).toEqual([]);
    expect(meta.supportedLangs).toBeUndefined();
  });

  it("tolerates a non-object meta", () => {
    const meta = sanitizeImporterMeta(null, manifest);
    expect(meta.id).toBe(manifest.id);
    expect(meta.fileExt).toEqual([]);
  });
});

describe("normalizeRows", () => {
  it("keeps valid rows, trims, nulls blanks, drops the wordless", () => {
    const rows = normalizeRows([
      { word: " 喝 ", reading: "hē", gloss: "to drink", source: "x" },
      { word: "猫" }, // bare headword
      { word: "", gloss: "no word" }, // dropped
      { gloss: "missing word" }, // dropped
      "garbage", // dropped
      null,
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      word: "喝",
      altWord: null,
      reading: "hē",
      gloss: "to drink",
      source: "x",
    });
    expect(rows[1]).toEqual({
      word: "猫",
      altWord: null,
      reading: null,
      gloss: null,
    });
    // `source` is omitted (not null) when absent, matching ImportRow's optional shape.
    expect("source" in rows[1]).toBe(false);
  });

  it("returns [] for non-array input (a misbehaving addon)", () => {
    expect(normalizeRows(undefined)).toEqual([]);
    expect(normalizeRows("nope")).toEqual([]);
    expect(normalizeRows({ word: "not in an array" })).toEqual([]);
  });
});
