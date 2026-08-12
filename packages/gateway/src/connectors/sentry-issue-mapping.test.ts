import { describe, expect, test } from "bun:test";

import { mapSentryIssueToItem } from "./sentry-issue-mapping.ts";

const CTX = { org: "acme", syncedAt: 1_700_000_000_000 };

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "4711",
    title: "TypeError: undefined is not a function",
    culprit: "app/utils/parse.tsx in handleSubmit",
    permalink: "https://acme.sentry.io/issues/4711/",
    status: "resolved",
    level: "error",
    count: "42",
    userCount: 7,
    shortId: "ACME-3B",
    firstSeen: "2026-07-01T00:00:00.000Z",
    lastSeen: "2026-08-01T12:00:00.000Z",
    project: { slug: "web", name: "Web" },
    metadata: { value: "undefined is not a function", type: "TypeError" },
    assignedTo: { id: "u1", name: "Dana", type: "user", email: "dana@acme.example" },
    ...overrides,
  };
}

describe("mapSentryIssueToItem", () => {
  test("maps the core item fields", () => {
    const row = mapSentryIssueToItem(issue(), CTX);
    expect(row?.service).toBe("sentry");
    expect(row?.type).toBe("error_issue");
    expect(row?.externalId).toBe("4711");
    expect(row?.title).toBe("TypeError: undefined is not a function");
    expect(row?.url).toBe("https://acme.sentry.io/issues/4711/");
    expect(row?.canonicalUrl).toBe("https://acme.sentry.io/issues/4711/");
    expect(row?.modifiedAt).toBe(Date.parse("2026-08-01T12:00:00.000Z"));
    expect(row?.syncedAt).toBe(CTX.syncedAt);
  });

  // SPEC A ATTRIBUTES NOTHING.
  test("authorId is always null even when the issue is assigned", () => {
    expect(mapSentryIssueToItem(issue(), CTX)?.authorId).toBeNull();
  });

  // THE SPEC B HINGE: assignedTo is stored RAW so Spec B needs no re-sync.
  test("assignedTo is carried into metadata unresolved", () => {
    const meta = mapSentryIssueToItem(issue(), CTX)?.metadata ?? {};
    expect(meta["assignedTo"]).toEqual({
      id: "u1",
      name: "Dana",
      type: "user",
      email: "dana@acme.example",
    });
  });

  test("assignedTo null is preserved as null, not dropped", () => {
    const meta = mapSentryIssueToItem(issue({ assignedTo: null }), CTX)?.metadata ?? {};
    expect(meta).toHaveProperty("assignedTo");
    expect(meta["assignedTo"]).toBeNull();
  });

  test("captures status, level, counts, shortId, project and org", () => {
    const meta = mapSentryIssueToItem(issue(), CTX)?.metadata ?? {};
    expect(meta["status"]).toBe("resolved");
    expect(meta["level"]).toBe("error");
    expect(meta["userCount"]).toBe(7);
    expect(meta["shortId"]).toBe("ACME-3B");
    expect(meta["project"]).toBe("web");
    expect(meta["org"]).toBe("acme");
    expect(meta["firstSeen"]).toBe(Date.parse("2026-07-01T00:00:00.000Z"));
    expect(meta["lastSeen"]).toBe(Date.parse("2026-08-01T12:00:00.000Z"));
  });

  test("body joins metadata.value and culprit", () => {
    expect(mapSentryIssueToItem(issue(), CTX)?.body).toBe(
      "undefined is not a function\n\napp/utils/parse.tsx in handleSubmit",
    );
  });

  test("body omits an absent side without leaving blank lines", () => {
    expect(mapSentryIssueToItem(issue({ culprit: undefined }), CTX)?.body).toBe(
      "undefined is not a function",
    );
    expect(mapSentryIssueToItem(issue({ metadata: {} }), CTX)?.body).toBe(
      "app/utils/parse.tsx in handleSubmit",
    );
    expect(mapSentryIssueToItem(issue({ culprit: undefined, metadata: {} }), CTX)?.body).toBe("");
  });

  test("falls back to the short id then the raw id when title is absent", () => {
    expect(mapSentryIssueToItem(issue({ title: undefined }), CTX)?.title).toBe("ACME-3B");
    expect(mapSentryIssueToItem(issue({ title: undefined, shortId: undefined }), CTX)?.title).toBe(
      "4711",
    );
  });

  test("clamps an over-long title to 512 characters", () => {
    const row = mapSentryIssueToItem(issue({ title: "x".repeat(900) }), CTX);
    expect(row?.title).toHaveLength(512);
  });

  test("returns null for rows that cannot be identified or timestamped", () => {
    expect(mapSentryIssueToItem(issue({ id: undefined }), CTX)).toBeNull();
    expect(mapSentryIssueToItem(issue({ id: "" }), CTX)).toBeNull();
    expect(mapSentryIssueToItem(issue({ lastSeen: undefined }), CTX)).toBeNull();
    expect(mapSentryIssueToItem(issue({ lastSeen: "not-a-date" }), CTX)).toBeNull();
    expect(mapSentryIssueToItem(42, CTX)).toBeNull();
    expect(mapSentryIssueToItem(null, CTX)).toBeNull();
    expect(mapSentryIssueToItem([1, 2], CTX)).toBeNull();
  });

  test("tolerates a non-record project and a missing permalink", () => {
    const row = mapSentryIssueToItem(issue({ project: "web", permalink: undefined }), CTX);
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.metadata["project"]).toBeNull();
  });

  test("count arrives as a string from Sentry and is preserved verbatim", () => {
    expect(mapSentryIssueToItem(issue(), CTX)?.metadata["count"]).toBe("42");
  });
});
