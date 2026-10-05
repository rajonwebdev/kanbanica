// Timezone-aware calendar helpers — the single place Kanbanica answers "what
// day is it?" for workspace/business logic.
//
// Two kinds of time live in this app:
//   - Exact moments (createdAt, comments, activity, closedAt…) — stored as UTC
//     timestamptz and displayed in the viewer's own timezone. Not handled here.
//   - Calendar days (due dates, sprint start/end) — a day like "2026-10-05"
//     that must be the same day for every viewer. "Today", "overdue" and day
//     boundaries for those are decided in the WORKSPACE timezone.
//
// Calendar days are plain "YYYY-MM-DD" strings, and all day arithmetic is done
// on UTC-anchored dates, so nothing here depends on the server's or browser's
// own timezone, and daylight-saving transitions can't add or lose a day.
// Built on Intl only — no timezone library dependency.

import { format } from "date-fns";

/** A calendar day, "YYYY-MM-DD". Compares correctly as a string. */
export type CalendarDay = string;

/** Used when a workspace has no (or an invalid) timezone. */
export const DEFAULT_TIMEZONE = "UTC";

const CALENDAR_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** True if `timeZone` is an IANA name this runtime understands, e.g. "Asia/Kolkata". */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The given timezone if valid, otherwise {@link DEFAULT_TIMEZONE}. */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
}

// Old IANA names some runtimes still report → their current names.
const RENAMED_TIMEZONES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
};

/** `timeZone` under its current IANA name when this runtime supports it. */
export function canonicalTimeZone(timeZone: string): string {
  const renamed = RENAMED_TIMEZONES[timeZone];
  return renamed && isValidTimeZone(renamed) ? renamed : timeZone;
}

/** Every timezone this runtime supports (current names), plus "UTC". */
export function listTimeZones(): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return [...new Set(["UTC", ...supported.map(canonicalTimeZone)])].sort();
}

/** The browser's / server's own timezone (current IANA name). */
export function systemTimeZone(): string {
  return canonicalTimeZone(
    resolveTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  );
}

/** "UTC+05:30" / "UTC−04:00" / "UTC" for `timeZone` at `at`. */
export function formatUtcOffset(
  timeZone: string,
  at: Date = new Date()
): string {
  const minutes = timeZoneOffsetMinutes(at, timeZone);
  if (minutes === 0) {
    return "UTC";
  }
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? "−" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** True if `value` is a real "YYYY-MM-DD" date (rejects "2026-02-30"). */
export function isCalendarDay(value: string): value is CalendarDay {
  const match = CALENDAR_DAY_RE.exec(value);
  if (!match) {
    return false;
  }
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function parseCalendarDay(day: CalendarDay): Date {
  if (!isCalendarDay(day)) {
    throw new RangeError(`Invalid calendar day: "${day}"`);
  }
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatUtcDay(date: Date): CalendarDay {
  return date.toISOString().slice(0, 10);
}

/** Wall-clock parts of `instant` in `timeZone`. */
function wallClock(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // Some runtimes still render midnight as "24" despite h23.
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** UTC offset of `timeZone` at `instant`, in minutes (IST → 330, EDT → -240). */
export function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const w = wallClock(instant, resolveTimeZone(timeZone));
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second
  );
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - wholeSeconds) / 60_000);
}

/** The calendar day `instant` falls on in `timeZone`. */
export function calendarDayInTimeZone(
  instant: Date,
  timeZone: string
): CalendarDay {
  const w = wallClock(instant, resolveTimeZone(timeZone));
  return `${String(w.year).padStart(4, "0")}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** Today's calendar day in `timeZone`. */
export function todayIn(timeZone: string, now: Date = new Date()): CalendarDay {
  return calendarDayInTimeZone(now, timeZone);
}

/** `day` plus `amount` calendar days (negative to go back). DST-proof. */
export function addCalendarDays(day: CalendarDay, amount: number): CalendarDay {
  return formatUtcDay(
    new Date(parseCalendarDay(day).getTime() + amount * MS_PER_DAY)
  );
}

/** Whole calendar days from `from` to `to` (positive when `to` is later). */
export function diffCalendarDays(to: CalendarDay, from: CalendarDay): number {
  return Math.round(
    (parseCalendarDay(to).getTime() - parseCalendarDay(from).getTime()) /
      MS_PER_DAY
  );
}

/** -1, 0 or 1. Plain string comparison is equivalent for valid days. */
export function compareCalendarDays(a: CalendarDay, b: CalendarDay): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Day of week, 0 = Sunday … 6 = Saturday (matches `Date#getDay`). */
export function dayOfWeek(day: CalendarDay): number {
  return parseCalendarDay(day).getUTCDay();
}

/** Weeks start on Monday (ISO 8601) for "this week" filters and groupings. */
export const WEEK_STARTS_ON = 1;

/** First day (Monday) of the week containing `day`. */
export function startOfWeekDay(day: CalendarDay): CalendarDay {
  return addCalendarDays(day, -((dayOfWeek(day) - WEEK_STARTS_ON + 7) % 7));
}

/** Last day (Sunday) of the week containing `day`. */
export function endOfWeekDay(day: CalendarDay): CalendarDay {
  return addCalendarDays(startOfWeekDay(day), 6);
}

/**
 * Date-picker bridge: the day a picker `Date` represents. Pickers hand back
 * local midnight of the day the user clicked, so the LOCAL components are the
 * user's intent — never convert it through UTC.
 */
export function calendarDayFromLocalDate(date: Date): CalendarDay {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Date-picker / date-fns bridge: a local-midnight `Date` whose local Y/M/D is
 * `day`. Use only to feed pickers (`selected`, `disabled`) or `format()` — it
 * prints the same day in every timezone, unlike `new Date("YYYY-MM-DD")`,
 * which is UTC midnight and shows the previous day west of Greenwich.
 */
export function localDateFromCalendarDay(day: CalendarDay): Date {
  parseCalendarDay(day); // validates
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Formats a calendar day with a date-fns pattern — same output in every timezone. */
export function formatCalendarDay(day: CalendarDay, pattern: string): string {
  return format(localDateFromCalendarDay(day), pattern);
}

/**
 * An exact moment as wall-clock text in `timeZone`, with the zone shown —
 * "Oct 5, 2026, 5:30 PM GMT+5:30". For server-rendered output (emails) that
 * has no browser to localise it.
 */
export function formatInstantInTimeZone(
  instant: Date,
  timeZone: string
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
}

/**
 * Reads a stored calendar-day value leniently: "YYYY-MM-DD" as-is, and a legacy
 * ISO timestamp (custom DATE values and saved filters written before the
 * calendar-day migration) via the same nearest-UTC-midnight rule the migration
 * uses. Anything else → null.
 */
export function coerceCalendarDay(value: unknown): CalendarDay | null {
  if (typeof value === "string" && isCalendarDay(value)) {
    return value;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const instant = new Date(value);
  return Number.isNaN(instant.getTime())
    ? null
    : nearestUtcMidnightDay(instant);
}

/**
 * Validates a calendar-day value arriving from a client (server actions).
 * Returns the day, `null` to clear, or `undefined` when absent — and throws on
 * anything else so a bad value can never reach the database.
 */
export function parseCalendarDayInput(
  value: unknown
): CalendarDay | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  if (typeof value === "string" && isCalendarDay(value)) {
    return value;
  }
  throw new RangeError("Invalid date. Expected YYYY-MM-DD.");
}

/**
 * The exact UTC instant at which `day` begins in `timeZone`. Use for SQL range
 * bounds on timestamptz columns ("created today in the workspace").
 *
 * If local midnight doesn't exist (a DST jump at 00:00, e.g.
 * America/Santiago), returns the first instant of that day instead.
 */
export function startOfDayInstant(day: CalendarDay, timeZone: string): Date {
  const tz = resolveTimeZone(timeZone);
  const utcMidnight = parseCalendarDay(day).getTime();
  // Two passes settle the offset in effect at the target instant.
  let candidate =
    utcMidnight - timeZoneOffsetMinutes(new Date(utcMidnight), tz) * 60_000;
  candidate =
    utcMidnight - timeZoneOffsetMinutes(new Date(candidate), tz) * 60_000;
  // Inside a DST gap the result can land on the previous day; step forward to
  // the first instant that actually belongs to `day`.
  while (calendarDayInTimeZone(new Date(candidate), tz) < day) {
    candidate += 60 * 60_000;
  }
  return new Date(candidate);
}

/**
 * Legacy-data recovery: the calendar day a "local midnight" timestamp was meant
 * to represent, without knowing the author's timezone.
 *
 * The date pickers stored a picked day as local midnight in the picker's own
 * browser ("Oct 5" in India → 2026-10-04T18:30Z, in New York →
 * 2026-10-05T04:00Z). Rounding to the nearest UTC midnight recovers the
 * intended day for any author offset strictly between UTC−12 and UTC+12.
 * Callers must flag {@link isAmbiguousLegacyMidnight} values for review.
 */
export function nearestUtcMidnightDay(instant: Date): CalendarDay {
  return formatUtcDay(
    new Date(Math.round(instant.getTime() / MS_PER_DAY) * MS_PER_DAY)
  );
}

/** Minutes past UTC midnight, e.g. 18:30Z → 1110. */
function utcMinuteOfDay(instant: Date): number {
  return instant.getUTCHours() * 60 + instant.getUTCMinutes();
}

/**
 * True if `instant` looks like a date picker's local midnight: it lands on a
 * whole quarter hour with no seconds (every real UTC offset is a multiple of
 * 15 minutes). False means it carries a real time of day — e.g. a sprint
 * start stamped with `new Date()` when the sprint was started.
 */
export function looksLikeLocalMidnight(instant: Date): boolean {
  return (
    instant.getUTCSeconds() === 0 &&
    instant.getUTCMilliseconds() === 0 &&
    instant.getUTCMinutes() % 15 === 0
  );
}

/**
 * True when nearest-UTC-midnight rounding can't tell two real offsets apart:
 * between 10:00Z and 12:00Z the value is midnight both for UTC−10…−12
 * (Hawaii) and UTC+12…+14 (New Zealand, Fiji, Tonga), a day apart.
 */
export function isAmbiguousLegacyMidnight(instant: Date): boolean {
  const minute = utcMinuteOfDay(instant);
  return minute >= 10 * 60 && minute <= 12 * 60;
}
