import { describe, expect, it } from "vitest";
import {
  ALL_FIELDS,
  defaultLayoutForKind,
  layoutsEqual,
  parseLayout,
  resolveLayout,
  serializeLayout,
  type CardLayout,
} from "@/lib/card-layout";

describe("card-layout — defaultLayoutForKind", () => {
  it("preserves today's vocab front/back (word → reading + definition)", () => {
    expect(defaultLayoutForKind("vocab")).toEqual({
      front: ["word"],
      back: ["reading", "definition"],
    });
  });
  it("puts translation first on sentence cards", () => {
    expect(defaultLayoutForKind("sentence")).toEqual({
      front: ["word"],
      back: ["translation", "definition"],
    });
  });
  it("flips to production-direction for writing cards", () => {
    expect(defaultLayoutForKind("writing")).toEqual({
      front: ["definition"],
      back: ["word", "reading"],
    });
  });
});

describe("card-layout — parse/serialize", () => {
  it("round-trips a valid layout", () => {
    const layout: CardLayout = {
      front: ["word", "image"],
      back: ["reading", "definition", "translation", "notes"],
    };
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it("returns null for null / empty / non-string-ish inputs", () => {
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout(undefined)).toBeNull();
    expect(parseLayout("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseLayout("not json")).toBeNull();
    expect(parseLayout("{front: word}")).toBeNull();
  });

  it("returns null when shape isn't an object with arrays", () => {
    expect(parseLayout(JSON.stringify(["word"]))).toBeNull();
    expect(parseLayout(JSON.stringify({ front: "word", back: [] }))).toBeNull();
    expect(parseLayout(JSON.stringify({ front: [], back: 1 }))).toBeNull();
  });

  it("drops unknown field ids silently (forward-compat)", () => {
    const raw = JSON.stringify({
      front: ["word", "future-field", 42],
      back: ["definition", "translation", "totally-unknown"],
    });
    expect(parseLayout(raw)).toEqual({
      front: ["word"],
      back: ["definition", "translation"],
    });
  });

  it("accepts empty face arrays (a face with no fields is a valid 'blank' side)", () => {
    expect(parseLayout(JSON.stringify({ front: [], back: ["word"] }))).toEqual({
      front: [],
      back: ["word"],
    });
  });
});

describe("card-layout — resolveLayout", () => {
  it("uses the stored layout when valid", () => {
    const stored = JSON.stringify({ front: ["definition"], back: ["word"] });
    expect(resolveLayout(stored, "vocab")).toEqual({
      front: ["definition"],
      back: ["word"],
    });
  });
  it("falls back to the kind default when the stored value is missing", () => {
    expect(resolveLayout(null, "vocab")).toEqual(defaultLayoutForKind("vocab"));
    expect(resolveLayout("", "sentence")).toEqual(defaultLayoutForKind("sentence"));
  });
  it("falls back to the kind default when the stored value is malformed", () => {
    expect(resolveLayout("oops not json", "writing")).toEqual(
      defaultLayoutForKind("writing"),
    );
  });
});

describe("card-layout — layoutsEqual", () => {
  it("is true for identical layouts", () => {
    expect(
      layoutsEqual(
        { front: ["word"], back: ["reading", "definition"] },
        { front: ["word"], back: ["reading", "definition"] },
      ),
    ).toBe(true);
  });
  it("is order-sensitive within a face", () => {
    expect(
      layoutsEqual(
        { front: ["word"], back: ["reading", "definition"] },
        { front: ["word"], back: ["definition", "reading"] },
      ),
    ).toBe(false);
  });
  it("ALL_FIELDS covers every FieldId exactly once", () => {
    expect(new Set(ALL_FIELDS).size).toBe(ALL_FIELDS.length);
  });
});
