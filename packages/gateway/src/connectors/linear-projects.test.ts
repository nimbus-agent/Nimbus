import { describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import {
  linearProjectMetadata,
  PROJECTS_QUERY,
  parseProjectsConnection,
  upsertLinearProject,
} from "./linear-projects.ts";
import { TICKET_META_VERSION } from "./ticket-depth.ts";

const BASE = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Payments rewrite",
  description: "short",
  content: "the long specification",
  slugId: "a1b2c3d4e5f6",
  url: "https://linear.app/acme/project/payments-rewrite-a1b2c3d4e5f6",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  startedAt: "2026-01-10T00:00:00.000Z",
  completedAt: "2026-02-01T00:00:00.000Z",
  canceledAt: null,
  archivedAt: null,
  targetDate: "2026-02-15",
  status: { type: "completed", name: "Completed" },
};

describe("linear project mapper", () => {
  test("maps a project to an item row", () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "linear.api_key": "k" }), "linear");
    expect(upsertLinearProject(ctx, BASE, 5)).toBe(BASE.id);
    const row = db.query("SELECT * FROM item WHERE service = 'linear'").get() as Record<
      string,
      unknown
    >;
    expect(row["type"]).toBe("project");
    expect(row["external_id"]).toBe(BASE.id);
    expect(row["id"]).toBe(`linear:${BASE.id}`);
    expect(row["title"]).toBe("Payments rewrite");
    expect(row["body"]).toBe("the long specification");
    expect(row["url"]).toBe(BASE.url);
    expect(row["modified_at"]).toBe(Date.parse(BASE.updatedAt));
  });

  test("the body falls back to description when content is absent", () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "linear.api_key": "k" }), "linear");
    upsertLinearProject(ctx, { ...BASE, content: null }, 5);
    const row = db.query("SELECT body FROM item WHERE service = 'linear'").get() as {
      body: string;
    };
    expect(row.body).toBe("short");
  });

  test("meta_v equals TICKET_META_VERSION and the key set is pinned", () => {
    const meta = linearProjectMetadata(BASE);
    expect(meta["meta_v"]).toBe(TICKET_META_VERSION);
    expect(Object.keys(meta).sort((a, b) => a.localeCompare(b))).toEqual([
      "created_at_ms",
      "due_at_ms",
      "linearId",
      "meta_v",
      "resolved_at_ms",
      "slug_id",
      "started_at_ms",
      "status",
      "status_category",
      "status_category_raw",
    ]);
    expect(meta).not.toHaveProperty("project_id");
    expect(meta).not.toHaveProperty("issue_type");
  });

  test.each([
    ["completed", "done"],
    ["canceled", "canceled"],
    ["planned", "todo"],
    ["paused", "in_progress"],
    ["backlog", "todo"],
    ["started", "in_progress"],
    ["mystery", "unknown"],
  ])("status type %s maps to %s", (type, category) => {
    expect(linearProjectMetadata({ ...BASE, status: { type, name: "x" } })["status_category"]).toBe(
      category,
    );
  });

  test("a missing status is unknown", () => {
    expect(linearProjectMetadata({ ...BASE, status: undefined })["status_category"]).toBe(
      "unknown",
    );
  });

  test("resolved_at_ms is completedAt, else canceledAt, else absent", () => {
    expect(linearProjectMetadata(BASE)["resolved_at_ms"]).toBe(Date.parse(BASE.completedAt));
    const canceled = linearProjectMetadata({
      ...BASE,
      completedAt: null,
      canceledAt: "2026-02-20T00:00:00.000Z",
    });
    expect(canceled["resolved_at_ms"]).toBe(Date.parse("2026-02-20T00:00:00.000Z"));
    const none = linearProjectMetadata({ ...BASE, completedAt: null });
    expect(none).not.toHaveProperty("resolved_at_ms");
  });

  test("the query selects the checked fields and includes archived projects", () => {
    expect(PROJECTS_QUERY).toContain("includeArchived: true");
    for (const f of ["canceledAt", "completedAt", "slugId", "status {", "pageInfo"]) {
      expect(PROJECTS_QUERY).toContain(f);
    }
    expect(PROJECTS_QUERY).not.toMatch(/\bstate\b/);
  });
});

describe("parseProjectsConnection", () => {
  const ok = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
    projects: { nodes, pageInfo: { hasNextPage, endCursor } },
  });

  test("parses a page", () => {
    const page = parseProjectsConnection(ok([BASE], true, "c"));
    expect(page.nodes).toHaveLength(1);
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("c");
  });

  test.each([
    ["no projects", {}],
    ["nodes not an array", { projects: { nodes: 1, pageInfo: {} } }],
    ["hasNextPage not a boolean", ok([], "yes" as unknown as boolean)],
    ["hasNextPage without a cursor", ok([], true, null)],
    ["a node without an id", ok([{ name: "x" }])],
    ["a node without a name", ok([{ id: "i" }])],
  ])("refuses %s", (_label, data) => {
    expect(() => parseProjectsConnection(data)).toThrow();
  });
});
