import { describe, expect, it } from "vitest";
import {
  parseExamples,
  pickSavedExample,
  serialiseExamples,
  EXAMPLE_KEY,
  type ExampleSentence,
} from "@/lib/examples";

describe("examples — parseExamples", () => {
  it("returns an empty array for null / undefined / empty string", () => {
    expect(parseExamples(null)).toEqual([]);
    expect(parseExamples(undefined)).toEqual([]);
    expect(parseExamples("")).toEqual([]);
  });

  it("returns an empty array when the prefix doesn't match", () => {
    // Free-form notes from before the example feature shipped should
    // still parse cleanly to "no examples", not blow up.
    expect(parseExamples("just some user notes")).toEqual([]);
    expect(parseExamples("[]")).toEqual([]);
  });

  it("returns an empty array for malformed JSON", () => {
    expect(parseExamples(`${EXAMPLE_KEY}{not json}`)).toEqual([]);
    expect(parseExamples(`${EXAMPLE_KEY}null`)).toEqual([]);
  });

  it("filters out entries without a target string", () => {
    const raw = `${EXAMPLE_KEY}${JSON.stringify([
      { id: "1", target: "你好", source: "user" },
      { id: "2", source: "ai" }, // no target → dropped
      null,
      "garbage",
    ])}`;
    const parsed = parseExamples(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.target).toBe("你好");
  });

  it("round-trips a real example list", () => {
    const original: ExampleSentence[] = [
      { id: "1", target: "你好", native: "hello", source: "user" },
      { id: "2", target: "再见", source: "ai" },
    ];
    const wire = serialiseExamples(original);
    expect(wire.startsWith(EXAMPLE_KEY)).toBe(true);
    expect(parseExamples(wire)).toEqual(original);
  });
});

describe("examples — pickSavedExample", () => {
  const wire = (list: ExampleSentence[]) => serialiseExamples(list);

  it("returns null for empty / wordless inputs", () => {
    expect(pickSavedExample(null, "你好")).toBeNull();
    expect(pickSavedExample("", "你好")).toBeNull();
    expect(pickSavedExample(wire([{ id: "1", target: "你好", source: "ai" }]), "")).toBeNull();
  });

  it("returns the most recent example that contains the word", () => {
    const notes = wire([
      { id: "1", target: "我喝水", native: "I drink water", source: "ai" },
      { id: "2", target: "她在喝茶", native: "She is drinking tea", source: "ai" },
    ]);
    // Both contain 喝; the later one wins so re-entry shows the freshest save.
    expect(pickSavedExample(notes, "喝")?.id).toBe("2");
  });

  it("skips examples that don't contain the word", () => {
    const notes = wire([
      { id: "1", target: "我喝水", native: "I drink water", source: "ai" },
      { id: "2", target: "她在跑步", native: "She is running", source: "ai" },
    ]);
    // Newest (跑步) lacks 喝 → falls back to the older matching one.
    expect(pickSavedExample(notes, "喝")?.id).toBe("1");
  });

  it("matches case-insensitively for Latin scripts", () => {
    const notes = wire([
      { id: "1", target: "Voy a la tienda", native: "I go to the store", source: "user" },
    ]);
    expect(pickSavedExample(notes, "VOY")?.id).toBe("1");
  });

  it("returns null when nothing matches", () => {
    const notes = wire([{ id: "1", target: "你好", source: "ai" }]);
    expect(pickSavedExample(notes, "再见")).toBeNull();
  });
});
