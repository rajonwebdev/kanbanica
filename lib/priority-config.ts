import { type CalendarDay, formatCalendarDay } from "@/lib/timezone";

export const PRIORITY_CONFIG = {
  NONE: { label: "No Priority", color: "text-gray-400", icon: "😴" },
  LOW: { label: "Low", color: "text-gray-500", icon: "🦥" },
  MEDIUM: { label: "Medium", color: "text-yellow-600", icon: "🚶" },
  HIGH: { label: "High", color: "text-orange-500", icon: "🏃" },
  URGENT: { label: "Urgent", color: "text-red-500", icon: "🚨" },
} as const;

export type Priority = keyof typeof PRIORITY_CONFIG;

export function userInitials(name: string): string {
  if (!name) {
    return "?";
  }
  const clean = name.includes("@") ? name.split("@")[0] : name;
  return (
    clean
      .split(/[\s._-]+/)
      .map((n) => n[0])
      .filter(Boolean)
      .join("")
      .toUpperCase()
      .slice(0, 2) || "?"
  );
}

export function avatarSrc(key: string | null | undefined): string | undefined {
  return key ? `/api/files/${key}` : undefined;
}

/**
 * Label for a due date (a calendar day). `today` is today in the WORKSPACE
 * timezone (`useWorkspaceToday()`), so every viewer sees the same label.
 */
export function formatDueDate(
  dueDate: CalendarDay | null,
  today: CalendarDay
): { label: string; overdue: boolean } | null {
  if (!dueDate) {
    return null;
  }
  if (dueDate === today) {
    return { label: "Today", overdue: false };
  }
  return {
    label: formatCalendarDay(dueDate, "MMM d"),
    overdue: dueDate < today,
  };
}
