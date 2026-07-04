import { afterEach, describe, expect, it, vi } from "vitest";

// vitest defaults to a Node environment — `window` doesn't exist.
// We install a minimal global stub before each call so isDemoRequested
// reads the URL we're testing against.
async function check(href: string): Promise<boolean> {
  vi.resetModules();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window: { location: URL } }).window = { location: new URL(href) };
  try {
    const mod = await import("@/lib/demo-seed");
    return mod.isDemoRequested();
  } finally {
    if (previous === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previous;
    }
  }
}

describe("isDemoRequested", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("returns true with the ?demo=1 query flag", async () => {
    expect(await check("https://tokori.ai/?demo=1")).toBe(true);
    expect(await check("https://tokori.ai/anything?demo=1")).toBe(true);
  });

  it("returns true on the /demo path", async () => {
    expect(await check("https://tokori.ai/demo")).toBe(true);
    expect(await check("https://tokori.ai/demo/")).toBe(true);
    expect(await check("https://tokori.ai/demo/index.html")).toBe(true);
    expect(await check("https://tokori.ai/demo/assets/foo.js")).toBe(true);
  });

  it("returns false on unrelated paths without the flag", async () => {
    expect(await check("https://tokori.ai/")).toBe(false);
    expect(await check("https://tokori.ai/app/")).toBe(false);
    expect(await check("https://tokori.ai/pricing")).toBe(false);
    expect(await check("https://tokori.ai/demos/something")).toBe(false);
  });
});
