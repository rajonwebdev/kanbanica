import { addCalendarDays, type CalendarDay } from "@/lib/timezone";

// Client-safe sprint date rules (no db import) — shared by the create-sprint
// modal, the sprint actions and the rollover.

/**
 * Last day of a sprint that starts on `startDay` and lasts `durationWeeks`.
 * Both ends are inclusive, so a 1-week sprint starting Mon Oct 5 ends Sun
 * Oct 11 — 7 calendar days — and the next one starts Oct 12.
 */
export function sprintEndDay(
  startDay: CalendarDay,
  durationWeeks: number
): CalendarDay {
  return addCalendarDays(startDay, durationWeeks * 7 - 1);
}
