import { describe, expect, it } from "vitest";
import {
  KIND_ORDER,
  collectionWordGid,
  parseCollectionWordGid,
  parsePdictGid,
  parseReviewGid,
  pdictGid,
  reviewGid,
} from "@/lib/sync/protocol";
import {
  FORCE_WIPE_SQL,
  KIND_SPECS,
  SYNCED_SETTING_KEYS,
  isSyncableSettingKey,
  settingKeyFromWire,
  settingKeyToWire,
} from "@/lib/sync/kinds";

describe("sync — composed gids", () => {
  it("review gid round-trips for every guid flavour", () => {
    const guids = [
      "3e880d89d490af58f8e96c8064ab92c9", // random hex (v32 trigger)
      "e380e724-f144-445f-9622-c33495530711:chat:10", // legacy install-uuid tag
      "srv:123", // server backfill
    ];
    for (const g of guids) {
      expect(parseReviewGid(reviewGid(g, 1_751_500_000))).toEqual({
        vocabGid: g,
        reviewedAt: 1_751_500_000,
      });
    }
  });

  it("collection-word and pdict gids round-trip", () => {
    expect(parseCollectionWordGid(collectionWordGid("srv:5", "abc"))).toEqual({
      collectionGid: "srv:5",
      vocabGid: "abc",
    });
    // Headwords may contain the other kinds' separators.
    expect(parsePdictGid(pdictGid("de", "E-Mail @ ~home: x"))).toEqual({
      lang: "de",
      word: "E-Mail @ ~home: x",
    });
  });
});

describe("sync — kind registry", () => {
  it("every kind has a spec and dependency order holds", () => {
    for (const kind of KIND_ORDER) {
      expect(KIND_SPECS[kind]).toBeDefined();
      expect(KIND_SPECS[kind].kind).toBe(kind);
    }
    const at = (k: string) => KIND_ORDER.indexOf(k as (typeof KIND_ORDER)[number]);
    expect(at("workspace")).toBeLessThan(at("vocab"));
    expect(at("vocab")).toBeLessThan(at("review"));
    expect(at("collection")).toBeLessThan(at("collectionWord"));
    expect(at("vocab")).toBeLessThan(at("collectionWord"));
    expect(at("libraryItem")).toBeLessThan(at("chapter"));
    expect(at("collection")).toBeLessThan(at("chapter"));
    expect(at("chat")).toBeLessThan(at("message"));
    expect(at("libraryItem")).toBeLessThan(at("readerDoc"));
  });

  it("force-wipe marks every table dirty=2 before any delete", () => {
    const firstDelete = FORCE_WIPE_SQL.findIndex((s) => s.startsWith("DELETE"));
    const lastMark = FORCE_WIPE_SQL.reduce(
      (acc, s, i) => (s.startsWith("UPDATE") ? i : acc),
      -1,
    );
    expect(firstDelete).toBeGreaterThan(-1);
    expect(lastMark).toBeLessThan(firstDelete);
  });
});

describe("sync — settings key mapping", () => {
  const gidById = (id: number) => (id === 12 ? "ws-gid-12" : null);
  const idByGid = (gid: string) => (gid === "ws-gid-12" ? 12 : null);

  it("curated global keys pass through unchanged", () => {
    for (const key of SYNCED_SETTING_KEYS) {
      expect(isSyncableSettingKey(key)).toBe(true);
      expect(settingKeyToWire(key, gidById)).toBe(key);
      expect(settingKeyFromWire(key, idByGid)).toBe(key);
    }
  });

  it("device-local keys never sync", () => {
    for (const key of [
      "cloud.account",
      "cloud.tier",
      "cloud.lastSyncAt",
      "sync.v2.state",
      "tokori.install.uuid",
      "window.width",
    ]) {
      expect(isSyncableSettingKey(key)).toBe(false);
      expect(settingKeyToWire(key, gidById)).toBeNull();
      expect(settingKeyFromWire(key, idByGid)).toBeNull();
    }
  });

  it("workspace study keys travel by gid, not by local id", () => {
    const wire = settingKeyToWire("workspace.12.study.srs", gidById);
    expect(wire).toBe("ws:ws-gid-12|study.srs");
    expect(settingKeyFromWire(wire!, idByGid)).toBe("workspace.12.study.srs");
  });

  it("gids containing colons survive the wire format", () => {
    // Legacy gids look like "<uuid>:chat:10" — the '|' separator keeps
    // parsing unambiguous where a ':' would not.
    const legacyGid = "e380e724-f144-445f-9622-c33495530711:tag:7";
    const wire = `ws:${legacyGid}|study.defaultPlugin`;
    expect(settingKeyFromWire(wire, (g) => (g === legacyGid ? 3 : null))).toBe(
      "workspace.3.study.defaultPlugin",
    );
  });

  it("unknown workspace gid on the receiving device maps to null", () => {
    expect(settingKeyFromWire("ws:nope|study.srs", idByGid)).toBeNull();
    // …and a workspace without a gid can't be pushed either.
    expect(settingKeyToWire("workspace.99.study.srs", gidById)).toBeNull();
  });
});
