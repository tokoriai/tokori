import { describe, expect, it } from "vitest";
import { formatClock } from "@/components/mic-waveform";

describe("formatClock", () => {
  it("renders m:ss with zero-padded seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(999)).toBe("0:00");
    expect(formatClock(1_000)).toBe("0:01");
    expect(formatClock(59_999)).toBe("0:59");
    expect(formatClock(60_000)).toBe("1:00");
    expect(formatClock(73_400)).toBe("1:13");
    expect(formatClock(605_000)).toBe("10:05");
  });

  it("clamps negatives to zero", () => {
    // Clock skew between Date.now() and a stored startedAt must never
    // render "-1:-5".
    expect(formatClock(-5_000)).toBe("0:00");
  });
});
