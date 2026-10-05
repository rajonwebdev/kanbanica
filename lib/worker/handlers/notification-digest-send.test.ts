import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleNotificationDigestSend } from "@/lib/worker/handlers/notification-digest-send";

const { selectMock, enqueueEmailMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  enqueueEmailMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { select: selectMock } }));
vi.mock("@/lib/email/index", () => ({ enqueueEmail: enqueueEmailMock }));

interface QueryChain extends PromiseLike<unknown[]> {
  from: () => QueryChain;
  leftJoin: () => QueryChain;
  limit: () => Promise<unknown[]>;
  where: () => QueryChain;
}

function createChain(result: unknown[]): QueryChain {
  const chain: QueryChain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
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

function job(userId = "u1") {
  return {
    data: {
      userId,
      windowStart: "2024-06-01T08:00:00.000Z",
      windowEnd: "2024-06-01T08:30:00.000Z",
    },
  } as never;
}

beforeEach(() => {
  selectMock.mockReset();
  enqueueEmailMock.mockReset();
});

describe("handleNotificationDigestSend", () => {
  it("does nothing when the user doesn't exist", async () => {
    queueSelectResults([]);
    await handleNotificationDigestSend([job()]);
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("does nothing when there are no unread notifications in the window", async () => {
    queueSelectResults([{ email: "u1@example.com", name: "User One" }], []);
    await handleNotificationDigestSend([job()]);
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("does nothing when every unread notification is filtered out by preference", async () => {
    queueSelectResults(
      [{ email: "u1@example.com", name: "User One" }],
      [
        {
          title: "Task created",
          triggerType: "task_created",
          createdAt: new Date(),
        },
      ],
      [{ triggerType: "task_created", emailEnabled: false }]
    );
    await handleNotificationDigestSend([job()]);
    expect(selectMock).toHaveBeenCalledTimes(3);
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it("sends a digest for a trigger that defaults to email-on when there's no explicit preference", async () => {
    queueSelectResults(
      [{ email: "u1@example.com", name: "User One" }],
      [
        {
          title: "You were assigned",
          triggerType: "task_assigned",
          createdAt: new Date(),
        },
      ],
      []
    );
    await handleNotificationDigestSend([job()]);
    expect(enqueueEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "u1@example.com" })
    );
  });

  it("respects an explicit emailEnabled:true preference overriding a non-default trigger", async () => {
    queueSelectResults(
      [{ email: "u1@example.com", name: "User One" }],
      [
        {
          title: "Task created",
          triggerType: "task_created",
          createdAt: new Date(),
        },
      ],
      [{ triggerType: "task_created", emailEnabled: true }]
    );
    await handleNotificationDigestSend([job()]);
    expect(enqueueEmailMock).toHaveBeenCalled();
  });

  it("HTML-escapes notification titles before interpolating them into the digest email", async () => {
    queueSelectResults(
      [{ email: "u1@example.com", name: "User One" }],
      [
        {
          title: "<script>alert(1)</script>",
          triggerType: "task_assigned",
          createdAt: new Date(),
        },
      ],
      []
    );
    await handleNotificationDigestSend([job()]);
    const [{ html }] = enqueueEmailMock.mock.calls[0] as [{ html: string }];
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("includes every surviving notification's title in the digest text", async () => {
    queueSelectResults(
      [{ email: "u1@example.com", name: "User One" }],
      [
        {
          title: "First notification",
          triggerType: "task_assigned",
          createdAt: new Date(),
        },
        {
          title: "Second notification",
          triggerType: "comment_reply",
          createdAt: new Date(),
        },
      ],
      []
    );
    await handleNotificationDigestSend([job()]);
    const [{ text }] = enqueueEmailMock.mock.calls[0] as [{ text: string }];
    expect(text).toContain("First notification");
    expect(text).toContain("Second notification");
  });

  it("formats notification times in the user's stored timezone, not UTC", async () => {
    queueSelectResults(
      [
        {
          email: "u1@example.com",
          name: "User One",
          timeZone: "Asia/Kolkata",
        },
      ],
      [
        {
          title: "Task assigned",
          triggerType: "task_assigned",
          createdAt: new Date("2026-10-05T12:00:00Z"),
        },
      ],
      [{ triggerType: "task_assigned", emailEnabled: true }]
    );
    await handleNotificationDigestSend([job()]);
    const [{ html, text }] = enqueueEmailMock.mock.calls[0] as [
      { html: string; text: string },
    ];
    expect(text).toContain("Oct 5, 2026, 5:30 PM GMT+5:30");
    expect(html).toContain("Oct 5, 2026, 5:30 PM GMT+5:30");
  });

  it("falls back to UTC when the user has no stored timezone", async () => {
    queueSelectResults(
      [{ email: "u1@example.com", name: "User One", timeZone: null }],
      [
        {
          title: "Task assigned",
          triggerType: "task_assigned",
          createdAt: new Date("2026-10-05T12:00:00Z"),
        },
      ],
      [{ triggerType: "task_assigned", emailEnabled: true }]
    );
    await handleNotificationDigestSend([job()]);
    const [{ text }] = enqueueEmailMock.mock.calls[0] as [{ text: string }];
    expect(text).toContain("Oct 5, 2026, 12:00 PM UTC");
  });
});
