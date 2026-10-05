import { beforeEach, describe, expect, it, vi } from "vitest";
import { sprint, taskSprint } from "@/db/schema";
import {
  closeSprintAndRollover,
  incrementSprintName,
  sprintEndDay,
} from "@/lib/sprint/rollover";

const {
  selectMock,
  insertMock,
  insertValuesSpy,
  deleteMock,
  deleteWhereSpy,
  updateMock,
  updateSetSpy,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  insertValuesSpy: vi.fn(),
  deleteMock: vi.fn(),
  deleteWhereSpy: vi.fn(),
  updateMock: vi.fn(),
  updateSetSpy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    delete: deleteMock,
    update: updateMock,
  },
}));
vi.mock("@paralleldrive/cuid2", () => ({ createId: () => "new-sprint-id" }));

interface SelectChain extends PromiseLike<unknown[]> {
  from: () => SelectChain;
  innerJoin: () => SelectChain;
  leftJoin: () => SelectChain;
  limit: () => Promise<unknown[]>;
  where: () => SelectChain;
}

function createSelectChain(result: unknown[]): SelectChain {
  const chain: SelectChain = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
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
    return createSelectChain(result);
  });
}

interface VoidChain extends PromiseLike<undefined> {
  onConflictDoNothing: () => Promise<undefined>;
}

function createVoidChain(): VoidChain {
  const chain: VoidChain = {
    onConflictDoNothing: () => Promise.resolve(undefined),
    // biome-ignore lint/suspicious/noThenProperty: mirrors Drizzle's own thenable query builder
    then: (onfulfilled, onrejected) =>
      Promise.resolve(undefined).then(onfulfilled, onrejected),
  };
  return chain;
}

function stubInsert() {
  insertMock.mockImplementation((table: unknown) => ({
    values: (rows: unknown) => {
      insertValuesSpy(table, rows);
      return createVoidChain();
    },
  }));
}

function stubDelete() {
  deleteMock.mockImplementation((table: unknown) => ({
    where: (cond: unknown) => {
      deleteWhereSpy(table, cond);
      return Promise.resolve(undefined);
    },
  }));
}

function stubUpdate() {
  updateMock.mockImplementation((table: unknown) => ({
    set: (values: unknown) => {
      updateSetSpy(table, values);
      return { where: () => Promise.resolve(undefined) };
    },
  }));
}

beforeEach(() => {
  selectMock.mockReset();
  insertMock.mockReset();
  insertValuesSpy.mockReset();
  deleteMock.mockReset();
  deleteWhereSpy.mockReset();
  updateMock.mockReset();
  updateSetSpy.mockReset();
  stubInsert();
  stubDelete();
  stubUpdate();
});

describe("sprintEndDay", () => {
  it("makes a 1-week sprint exactly 7 calendar days, both ends inclusive", () => {
    expect(sprintEndDay("2026-10-05", 1)).toBe("2026-10-11");
  });

  it("makes an N-week sprint N×7 days", () => {
    expect(sprintEndDay("2026-10-05", 2)).toBe("2026-10-18");
    expect(sprintEndDay("2026-10-05", 4)).toBe("2026-11-01");
  });

  it("crosses month, year and DST boundaries without drifting", () => {
    expect(sprintEndDay("2026-12-28", 1)).toBe("2027-01-03");
    // EU fall-back (Oct 25) and US fall-back (Nov 1) inside the sprint.
    expect(sprintEndDay("2026-10-21", 1)).toBe("2026-10-27");
    expect(sprintEndDay("2026-10-28", 1)).toBe("2026-11-03");
  });
});

describe("incrementSprintName", () => {
  it("increments a single-digit trailing number", () => {
    expect(incrementSprintName("Sprint 3")).toBe("Sprint 4");
  });

  it("increments a multi-digit trailing number", () => {
    expect(incrementSprintName("Sprint 10")).toBe("Sprint 11");
  });

  it("preserves trailing whitespace after the number", () => {
    expect(incrementSprintName("Sprint 3 ")).toBe("Sprint 4 ");
  });

  it("only increments the trailing number, not one embedded earlier in the name", () => {
    expect(incrementSprintName("Sprint 2024-3")).toBe("Sprint 2024-4");
  });

  it("falls back to appending ' 2' when there is no trailing number", () => {
    expect(incrementSprintName("Backlog")).toBe("Backlog 2");
  });

  it("falls back to appending ' 2' when the number isn't at the end", () => {
    expect(incrementSprintName("2024 Sprint")).toBe("2024 Sprint 2");
  });
});

describe("closeSprintAndRollover", () => {
  it("is a no-op when the sprint is not ACTIVE", async () => {
    queueSelectResults([
      { status: "PLANNED", name: "Sprint 1", endDate: null, durationWeeks: 2 },
    ]);
    const result = await closeSprintAndRollover({
      spaceId: "sp1",
      sprintId: "s1",
      actorId: "u1",
      incompleteStrategy: "leave_as_is",
      autoCreateNext: false,
    });
    expect(result).toEqual({ nextSprintId: null });
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("closes the sprint with no rollover when leave_as_is and autoCreateNext is false", async () => {
    queueSelectResults(
      [
        {
          status: "ACTIVE",
          name: "Sprint 1",
          endDate: "2024-01-01",
          durationWeeks: 2,
        },
      ],
      [{ taskId: "t1", statusType: "OPEN" }]
    );
    const result = await closeSprintAndRollover({
      spaceId: "sp1",
      sprintId: "s1",
      actorId: "u1",
      incompleteStrategy: "leave_as_is",
      autoCreateNext: false,
    });
    expect(result).toEqual({ nextSprintId: null });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateSetSpy).toHaveBeenCalledWith(
      sprint,
      expect.objectContaining({ status: "CLOSED" })
    );
  });

  it("creates the next sprint from space defaults when no PLANNED sprint exists", async () => {
    queueSelectResults(
      [
        {
          status: "ACTIVE",
          name: "Sprint 5",
          endDate: "2024-01-01",
          durationWeeks: 2,
        },
      ],
      [],
      [] // no existing PLANNED sprint
    );
    const result = await closeSprintAndRollover({
      spaceId: "sp1",
      sprintId: "s1",
      actorId: "u1",
      incompleteStrategy: "move_to_backlog",
      autoCreateNext: true,
    });
    expect(result).toEqual({ nextSprintId: "new-sprint-id" });
    const [table, values] = insertValuesSpy.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(table).toBe(sprint);
    expect(values).toMatchObject({
      id: "new-sprint-id",
      spaceId: "sp1",
      name: incrementSprintName("Sprint 5"),
      status: "PLANNED",
      // Day after the closed sprint's last day; 2 weeks = 14 days inclusive.
      startDate: "2024-01-02",
      endDate: "2024-01-15",
    });
  });

  it("starts the next sprint on 'today' in the WORKSPACE timezone when the closed one had no end date", async () => {
    vi.useFakeTimers();
    // 20:00 UTC on Oct 5 is already Oct 6 in India.
    vi.setSystemTime(new Date("2026-10-05T20:00:00Z"));
    try {
      queueSelectResults(
        [
          {
            status: "ACTIVE",
            name: "Sprint 1",
            endDate: null,
            durationWeeks: 1,
            timezone: "Asia/Kolkata",
          },
        ],
        [],
        []
      );
      await closeSprintAndRollover({
        spaceId: "sp1",
        sprintId: "s1",
        actorId: "u1",
        incompleteStrategy: "move_to_backlog",
        autoCreateNext: true,
      });
      const [, values] = insertValuesSpy.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(values).toMatchObject({
        startDate: "2026-10-06",
        endDate: "2026-10-12",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses an existing PLANNED sprint instead of creating a new one", async () => {
    queueSelectResults(
      [
        {
          status: "ACTIVE",
          name: "Sprint 5",
          endDate: "2024-01-01",
          durationWeeks: 2,
        },
      ],
      [],
      [{ id: "existing-planned-id" }]
    );
    const result = await closeSprintAndRollover({
      spaceId: "sp1",
      sprintId: "s1",
      actorId: "u1",
      incompleteStrategy: "move_to_backlog",
      autoCreateNext: true,
    });
    expect(result).toEqual({ nextSprintId: "existing-planned-id" });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("prefers an explicit valid PLANNED targetSprintId over auto-create, and skips the existing-PLANNED query", async () => {
    queueSelectResults(
      [
        {
          status: "ACTIVE",
          name: "Sprint 5",
          endDate: "2024-01-01",
          durationWeeks: 2,
        },
      ],
      [],
      [{ id: "target-1", status: "PLANNED" }]
    );
    const result = await closeSprintAndRollover({
      spaceId: "sp1",
      sprintId: "s1",
      actorId: "u1",
      incompleteStrategy: "move_to_backlog",
      autoCreateNext: true,
      targetSprintId: "target-1",
    });
    expect(result).toEqual({ nextSprintId: "target-1" });
    expect(selectMock).toHaveBeenCalledTimes(3);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("ignores an explicit targetSprintId that is not PLANNED and falls through", async () => {
    queueSelectResults(
      [
        {
          status: "ACTIVE",
          name: "Sprint 5",
          endDate: "2024-01-01",
          durationWeeks: 2,
        },
      ],
      [],
      [{ id: "target-1", status: "ACTIVE" }]
    );
    const result = await closeSprintAndRollover({
      spaceId: "sp1",
      sprintId: "s1",
      actorId: "u1",
      incompleteStrategy: "move_to_backlog",
      autoCreateNext: false,
      targetSprintId: "target-1",
    });
    expect(result).toEqual({ nextSprintId: null });
  });

  it("deletes incomplete tasks and carries them to the next sprint under move_to_next_sprint", async () => {
    queueSelectResults(
      [
        {
          status: "ACTIVE",
          name: "Sprint 5",
          endDate: "2024-01-01",
          durationWeeks: 2,
        },
      ],
      [
        { taskId: "t1", statusType: "OPEN" },
        { taskId: "t2", statusType: "ACTIVE" },
        { taskId: "t3", statusType: "CLOSED" },
      ],
      [{ id: "planned-1" }]
    );
    await closeSprintAndRollover({
      spaceId: "sp1",
      sprintId: "s1",
      actorId: "u1",
      incompleteStrategy: "move_to_next_sprint",
      autoCreateNext: true,
    });
    expect(deleteWhereSpy).toHaveBeenCalledTimes(1);
    expect(deleteWhereSpy.mock.calls[0][0]).toBe(taskSprint);
    const [table, rows] = insertValuesSpy.mock.calls[0] as [
      unknown,
      Array<{ sprintId: string }>,
    ];
    expect(table).toBe(taskSprint);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sprintId === "planned-1")).toBe(true);
  });

  it("deletes incomplete tasks without re-inserting them under move_to_backlog", async () => {
    queueSelectResults(
      [
        {
          status: "ACTIVE",
          name: "Sprint 5",
          endDate: "2024-01-01",
          durationWeeks: 2,
        },
      ],
      [{ taskId: "t1", statusType: "OPEN" }]
    );
    await closeSprintAndRollover({
      spaceId: "sp1",
      sprintId: "s1",
      actorId: "u1",
      incompleteStrategy: "move_to_backlog",
      autoCreateNext: false,
    });
    expect(deleteWhereSpy).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("leaves taskSprint rows untouched under leave_as_is even with incomplete tasks", async () => {
    queueSelectResults(
      [
        {
          status: "ACTIVE",
          name: "Sprint 5",
          endDate: "2024-01-01",
          durationWeeks: 2,
        },
      ],
      [{ taskId: "t1", statusType: "OPEN" }]
    );
    await closeSprintAndRollover({
      spaceId: "sp1",
      sprintId: "s1",
      actorId: "u1",
      incompleteStrategy: "leave_as_is",
      autoCreateNext: false,
    });
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
