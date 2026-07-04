import { describe, expect, it } from "vitest";
import { parseManifest } from "@/lib/addons/manifest";

function manifest(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    id: "demo-addon",
    name: "Demo",
    version: "1.0.0",
    description: "A demo",
    kind: "study",
    entry: "index.js",
    ...overrides,
  });
}

describe("parseManifest — happy path", () => {
  it("accepts a fully-populated manifest", () => {
    const result = parseManifest(
      manifest({
        author: "you",
        homepage: "https://example.com",
        license: "MIT",
        minAppVersion: "0.1.0",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("demo-addon");
      expect(result.manifest.kind).toBe("study");
      expect(result.manifest.license).toBe("MIT");
    }
  });

  it("trims display fields", () => {
    const result = parseManifest(manifest({ name: "  Demo  ", description: "  d  " }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("Demo");
      expect(result.manifest.description).toBe("d");
    }
  });
});

describe("parseManifest — rejections", () => {
  it("rejects invalid JSON", () => {
    const r = parseManifest("not json");
    expect(r.ok).toBe(false);
  });

  it("rejects a missing id", () => {
    const r = parseManifest(manifest({ id: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/id/);
  });

  it("rejects an UpperCase id", () => {
    const r = parseManifest(manifest({ id: "Demo-Addon" }));
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown kind", () => {
    const r = parseManifest(manifest({ kind: "nonsense" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/kind/);
  });

  it("rejects a non-semver version", () => {
    const r = parseManifest(manifest({ version: "v1" }));
    expect(r.ok).toBe(false);
  });

  it("rejects entry paths that escape the folder", () => {
    expect(parseManifest(manifest({ entry: "../sneaky.js" })).ok).toBe(false);
    expect(parseManifest(manifest({ entry: "/abs/sneaky.js" })).ok).toBe(false);
  });

  it("rejects empty entry", () => {
    expect(parseManifest(manifest({ entry: "" })).ok).toBe(false);
  });
});
