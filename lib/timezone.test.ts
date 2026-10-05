import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addCalendarDays,
  calendarDayFromLocalDate,
  calendarDayInTimeZone,
  canonicalTimeZone,
  coerceCalendarDay,
  compareCalendarDays,
  DEFAULT_TIMEZONE,
  dayOfWeek,
  diffCalendarDays,
  endOfWeekDay,
  formatCalendarDay,
  formatInstantInTimeZone,
  formatUtcOffset,
  isAmbiguousLegacyMidnight,
  isCalendarDay,
  isValidTimeZone,
  listTimeZones,
  localDateFromCalendarDay,
  looksLikeLocalMidnight,
  nearestUtcMidnightDay,
  parseCalendarDayInput,
  resolveTimeZone,
  startOfDayInstant,
  startOfWeekDay,
  timeZoneOffsetMinutes,
  todayIn,
} from "@/lib/timezone";

// Every result must be identical no matter which timezone the server (or the
// test machine) runs in — so the whole suite runs once per server timezone.
const SERVER_TIMEZONES = [
  "UTC",
  "Asia/Kolkata",
  "America/New_York",
  "Europe/Berlin",
];

const at = (iso: string) => new Date(iso);

describe.each(SERVER_TIMEZONES)("with the server running in %s", (serverTz) => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = serverTz;
  });
  afterAll(() => {
    process.env.TZ = originalTz;
  });

  describe("isValidTimeZone / resolveTimeZone", () => {
    it("accepts IANA names", () => {
      expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
      expect(isValidTimeZone("America/New_York")).toBe(true);
      expect(isValidTimeZone("UTC")).toBe(true);
    });

    it("rejects junk and empty values", () => {
      expect(isValidTimeZone("Mars/Olympus")).toBe(false);
      expect(isValidTimeZone("")).toBe(false);
    });

    it("falls back to UTC for missing or invalid zones", () => {
      expect(resolveTimeZone(null)).toBe(DEFAULT_TIMEZONE);
      expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIMEZONE);
      expect(resolveTimeZone("Mars/Olympus")).toBe(DEFAULT_TIMEZONE);
      expect(resolveTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    });
  });

  describe("isCalendarDay", () => {
    it("accepts real days and rejects malformed or impossible ones", () => {
      expect(isCalendarDay("2026-10-05")).toBe(true);
      expect(isCalendarDay("2028-02-29")).toBe(true);
      expect(isCalendarDay("2026-02-29")).toBe(false);
      expect(isCalendarDay("2026-13-01")).toBe(false);
      expect(isCalendarDay("2026-10-5")).toBe(false);
      expect(isCalendarDay("2026-10-05T00:00:00Z")).toBe(false);
    });
  });

  describe("calendarDayInTimeZone / todayIn", () => {
    // 2026-10-05 12:00 UTC = 17:30 IST = 08:00 EDT = 14:00 CEST
    const noonUtc = at("2026-10-05T12:00:00Z");

    it("gives the same day everywhere for a mid-day instant", () => {
      expect(calendarDayInTimeZone(noonUtc, "Asia/Kolkata")).toBe("2026-10-05");
      expect(calendarDayInTimeZone(noonUtc, "America/New_York")).toBe(
        "2026-10-05"
      );
      expect(calendarDayInTimeZone(noonUtc, "Europe/Berlin")).toBe(
        "2026-10-05"
      );
    });

    it("splits the day for a late-evening UTC instant", () => {
      // 20:00 UTC is already Oct 6 in India, still Oct 5 in New York.
      const evening = at("2026-10-05T20:00:00Z");
      expect(calendarDayInTimeZone(evening, "Asia/Kolkata")).toBe("2026-10-06");
      expect(calendarDayInTimeZone(evening, "America/New_York")).toBe(
        "2026-10-05"
      );
    });

    it("rolls over exactly at workspace-local midnight", () => {
      // Oct 5 18:29:59Z = 23:59:59 IST; 18:30:00Z = 00:00 IST on Oct 6.
      expect(todayIn("Asia/Kolkata", at("2026-10-05T18:29:59Z"))).toBe(
        "2026-10-05"
      );
      expect(todayIn("Asia/Kolkata", at("2026-10-05T18:30:00Z"))).toBe(
        "2026-10-06"
      );
      // 03:59:59Z = 23:59:59 EDT on Oct 4; 04:00Z = 00:00 EDT on Oct 5.
      expect(todayIn("America/New_York", at("2026-10-05T03:59:59Z"))).toBe(
        "2026-10-04"
      );
      expect(todayIn("America/New_York", at("2026-10-05T04:00:00Z"))).toBe(
        "2026-10-05"
      );
    });

    it("treats an invalid timezone as UTC", () => {
      expect(todayIn("Mars/Olympus", at("2026-10-05T23:30:00Z"))).toBe(
        "2026-10-05"
      );
    });
  });

  describe("timeZoneOffsetMinutes", () => {
    it("reports fixed and DST-dependent offsets", () => {
      expect(
        timeZoneOffsetMinutes(at("2026-01-15T12:00:00Z"), "Asia/Kolkata")
      ).toBe(330);
      expect(
        timeZoneOffsetMinutes(at("2026-01-15T12:00:00Z"), "America/New_York")
      ).toBe(-300);
      expect(
        timeZoneOffsetMinutes(at("2026-07-15T12:00:00Z"), "America/New_York")
      ).toBe(-240);
      expect(
        timeZoneOffsetMinutes(at("2026-01-15T12:00:00Z"), "Europe/Berlin")
      ).toBe(60);
      expect(
        timeZoneOffsetMinutes(at("2026-07-15T12:00:00Z"), "Europe/Berlin")
      ).toBe(120);
      expect(timeZoneOffsetMinutes(at("2026-07-15T12:00:00Z"), "UTC")).toBe(0);
    });
  });

  describe("addCalendarDays / diffCalendarDays", () => {
    it("adds and subtracts across month and year boundaries", () => {
      expect(addCalendarDays("2026-10-05", 7)).toBe("2026-10-12");
      expect(addCalendarDays("2026-12-30", 3)).toBe("2027-01-02");
      expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
      expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    });

    // A 1-week sprint crossing each DST change must still span whole days.
    it.each([
      ["US spring-forward", "2026-03-05"],
      ["EU spring-forward", "2026-03-26"],
      ["EU fall-back", "2026-10-21"],
      ["US fall-back", "2026-10-28"],
    ])("never gains or loses a day across %s", (_label, start) => {
      const end = addCalendarDays(start, 7);
      expect(diffCalendarDays(end, start)).toBe(7);
      expect(addCalendarDays(end, -7)).toBe(start);
    });

    it("counts days in both directions", () => {
      expect(diffCalendarDays("2026-10-10", "2026-10-05")).toBe(5);
      expect(diffCalendarDays("2026-10-05", "2026-10-10")).toBe(-5);
      expect(diffCalendarDays("2026-10-05", "2026-10-05")).toBe(0);
    });

    it("throws on an invalid day instead of returning garbage", () => {
      expect(() => addCalendarDays("2026-02-30", 1)).toThrow(RangeError);
    });
  });

  describe("compareCalendarDays / dayOfWeek", () => {
    it("orders days", () => {
      expect(compareCalendarDays("2026-10-04", "2026-10-05")).toBe(-1);
      expect(compareCalendarDays("2026-10-05", "2026-10-05")).toBe(0);
      expect(compareCalendarDays("2026-12-01", "2026-10-05")).toBe(1);
    });

    it("returns 0 = Sunday … 6 = Saturday", () => {
      expect(dayOfWeek("2026-10-04")).toBe(0); // Sunday
      expect(dayOfWeek("2026-10-05")).toBe(1); // Monday
      expect(dayOfWeek("2026-10-10")).toBe(6); // Saturday
    });
  });

  describe("startOfDayInstant", () => {
    it("returns local midnight as a UTC instant", () => {
      expect(
        startOfDayInstant("2026-10-05", "Asia/Kolkata").toISOString()
      ).toBe("2026-10-04T18:30:00.000Z");
      expect(
        startOfDayInstant("2026-10-05", "America/New_York").toISOString()
      ).toBe("2026-10-05T04:00:00.000Z");
      expect(
        startOfDayInstant("2026-01-15", "America/New_York").toISOString()
      ).toBe("2026-01-15T05:00:00.000Z");
      expect(startOfDayInstant("2026-10-05", "UTC").toISOString()).toBe(
        "2026-10-05T00:00:00.000Z"
      );
    });

    it("handles the DST change days themselves", () => {
      // EU fall-back day: midnight is still CEST (+2).
      expect(
        startOfDayInstant("2026-10-25", "Europe/Berlin").toISOString()
      ).toBe("2026-10-24T22:00:00.000Z");
      // The day after: CET (+1).
      expect(
        startOfDayInstant("2026-10-26", "Europe/Berlin").toISOString()
      ).toBe("2026-10-25T23:00:00.000Z");
      // US spring-forward day: midnight is still EST (-5).
      expect(
        startOfDayInstant("2026-03-08", "America/New_York").toISOString()
      ).toBe("2026-03-08T05:00:00.000Z");
    });

    it("lands on the first real instant when midnight is skipped", () => {
      // Chile springs forward at 00:00 → 01:00, so 00:00 never happens.
      const start = startOfDayInstant("2026-09-06", "America/Santiago");
      expect(calendarDayInTimeZone(start, "America/Santiago")).toBe(
        "2026-09-06"
      );
      expect(
        calendarDayInTimeZone(new Date(start.getTime() - 1), "America/Santiago")
      ).toBe("2026-09-05");
    });

    it("round-trips with calendarDayInTimeZone for every test zone", () => {
      for (const tz of [
        ...SERVER_TIMEZONES,
        "Pacific/Auckland",
        "Pacific/Honolulu",
      ]) {
        const start = startOfDayInstant("2026-10-25", tz);
        expect(calendarDayInTimeZone(start, tz)).toBe("2026-10-25");
        expect(calendarDayInTimeZone(new Date(start.getTime() - 1), tz)).toBe(
          "2026-10-24"
        );
      }
    });
  });

  describe("startOfWeekDay / endOfWeekDay (weeks start Monday)", () => {
    it.each([
      ["Monday", "2026-10-05"],
      ["Wednesday", "2026-10-07"],
      ["Sunday", "2026-10-11"],
    ])("puts %s in the Mon Oct 5 – Sun Oct 11 week", (_label, day) => {
      expect(startOfWeekDay(day)).toBe("2026-10-05");
      expect(endOfWeekDay(day)).toBe("2026-10-11");
    });

    it("spans a year boundary", () => {
      expect(startOfWeekDay("2027-01-01")).toBe("2026-12-28");
      expect(endOfWeekDay("2027-01-01")).toBe("2027-01-03");
    });
  });

  describe("date-picker bridge", () => {
    it("reads the clicked day from a picker's local-midnight Date", () => {
      // What a picker hands back for "Oct 5" in whatever zone it runs in.
      expect(calendarDayFromLocalDate(new Date(2026, 9, 5))).toBe("2026-10-05");
    });

    it("round-trips a calendar day through a local Date", () => {
      for (const day of [
        "2026-10-05",
        "2026-03-08",
        "2026-10-25",
        "2028-02-29",
      ]) {
        expect(calendarDayFromLocalDate(localDateFromCalendarDay(day))).toBe(
          day
        );
      }
    });

    it("shows the same day to every viewer (two users, different timezones)", () => {
      // The whole point: "Oct 5" must not print as "Oct 4" west of UTC.
      expect(formatCalendarDay("2026-10-05", "MMM d")).toBe("Oct 5");
      expect(formatCalendarDay("2026-01-15", "EEE, MMM d, yyyy")).toBe(
        "Thu, Jan 15, 2026"
      );
    });
  });

  describe("parseCalendarDayInput", () => {
    it("accepts days, null and empty; passes undefined through", () => {
      expect(parseCalendarDayInput("2026-10-05")).toBe("2026-10-05");
      expect(parseCalendarDayInput(null)).toBeNull();
      expect(parseCalendarDayInput("")).toBeNull();
      expect(parseCalendarDayInput(undefined)).toBeUndefined();
    });

    it("rejects instants and junk so they can't reach the database", () => {
      for (const bad of [
        "2026-10-05T00:00:00Z",
        "2026-02-30",
        "Oct 5",
        42,
        new Date(),
        {},
      ]) {
        expect(() => parseCalendarDayInput(bad)).toThrow(RangeError);
      }
    });
  });

  describe("coerceCalendarDay (lenient legacy read)", () => {
    it("keeps days and recovers legacy local-midnight ISO values", () => {
      expect(coerceCalendarDay("2026-10-05")).toBe("2026-10-05");
      expect(coerceCalendarDay("2026-10-04T18:30:00.000Z")).toBe("2026-10-05");
      expect(coerceCalendarDay("2026-10-05T04:00:00.000Z")).toBe("2026-10-05");
    });

    it("returns null for blanks and junk", () => {
      for (const v of [null, undefined, "", "nope", {}, true]) {
        expect(coerceCalendarDay(v)).toBeNull();
      }
    });
  });

  describe("timezone names and labels", () => {
    it("lists UTC and current names", () => {
      const zones = listTimeZones();
      expect(zones).toContain("UTC");
      expect(zones).toContain("America/New_York");
      expect(zones).toContain(canonicalTimeZone("Asia/Calcutta"));
      expect(new Set(zones).size).toBe(zones.length);
    });

    it("maps renamed zones to their current names", () => {
      expect(canonicalTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
      expect(canonicalTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    });

    it("labels UTC offsets, following DST", () => {
      const jan = at("2026-01-15T12:00:00Z");
      const jul = at("2026-07-15T12:00:00Z");
      expect(formatUtcOffset("Asia/Kolkata", jan)).toBe("UTC+05:30");
      expect(formatUtcOffset("America/New_York", jan)).toBe("UTC−05:00");
      expect(formatUtcOffset("America/New_York", jul)).toBe("UTC−04:00");
      expect(formatUtcOffset("UTC", jan)).toBe("UTC");
    });

    it("formats an exact moment in a given timezone (emails)", () => {
      const noonUtc = at("2026-10-05T12:00:00Z");
      expect(formatInstantInTimeZone(noonUtc, "Asia/Kolkata")).toBe(
        "Oct 5, 2026, 5:30 PM GMT+5:30"
      );
      expect(formatInstantInTimeZone(noonUtc, "America/New_York")).toBe(
        "Oct 5, 2026, 8:00 AM EDT"
      );
    });
  });

  describe("legacy local-midnight recovery", () => {
    // How the old date pickers stored "Oct 5" from different browsers.
    it.each([
      ["India (+05:30)", "2026-10-04T18:30:00Z"],
      ["New York, EDT (-04:00)", "2026-10-05T04:00:00Z"],
      ["New York, EST (-05:00)", "2026-10-05T05:00:00Z"],
      ["Berlin, CEST (+02:00)", "2026-10-04T22:00:00Z"],
      ["UTC", "2026-10-05T00:00:00Z"],
      ["Kathmandu (+05:45)", "2026-10-04T18:15:00Z"],
    ])("recovers the picked day for %s", (_label, stored) => {
      expect(nearestUtcMidnightDay(at(stored))).toBe("2026-10-05");
      expect(looksLikeLocalMidnight(at(stored))).toBe(true);
      expect(isAmbiguousLegacyMidnight(at(stored))).toBe(false);
    });

    it("flags the band where Hawaii and New Zealand collide", () => {
      // NZDT (+13) "Oct 5" and HST (-10) "Oct 4" land at 11:00Z / 10:00Z.
      expect(isAmbiguousLegacyMidnight(at("2026-10-04T11:00:00Z"))).toBe(true);
      expect(isAmbiguousLegacyMidnight(at("2026-10-04T10:00:00Z"))).toBe(true);
      expect(isAmbiguousLegacyMidnight(at("2026-10-04T12:00:00Z"))).toBe(true);
      expect(isAmbiguousLegacyMidnight(at("2026-10-04T09:45:00Z"))).toBe(false);
      expect(isAmbiguousLegacyMidnight(at("2026-10-04T12:15:00Z"))).toBe(false);
    });

    it("recognises values that carry a real time of day", () => {
      // e.g. a sprint start stamped with new Date() when it was started
      expect(looksLikeLocalMidnight(at("2026-10-02T04:53:12.123Z"))).toBe(
        false
      );
      expect(looksLikeLocalMidnight(at("2026-10-02T04:53:00Z"))).toBe(false);
      expect(looksLikeLocalMidnight(at("2026-10-02T04:30:00Z"))).toBe(true);
    });
  });
});
