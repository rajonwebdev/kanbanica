import { and, eq, isNotNull } from "drizzle-orm";
import type { Job } from "pg-boss";
import { space, sprint, workspace } from "@/db/schema";
import { db } from "@/lib/db";
import { closeSprintAndRollover } from "@/lib/sprint/rollover";
import { todayIn } from "@/lib/timezone";

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleSprintAutoClose(
  _jobs: Job<Record<string, never>>[]
) {
  const now = new Date();

  // ACTIVE sprints with an end date, in spaces that have "Auto-mark sprint as
  // done" enabled. The space-level settings are the single source of truth (the
  // same toggles the Sprints settings page saves).
  const activeSprints = await db
    .select({
      id: sprint.id,
      name: sprint.name,
      spaceId: sprint.spaceId,
      createdBy: sprint.createdBy,
      endDate: sprint.endDate,
      timezone: workspace.timezone,
      autoCreateNext: space.sprintAutoCreateNext,
      moveIncomplete: space.sprintAutoMoveIncomplete,
    })
    .from(sprint)
    .innerJoin(space, eq(sprint.spaceId, space.id))
    .innerJoin(workspace, eq(space.workspaceId, workspace.id))
    .where(
      and(
        eq(sprint.status, "ACTIVE"),
        eq(space.sprintAutoMarkDone, true),
        isNotNull(sprint.endDate)
      )
    );

  // The end day is inclusive: a sprint ending Oct 10 closes once Oct 11 has
  // begun in ITS workspace's timezone. The job runs hourly, so each workspace
  // closes shortly after its own midnight rather than at 00:00 UTC.
  const eligibleSprints = activeSprints.filter(
    (s) => s.endDate !== null && s.endDate < todayIn(s.timezone, now)
  );

  if (eligibleSprints.length === 0) {
    return;
  }

  console.log(
    `[sprint.auto-close] processing ${eligibleSprints.length} sprint(s)`
  );

  for (const s of eligibleSprints) {
    try {
      const { nextSprintId } = await closeSprintAndRollover({
        spaceId: s.spaceId,
        sprintId: s.id,
        actorId: s.createdBy,
        autoCreateNext: s.autoCreateNext,
        incompleteStrategy: s.moveIncomplete
          ? "move_to_next_sprint"
          : "move_to_backlog",
      });
      console.log(
        `[sprint.auto-close] closed "${s.name}" (${s.id})` +
          (nextSprintId ? ` → next sprint ${nextSprintId}` : "")
      );
    } catch (err) {
      console.error(`[sprint.auto-close] failed for sprint ${s.id}`, err);
    }
  }
}
