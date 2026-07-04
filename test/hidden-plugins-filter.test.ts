/**
 * `pluginsForWorkspace` is the picker's source of truth: the
 * language gate from `pluginsForLanguage` PLUS the per-workspace
 * `hiddenPlugins` set. A bug here can lock the user out of modes
 * they want, or surface modes they explicitly hid. Pure data in,
 * pure list out — fast to cover the corners.
 */

import { describe, expect, it } from "vitest";
import {
  STUDY_PLUGINS,
  pluginsForLanguage,
  pluginsForWorkspace,
} from "@/lib/study/registry";

describe("pluginsForWorkspace", () => {
  it("matches pluginsForLanguage when nothing is hidden", () => {
    expect(pluginsForWorkspace("en", []).map((p) => p.meta.id)).toEqual(
      pluginsForLanguage("en").map((p) => p.meta.id),
    );
  });

  it("filters out hidden ids", () => {
    const all = pluginsForLanguage("zh").map((p) => p.meta.id);
    expect(all).toContain("hanzi-writing");
    const visible = pluginsForWorkspace("zh", ["hanzi-writing"]).map(
      (p) => p.meta.id,
    );
    expect(visible).not.toContain("hanzi-writing");
    expect(visible.length).toBe(all.length - 1);
  });

  it("accepts a Set as well as an array", () => {
    const hiddenList = pluginsForWorkspace("zh", ["hanzi-writing"]);
    const hiddenSet = pluginsForWorkspace("zh", new Set(["hanzi-writing"]));
    expect(hiddenList.map((p) => p.meta.id)).toEqual(
      hiddenSet.map((p) => p.meta.id),
    );
  });

  it("ignores ids that aren't language-available anyway", () => {
    // hanzi-writing is CJK-only, so hiding it for an English workspace
    // is a no-op rather than a crash. The list still matches the
    // base language gate.
    expect(
      pluginsForWorkspace("en", ["hanzi-writing"]).map((p) => p.meta.id),
    ).toEqual(pluginsForLanguage("en").map((p) => p.meta.id));
  });

  it("can hide every plugin (returns empty list)", () => {
    const allIds = STUDY_PLUGINS.map((p) => p.meta.id);
    expect(pluginsForWorkspace("zh", allIds)).toEqual([]);
  });

  it("never returns plugins the language gate excluded", () => {
    // hanzi-writing is CJK-only (`supportedLangs`) — the workspace
    // filter must respect that even with an empty hidden list.
    const ids = pluginsForWorkspace("de", []).map((p) => p.meta.id);
    expect(ids).not.toContain("hanzi-writing");
  });
});
