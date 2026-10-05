// Shared server-side task-filter WHERE-clause builder. One place builds the
// Drizzle conditions for status / priority / due / assignee / tags / sprint so
// getFilteredTasks (list view) and globalSearch (omnibox) never duplicate SQL.
//
// Server-only (imports db). Assignee/tags/sprint use subqueries so they compose
// with LIMIT — no post-fetch JS filtering.

import {
  and,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import { listStatus, task, taskAssignee, taskTag } from "@/db/schema";
import { taskSprint } from "@/db/schema/sprint";
import { db } from "@/lib/db";
import { type CalendarDay, endOfWeekDay, startOfWeekDay } from "@/lib/timezone";
import type { TaskFilters } from "./options";

type PriorityValue = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";

/**
 * Build the reusable task-filter conditions. Returns an array to spread into an
 * `and(...)`.
 *
 * Note: a `statusType` filter references `listStatus.type`, so the caller's query
 * MUST innerJoin `listStatus` (globalSearch does). Callers that filter by concrete
 * `status` IDs (getFilteredTasks) don't need that join.
 *
 * `today` is today's calendar day in the WORKSPACE timezone (see
 * getWorkspaceToday) — due dates are calendar days, so "today"/"overdue"/"this
 * week" are day comparisons, never instant comparisons.
 */
export function buildTaskFilterConditions(
  filters: TaskFilters,
  today: CalendarDay
): SQL[] {
  const conditions: SQL[] = [];

  if (filters.status?.length) {
    conditions.push(inArray(task.statusId, filters.status));
  }

  if (filters.statusType?.length) {
    conditions.push(inArray(listStatus.type, filters.statusType));
  }

  if (filters.priority?.length) {
    conditions.push(
      inArray(task.priority, filters.priority as PriorityValue[])
    );
  }

  if (filters.due) {
    if (filters.due === "overdue") {
      // Strictly before today: a task due today is "due today", not overdue.
      conditions.push(lt(task.dueDateEnd, today));
    } else if (filters.due === "today") {
      conditions.push(gte(task.dueDateEnd, today));
      conditions.push(lte(task.dueDateEnd, today));
    } else if (filters.due === "this_week") {
      // Monday–Sunday week containing today.
      conditions.push(gte(task.dueDateEnd, startOfWeekDay(today)));
      conditions.push(lte(task.dueDateEnd, endOfWeekDay(today)));
    } else if (filters.due === "no_due_date") {
      conditions.push(isNull(task.dueDateEnd));
    }
  }

  // Assignee — OR of (has any of the picked users) and (unassigned = no rows).
  if (filters.assignee?.length) {
    const hasUnassigned = filters.assignee.includes("unassigned");
    const userIds = filters.assignee.filter((a) => a !== "unassigned");
    const parts: SQL[] = [];
    if (userIds.length) {
      parts.push(
        inArray(
          task.id,
          db
            .select({ id: taskAssignee.taskId })
            .from(taskAssignee)
            .where(inArray(taskAssignee.userId, userIds))
        )
      );
    }
    if (hasUnassigned) {
      parts.push(
        notInArray(
          task.id,
          db.select({ id: taskAssignee.taskId }).from(taskAssignee)
        )
      );
    }
    if (parts.length === 1) {
      conditions.push(parts[0]);
    } else if (parts.length > 1) {
      const combined = or(...parts);
      if (combined) {
        conditions.push(combined);
      }
    }
  }

  // Tags — task has any of the picked tags.
  if (filters.tags?.length) {
    conditions.push(
      inArray(
        task.id,
        db
          .select({ id: taskTag.taskId })
          .from(taskTag)
          .where(inArray(taskTag.tagId, filters.tags))
      )
    );
  }

  // Sprint — membership via the taskSprint join table (no task.sprintId column).
  if (filters.sprint?.length) {
    conditions.push(
      inArray(
        task.id,
        db
          .select({ id: taskSprint.taskId })
          .from(taskSprint)
          .where(inArray(taskSprint.sprintId, filters.sprint))
      )
    );
  }

  return conditions;
}

/** Merge builder conditions with base conditions into a single `and(...)`. */
export function withTaskFilters(
  base: SQL[],
  filters: TaskFilters,
  today: CalendarDay
): SQL | undefined {
  return and(...base, ...buildTaskFilterConditions(filters, today));
}
