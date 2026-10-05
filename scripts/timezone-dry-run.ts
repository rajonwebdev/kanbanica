import { existsSync } from "node:fs";
import postgres from "postgres";
import { sanitizeDatabaseUrl } from "@/lib/pg-connection";
import {
  diffCalendarDays,
  isValidTimeZone,
  resolveTimeZone,
} from "@/lib/timezone";
import {
  formatOffset,
  type LegacyDateProposal,
  proposeCalendarDay,
} from "@/lib/timezone-migration";

// READ-ONLY dry run for the calendar-day migration.
//
// Reports, for every task due date, sprint start/end and custom DATE value,
// which calendar day the migration WOULD write and which rows need a human to
// look at them. It never writes: everything runs inside a READ ONLY
// transaction, which Postgres itself refuses to let modify data.
//
//   pnpm tz:dry-run                     # flagged rows + summary
//   pnpm tz:dry-run --all               # every row
//   pnpm tz:dry-run --tz=Asia/Kolkata   # read values as if the workspace used this timezone
//   pnpm tz:dry-run --json > report.json

if (existsSync(".env")) {
  process.loadEnvFile();
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const showAll = flag("all");
const asJson = flag("json");
const tzOverride = option("tz");

if (tzOverride && !isValidTimeZone(tzOverride)) {
  console.error(`--tz: "${tzOverride}" is not a valid IANA timezone.`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

interface Row {
  id: string;
  label: string;
  proposal: LegacyDateProposal;
  source:
    | "task.due_date_start"
    | "task.due_date_end"
    | "sprint.start_date"
    | "sprint.end_date"
    | "custom_field_value";
  workspaceTimeZone: string;
}

interface SprintLength {
  endDay: string;
  expectedDays: number;
  id: string;
  /** Days covered counting both ends — what the user actually experiences. */
  inclusiveDays: number;
  label: string;
  startDay: string;
}

function describeHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparsed DATABASE_URL)";
  }
}

async function main() {
  const { url, ssl } = sanitizeDatabaseUrl(databaseUrl as string);
  const sql = postgres(url, { max: 1, ssl });

  const rows: Row[] = [];
  const sprintLengths: SprintLength[] = [];
  const workspaces: { id: string; name: string; timezone: string }[] = [];

  try {
    await sql.begin("read only", async (tx) => {
      const wsRows = await tx<{ id: string; name: string; timezone: string }[]>`
        select id, name, timezone from workspace order by created_at`;
      workspaces.push(...wsRows);
      const tzFor = (workspaceTimeZone: string) =>
        resolveTimeZone(tzOverride ?? workspaceTimeZone);

      const tasks = await tx<
        {
          id: string;
          seq_number: number;
          title: string;
          timezone: string;
          due_date_start: Date | null;
          due_date_end: Date | null;
        }[]
      >`
        select t.id, t.seq_number, t.title, w.timezone,
               t.due_date_start, t.due_date_end
        from task t
        join workspace w on w.id = t.workspace_id
        where t.due_date_start is not null or t.due_date_end is not null
        order by w.id, t.seq_number`;

      for (const t of tasks) {
        const tz = tzFor(t.timezone);
        const label = `#${t.seq_number} ${t.title}`;
        if (t.due_date_start) {
          rows.push({
            source: "task.due_date_start",
            id: t.id,
            label,
            workspaceTimeZone: tz,
            proposal: proposeCalendarDay(t.due_date_start, tz),
          });
        }
        if (t.due_date_end) {
          rows.push({
            source: "task.due_date_end",
            id: t.id,
            label,
            workspaceTimeZone: tz,
            proposal: proposeCalendarDay(t.due_date_end, tz),
          });
        }
      }

      const sprints = await tx<
        {
          id: string;
          name: string;
          status: string;
          duration_weeks: number;
          timezone: string;
          start_date: Date | null;
          end_date: Date | null;
        }[]
      >`
        select s.id, s.name, s.status, s.duration_weeks, w.timezone,
               s.start_date, s.end_date
        from sprint s
        join space sp on sp.id = s.space_id
        join workspace w on w.id = sp.workspace_id
        where s.start_date is not null or s.end_date is not null
        order by s.created_at`;

      for (const s of sprints) {
        const tz = tzFor(s.timezone);
        const label = `${s.name} (${s.status})`;
        const start = s.start_date
          ? proposeCalendarDay(s.start_date, tz)
          : null;
        const end = s.end_date ? proposeCalendarDay(s.end_date, tz) : null;
        if (start) {
          rows.push({
            source: "sprint.start_date",
            id: s.id,
            label,
            workspaceTimeZone: tz,
            proposal: start,
          });
        }
        if (end) {
          rows.push({
            source: "sprint.end_date",
            id: s.id,
            label,
            workspaceTimeZone: tz,
            proposal: end,
          });
        }
        if (start?.proposedDay && end?.proposedDay) {
          sprintLengths.push({
            id: s.id,
            label,
            startDay: start.proposedDay,
            endDay: end.proposedDay,
            inclusiveDays:
              diffCalendarDays(end.proposedDay, start.proposedDay) + 1,
            expectedDays: s.duration_weeks * 7,
          });
        }
      }

      const customValues = await tx<
        {
          id: string;
          field_name: string;
          seq_number: number;
          timezone: string;
          value: unknown;
        }[]
      >`
        select v.id, d.name as field_name, t.seq_number, w.timezone, v.value
        from custom_field_value v
        join custom_field_definition d on d.id = v.field_id
        join task t on t.id = v.task_id
        join workspace w on w.id = t.workspace_id
        where d.type = 'DATE' and v.value is not null and v.value <> 'null'::jsonb`;

      for (const v of customValues) {
        const tz = tzFor(v.timezone);
        rows.push({
          source: "custom_field_value",
          id: v.id,
          label: `#${v.seq_number} · ${v.field_name}`,
          workspaceTimeZone: tz,
          proposal: proposeCalendarDay(v.value, tz),
        });
      }
    });
  } finally {
    await sql.end();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    database: describeHost(url),
    timezoneOverride: tzOverride ?? null,
    workspaces,
    summary: summarize(rows),
    sprintLengthMismatches: sprintLengths.filter(
      (s) => s.inclusiveDays !== s.expectedDays
    ),
    rows:
      showAll || asJson
        ? rows
        : rows.filter((r) => r.proposal.flags.length > 0),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report, rows.length);
}

function summarize(rows: Row[]) {
  const sources = [...new Set(rows.map((r) => r.source))];
  return sources.map((source) => {
    const subset = rows.filter((r) => r.source === source);
    const count = (f: string) =>
      subset.filter((r) => r.proposal.flags.includes(f as never)).length;
    return {
      source,
      total: subset.length,
      hasTimeOfDay: count("HAS_TIME_OF_DAY"),
      ambiguousOffset: count("AMBIGUOUS_OFFSET"),
      invalid: count("INVALID"),
      differsFromWorkspaceTz: count("DIFFERS_FROM_WORKSPACE_TZ"),
      needsReview: subset.filter((r) => r.proposal.needsReview).length,
    };
  });
}

function printReport(
  report: {
    generatedAt: string;
    database: string;
    timezoneOverride: string | null;
    workspaces: { id: string; name: string; timezone: string }[];
    summary: ReturnType<typeof summarize>;
    sprintLengthMismatches: SprintLength[];
    rows: Row[];
  },
  totalRows: number
) {
  console.log(
    "Calendar-day migration — DRY RUN (read-only, nothing is written)"
  );
  console.log(`Database:  ${report.database}`);
  console.log(`Generated: ${report.generatedAt}`);
  console.log(
    `Workspaces: ${report.workspaces.map((w) => `${w.name} [${w.timezone}]`).join(", ") || "none"}`
  );
  if (report.timezoneOverride) {
    console.log(`Timezone override (--tz): ${report.timezoneOverride}`);
  }

  console.log("\nSummary");
  if (report.summary.length === 0) {
    console.log("  No due dates, sprint dates or custom DATE values found.");
  } else {
    console.table(report.summary);
  }

  if (report.sprintLengthMismatches.length > 0) {
    console.log(
      "\nSprints whose length doesn't match their duration (start and end both counted):"
    );
    console.table(
      report.sprintLengthMismatches.map((s) => ({
        sprint: s.label,
        start: s.startDay,
        end: s.endDay,
        days: s.inclusiveDays,
        expected: s.expectedDays,
      }))
    );
  }

  const heading = showAll ? "All rows" : "Flagged rows";
  console.log(`\n${heading} (${report.rows.length} of ${totalRows})`);
  if (report.rows.length > 0) {
    console.table(
      report.rows.map((r) => ({
        source: r.source,
        item: r.label.length > 40 ? `${r.label.slice(0, 39)}…` : r.label,
        stored: r.proposal.stored,
        "implied offset": formatOffset(r.proposal.inferredOffsetMinutes),
        "would write": r.proposal.proposedDay ?? "—",
        [`in ${report.timezoneOverride ?? "workspace tz"}`]:
          r.proposal.workspaceDay ?? "—",
        flags: r.proposal.flags.join(", ") || "—",
        review: r.proposal.needsReview ? "YES" : "",
      }))
    );
  }

  console.log(
    "\nFlags: HAS_TIME_OF_DAY = resolved in the workspace timezone · AMBIGUOUS_OFFSET = UTC−10…−12 vs UTC+12…+14, needs review" +
      " · DIFFERS_FROM_WORKSPACE_TZ = the author's day differs from a naive read in the workspace timezone · INVALID = needs review"
  );
}

main().catch((error) => {
  console.error("[tz:dry-run] failed:", error);
  process.exit(1);
});
