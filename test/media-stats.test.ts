import { describe, expect, it } from "vitest";
import { formatWatchTime, watchTimeTotals } from "@/lib/media/stats";

// Fixed reference: noon local time so "today" spans 12h back to
// midnight regardless of timezone.
const NOW = new Date(2026, 6, 9, 12, 0, 0).getTime();
const nowSec = Math.floor(NOW / 1000);

function session(kind: string, agoSecs: number, durationSecs: number) {
  return { kind, startedAt: nowSec - agoSecs, durationSecs };
}

describe("watchTimeTotals", () => {
  it("buckets media-kind sessions into today / week / total", () => {
    const t = watchTimeTotals(
      [
        session("video", 3600, 600), // this morning → all three
        session("podcast", 2 * 86_400, 900), // 2 days ago → week + total
        session("listening", 20 * 86_400, 1200), // 3 weeks ago → total only
      ],
      NOW,
    );
    expect(t.todaySecs).toBe(600);
    expect(t.weekSecs).toBe(1500);
    expect(t.totalSecs).toBe(2700);
  });

  it("ignores non-media kinds and empty durations", () => {
    const t = watchTimeTotals(
      [
        session("review", 60, 999),
        session("reading", 60, 999),
        session("chat", 60, 999),
        { kind: "video", startedAt: nowSec - 60, durationSecs: null },
        { kind: "video", startedAt: nowSec - 60, durationSecs: 0 },
      ],
      NOW,
    );
    expect(t.totalSecs).toBe(0);
  });
});

describe("formatWatchTime", () => {
  it("renders minutes under an hour, h+m past it", () => {
    expect(formatWatchTime(0)).toBe("0m");
    expect(formatWatchTime(35 * 60)).toBe("35m");
    expect(formatWatchTime(5040)).toBe("1h 24m");
  });
});
