import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { userEmailPreference } from "@/db/schema";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canonicalTimeZone, isValidTimeZone } from "@/lib/timezone";

const DIGEST_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function GET(_req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [pref] = await db
    .select()
    .from(userEmailPreference)
    .where(eq(userEmailPreference.userId, session.user.id))
    .limit(1);

  return NextResponse.json({
    // `saved: false` lets the settings page pre-fill the browser timezone for a
    // user who has never saved email preferences (emails can't read it).
    saved: Boolean(pref),
    preference: pref ?? {
      deliveryMode: "instant",
      digestTime: "08:00",
      digestTimezone: "UTC",
      soundEnabled: true,
      soundVolume: 70,
      soundType: "default",
    },
  });
}

export async function PATCH(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    deliveryMode,
    digestTime,
    digestTimezone,
    soundEnabled,
    soundVolume,
    soundType,
  } = body;

  if (
    digestTimezone !== undefined &&
    (typeof digestTimezone !== "string" || !isValidTimeZone(digestTimezone))
  ) {
    return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
  }
  if (
    digestTime !== undefined &&
    (typeof digestTime !== "string" || !DIGEST_TIME_RE.test(digestTime))
  ) {
    return NextResponse.json({ error: "Invalid digest time" }, { status: 400 });
  }
  const timeZone =
    digestTimezone === undefined
      ? undefined
      : canonicalTimeZone(digestTimezone);

  const [existing] = await db
    .select({ id: userEmailPreference.id })
    .from(userEmailPreference)
    .where(eq(userEmailPreference.userId, session.user.id))
    .limit(1);

  const now = new Date();

  if (existing) {
    await db
      .update(userEmailPreference)
      .set({
        ...(deliveryMode !== undefined && { deliveryMode }),
        ...(digestTime !== undefined && { digestTime }),
        ...(timeZone !== undefined && { digestTimezone: timeZone }),
        ...(soundEnabled !== undefined && { soundEnabled }),
        ...(soundVolume !== undefined && { soundVolume }),
        ...(soundType !== undefined && { soundType }),
        updatedAt: now,
      })
      .where(eq(userEmailPreference.id, existing.id));
  } else {
    await db.insert(userEmailPreference).values({
      id: createId(),
      userId: session.user.id,
      deliveryMode: deliveryMode ?? "instant",
      digestTime: digestTime ?? "08:00",
      digestTimezone: timeZone ?? "UTC",
      soundEnabled: soundEnabled ?? true,
      soundVolume: soundVolume ?? 70,
      soundType: soundType ?? "default",
      updatedAt: now,
    });
  }

  return NextResponse.json({ ok: true });
}
