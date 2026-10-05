import {
  addCalendarDays,
  type CalendarDay,
  diffCalendarDays,
  formatCalendarDay,
} from "@/lib/timezone";

/**
 * "5 days overdue" / "Due today" / "Due tomorrow" / "Due Mon, Jan 5" — for a
 * due date (calendar day), relative to `today` in the WORKSPACE timezone.
 */
export function describeDeadline(
  dueDate: CalendarDay,
  today: CalendarDay
): {
  text: string;
  overdue: boolean;
} {
  if (dueDate < today) {
    const days = diffCalendarDays(today, dueDate);
    return {
      text: `${days} day${days === 1 ? "" : "s"} overdue`,
      overdue: true,
    };
  }
  if (dueDate === today) {
    return { text: "Due today", overdue: false };
  }
  if (dueDate === addCalendarDays(today, 1)) {
    return { text: "Due tomorrow", overdue: false };
  }
  return {
    text: `Due ${formatCalendarDay(dueDate, "EEE, MMM d")}`,
    overdue: false,
  };
}
