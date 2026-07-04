import { describe, expect, it } from "vitest";
import { GRAMMAR_KEY, parseGrammarProfile } from "@/lib/grammar-profile";

describe("parseGrammarProfile", () => {
  it("parses a clean German noun object", () => {
    const json = JSON.stringify({
      pos: "noun",
      lemma: "Haus",
      register: "neutral",
      noun: { gender: "n", article: "das", plural: "Häuser" },
      synonyms: ["Gebäude", "Heim"],
      notes: ["Diminutiv: Häuschen."],
    });
    expect(parseGrammarProfile(json)).toEqual({
      pos: "noun",
      lemma: "Haus",
      register: "neutral",
      noun: { gender: "n", article: "das", plural: "Häuser" },
      synonyms: ["Gebäude", "Heim"],
      notes: ["Diminutiv: Häuschen."],
    });
  });

  it("preserves a Spanish verb's present-tense order", () => {
    const json = JSON.stringify({
      pos: "verb",
      verb: {
        infinitive: "hablar",
        auxiliary: "haber",
        present: ["hablo", "hablas", "habla", "hablamos", "habláis", "hablan"],
        past: "habló",
        participle: "hablado",
      },
    });
    const result = parseGrammarProfile(json);
    expect(result?.verb?.present).toEqual([
      "hablo",
      "hablas",
      "habla",
      "hablamos",
      "habláis",
      "hablan",
    ]);
    expect(result?.verb?.participle).toBe("hablado");
  });

  it("recovers JSON wrapped in a markdown code fence", () => {
    const raw = '```json\n{"pos":"adjective","adjective":{"comparative":"größer","superlative":"am größten"}}\n```';
    expect(parseGrammarProfile(raw)).toEqual({
      pos: "adjective",
      adjective: { comparative: "größer", superlative: "am größten" },
    });
  });

  it("recovers JSON with a chatty preamble before the object", () => {
    const raw = 'Sure! Here is the grammar:\n{"pos":"noun","noun":{"gender":"f","article":"la"}}';
    expect(parseGrammarProfile(raw)).toEqual({
      pos: "noun",
      noun: { gender: "f", article: "la" },
    });
  });

  it("maps spelled-out gender words to the short form", () => {
    const json = JSON.stringify({
      pos: "noun",
      noun: { gender: "feminine", article: "la" },
    });
    expect(parseGrammarProfile(json)?.noun?.gender).toBe("f");
  });

  it("coerces an unknown part of speech to 'other'", () => {
    expect(parseGrammarProfile('{"pos":"banana"}')).toEqual({ pos: "other" });
  });

  it("clamps synonyms to 4 and notes to 2", () => {
    const json = JSON.stringify({
      pos: "noun",
      synonyms: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      notes: ["n1", "n2", "n3", "n4", "n5"],
    });
    const result = parseGrammarProfile(json);
    expect(result?.synonyms).toEqual(["a", "b", "c", "d"]);
    expect(result?.notes).toEqual(["n1", "n2"]);
  });

  it("drops a sub-object that doesn't match the part of speech", () => {
    const json = JSON.stringify({
      pos: "noun",
      noun: { gender: "m", article: "der" },
      verb: { infinitive: "should-be-dropped" },
    });
    const result = parseGrammarProfile(json);
    expect(result?.noun).toEqual({ gender: "m", article: "der" });
    expect(result?.verb).toBeUndefined();
  });

  it("drops empty-string fields rather than keeping blanks", () => {
    const json = JSON.stringify({
      pos: "noun",
      noun: { gender: "m", article: "  ", plural: "" },
    });
    expect(parseGrammarProfile(json)?.noun).toEqual({ gender: "m" });
  });

  it("returns null for unrecoverable input", () => {
    expect(parseGrammarProfile("not json at all")).toBeNull();
    expect(parseGrammarProfile("")).toBeNull();
    expect(parseGrammarProfile("{ broken: ")).toBeNull();
    expect(parseGrammarProfile("[1, 2, 3]")).toBeNull();
  });
});

describe("GRAMMAR_KEY", () => {
  it("namespaces by language and word", () => {
    expect(GRAMMAR_KEY("de", "Haus")).toBe("tokori.grammar.de.Haus");
    expect(GRAMMAR_KEY("es", "casa")).toBe("tokori.grammar.es.casa");
  });
});
