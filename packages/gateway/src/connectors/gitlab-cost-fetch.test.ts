// The GitLab cost requests' every reply branch, called directly with a fake fetch (documentation-shaped bodies).
import { describe, expect, test } from "bun:test";
import pino from "pino";

import type { SyncContext } from "../sync/types.ts";
import {
  GITLAB_COST_GAPS,
  GITLAB_MAX_PROJECT_PAGES,
  GITLAB_MAX_USAGE_PAGES,
  type GitlabConn,
  gitlabGroupId,
  gitlabGroupProjects,
  gitlabMonthUsage,
  gitlabProjectJobs,
  graphqlUrl,
} from "./gitlab-cost-fetch.ts";
import { type fetchSameOriginOnly, RedirectRefusedError } from "./same-origin-fetch.ts";

type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> };

function conn(respond: (url: URL, n: number) => Reply | Error): { c: GitlabConn; calls: string[] } {
  const calls: string[] = [];
  // A no-op limiter: the page-cap tests make dozens of requests, and the real one would pace them.
  const rateLimiter = { acquire: async () => {}, penalise: () => {} };
  const ctx = { rateLimiter, logger: pino({ level: "silent" }) } as unknown as SyncContext;
  const fetchFn = (async (input: string) => {
    calls.push(input);
    const r = respond(new URL(input), calls.length);
    if (r instanceof Error) throw r;
    const text = r.raw ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text, { status: r.status, headers: r.headers ?? {} });
  }) as unknown as typeof fetchSameOriginOnly;
  return { c: { ctx, fetchFn, apiBase: "https://gitlab.com/api/v4", pat: "t" }, calls };
}

const usagePage = (nodes: unknown[], next: string | null, more: boolean) => ({
  status: 200,
  body: {
    data: {
      ciMinutesProjectMonthlyUsage: { nodes, pageInfo: { hasNextPage: more, endCursor: next } },
    },
  },
});

describe("graphqlUrl", () => {
  test("an /api/v4 base maps to /api/graphql; any other base gets /graphql", () => {
    expect(graphqlUrl("https://gitlab.com/api/v4")).toBe("https://gitlab.com/api/graphql");
    expect(graphqlUrl("https://git.example.com/gl")).toBe("https://git.example.com/gl/graphql");
  });
});

describe("gitlabGroupId", () => {
  test("the id, a null group, a malformed group and a malformed body", async () => {
    expect(
      await gitlabGroupId(
        conn(() => ({ status: 200, body: { data: { group: { id: "g1" } } } })).c,
        "acme",
      ),
    ).toEqual({ kind: "id", id: "g1" });
    expect(
      await gitlabGroupId(conn(() => ({ status: 200, body: { data: { group: null } } })).c, "acme"),
    ).toEqual({ kind: "gap", reason: GITLAB_COST_GAPS.notFound("acme") });
    expect(
      await gitlabGroupId(
        conn(() => ({ status: 200, body: { data: { group: { id: 7 } } } })).c,
        "acme",
      ),
    ).toEqual({ kind: "retry" });
    expect(await gitlabGroupId(conn(() => ({ status: 200, raw: "not json" })).c, "acme")).toEqual({
      kind: "retry",
    });
    expect(await gitlabGroupId(conn(() => ({ status: 200, body: [1] })).c, "acme")).toEqual({
      kind: "retry",
    });
    expect(
      await gitlabGroupId(conn(() => ({ status: 200, body: { nothing: 1 } })).c, "acme"),
    ).toEqual({
      kind: "retry",
    });
  });

  test("GraphQL errors with no data are a gap naming the first message, or a generic one", async () => {
    expect(
      await gitlabGroupId(
        conn(() => ({ status: 200, body: { errors: [{ message: "nope" }] } })).c,
        "acme",
      ),
    ).toEqual({ kind: "gap", reason: GITLAB_COST_GAPS.graphql("acme", "nope") });
    expect(
      await gitlabGroupId(conn(() => ({ status: 200, body: { errors: ["x"] } })).c, "acme"),
    ).toEqual({
      kind: "gap",
      reason: GITLAB_COST_GAPS.graphql("acme", "an error"),
    });
  });

  test("statuses: 401/403 access, 404 not found, 429 with and without retry-after, 5xx", async () => {
    const at = async (status: number, headers?: Record<string, string>) =>
      gitlabGroupId(
        conn(() => ({ status, ...(headers === undefined ? {} : { headers }) })).c,
        "acme",
      );
    expect(await at(401)).toEqual({ kind: "gap", reason: GITLAB_COST_GAPS.access("acme") });
    expect(await at(403)).toEqual({ kind: "gap", reason: GITLAB_COST_GAPS.access("acme") });
    expect(await at(404)).toEqual({ kind: "gap", reason: GITLAB_COST_GAPS.notFound("acme") });
    expect(await at(429, { "retry-after": "2" })).toEqual({ kind: "retry" });
    expect(await at(429, { "retry-after": "soon" })).toEqual({ kind: "retry" });
    expect(await at(429)).toEqual({ kind: "retry" });
    expect(await at(503)).toEqual({ kind: "retry" });
  });

  test("a refused redirect is a gap; any other fetch error propagates", async () => {
    expect(await gitlabGroupId(conn(() => new RedirectRefusedError()).c, "acme")).toEqual({
      kind: "gap",
      reason: GITLAB_COST_GAPS.redirect("acme"),
    });
    await expect(gitlabGroupId(conn(() => new Error("socket")).c, "acme")).rejects.toThrow(
      "socket",
    );
  });
});

describe("gitlabMonthUsage", () => {
  test("two pages are joined", async () => {
    const { c } = conn((_u, n) =>
      n === 1 ? usagePage([{ a: 1 }], "c1", true) : usagePage([{ b: 2 }], null, false),
    );
    expect(await gitlabMonthUsage(c, "acme", "g", "2026-11")).toEqual({
      kind: "nodes",
      nodes: [{ a: 1 }, { b: 2 }],
    });
  });

  test("a null connection is an access gap; a malformed one, or more pages with no cursor, retries", async () => {
    const nullConn = conn(() => ({
      status: 200,
      body: { data: { ciMinutesProjectMonthlyUsage: null } },
    }));
    expect(await gitlabMonthUsage(nullConn.c, "acme", "g", "2026-11")).toEqual({
      kind: "gap",
      reason: GITLAB_COST_GAPS.access("acme"),
    });
    const bad = conn(() => ({
      status: 200,
      body: { data: { ciMinutesProjectMonthlyUsage: { nodes: 1 } } },
    }));
    expect(await gitlabMonthUsage(bad.c, "acme", "g", "2026-11")).toEqual({ kind: "retry" });
    const noCursor = conn(() => usagePage([], null, true));
    expect(await gitlabMonthUsage(noCursor.c, "acme", "g", "2026-11")).toEqual({ kind: "retry" });
    const failing = conn(() => ({ status: 403 }));
    expect((await gitlabMonthUsage(failing.c, "acme", "g", "2026-11")).kind).toBe("gap");
  });

  test("the page cap is a retry, never a partial month", async () => {
    const { c, calls } = conn((_u, n) => usagePage([{ n }], `c${String(n)}`, true));
    expect(await gitlabMonthUsage(c, "acme", "g", "2026-11")).toEqual({ kind: "retry" });
    expect(calls).toHaveLength(GITLAB_MAX_USAGE_PAGES);
  });
});

describe("gitlabGroupProjects", () => {
  const proj = (id: number) => ({ id, path_with_namespace: `acme/p${String(id)}` });

  test("a short page ends the listing", async () => {
    const { c, calls } = conn(() => ({ status: 200, body: [proj(1), proj(2)] }));
    expect(await gitlabGroupProjects(c, "acme")).toEqual({
      kind: "projects",
      projects: [
        { id: 1, fullPath: "acme/p1" },
        { id: 2, fullPath: "acme/p2" },
      ],
    });
    expect(new URL(calls[0] ?? "").searchParams.get("include_subgroups")).toBe("true");
  });

  test("a body that is not a list, or a malformed project, retries; an error status passes through", async () => {
    expect(await gitlabGroupProjects(conn(() => ({ status: 200, body: {} })).c, "acme")).toEqual({
      kind: "retry",
    });
    expect(
      await gitlabGroupProjects(conn(() => ({ status: 200, body: [{ id: "1" }] })).c, "acme"),
    ).toEqual({ kind: "retry" });
    expect((await gitlabGroupProjects(conn(() => ({ status: 404 })).c, "acme")).kind).toBe("gap");
  });

  test("more than the cap is a month gap", async () => {
    const full = Array.from({ length: 100 }, (_, i) => proj(i));
    const { c, calls } = conn(() => ({ status: 200, body: full }));
    expect(await gitlabGroupProjects(c, "acme")).toEqual({
      kind: "month_gap",
      reason: GITLAB_COST_GAPS.projectCap("acme"),
    });
    expect(calls).toHaveLength(GITLAB_MAX_PROJECT_PAGES);
  });
});

describe("gitlabProjectJobs", () => {
  const p = { id: 11, fullPath: "acme/web" };
  const job = (created: unknown) => ({ id: 1, created_at: created });

  test("a job repeated on the next offset page is kept once; a job with no id is kept", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 - i,
      created_at: "2026-11-02T00:00:00Z",
    }));
    const page2 = [
      { id: 901, created_at: "2026-11-02T00:00:00Z" },
      { id: 900, created_at: "2026-11-02T00:00:00Z" },
      { created_at: "2026-11-02T00:00:00Z" },
    ];
    const { c } = conn((_u, n) => ({ status: 200, body: n === 1 ? page1 : page2 }));
    const r = await gitlabProjectJobs(c, "acme", p, "2026-10-25", "2026-11");
    expect(r.kind === "jobs" ? r.jobs.length : -1).toBe(102);
  });

  test("stops at a page whose last job was created before the day asked for", async () => {
    const page = Array.from({ length: 100 }, () => job("2026-11-02T00:00:00Z"));
    page[99] = job("2026-10-01T00:00:00Z");
    const { c, calls } = conn(() => ({ status: 200, body: page }));
    const r = await gitlabProjectJobs(c, "acme", p, "2026-10-31", "2026-11");
    expect(r.kind).toBe("jobs");
    expect(calls).toHaveLength(1);
  });

  test("a full page with an unreadable last date keeps paging; a body that is not a list retries", async () => {
    const page = Array.from({ length: 100 }, () => job("never"));
    const { c, calls } = conn((_u, n) => ({ status: 200, body: n === 1 ? page : [] }));
    expect((await gitlabProjectJobs(c, "acme", p, "2026-10-31", "2026-11")).kind).toBe("jobs");
    expect(calls).toHaveLength(2);
    expect(
      await gitlabProjectJobs(
        conn(() => ({ status: 200, body: {} })).c,
        "acme",
        p,
        "2026-10-31",
        "2026-11",
      ),
    ).toEqual({ kind: "retry" });
    expect(
      (await gitlabProjectJobs(conn(() => ({ status: 403 })).c, "acme", p, "2026-10-31", "2026-11"))
        .kind,
    ).toBe("gap");
  });
});
