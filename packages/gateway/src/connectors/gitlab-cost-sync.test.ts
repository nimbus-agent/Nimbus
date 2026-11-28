// The GitLab compute-minute sync over the REAL capabilities, store and index; only GitLab is faked (an injected
// fetch). Response bodies are DOCUMENTATION-SHAPED (the GraphQL and REST references), not recorded live responses.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import type { NimbusCostGitlabConfig } from "../config/cost-gitlab-toml.ts";
import { readCostLines } from "../finops/cost-line-store.ts";
import { COST_SYNC_CURSOR_PREFIXES, decodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { GITLAB_COST_GAPS } from "./gitlab-cost-fetch.ts";
import { createGitlabCostSyncable } from "./gitlab-cost-sync.ts";
import { fetchSameOriginOnly } from "./same-origin-fetch.ts";

const NOW = Date.UTC(2026, 10, 20, 9); // 2026-11-20, past the restatement window
const DAY = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.gitlab_billing;

let db: Database;
let vault: NimbusVault;
beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  await vault.set("gitlab.pat", "glpat-secret");
});
afterEach(() => db.close());

function ctx(): SyncContext {
  upsertSchedulerRegistration(db, "gitlab_billing", DAY, Date.now(), false);
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "gitlab_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    depth: "full",
  } as SyncContext;
}

type Call = { url: string; body: string | undefined; headers: Record<string, string> };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function fakeGitlab(respond: (url: URL, body: Record<string, unknown> | null) => Reply) {
  const calls: Call[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url: input, body, headers });
    const r = respond(
      new URL(input),
      body === undefined ? null : (JSON.parse(body) as Record<string, unknown>),
    );
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers ?? {},
    });
  }) as unknown as typeof fetchSameOriginOnly;
  return { calls, fetch };
}

/** A GitLab.com GraphQL fake: the group id, then usage per project for the requested month. */
function dotCom(
  totals: Record<string, Record<string, number>>,
  extra?: (q: string) => Reply | undefined,
) {
  return fakeGitlab((url, body) => {
    expect(url.toString()).toBe("https://gitlab.com/api/graphql");
    const q = String(body?.["query"] ?? "");
    const hit = extra?.(q);
    if (hit !== undefined) return hit;
    if (q.includes("group(fullPath"))
      return { status: 200, body: { data: { group: { id: "gid://gitlab/Group/1" } } } };
    const vars = (body?.["variables"] ?? {}) as Record<string, string>;
    const month = String(vars["d"]).slice(0, 7);
    const nodes = Object.entries(totals[month] ?? {}).map(([fullPath, minutes]) => ({
      minutes,
      project: { id: `gid://${fullPath}`, fullPath },
    }));
    return {
      status: 200,
      body: {
        data: {
          ciMinutesProjectMonthlyUsage: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
  });
}

const cfg = (over: Partial<NimbusCostGitlabConfig> = {}): NimbusCostGitlabConfig => ({
  groups: ["acme"],
  ratePerMinute: null,
  currency: "USD",
  runnerRates: [],
  ...over,
});

async function sync(
  gl: { fetch: typeof fetchSameOriginOnly },
  config: NimbusCostGitlabConfig,
  cursor: string | null = null,
  now = NOW,
) {
  return createGitlabCostSyncable({ gitlab: () => config, now: () => now, fetch: gl.fetch }).sync(
    ctx(),
    cursor,
  );
}

const stored = () =>
  readCostLines(db, { fromDay: "2026-01-01", toDay: "2026-12-31" })
    .map(
      (l) =>
        [
          l.subAccountName ?? l.subAccountId,
          l.chargeDay,
          l.consumedQuantity,
          l.billedCost,
          l.priced,
        ] as const,
    )
    .sort();

describe("gitlab_billing sync: what it fetches", () => {
  test("a removed PAT keeps the gaps recorded earlier", async () => {
    const missing = dotCom({}, (q) =>
      q.includes("group(fullPath") ? { status: 200, body: { data: { group: null } } } : undefined,
    );
    const first = await sync(missing, cfg());
    await vault.delete("gitlab.pat");
    const r = await sync(dotCom({}), cfg(), first.cursor ?? null);
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).gaps).toEqual({
      acme: GITLAB_COST_GAPS.notFound("acme"),
    });
  });

  test("no groups, or no PAT, makes no request", async () => {
    const gl = dotCom({});
    await sync(gl, cfg({ groups: [] }));
    await vault.delete("gitlab.pat");
    await sync(gl, cfg());
    expect(gl.calls).toEqual([]);
  });

  test("GitLab.com: the group id, then the month's usage, stored as the observed day's line", async () => {
    const gl = dotCom({ "2026-11": { "acme/web": 100, "acme/api": 40 } });
    const r = await sync(gl, cfg({ ratePerMinute: 0.01 }), null, NOW);
    expect(stored()).toEqual([
      ["acme/api", "2026-11-20", 40, 0.4, true],
      ["acme/web", "2026-11-20", 100, 1, true],
    ]);
    // The token is sent as a bearer token to GitLab's GraphQL endpoint only.
    expect(new Set(gl.calls.map((c) => c.headers["Authorization"]))).toEqual(
      new Set(["Bearer glpat-secret"]),
    );
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).synced).toEqual({ acme: "2026-11-20" });
  });

  test("the next day stores only the difference", async () => {
    const first = await sync(dotCom({ "2026-11": { "acme/web": 100 } }), cfg(), null, NOW);
    await sync(dotCom({ "2026-11": { "acme/web": 130 } }), cfg(), first.cursor ?? null, NOW + DAY);
    expect(stored()).toEqual([
      ["acme/web", "2026-11-20", 100, 0, false],
      ["acme/web", "2026-11-21", 30, 0, false],
    ]);
  });

  test("a rate set later re-prices the stored lines before the fetch, with no extra request", async () => {
    const first = await sync(dotCom({ "2026-11": { "acme/web": 100 } }), cfg(), null, NOW);
    const gl = dotCom({ "2026-11": { "acme/web": 100 } });
    await sync(gl, cfg({ ratePerMinute: 0.02 }), first.cursor ?? null, NOW);
    expect(stored()).toEqual([["acme/web", "2026-11-20", 100, 2, true]]);
    expect(gl.calls).toHaveLength(2); // the group id and one usage page, as on any run
  });

  test("a null group and a GraphQL error are stated gaps; nothing is written", async () => {
    const missing = dotCom({}, (q) =>
      q.includes("group(fullPath") ? { status: 200, body: { data: { group: null } } } : undefined,
    );
    const r1 = await sync(missing, cfg());
    expect(decodeCostSyncCursor(PREFIX, r1.cursor ?? null).gaps).toEqual({
      acme: GITLAB_COST_GAPS.notFound("acme"),
    });
    const refused = dotCom({}, (q) =>
      q.includes("ciMinutes")
        ? { status: 200, body: { errors: [{ message: "access denied" }] } }
        : undefined,
    );
    const r2 = await sync(refused, cfg());
    expect(decodeCostSyncCursor(PREFIX, r2.cursor ?? null).gaps).toEqual({
      acme: GITLAB_COST_GAPS.graphql("acme", "access denied"),
    });
    expect(stored()).toEqual([]);
  });

  test("401/403/404 are gaps, 429 penalises and retries, a 5xx retries; none writes", async () => {
    for (const [status, gap] of [
      [401, GITLAB_COST_GAPS.access("acme")],
      [403, GITLAB_COST_GAPS.access("acme")],
      [404, GITLAB_COST_GAPS.notFound("acme")],
    ] as const) {
      const r = await sync(
        fakeGitlab(() => ({ status })),
        cfg(),
      );
      expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).gaps).toEqual({ acme: gap });
    }
    for (const status of [429, 502]) {
      const r = await sync(
        fakeGitlab(() => ({ status, headers: { "retry-after": "1" } })),
        cfg(),
      );
      const c = decodeCostSyncCursor(PREFIX, r.cursor ?? null);
      expect(c.gaps).toEqual({});
      expect(c.pending["acme"]).toContain("2026-11");
    }
    expect(stored()).toEqual([]);
  });

  test("an unreadable usage node keeps the month as stored (a month gap)", async () => {
    const first = await sync(dotCom({ "2026-11": { "acme/web": 100 } }), cfg(), null, NOW);
    const bad = fakeGitlab((_u, body) =>
      String(body?.["query"]).includes("group(fullPath")
        ? { status: 200, body: { data: { group: { id: "g" } } } }
        : {
            status: 200,
            body: {
              data: {
                ciMinutesProjectMonthlyUsage: {
                  nodes: [{ minutes: "lots", project: { fullPath: "acme/web" } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
    );
    await sync(bad, cfg(), first.cursor ?? null, NOW + DAY);
    expect(stored()).toEqual([["acme/web", "2026-11-20", 100, 0, false]]);
  });

  test("runner_rates on GitLab.com is a stated gap, and nothing is fetched", async () => {
    const gl = dotCom({});
    const r = await sync(gl, cfg({ runnerRates: [["big", 0.1]] }));
    expect(gl.calls).toEqual([]);
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).gaps).toEqual({
      acme: GITLAB_COST_GAPS.runnerRatesOnDotCom,
    });
  });

  test("the PAT never follows a redirect to another origin", async () => {
    const seen: string[] = [];
    const raw = (async (input: string) => {
      seen.push(new URL(input).host);
      return new Response("", {
        status: 302,
        headers: { location: "https://evil.example/api/graphql" },
      });
    }) as unknown as typeof globalThis.fetch;
    const r = await createGitlabCostSyncable({
      gitlab: () => cfg(),
      now: () => NOW,
      fetch: (u, i) => fetchSameOriginOnly(u, i, raw),
    }).sync(ctx(), null);
    expect(seen.every((h) => h === "gitlab.com")).toBe(true);
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).gaps).toEqual({
      acme: GITLAB_COST_GAPS.redirect("acme"),
    });
  });
});

describe("gitlab_billing sync: self-managed", () => {
  beforeEach(async () => {
    await vault.set("gitlab.api_base", "https://git.example.com/api/v4");
  });

  const job = (id: number, finished: string, seconds: number, runner = "big-linux") => ({
    id,
    status: "success",
    duration: seconds,
    created_at: finished,
    finished_at: finished,
    runner: {
      id: runner === "big-linux" ? 7 : 8,
      description: runner,
      runner_type: "instance_type",
    },
  });

  test("projects, then jobs per project, summed per day and runner with the runner's rate", async () => {
    const gl = fakeGitlab((url) => {
      expect(url.host).toBe("git.example.com");
      if (url.pathname === "/api/v4/groups/acme/projects") {
        return { status: 200, body: [{ id: 11, path_with_namespace: "acme/web" }] };
      }
      if (url.pathname === "/api/v4/projects/11/jobs") {
        expect(url.searchParams.getAll("scope[]")).toEqual(["success", "failed", "canceled"]);
        return {
          status: 200,
          body: [
            job(3, "2026-11-19T10:00:00Z", 120),
            job(2, "2026-11-19T09:00:00Z", 60, "small"),
            job(1, "2026-10-01T09:00:00Z", 60),
          ],
        };
      }
      return { status: 404 };
    });
    await sync(gl, cfg({ ratePerMinute: 0.01, runnerRates: [["big-linux", 0.05]] }));
    expect(stored()).toEqual([
      // A first sync also reads the previous month (the restatement rule), so October's job is a line too.
      ["acme/web", "2026-10-01", 1, 0.05, true],
      ["acme/web", "2026-11-19", 1, 0.01, true],
      ["acme/web", "2026-11-19", 2, 0.1, true],
    ]);
    // Paged once per run: the two months share one jobs listing.
    expect(gl.calls.filter((c) => c.url.includes("/jobs"))).toHaveLength(1);
    expect(gl.calls.every((c) => c.headers["PRIVATE-TOKEN"] === "glpat-secret")).toBe(true);
  });

  test("an empty project listing never clears a month that holds lines", async () => {
    const one = fakeGitlab((url) =>
      url.pathname.endsWith("/projects")
        ? { status: 200, body: [{ id: 11, path_with_namespace: "acme/web" }] }
        : { status: 200, body: [job(1, "2026-11-19T10:00:00Z", 120)] },
    );
    const first = await sync(one, cfg());
    const none = fakeGitlab((url) =>
      url.pathname.endsWith("/projects") ? { status: 200, body: [] } : { status: 404 },
    );
    const r = await sync(none, cfg(), first.cursor ?? null, NOW + DAY);
    expect(stored()).toEqual([["acme/web", "2026-11-19", 2, 0, false]]);
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).gaps).toEqual({
      acme: GITLAB_COST_GAPS.noProjects("acme"),
    });
  });

  test("more jobs than the cap is a month gap that keeps the stored month", async () => {
    const full = Array.from({ length: 100 }, (_, i) => job(i, "2026-11-19T10:00:00Z", 60));
    const gl = fakeGitlab((url) =>
      url.pathname.endsWith("/projects")
        ? { status: 200, body: [{ id: 11, path_with_namespace: "acme/web" }] }
        : { status: 200, body: full },
    );
    const r = await createGitlabCostSyncable({
      gitlab: () => cfg(),
      now: () => NOW,
      fetch: gl.fetch,
      maxJobPages: 2,
    }).sync(ctx(), null);
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).pending["acme"]).toContain("2026-11");
    expect(stored()).toEqual([]);
  });
});
