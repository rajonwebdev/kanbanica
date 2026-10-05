import { describe, expect, it } from "vitest";
import { formatOffset, proposeCalendarDay } from "@/lib/timezone-migration";

describe("proposeCalendarDay", () => {
  it("keeps values that are already calendar days", () => {
    const p = proposeCalendarDay("2026-10-05", "Asia/Kolkata");
    expect(p.proposedDay).toBe("2026-10-05");
    expect(p.flags).toEqual([]);
    expect(p.needsReview).toBe(false);
  });

  it("recovers an India-picked day regardless of the workspace timezone", () => {
    // "Oct 5" picked in an IST browser.
    const stored = new Date("2026-10-04T18:30:00Z");
    for (const tz of ["Asia/Kolkata", "America/New_York", "UTC"]) {
      const p = proposeCalendarDay(stored, tz);
      expect(p.proposedDay).toBe("2026-10-05");
      expect(p.inferredOffsetMinutes).toBe(330);
      expect(p.needsReview).toBe(false);
    }
  });

  it("recovers a New York-picked day and reports its offset", () => {
    const p = proposeCalendarDay("2026-10-05T04:00:00.000Z", "Asia/Kolkata");
    expect(p.proposedDay).toBe("2026-10-05");
    expect(p.inferredOffsetMinutes).toBe(-240);
    expect(formatOffset(p.inferredOffsetMinutes)).toBe("-04:00");
  });

  it("notes when the workspace timezone would read the value differently", () => {
    // India-picked "Oct 5", read naively in a New York workspace = Oct 4.
    const p = proposeCalendarDay("2026-10-04T18:30:00Z", "America/New_York");
    expect(p.workspaceDay).toBe("2026-10-04");
    expect(p.flags).toContain("DIFFERS_FROM_WORKSPACE_TZ");
    expect(p.needsReview).toBe(false);
  });

  it("resolves values with a real time of day in the workspace timezone", () => {
    // A sprint started at 10:23 IST on Oct 2 → 04:53:12Z.
    const p = proposeCalendarDay("2026-10-02T04:53:12.331Z", "Asia/Kolkata");
    expect(p.flags).toContain("HAS_TIME_OF_DAY");
    expect(p.proposedDay).toBe("2026-10-02");
    expect(p.inferredOffsetMinutes).toBeNull();
  });

  it("flags the Hawaii / New Zealand band for review", () => {
    const p = proposeCalendarDay("2026-10-04T11:00:00Z", "Pacific/Auckland");
    expect(p.flags).toContain("AMBIGUOUS_OFFSET");
    expect(p.needsReview).toBe(true);
  });

  it("flags junk values instead of guessing", () => {
    for (const junk of ["not a date", 42, null, { a: 1 }]) {
      const p = proposeCalendarDay(junk, "UTC");
      expect(p.proposedDay).toBeNull();
      expect(p.flags).toEqual(["INVALID"]);
      expect(p.needsReview).toBe(true);
    }
  });
});

describe("formatOffset", () => {
  it("formats signed hours and minutes", () => {
    expect(formatOffset(330)).toBe("+05:30");
    expect(formatOffset(-300)).toBe("-05:00");
    expect(formatOffset(0)).toBe("+00:00");
    expect(formatOffset(null)).toBe("—");
  });
});
