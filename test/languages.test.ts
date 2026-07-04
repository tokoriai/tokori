import { describe, expect, it } from "vitest";
import {
  bcp47,
  languageGlyph,
  languageName,
  languageNative,
  LANGUAGES,
  PICKABLE_LANGUAGES,
  profileFor,
  tutorOpenerWithName,
} from "@/lib/languages";

describe("languages — name lookups", () => {
  it("returns the language name for known codes", () => {
    expect(languageName("zh")).toMatch(/Chinese/);
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("de")).toBe("German");
    expect(languageName("en")).toBe("English");
  });

  it("falls back to the code for unknown languages", () => {
    expect(languageName("xx")).toBe("xx");
  });

  it("returns the native name for known codes", () => {
    expect(languageNative("zh")).toBe("中文");
    expect(languageNative("ja")).toBe("日本語");
    expect(languageNative("de")).toBe("Deutsch");
  });

  it("returns a glyph for known codes", () => {
    expect(languageGlyph("zh")).toBeTruthy();
    expect(languageGlyph("ja")).toBeTruthy();
  });

  it("falls back to the upper-cased code as glyph for unknown languages", () => {
    expect(languageGlyph("xx")).toBe("XX");
  });
});

describe("languages — bcp47", () => {
  it("returns BCP-47 tags for the major supported languages", () => {
    // Used by Intl.Segmenter / SpeechSynthesis — must include a region for
    // Chinese / Portuguese / English so TTS picks the right voice.
    expect(bcp47("zh")).toMatch(/^zh(-|$)/);
    expect(bcp47("ja")).toMatch(/^ja(-|$)/);
    expect(bcp47("de")).toMatch(/^de(-|$)/);
  });
});

describe("languages — catalogues", () => {
  it("exposes all languages with required shape", () => {
    expect(LANGUAGES.length).toBeGreaterThan(0);
    for (const l of LANGUAGES) {
      expect(typeof l.code).toBe("string");
      expect(typeof l.name).toBe("string");
      expect(typeof l.nativeName).toBe("string");
      expect(typeof l.glyph).toBe("string");
    }
  });

  it("PICKABLE_LANGUAGES is a subset of LANGUAGES", () => {
    const all = new Set(LANGUAGES.map((l) => l.code));
    for (const l of PICKABLE_LANGUAGES) {
      expect(all.has(l.code)).toBe(true);
    }
  });
});

describe("languages — tutorOpenerWithName", () => {
  it("returns the plain opener unchanged when the name is blank", () => {
    expect(tutorOpenerWithName("en", "")).toBe(profileFor("en").onboardingPreview);
    expect(tutorOpenerWithName("zh", "   ")).toBe(profileFor("zh").onboardingPreview);
  });

  it("inserts a Latin vocative after the greeting word", () => {
    expect(tutorOpenerWithName("en", "Sam")).toBe(
      "Hi, Sam! I'm your conversation partner.",
    );
  });

  it("uses a fullwidth comma for Chinese", () => {
    expect(tutorOpenerWithName("zh", "Sam")).toBe(
      "你好，Sam！我是你的中文老师。",
    );
  });

  it("uses an ideographic comma for Japanese", () => {
    expect(tutorOpenerWithName("ja", "Sam")).toBe(
      "こんにちは、Sam。日本語の練習を始めましょう。",
    );
  });

  it("preserves the French space before the exclamation mark", () => {
    expect(tutorOpenerWithName("fr", "Sam")).toBe(
      "Bonjour, Sam ! Je suis votre tuteur de français.",
    );
  });

  it("keeps the Spanish opening ¡ outside the vocative", () => {
    expect(tutorOpenerWithName("es", "Sam")).toBe(
      "¡Hola, Sam! Soy tu tutor de español.",
    );
  });

  it("trims surrounding whitespace from the typed name", () => {
    expect(tutorOpenerWithName("en", "  Sam  ")).toBe(
      "Hi, Sam! I'm your conversation partner.",
    );
  });
});
