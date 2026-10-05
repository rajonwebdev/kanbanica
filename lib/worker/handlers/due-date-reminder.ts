import { and, eq, gte, lte, not } from "drizzle-orm";
import type { Job } from "pg-boss";
import {
  listStatus,
  notification,
  task,
  taskAssignee,
  taskWatcher,
  workspace,
} from "@/db/schema";
import { db } from "@/lib/db";
import { createNotifications } from "@/lib/notifications/create-notification";
import { addCalendarDays, startOfDayInstant, todayIn } from "@/lib/timezone";

interface ReminderTask {
  id: string;
  title: string;
  /** Start of "today" in the task's workspace — the dedupe window. */
  todayStart: Date;
  workspaceId: string;
}

export async function handleDueDateReminder(
  _jobs: Job<Record<string, never>>[]
) {
  const now = new Date();

  // "Today" differs between workspaces (by at most a day either way from UTC),
  // so fetch every open task due within that span once, then classify each
  // against ITS workspace's today. Due dates are calendar days.
  const utcToday = todayIn("UTC", now);
  const candidates = await db
    .select({
      id: task.id,
      title: task.title,
      workspaceId: task.workspaceId,
      dueDateEnd: task.dueDateEnd,
      timezone: workspace.timezone,
    })
    .from(task)
    .innerJoin(listStatus, eq(listStatus.id, task.statusId))
    .innerJoin(workspace, eq(workspace.id, task.workspaceId))
    .where(
      and(
        gte(task.dueDateEnd, addCalendarDays(utcToday, -2)),
        lte(task.dueDateEnd, addCalendarDays(utcToday, 2)),
        eq(task.isArchived, false),
        not(eq(listStatus.type, "CLOSED"))
      )
    );

  const dueTomorrow: ReminderTask[] = [];
  const dueToday: ReminderTask[] = [];
  const overdueTasks: ReminderTask[] = [];
  for (const c of candidates) {
    if (!c.dueDateEnd) {
      continue;
    }
    const today = todayIn(c.timezone, now);
    const t: ReminderTask = {
      id: c.id,
      title: c.title,
      workspaceId: c.workspaceId,
      todayStart: startOfDayInstant(today, c.timezone),
    };
    if (c.dueDateEnd === addCalendarDays(today, 1)) {
      dueTomorrow.push(t);
    } else if (c.dueDateEnd === today) {
      dueToday.push(t);
    } else if (c.dueDateEnd === addCalendarDays(today, -1)) {
      // Overdue reminder fires once, the day after the due day.
      overdueTasks.push(t);
    }
  }

  async function getTaskRecipients(taskId: string): Promise<string[]> {
    const [assignees, watchers] = await Promise.all([
      db
        .select({ userId: taskAssignee.userId })
        .from(taskAssignee)
        .where(eq(taskAssignee.taskId, taskId)),
      db
        .select({ userId: taskWatcher.userId })
        .from(taskWatcher)
        .where(eq(taskWatcher.taskId, taskId)),
    ]);
    return [
      ...new Set([
        ...assignees.map((a) => a.userId),
        ...watchers.map((w) => w.userId),
      ]),
    ];
  }

  // Once per workspace-local day: the job runs hourly.
  async function alreadyNotified(
    t: ReminderTask,
    triggerType: string
  ): Promise<boolean> {
    const todayNotifs = await db
      .select({ id: notification.id })
      .from(notification)
      .where(
        and(
          eq(notification.entityId, t.id),
          eq(notification.triggerType, triggerType),
          gte(notification.createdAt, t.todayStart)
        )
      )
      .limit(1);
    return todayNotifs.length > 0;
  }

  for (const t of dueTomorrow) {
    if (await alreadyNotified(t, "due_date_reminder_1day")) {
      continue;
    }
    const recipients = await getTaskRecipients(t.id);
    if (recipients.length === 0) {
      continue;
    }
    createNotifications({
      workspaceId: t.workspaceId,
      actorId: null,
      recipientIds: recipients,
      triggerType: "due_date_reminder_1day",
      entityType: "TASK",
      entityId: t.id,
      title: `Task "${t.title}" is due tomorrow`,
    });
  }

  for (const t of dueToday) {
    if (await alreadyNotified(t, "due_date_today")) {
      continue;
    }
    const recipients = await getTaskRecipients(t.id);
    if (recipients.length === 0) {
      continue;
    }
    createNotifications({
      workspaceId: t.workspaceId,
      actorId: null,
      recipientIds: recipients,
      triggerType: "due_date_today",
      entityType: "TASK",
      entityId: t.id,
      title: `Task "${t.title}" is due today`,
    });
  }

  for (const t of overdueTasks) {
    if (await alreadyNotified(t, "task_overdue")) {
      continue;
    }
    const recipients = await getTaskRecipients(t.id);
    if (recipients.length === 0) {
      continue;
    }
    createNotifications({
      workspaceId: t.workspaceId,
      actorId: null,
      recipientIds: recipients,
      triggerType: "task_overdue",
      entityType: "TASK",
      entityId: t.id,
      title: `Task "${t.title}" is overdue`,
    });
  }

  console.log("[due-date-reminder] processed", {
    dueTomorrow: dueTomorrow.length,
    dueToday: dueToday.length,
    overdue: overdueTasks.length,
  });
}
