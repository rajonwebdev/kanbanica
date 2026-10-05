import { and, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  buildTaskFilterConditions,
  withTaskFilters,
} from "@/lib/filters/task-conditions";

// Wednesday 2026-10-07 — "today" in the workspace timezone.
const TODAY = "2026-10-07";
const dialect = new PgDialect();
const render = (conditions: SQL[]) => {
  const combined = and(...conditions);
  if (!combined) {
    throw new Error("no conditions");
  }
  return dialect.sqlToQuery(combined);
};

// No @/lib/db mock needed: buildTaskFilterConditions only ever *builds* SQL
// (including unexecuted Drizzle subqueries for assignee/tags/sprint) — it never
// awaits a query, so the real query builder can be exercised safely with no
// network I/O.

describe("buildTaskFilterConditions", () => {
  it("returns no conditions for empty filters", () => {
    expect(buildTaskFilterConditions({}, TODAY)).toHaveLength(0);
  });

  it("adds one condition for a non-empty status filter", () => {
    expect(buildTaskFilterConditions({ status: ["s1"] }, TODAY)).toHaveLength(
      1
    );
  });

  it("ignores an empty status array", () => {
    expect(buildTaskFilterConditions({ status: [] }, TODAY)).toHaveLength(0);
  });

  it("adds one condition for a non-empty statusType filter", () => {
    expect(
      buildTaskFilterConditions({ statusType: ["OPEN"] }, TODAY)
    ).toHaveLength(1);
  });

  it("adds one condition for a non-empty priority filter", () => {
    expect(
      buildTaskFilterConditions({ priority: ["HIGH"] }, TODAY)
    ).toHaveLength(1);
  });

  describe("due", () => {
    it("adds no condition when due is the empty-string sentinel", () => {
      expect(buildTaskFilterConditions({ due: "" }, TODAY)).toHaveLength(0);
    });

    it("adds one condition for 'overdue'", () => {
      expect(buildTaskFilterConditions({ due: "overdue" }, TODAY)).toHaveLength(
        1
      );
    });

    it("adds two conditions (start/end of day) for 'today'", () => {
      expect(buildTaskFilterConditions({ due: "today" }, TODAY)).toHaveLength(
        2
      );
    });

    it("adds two conditions (start/end of week) for 'this_week'", () => {
      expect(
        buildTaskFilterConditions({ due: "this_week" }, TODAY)
      ).toHaveLength(2);
    });

    it("adds one condition for 'no_due_date'", () => {
      expect(
        buildTaskFilterConditions({ due: "no_due_date" }, TODAY)
      ).toHaveLength(1);
    });
  });

  describe("due — calendar-day bounds in the workspace timezone", () => {
    it("overdue is strictly before today, so a task due today is not overdue", () => {
      const q = render(buildTaskFilterConditions({ due: "overdue" }, TODAY));
      expect(q.sql).toContain('"task"."due_date_end" < $1');
      expect(q.params).toEqual([TODAY]);
    });

    it("today is exactly today's calendar day", () => {
      const q = render(buildTaskFilterConditions({ due: "today" }, TODAY));
      expect(q.sql).toContain('"task"."due_date_end" >= $1');
      expect(q.sql).toContain('"task"."due_date_end" <= $2');
      expect(q.params).toEqual([TODAY, TODAY]);
    });

    it("this week is the Monday–Sunday week containing today", () => {
      const q = render(buildTaskFilterConditions({ due: "this_week" }, TODAY));
      expect(q.params).toEqual(["2026-10-05", "2026-10-11"]);
    });

    it("a Sunday still belongs to the week that started the Monday before", () => {
      const q = render(
        buildTaskFilterConditions({ due: "this_week" }, "2026-10-11")
      );
      expect(q.params).toEqual(["2026-10-05", "2026-10-11"]);
    });

    it("bounds don't depend on the server's timezone", () => {
      const original = process.env.TZ;
      const results = ["UTC", "Asia/Kolkata", "America/New_York"].map((tz) => {
        process.env.TZ = tz;
        return render(buildTaskFilterConditions({ due: "this_week" }, TODAY))
          .params;
      });
      process.env.TZ = original;
      expect(new Set(results.map((r) => r.join()))).toEqual(
        new Set(["2026-10-05,2026-10-11"])
      );
    });
  });

  describe("assignee", () => {
    it("ignores an empty assignee array", () => {
      expect(buildTaskFilterConditions({ assignee: [] }, TODAY)).toHaveLength(
        0
      );
    });

    it("adds one condition for specific user ids only", () => {
      expect(
        buildTaskFilterConditions({ assignee: ["u1", "u2"] }, TODAY)
      ).toHaveLength(1);
    });

    it("adds one condition for the 'unassigned' sentinel only", () => {
      expect(
        buildTaskFilterConditions({ assignee: ["unassigned"] }, TODAY)
      ).toHaveLength(1);
    });

    it("combines user ids and 'unassigned' into a single OR condition", () => {
      expect(
        buildTaskFilterConditions({ assignee: ["u1", "unassigned"] }, TODAY)
      ).toHaveLength(1);
    });
  });

  it("adds one condition for a non-empty tags filter", () => {
    expect(buildTaskFilterConditions({ tags: ["t1"] }, TODAY)).toHaveLength(1);
  });

  it("adds one condition for a non-empty sprint filter", () => {
    expect(
      buildTaskFilterConditions({ sprint: ["sprint1"] }, TODAY)
    ).toHaveLength(1);
  });

  it("combines multiple independent filters additively", () => {
    expect(
      buildTaskFilterConditions(
        {
          status: ["s1"],
          priority: ["HIGH"],
          tags: ["t1"],
        },
        TODAY
      )
    ).toHaveLength(3);
  });
});

describe("withTaskFilters", () => {
  it("returns undefined when there are no base or filter conditions", () => {
    expect(withTaskFilters([], {}, TODAY)).toBeUndefined();
  });

  it("returns a defined SQL expression when at least one condition exists", () => {
    expect(withTaskFilters([], { status: ["s1"] }, TODAY)).toBeDefined();
  });

  it("combines base conditions with filter conditions", () => {
    const [baseCondition] = buildTaskFilterConditions(
      { priority: ["HIGH"] },
      TODAY
    );
    expect(
      withTaskFilters([baseCondition], { status: ["s1"] }, TODAY)
    ).toBeDefined();
  });
});
