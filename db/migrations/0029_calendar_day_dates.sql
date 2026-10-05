-- Calendar-day migration: due dates, sprint dates and custom DATE values become
-- plain calendar days ("YYYY-MM-DD") instead of instants.
--
-- The old pickers stored a picked day as LOCAL MIDNIGHT of the picker's own
-- browser (India "Oct 5" → 2026-10-04T18:30Z, New York → 2026-10-05T04:00Z).
-- A plain ::date cast would use the database session timezone and shift those
-- days, so each value goes through the confirmed rule instead — identical to
-- proposeCalendarDay() in lib/timezone-migration.ts, which powers the dry run
-- (`pnpm tz:dry-run`):
--   * whole quarter hour, no seconds (a picker's local midnight)
--       → nearest UTC midnight; recovers the author's day for UTC−12…+12
--   * carries a real time of day (e.g. a sprint start stamped "now")
--       → the day it falls on in the WORKSPACE timezone
--
-- Run `pnpm tz:dry-run` first and review flagged rows. Set each workspace's
-- timezone BEFORE migrating if it holds sprints started via "Start sprint".

CREATE OR REPLACE FUNCTION "kanbanica_legacy_calendar_day"(v timestamptz, tz text)
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN date_trunc('minute', v) = date_trunc('milliseconds', v)
         AND (extract(minute FROM v AT TIME ZONE 'UTC')::int % 15) = 0
      THEN ((v AT TIME ZONE 'UTC') + interval '12 hours')::date
    ELSE (v AT TIME ZONE (
      CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = tz)
        THEN tz ELSE 'UTC' END
    ))::date
  END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kanbanica_workspace_tz"(workspace_id text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT timezone FROM workspace WHERE id = workspace_id
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kanbanica_space_tz"(space_id text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT w.timezone FROM space s JOIN workspace w ON w.id = s.workspace_id WHERE s.id = space_id
$$;--> statement-breakpoint
ALTER TABLE "task" ALTER COLUMN "due_date_start" SET DATA TYPE date
  USING "kanbanica_legacy_calendar_day"("due_date_start", "kanbanica_workspace_tz"("workspace_id"));--> statement-breakpoint
ALTER TABLE "task" ALTER COLUMN "due_date_end" SET DATA TYPE date
  USING "kanbanica_legacy_calendar_day"("due_date_end", "kanbanica_workspace_tz"("workspace_id"));--> statement-breakpoint
ALTER TABLE "sprint" ALTER COLUMN "start_date" SET DATA TYPE date
  USING "kanbanica_legacy_calendar_day"("start_date", "kanbanica_space_tz"("space_id"));--> statement-breakpoint
ALTER TABLE "sprint" ALTER COLUMN "end_date" SET DATA TYPE date
  USING "kanbanica_legacy_calendar_day"("end_date", "kanbanica_space_tz"("space_id"));--> statement-breakpoint
-- Custom DATE values (jsonb). Only ISO timestamp strings are converted; values
-- that are already "YYYY-MM-DD" or not dates at all are left untouched (the
-- dry run lists the latter as INVALID for manual review).
UPDATE "custom_field_value" AS v
SET "value" = to_jsonb("kanbanica_legacy_calendar_day"((v."value" #>> '{}')::timestamptz, w."timezone")::text),
    "updated_at" = now()
FROM "custom_field_definition" AS d, "task" AS t, "workspace" AS w
WHERE d."id" = v."field_id"
  AND d."type" = 'DATE'
  AND t."id" = v."task_id"
  AND w."id" = t."workspace_id"
  AND jsonb_typeof(v."value") = 'string'
  AND (v."value" #>> '{}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}';--> statement-breakpoint
-- DATE field defaults: no task, so the workspace comes from the definition.
UPDATE "custom_field_definition" AS d
SET "default_value" = to_jsonb("kanbanica_legacy_calendar_day"((d."default_value" #>> '{}')::timestamptz, w."timezone")::text),
    "updated_at" = now()
FROM "workspace" AS w
WHERE d."type" = 'DATE'
  AND w."id" = d."workspace_id"
  AND jsonb_typeof(d."default_value") = 'string'
  AND (d."default_value" #>> '{}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}';--> statement-breakpoint
DROP FUNCTION "kanbanica_space_tz"(text);--> statement-breakpoint
DROP FUNCTION "kanbanica_workspace_tz"(text);--> statement-breakpoint
DROP FUNCTION "kanbanica_legacy_calendar_day"(timestamptz, text);
