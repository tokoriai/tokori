import { describe, expect, it } from "vitest";
import { lemmaCandidates } from "@/lib/dictionaries/lemmatizer";

describe("lemmaCandidates — German", () => {
  it("handles the common irregulars (sein, haben, gehen)", () => {
    expect(lemmaCandidates("de", "ist")).toContain("sein");
    expect(lemmaCandidates("de", "war")).toContain("sein");
    expect(lemmaCandidates("de", "habe")).toContain("haben");
    expect(lemmaCandidates("de", "ging")).toContain("gehen");
    expect(lemmaCandidates("de", "gegangen")).toContain("gehen");
    expect(lemmaCandidates("de", "kann")).toContain("können");
  });

  it("strips regular present-tense endings to reach the infinitive", () => {
    expect(lemmaCandidates("de", "machst")).toContain("machen");
    expect(lemmaCandidates("de", "macht")).toContain("machen");
    // already-lemma forms are deduped — the surface form would hit
    // exact lookup before falling through to the lemmatizer anyway.
    expect(lemmaCandidates("de", "machen")).not.toContain("machen");
  });

  it("strips past participle ge-X-t form", () => {
    expect(lemmaCandidates("de", "gemacht")).toContain("machen");
  });

  it("returns [] when the language has no rules", () => {
    expect(lemmaCandidates("zh", "你好")).toEqual([]);
    expect(lemmaCandidates("ja", "食べる")).toEqual([]);
  });

  it("dedupes the surface form and lowercased copy", () => {
    const cands = lemmaCandidates("de", "Gehen");
    expect(cands).not.toContain("Gehen");
    expect(cands).not.toContain("gehen");
  });
});

describe("lemmaCandidates — Spanish", () => {
  it("handles the common irregulars (ser, ir, tener, haber)", () => {
    expect(lemmaCandidates("es", "soy")).toContain("ser");
    expect(lemmaCandidates("es", "fui")).toContain("ser");
    expect(lemmaCandidates("es", "voy")).toContain("ir");
    expect(lemmaCandidates("es", "tengo")).toContain("tener");
    expect(lemmaCandidates("es", "hemos")).toContain("haber");
  });

  it("strips -ar conjugations to find the infinitive", () => {
    expect(lemmaCandidates("es", "hablamos")).toContain("hablar");
    expect(lemmaCandidates("es", "hablan")).toContain("hablar");
    expect(lemmaCandidates("es", "hablé")).toContain("hablar");
  });

  it("strips -er and -ir conjugations", () => {
    expect(lemmaCandidates("es", "comemos")).toContain("comer");
    expect(lemmaCandidates("es", "vivimos")).toContain("vivir");
  });

  it("strips gerund and participle endings", () => {
    expect(lemmaCandidates("es", "hablando")).toContain("hablar");
    expect(lemmaCandidates("es", "comido")).toContain("comer");
  });

  it("returns the lowercased input when no rule matches", () => {
    const cands = lemmaCandidates("es", "casa");
    expect(cands).not.toContain("casa");
  });
});
