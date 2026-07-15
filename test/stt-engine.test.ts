import { describe, expect, it } from "vitest";
import { resolveSttEngine } from "@/lib/stt";
import type { ProviderConfig } from "@/lib/db";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 1,
    kind: "openai",
    label: "OpenAI",
    model: "gpt-4o-mini",
    apiKey: "sk-test",
    host: null,
    baseUrl: null,
    isDefault: false,
    createdAt: 0,
    ...overrides,
  };
}

describe("resolveSttEngine", () => {
  const whisper = provider();

  it("auto prefers the browser engine when available", () => {
    expect(resolveSttEngine("auto", true, whisper, true)).toBe("browser");
    expect(resolveSttEngine("auto", true, null, false)).toBe("browser");
  });

  it("auto prefers a downloaded local model over the metered API", () => {
    // Free + private + offline beats paying per minute.
    expect(resolveSttEngine("auto", false, whisper, true)).toBe("local");
    expect(resolveSttEngine("auto", false, null, true)).toBe("local");
  });

  it("auto falls back to the whisper API when nothing else exists", () => {
    // The Linux/WebKitGTK case with no local model downloaded.
    expect(resolveSttEngine("auto", false, whisper, false)).toBe("whisper");
  });

  it("auto resolves to none on a bare setup", () => {
    expect(resolveSttEngine("auto", false, null, false)).toBe("none");
  });

  it("browser choice is strict — no silent fallback", () => {
    expect(resolveSttEngine("browser", true, whisper, true)).toBe("browser");
    expect(resolveSttEngine("browser", false, whisper, true)).toBe("none");
  });

  it("whisper choice is strict — no silent fallback", () => {
    expect(resolveSttEngine("whisper", true, whisper, true)).toBe("whisper");
    expect(resolveSttEngine("whisper", true, null, true)).toBe("none");
  });

  it("local choice is strict — needs a downloaded model", () => {
    expect(resolveSttEngine("local", true, whisper, true)).toBe("local");
    expect(resolveSttEngine("local", true, whisper, false)).toBe("none");
  });
});
