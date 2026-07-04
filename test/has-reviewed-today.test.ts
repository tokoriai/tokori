/**
 * `startOfLocalDayUnix` is the boundary the auto-drill flow uses to
 * decide whether today's SRS pass has already happened. A bug here
 * would either silently auto-drill new sessions (if it skews into
 * yesterday) or miss already-anchored ones (if it skews into
 * tomorrow). Pure-function test — the SQL / fb paths in `db.ts` use
 * this value verbatim.
 */

import { describe, expect, it } from "vitest";
import { startOfLocalDayUnix } from "@/lib/db";

describe("startOfLocalDayUnix", () => {
  it("returns midnight (00:00:00.000 local) as unix seconds", () => {
    const noon = new Date();
    noon.setHours(12, 34, 56, 789);
    const got = startOfLocalDayUnix(noon);
    const back = new Date(got * 1000);
    expect(back.getHours()).toBe(0);
    expect(back.getMinutes()).toBe(0);
    expect(back.getSeconds()).toBe(0);
    expect(back.getMilliseconds()).toBe(0);
    expect(back.getFullYear()).toBe(noon.getFullYear());
    expect(back.getMonth()).toBe(noon.getMonth());
    expect(back.getDate()).toBe(noon.getDate());
  });

  it("is stable across multiple calls within the same day", () => {
    const morning = new Date();
    morning.setHours(8, 15, 0, 0);
    const evening = new Date(morning);
    evening.setHours(22, 47, 0, 0);
    expect(startOfLocalDayUnix(morning)).toBe(startOfLocalDayUnix(evening));
  });

  it("rolls to the next boundary across midnight", () => {
    const lateMonday = new Date();
    lateMonday.setHours(23, 59, 59, 999);
    const earlyTuesday = new Date(lateMonday.getTime() + 2000); // +2s
    const monday = startOfLocalDayUnix(lateMonday);
    const tuesday = startOfLocalDayUnix(earlyTuesday);
    expect(tuesday).toBe(monday + 86_400);
  });

  it("returns an integer (unix seconds, not millis)", () => {
    const got = startOfLocalDayUnix(new Date());
    expect(Number.isInteger(got)).toBe(true);
    // Sanity: between 2020-01-01 and 2100-01-01.
    expect(got).toBeGreaterThan(1_577_836_800);
    expect(got).toBeLessThan(4_102_444_800);
  });
});
