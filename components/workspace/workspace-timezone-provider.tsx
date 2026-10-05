"use client";

import { createContext, useContext, useEffect, useState } from "react";
import {
  addCalendarDays,
  type CalendarDay,
  DEFAULT_TIMEZONE,
  startOfDayInstant,
  todayIn,
} from "@/lib/timezone";

// The current workspace's IANA timezone, for client-side calendar decisions
// ("Today", "Overdue", days remaining). Exact timestamps are NOT formatted with
// it — those stay in the viewer's own browser timezone.
const WorkspaceTimeZoneContext = createContext<{
  timeZone: string;
  today: CalendarDay | null;
}>({ timeZone: DEFAULT_TIMEZONE, today: null });

export function WorkspaceTimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string;
  children: React.ReactNode;
}) {
  const [today, setToday] = useState(() => todayIn(timeZone));

  // One timer for the whole workspace: flip "today" at the workspace's
  // midnight so "Today"/"Overdue" labels stay right on a page left open.
  useEffect(() => {
    setToday(todayIn(timeZone));
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const nextMidnight = startOfDayInstant(
        addCalendarDays(todayIn(timeZone), 1),
        timeZone
      );
      // +1s so the new day has definitely begun; capped at an hour so a
      // sleeping laptop re-checks soon after waking.
      const delay = Math.min(
        nextMidnight.getTime() - Date.now() + 1000,
        3_600_000
      );
      timer = setTimeout(
        () => {
          setToday(todayIn(timeZone));
          schedule();
        },
        Math.max(delay, 1000)
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [timeZone]);

  return (
    <WorkspaceTimeZoneContext.Provider value={{ timeZone, today }}>
      {children}
    </WorkspaceTimeZoneContext.Provider>
  );
}

export function useWorkspaceTimeZone(): string {
  return useContext(WorkspaceTimeZoneContext).timeZone;
}

/** Today's calendar day in the workspace timezone. */
export function useWorkspaceToday(): CalendarDay {
  const { timeZone, today } = useContext(WorkspaceTimeZoneContext);
  // Outside a provider (e.g. global pages), fall back to computing it.
  return today ?? todayIn(timeZone);
}
