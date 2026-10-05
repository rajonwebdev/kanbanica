// Proposes the calendar day each legacy due date / sprint date / custom DATE
// value was meant to be, for the calendar-day migration. Pure and read-only:
// used by `scripts/timezone-dry-run.ts`, which only REPORTS proposals — no data
// is changed until the migration rule is confirmed.
//
// Rule (see lib/timezone.ts for the helpers):
//   - Already "YYYY-MM-DD"            → kept as-is.
//   - Looks like a picker's local     → nearest UTC midnight (recovers the
//     midnight (whole quarter hour)     author's day for offsets UTC−12…+12).
//   - Carries a real time of day      → the day it falls on in the workspace
//     (e.g. sprint start = "now")       timezone.
// Values the rule can't decide safely are flagged `needsReview`.

import {
  type CalendarDay,
  calendarDayInTimeZone,
  isAmbiguousLegacyMidnight,
  isCalendarDay,
  looksLikeLocalMidnight,
  nearestUtcMidnightDay,
} from "@/lib/timezone";

export type LegacyDateFlag =
  /** Not a timestamp or day at all — must be fixed by hand. */
  | "INVALID"
  /** Has a real time of day, so it was resolved in the workspace timezone. */
  | "HAS_TIME_OF_DAY"
  /** Midnight for both UTC−10…−12 and UTC+12…+14 — a day apart. */
  | "AMBIGUOUS_OFFSET"
  /** Reading it in the workspace timezone would give a different day. */
  | "DIFFERS_FROM_WORKSPACE_TZ";

export interface LegacyDateProposal {
  flags: LegacyDateFlag[];
  /**
   * The author's UTC offset implied by treating the value as local midnight,
   * in minutes (IST → 330, EDT → -240). Null when it carries a time of day.
   */
  inferredOffsetMinutes: number | null;
  needsReview: boolean;
  /** The day the migration would write, or null if it can't decide. */
  proposedDay: CalendarDay | null;
  /** The stored value, as ISO text (or the raw value if it isn't a date). */
  stored: string;
  /** The day the value falls on in the workspace timezone. */
  workspaceDay: CalendarDay | null;
}

/** Minutes past UTC midnight → the local-midnight offset it implies. */
function impliedOffsetMinutes(instant: Date): number {
  const minute = instant.getUTCHours() * 60 + instant.getUTCMinutes();
  // Before noon UTC: a western zone's midnight that same UTC day (04:00Z →
  // −4h). From noon on: an eastern zone's midnight of the next day (18:30Z →
  // +5:30). Exactly 12:00 is ±12 and is flagged ambiguous anyway.
  return minute < 12 * 60 ? -minute : 24 * 60 - minute;
}

export function proposeCalendarDay(
  value: unknown,
  workspaceTimeZone: string
): LegacyDateProposal {
  if (typeof value === "string" && isCalendarDay(value)) {
    return {
      stored: value,
      proposedDay: value,
      workspaceDay: value,
      inferredOffsetMinutes: null,
      flags: [],
      needsReview: false,
    };
  }

  const instant =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;

  if (!instant || Number.isNaN(instant.getTime())) {
    return {
      stored: String(value),
      proposedDay: null,
      workspaceDay: null,
      inferredOffsetMinutes: null,
      flags: ["INVALID"],
      needsReview: true,
    };
  }

  const flags: LegacyDateFlag[] = [];
  const workspaceDay = calendarDayInTimeZone(instant, workspaceTimeZone);
  let proposedDay: CalendarDay;
  let inferredOffsetMinutes: number | null = null;

  if (looksLikeLocalMidnight(instant)) {
    proposedDay = nearestUtcMidnightDay(instant);
    inferredOffsetMinutes = impliedOffsetMinutes(instant);
    if (isAmbiguousLegacyMidnight(instant)) {
      flags.push("AMBIGUOUS_OFFSET");
    }
  } else {
    proposedDay = workspaceDay;
    flags.push("HAS_TIME_OF_DAY");
  }

  if (proposedDay !== workspaceDay) {
    flags.push("DIFFERS_FROM_WORKSPACE_TZ");
  }

  return {
    stored: instant.toISOString(),
    proposedDay,
    workspaceDay,
    inferredOffsetMinutes,
    flags,
    needsReview: flags.includes("AMBIGUOUS_OFFSET"),
  };
}

/** "+05:30" / "-04:00" for an offset in minutes. */
export function formatOffset(minutes: number | null): string {
  if (minutes === null) {
    return "—";
  }
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
