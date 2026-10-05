import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDueDateReminder } from "@/lib/worker/handlers/due-date-reminder";

const { selectMock, createNotificationsMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  createNotificationsMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { select: selectMock } }));
vi.mock("@/lib/notifications/create-notification", () => ({
  createNotifications: createNotificationsMock,
}));

interface QueryChain extends PromiseLike<unknown[]> {
  from: () => QueryChain;
  innerJoin: () => QueryChain;
  limit: () => Promise<unknown[]>;
  where: () => QueryChain;
}

function createChain(result: unknown[]): QueryChain {
  const chain: QueryChain = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    limit: () => Promise.resolve(result),
    // biome-ignore lint/suspicious/noThenProperty: mirrors Drizzle's own thenable query builder
    then: (onfulfilled, onrejected) =>
      Promise.resolve(result).then(onfulfilled, onrejected),
  };
  return chain;
}

function queueSelectResults(...batches: unknown[][]) {
  let index = 0;
  selectMock.mockImplementation(() => {
    const result = batches[index] ?? [];
    index += 1;
    return createChain(result);
  });
}

// Pinned "now": 2026-10-05 12:00 UTC — Oct 5 in UTC, India and New York.
const NOW = new Date("2026-10-05T12:00:00Z");

/** A candidate row as the single due-window query returns it. */
function dueTask(
  id: string,
  dueDateEnd: string,
  overrides: Partial<{ title: string; timezone: string }> = {}
) {
  return {
    id,
    title: overrides.title ?? `Task ${id}`,
    workspaceId: "w1",
    dueDateEnd,
    timezone: overrides.timezone ?? "UTC",
  };
}

beforeEach(() => {
  selectMock.mockReset();
  createNotificationsMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handleDueDateReminder", () => {
  it("sends a 1-day reminder for a task due tomorrow", async () => {
    queueSelectResults(
      [dueTask("t1", "2026-10-06")],
      [], // alreadyNotified check
      [{ userId: "u1" }], // assignees
      [] // watchers
    );
    await handleDueDateReminder([]);
    expect(createNotificationsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "due_date_reminder_1day",
        entityId: "t1",
        recipientIds: ["u1"],
      })
    );
  });

  it("sends a due-today reminder for a task due today", async () => {
    queueSelectResults(
      [dueTask("t2", "2026-10-05")],
      [],
      [{ userId: "u1" }],
      []
    );
    await handleDueDateReminder([]);
    expect(createNotificationsMock).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "due_date_today", entityId: "t2" })
    );
  });

  it("sends an overdue reminder the day after the due day", async () => {
    queueSelectResults(
      [dueTask("t3", "2026-10-04")],
      [],
      [{ userId: "u1" }],
      []
    );
    await handleDueDateReminder([]);
    expect(createNotificationsMock).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "task_overdue", entityId: "t3" })
    );
  });

  it("does not remind about tasks due further out or long overdue", async () => {
    queueSelectResults([
      dueTask("t4", "2026-10-07"),
      dueTask("t5", "2026-10-03"),
    ]);
    await handleDueDateReminder([]);
    expect(createNotificationsMock).not.toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("decides 'today' per workspace timezone", async () => {
    // 20:00 UTC on Oct 5 = 01:30 Oct 6 in India, 16:00 Oct 5 in New York.
    vi.setSystemTime(new Date("2026-10-05T20:00:00Z"));
    queueSelectResults(
      [
        dueTask("india", "2026-10-06", { timezone: "Asia/Kolkata" }),
        dueTask("newyork", "2026-10-06", { timezone: "America/New_York" }),
      ],
      [], // alreadyNotified (newyork, due tomorrow — processed first)
      [{ userId: "u1" }],
      [],
      [], // alreadyNotified (india, due today)
      [{ userId: "u1" }],
      []
    );
    await handleDueDateReminder([]);
    expect(createNotificationsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "india",
        triggerType: "due_date_today",
      })
    );
    expect(createNotificationsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "newyork",
        triggerType: "due_date_reminder_1day",
      })
    );
  });

  it("skips a task that was already notified today, without querying recipients", async () => {
    queueSelectResults([dueTask("t1", "2026-10-06")], [{ id: "n1" }]);
    await handleDueDateReminder([]);
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(createNotificationsMock).not.toHaveBeenCalled();
  });

  it("skips a task with no assignees or watchers", async () => {
    queueSelectResults([dueTask("t1", "2026-10-06")], [], [], []);
    await handleDueDateReminder([]);
    expect(createNotificationsMock).not.toHaveBeenCalled();
  });

  it("deduplicates a user who is both assignee and watcher", async () => {
    queueSelectResults(
      [dueTask("t1", "2026-10-06")],
      [],
      [{ userId: "u1" }],
      [{ userId: "u1" }, { userId: "u2" }]
    );
    await handleDueDateReminder([]);
    expect(createNotificationsMock).toHaveBeenCalledWith(
      expect.objectContaining({ recipientIds: ["u1", "u2"] })
    );
  });

  it("includes the task title in the notification message", async () => {
    queueSelectResults(
      [dueTask("t1", "2026-10-06", { title: "Ship the release" })],
      [],
      [{ userId: "u1" }],
      []
    );
    await handleDueDateReminder([]);
    expect(createNotificationsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("Ship the release"),
      })
    );
  });
});
