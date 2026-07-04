import { describe, expect, it } from "vitest";
import {
  applyPatch,
  enrichersForLanguage,
  type CardDraft,
  type CardEnricher,
  type CardPatch,
  type EnricherContext,
} from "@/lib/card-enrich/api";
import dictAutoload from "@/lib/card-enrich/enrichers/dict-autoload";
import ttsAudio from "@/lib/card-enrich/enrichers/tts-audio";
import { CARD_ENRICHERS } from "@/lib/card-enrich/registry";
import type { DictEntry } from "@/lib/db";

const baseDraft: CardDraft = {
  workspaceId: 1,
  targetLang: "zh",
  nativeLang: "en",
  word: "你好",
  kind: "vocab",
  reading: null,
  gloss: null,
  frontExtra: null,
  cardNotes: null,
  imageData: null,
  audioBytes: null,
  audioMime: null,
};

function ctx(overrides: Partial<EnricherContext> = {}): EnricherContext {
  return {
    sendChat: null,
    synthesize: null,
    lookupDict: async () => null,
    knownVocab: async () => [],
    ...overrides,
  };
}

describe("applyPatch", () => {
  it("returns a new object — never mutates the input draft", () => {
    const next = applyPatch(baseDraft, { reading: "nǐ hǎo" });
    expect(next).not.toBe(baseDraft);
    expect(baseDraft.reading).toBeNull();
    expect(next.reading).toBe("nǐ hǎo");
  });

  it("treats `undefined` as 'no change'", () => {
    const next = applyPatch(
      { ...baseDraft, reading: "ni hao", gloss: "hello" },
      { gloss: undefined },
    );
    expect(next.reading).toBe("ni hao");
    expect(next.gloss).toBe("hello");
  });

  it("treats explicit `null` as 'clear the field'", () => {
    const next = applyPatch(
      { ...baseDraft, reading: "ni hao" },
      { reading: null },
    );
    expect(next.reading).toBeNull();
  });

  it("preserves immutable draft identity for unrelated fields", () => {
    const seed = { ...baseDraft, gloss: "hi", cardNotes: "note" };
    const next = applyPatch(seed, { gloss: "hello" });
    expect(next.gloss).toBe("hello");
    expect(next.cardNotes).toBe("note");
  });
});

describe("enrichersForLanguage", () => {
  function fakeEnricher(
    id: string,
    languages?: ReadonlyArray<"zh" | "ja"> | "*",
  ): CardEnricher {
    return {
      meta: {
        id,
        name: id,
        description: "",
        targets: ["reading"],
        trigger: "manual",
        languages,
      },
      run: async () => ({}),
    };
  }

  it("filters to enrichers that target the active language", () => {
    const list = [
      fakeEnricher("zh-only", ["zh"]),
      fakeEnricher("ja-only", ["ja"]),
      fakeEnricher("everywhere", "*"),
      fakeEnricher("no-languages-field"),
    ];
    const zh = enrichersForLanguage(list, "zh");
    expect(zh.map((e) => e.meta.id)).toEqual([
      "zh-only",
      "everywhere",
      "no-languages-field",
    ]);
  });
});

describe("dict-autoload enricher", () => {
  const dictEntry: DictEntry = {
    word: "你好",
    altWord: null,
    reading: "nǐ hǎo",
    gloss: "hello; hi",
    inflectionOf: null,
  };

  it("fills blank reading and gloss from a dict hit", async () => {
    const patch = await dictAutoload.run(
      baseDraft,
      ctx({ lookupDict: async () => dictEntry }),
    );
    expect(patch.reading).toBe("nǐ hǎo");
    expect(patch.gloss).toBe("hello; hi");
  });

  it("does not overwrite user input — empty patch when both filled", async () => {
    const draft: CardDraft = {
      ...baseDraft,
      reading: "user-typed",
      gloss: "user-typed",
    };
    const patch = await dictAutoload.run(
      draft,
      ctx({ lookupDict: async () => dictEntry }),
    );
    expect(patch).toEqual({});
  });

  it("falls back to translate when dict has no entry", async () => {
    const patch = await dictAutoload.run(
      baseDraft,
      ctx({
        lookupDict: async () => null,
        translateFallback: async () => "the greeting word",
      }),
    );
    expect(patch.gloss).toBe("the greeting word");
    // Translate fills only gloss — never invents a phonetic reading.
    expect(patch.reading).toBeUndefined();
  });

  it("returns empty patch when both dict and translate miss", async () => {
    const patch = await dictAutoload.run(
      baseDraft,
      ctx({
        lookupDict: async () => null,
        translateFallback: async () => null,
      }),
    );
    expect(patch).toEqual({});
  });

  it("swallows dict errors and tries the translate fallback", async () => {
    const patch = await dictAutoload.run(
      baseDraft,
      ctx({
        lookupDict: async () => {
          throw new Error("network down");
        },
        translateFallback: async () => "fallback gloss",
      }),
    );
    expect(patch.gloss).toBe("fallback gloss");
  });

  it("is no-op on empty word", async () => {
    const patch = await dictAutoload.run(
      { ...baseDraft, word: "  " },
      ctx({ lookupDict: async () => dictEntry }),
    );
    expect(patch).toEqual({});
  });
});

describe("tts-audio enricher", () => {
  it("writes audio bytes + mime when synthesize succeeds", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const patch = await ttsAudio.run(
      baseDraft,
      ctx({ synthesize: async () => ({ bytes, mime: "audio/wav" }) }),
    );
    expect(patch.audioBytes).toEqual(bytes);
    expect(patch.audioMime).toBe("audio/wav");
  });

  it("returns empty patch when synthesize is null (no TTS configured)", async () => {
    const patch = await ttsAudio.run(baseDraft, ctx({ synthesize: null }));
    expect(patch).toEqual({});
  });

  it("does NOT overwrite existing audio — empty patch on filled draft", async () => {
    const draft: CardDraft = {
      ...baseDraft,
      audioBytes: new Uint8Array([99]),
      audioMime: "audio/mpeg",
    };
    const patch = await ttsAudio.run(
      draft,
      ctx({
        synthesize: async () => ({
          bytes: new Uint8Array([1, 2, 3]),
          mime: "audio/wav",
        }),
      }),
    );
    expect(patch).toEqual({});
  });

  it("returns empty patch when synthesize throws (graceful degradation)", async () => {
    const patch = await ttsAudio.run(
      baseDraft,
      ctx({
        synthesize: async () => {
          throw new Error("tts provider unreachable");
        },
      }),
    );
    expect(patch).toEqual({});
  });
});

describe("CARD_ENRICHERS registry", () => {
  it("ships exactly the three built-in enrichers", () => {
    expect(CARD_ENRICHERS.map((e) => e.meta.id).sort()).toEqual([
      "ai-cloze",
      "dict-autoload",
      "tts-audio",
    ]);
  });

  it("has unique ids", () => {
    const ids = CARD_ENRICHERS.map((e) => e.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has at most one 'auto' enricher writing each target — avoids races", () => {
    // Auto enrichers run on word-set without coordination. If two
    // auto enrichers both wrote `gloss`, the second would clobber
    // the first non-deterministically. The architecture allows
    // multiple auto enrichers but each target should be owned by
    // at most one.
    const autos = CARD_ENRICHERS.filter((e) => e.meta.trigger === "auto");
    const targetOwners = new Map<string, string>();
    for (const e of autos) {
      for (const t of e.meta.targets) {
        if (targetOwners.has(t)) {
          throw new Error(
            `Two auto enrichers write '${t}': ` +
              `${targetOwners.get(t)} and ${e.meta.id}`,
          );
        }
        targetOwners.set(t, e.meta.id);
      }
    }
    expect(autos.length).toBeGreaterThan(0);
  });

  it("respects priority ordering — dict-autoload runs first in sweeps", () => {
    const sorted = [...CARD_ENRICHERS].sort(
      (a, b) => (b.meta.priority ?? 0) - (a.meta.priority ?? 0),
    );
    expect(sorted[0]?.meta.id).toBe("dict-autoload");
  });
});

describe("patch composition — manual sweep semantics", () => {
  it("merging multiple patches converges on the expected draft", () => {
    let draft = baseDraft;
    const patches: CardPatch[] = [
      { reading: "nǐ hǎo", gloss: "hello" }, // dict-autoload
      { frontExtra: "{{c1::你好}}, 我是 Tokori." }, // ai-cloze
      { audioBytes: new Uint8Array([42]), audioMime: "audio/mpeg" }, // tts-audio
    ];
    for (const p of patches) draft = applyPatch(draft, p);
    expect(draft.reading).toBe("nǐ hǎo");
    expect(draft.gloss).toBe("hello");
    expect(draft.frontExtra).toContain("{{c1::你好}}");
    expect(draft.audioBytes).toEqual(new Uint8Array([42]));
    expect(draft.audioMime).toBe("audio/mpeg");
  });

  it("empty patch from an enricher is a no-op (used for 'nothing to fill')", () => {
    const before = { ...baseDraft, reading: "ni hao", gloss: "hello" };
    const after = applyPatch(before, {});
    expect(after).toEqual(before);
  });
});
