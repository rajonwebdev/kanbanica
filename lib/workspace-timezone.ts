import { eq } from "drizzle-orm";
import { workspace } from "@/db/schema";
import { db } from "@/lib/db";
import { type CalendarDay, resolveTimeZone, todayIn } from "@/lib/timezone";

/**
 * The workspace's IANA timezone — the source of truth for every calendar
 * decision in that workspace (today, overdue, sprint boundaries). Falls back
 * to UTC for an unknown workspace or an invalid stored value.
 */
export async function getWorkspaceTimeZone(
  workspaceId: string
): Promise<string> {
  const [row] = await db
    .select({ timezone: workspace.timezone })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return resolveTimeZone(row?.timezone);
}

/** Today's calendar day in the workspace's timezone. */
export async function getWorkspaceToday(
  workspaceId: string,
  now: Date = new Date()
): Promise<CalendarDay> {
  return todayIn(await getWorkspaceTimeZone(workspaceId), now);
}
