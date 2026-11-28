// The Jenkins build-minutes sync over the REAL capabilities, store and index; only Jenkins is faked (an injected
// fetch). Response bodies are DOCUMENTATION-SHAPED (the Jenkins remote API), not recorded live responses. A fake
// returns a field only when the request's `tree` asks for it.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import type { NimbusCostJenkinsConfig } from "../config/cost-jenkins-toml.ts";
import { readCostLines } from "../finops/cost-line-store.ts";
import { COST_SYNC_CURSOR_PREFIXES, decodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { JENKINS_COST_GAPS } from "./jenkins-cost-fetch.ts";
import { createJenkinsCostSyncable } from "./jenkins-cost-sync.ts";
import { type fetchSameOriginOnly, RedirectRefusedError } from "./same-origin-fetch.ts";

const NOW = Date.UTC(2026, 10, 20, 9); // 2026-11-20, past the restatement window
const DAY = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.jenkins_billing;
const BASE = "https://ci.acme.test/";
const HOST = "ci.acme.test";
const T1 = Date.UTC(2026, 10, 2, 9);
const T2 = Date.UTC(2026, 10, 3, 9);

let db: Database;
let vault: NimbusVault;
beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  await vault.set("jenkins.base_url", BASE);
  await vault.set("jenkins.username", "robot");
  await vault.set("jenkins.api_token", "tok-secret");
});
afterEach(() => db.close());

function ctx(): SyncContext {
  upsertSchedulerRegistration(db, "jenkins_billing", DAY, Date.now(), false);
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "jenkins_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter({
      jenkins: { requestsPerMinute: 600_000, burstSize: 100 },
    }),
    depth: "full",
  } as SyncContext;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Call = { url: string; headers: Record<string, string> };

function fake(respond: (url: URL) => Reply | "redirect") {
  const calls: Call[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    calls.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = respond(new URL(input));
    if (r === "redirect") throw new RedirectRefusedError();
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers ?? {},
    });
  }) as unknown as typeof fetchSameOriginOnly;
  return { calls, fetch };
}

const build = (number: number, timestamp: number, minutes: number, builtOn = "linux-1") => ({
  number,
  timestamp,
  duration: minutes * 60_000,
  builtOn,
  result: "SUCCESS",
  building: false,
});

type JobNode = { name: string; url: string; _class?: string; jobs?: JobNode[] };
const FOLDER = "com.cloudbees.hudson.plugins.folder.Folder";
/** A listing node: only its own NAME (a nested job is named by its path), as Jenkins returns it for the connector tree. */
const node = (name: string, jobs?: JobNode[]): JobNode => ({
  name,
  url: `https://elsewhere.test/job/${name}/`,
  ...(jobs === undefined ? {} : { jobs }),
});

/** `jobs`: the listing tree; `builds`: per full name, served 200 at a page of the `{from,to}` range in the tree. */
function jenkins(data: {
  jobs: JobNode[] | "bad";
  builds?: Record<string, unknown[]>;
  missing?: string[];
  denied?: string[];
  /** Folder full name → the children its own `jobs[...]` listing returns. */
  folders?: Record<string, JobNode[]>;
  /** Job full names whose builds answer with this status. */
  failing?: Record<string, number>;
}) {
  return fake((url) => {
    expect(url.origin).toBe("https://ci.acme.test");
    const tree = url.searchParams.get("tree") ?? "";
    if (url.pathname === "/api/json") {
      return { status: 200, body: data.jobs === "bad" ? { nope: 1 } : { jobs: data.jobs } };
    }
    const fullName = url.pathname
      .replace(/^\/job\//, "")
      .replace(/\/api\/json$/, "")
      .split("/job/")
      .join("/");
    const failStatus = data.failing?.[fullName];
    if (failStatus !== undefined && tree.startsWith("builds[")) return { status: failStatus };
    if (data.denied?.includes(fullName) === true) return { status: 403 };
    if (data.missing?.includes(fullName) === true) return { status: 404 };
    if (tree.startsWith("jobs[")) {
      return { status: 200, body: { jobs: data.folders?.[fullName] ?? [] } };
    }
    const range = /\{(\d+),(\d+)\}$/.exec(tree);
    const all = data.builds?.[fullName];
    if (range === null || all === undefined) return { status: 200, body: {} }; // a folder: no `builds`
    return { status: 200, body: { builds: all.slice(Number(range[1]), Number(range[2])) } };
  });
}

const cfg = (over: Partial<NimbusCostJenkinsConfig> = {}): NimbusCostJenkinsConfig => ({
  enabled: true,
  ratePerMinute: null,
  currency: "USD",
  agentRates: [],
  agentCost: [],
  ...over,
});

async function sync(
  j: { fetch: typeof fetchSameOriginOnly },
  config: NimbusCostJenkinsConfig | null,
  cursor: string | null = null,
  now = NOW,
  extra: { maxJobs?: number; maxBuildPages?: number } = {},
) {
  return createJenkinsCostSyncable({
    jenkins: () => config,
    now: () => now,
    fetch: j.fetch,
    ...extra,
  }).sync(ctx(), cursor);
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

const gaps = (r: { cursor?: string | null }) => decodeCostSyncCursor(PREFIX, r.cursor ?? null).gaps;
const pending = (r: { cursor?: string | null }) =>
  decodeCostSyncCursor(PREFIX, r.cursor ?? null).pending[HOST];

describe("jenkins_billing sync: what it fetches", () => {
  test("not enabled, or no credential, makes no request", async () => {
    const j = jenkins({ jobs: [] });
    await sync(j, cfg({ enabled: false }));
    await vault.delete("jenkins.api_token");
    const r = await sync(j, cfg(), "keep-me");
    expect(j.calls).toEqual([]);
    expect(r.cursor).toBe("keep-me");
  });

  test("an unreadable cost config keeps the cursor whole, so a pending month is still fetched later", async () => {
    const refused = await sync(
      fake(() => ({ status: 503 })),
      cfg(),
    );
    expect(pending(refused)).toContain("2026-10");
    const j = jenkins({ jobs: [] });
    const r = await sync(j, null, refused.cursor ?? null);
    expect(j.calls).toEqual([]);
    expect(r.cursor).toBe(refused.cursor);
  });

  test("a plain http base is a stated gap before any request; loopback http is allowed", async () => {
    await vault.set("jenkins.base_url", "http://ci.acme.test");
    const j = jenkins({ jobs: [] });
    const r = await sync(j, cfg());
    expect(j.calls).toEqual([]);
    expect(gaps(r)).toEqual({ [HOST]: JENKINS_COST_GAPS.insecureBase });
    await vault.set("jenkins.base_url", "not a url");
    expect(gaps(await sync(j, cfg()))["jenkins"]).toBe(JENKINS_COST_GAPS.insecureBase);
    await vault.set("jenkins.base_url", "http://127.0.0.1:8080");
    const loop = fake(() => ({ status: 200, body: { jobs: [] } }));
    await sync(loop, cfg());
    expect(loop.calls[0]?.url.startsWith("http://127.0.0.1:8080/api/json")).toBe(true);
  });

  test("folders are walked; builds are priced by agent with the built-in node and Basic auth", async () => {
    const j = jenkins({
      jobs: [node("team", [node("app"), node("lib")])],
      builds: {
        "team/app": [build(2, T2, 10, "big"), build(1, T1, 4, "")],
        "team/lib": [build(1, T1, 6)],
      },
    });
    const r = await sync(j, cfg({ ratePerMinute: 0.01, agentRates: [["big", 0.1]] }));
    expect(stored()).toEqual([
      ["team/app", "2026-11-02", 4, 0.04, true],
      ["team/app", "2026-11-03", 10, 1, true],
      ["team/lib", "2026-11-02", 6, 0.06, true],
    ]);
    const expected = `Basic ${Buffer.from("robot:tok-secret").toString("base64")}`;
    expect(new Set(j.calls.map((c) => c.headers["Authorization"]))).toEqual(new Set([expected]));
    // The listing's own `url` (another origin) is never requested.
    expect(j.calls.every((c) => c.url.startsWith("https://ci.acme.test/"))).toBe(true);
    // A folder is never fetched for builds.
    expect(j.calls.some((c) => c.url.includes("/job/team/api/json"))).toBe(false);
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).synced).toEqual({ [HOST]: "2026-11-20" });
  });

  test("a job missing from a later listing keeps its stored lines", async () => {
    const first = await sync(
      jenkins({
        jobs: [node("a"), node("b")],
        builds: { a: [build(1, T1, 2)], b: [build(1, T1, 5)] },
      }),
      cfg(),
    );
    await sync(
      jenkins({ jobs: [node("a")], builds: { a: [build(1, T1, 3)] } }),
      cfg(),
      first.cursor ?? null,
      NOW + DAY,
    );
    expect(stored()).toEqual([
      ["a", "2026-11-02", 3, 0, false],
      ["b", "2026-11-02", 5, 0, false],
    ]);
  });

  test("an empty listing never clears a month that holds lines", async () => {
    const first = await sync(
      jenkins({ jobs: [node("a")], builds: { a: [build(1, T1, 2)] } }),
      cfg(),
    );
    const r = await sync(jenkins({ jobs: [] }), cfg(), first.cursor ?? null, NOW + DAY);
    expect(stored()).toEqual([["a", "2026-11-02", 2, 0, false]]);
    expect(pending(r)).toContain("2026-11");
  });

  test("a month that reads as empty although it holds lines is kept, not cleared", async () => {
    const first = await sync(
      jenkins({ jobs: [node("a")], builds: { a: [build(1, T1, 2)] } }),
      cfg(),
    );
    await sync(
      jenkins({ jobs: [node("a")], builds: { a: [] } }),
      cfg(),
      first.cursor ?? null,
      NOW + DAY,
    );
    expect(stored()).toEqual([["a", "2026-11-02", 2, 0, false]]);
  });

  test("a job that is gone or refused keeps its stored lines and blocks nothing", async () => {
    const first = await sync(
      jenkins({
        jobs: [node("a"), node("b"), node("c")],
        builds: { a: [build(1, T1, 2)], b: [build(1, T1, 5)], c: [build(1, T1, 7)] },
      }),
      cfg(),
    );
    const r = await sync(
      jenkins({
        jobs: [node("a"), node("b"), node("c")],
        builds: { a: [build(1, T1, 3)], b: [], c: [] },
        missing: ["b"],
        denied: ["c"],
      }),
      cfg(),
      first.cursor ?? null,
      NOW + DAY,
    );
    expect(stored()).toEqual([
      ["a", "2026-11-02", 3, 0, false],
      ["b", "2026-11-02", 5, 0, false],
      ["c", "2026-11-02", 7, 0, false],
    ]);
    expect(gaps(r)[HOST]).toContain(JENKINS_COST_GAPS.jobDenied("c"));
  });

  test("a build repeated across pages counts once, and a running build is skipped", async () => {
    const many = Array.from({ length: 200 }, (_, i) => build(1000 - i, T1, 1));
    const j = jenkins({
      jobs: [node("a")],
      builds: {
        a: [...many, build(1000, T1, 1), { ...build(5, T1, 9), building: true }, build(4, T2, 2)],
      },
    });
    await sync(j, cfg());
    expect(stored()).toEqual([
      ["a", "2026-11-02", 200, 0, false],
      ["a", "2026-11-03", 2, 0, false],
    ]);
  });

  test("builds are paged {0,200}, {200,400} up to the cap; a capped job keeps its lines and names the gap", async () => {
    const first = await sync(
      jenkins({
        jobs: [node("a"), node("b")],
        builds: { a: [build(1, T1, 2)], b: [build(1, T1, 3)] },
      }),
      cfg(),
    );
    // `a` has 1,000 recent builds that never reach the lookback; `b` is read in full.
    const recent = Array.from({ length: 1200 }, (_, i) => build(5000 - i, T2, 1));
    const j = jenkins({
      jobs: [node("a"), node("b")],
      builds: { a: recent, b: [build(1, T1, 4)] },
    });
    const r = await sync(j, cfg(), first.cursor ?? null, NOW + DAY);
    const aPages = j.calls
      .filter((c) => c.url.includes("/job/a/"))
      .map((c) => decodeURIComponent(c.url).match(/\{\d+,\d+\}/)?.[0]);
    expect(aPages).toEqual(["{0,200}", "{200,400}", "{400,600}", "{600,800}", "{800,1000}"]);
    // Nov 2 is before `a`'s oldest read build (Nov 3, within the lookback floor of Nov: not reached): kept as stored.
    expect(stored()).toContainEqual(["a", "2026-11-02", 2, 0, false]);
    expect(stored()).toContainEqual(["b", "2026-11-02", 4, 0, false]);
    expect(gaps(r)[HOST]).toContain("a: more than 1,000 builds");
    // The cap is not permanent: the month stays pending (its other jobs were written).
    expect(pending(r)).toContain("2026-11");
  });

  test("the job cap is a month gap for every month: no write", async () => {
    const j = jenkins({
      jobs: [node("a"), node("b"), node("c")],
      builds: { a: [build(1, T1, 2)] },
    });
    const r = await sync(j, cfg(), null, NOW, { maxJobs: 2 });
    expect(stored()).toEqual([]);
    expect(gaps(r)).toEqual({ [HOST]: JENKINS_COST_GAPS.jobCap(HOST) });
    expect(pending(r)).toContain("2026-11");
  });

  test("a body that is not the documented shape is a retry, never a clear", async () => {
    const r = await sync(jenkins({ jobs: "bad" }), cfg());
    expect(stored()).toEqual([]);
    expect(pending(r)).toContain("2026-11");
    const notJson = fake(() => ({ status: 200, headers: {} }));
    expect(pending(await sync(notJson, cfg()))).toContain("2026-11");
  });

  test("a job whose builds are not the documented shape, or answer 500, is that job's gap: others are still written", async () => {
    const first = await sync(
      jenkins({
        jobs: [node("good"), node("bad")],
        builds: { good: [build(1, T1, 2)], bad: [build(1, T1, 9)] },
      }),
      cfg(),
    );
    const j = jenkins({
      jobs: [node("good"), node("bad")],
      builds: { good: [build(1, T1, 3)] },
      failing: { bad: 500 },
    });
    const r = await sync(j, cfg(), first.cursor ?? null, NOW + DAY);
    expect(stored()).toEqual([
      ["bad", "2026-11-02", 9, 0, false],
      ["good", "2026-11-02", 3, 0, false],
    ]);
    expect(gaps(r)[HOST]).toBe(JENKINS_COST_GAPS.jobFailed("bad"));
    // A 500 is transient: the healthy job is written, the month stays pending until `bad` is read.
    expect(pending(r)).toContain("2026-11");
    const odd = fake((url) =>
      url.pathname === "/api/json"
        ? { status: 200, body: { jobs: [node("a"), node("b")] } }
        : url.pathname.includes("/job/a/")
          ? { status: 200, body: { builds: "nope" } }
          : { status: 200, body: { builds: [build(1, T1, 4)] } },
    );
    const r2 = await sync(odd, cfg());
    expect(gaps(r2)[HOST]).toBe(JENKINS_COST_GAPS.jobFailed("a"));
    expect(stored()).toContainEqual(["b", "2026-11-02", 4, 0, false]);
  });

  test("a 429 on one job's builds stops the whole host: nothing is written", async () => {
    const j = jenkins({
      jobs: [node("a"), node("b")],
      builds: { b: [build(1, T1, 4)] },
      failing: { a: 429 },
    });
    const r = await sync(j, cfg());
    expect(stored()).toEqual([]);
    expect(pending(r)).toContain("2026-11");
  });

  test("jobs nested deeper than the listing tree are found; folders are never fetched for builds or counted", async () => {
    // a/b/c/d is the fourth level: its children are past the tree, so it is expanded with its own request.
    const deep = node("a", [node("b", [node("c", [{ ...node("d"), _class: FOLDER }])])]);
    const j = jenkins({
      jobs: [deep],
      folders: {
        "a/b/c/d": [node("e", [node("f")])],
      },
      builds: { "a/b/c/d/e/f": [build(1, T1, 6)] },
    });
    await sync(j, cfg());
    expect(stored()).toEqual([["a/b/c/d/e/f", "2026-11-02", 6, 0, false]]);
    const buildCalls = j.calls.filter((c) => decodeURIComponent(c.url).includes("builds["));
    expect(buildCalls.every((c) => c.url.includes("/job/a/job/b/job/c/job/d/job/e/job/f/"))).toBe(
      true,
    );
    expect(
      j.calls.some((c) =>
        decodeURIComponent(c.url).includes("/job/d/api/json?tree=jobs[name,url,jobs[name,url]]"),
      ),
    ).toBe(true);
  });

  test("a folder found by its class at any depth is expanded again, and folders do not count against the job cap", async () => {
    const deep = node("a", [node("b", [node("c", [{ ...node("d"), _class: FOLDER }])])]);
    const j = jenkins({
      jobs: [deep],
      folders: {
        "a/b/c/d": [{ ...node("e"), _class: FOLDER }],
        "a/b/c/d/e": [node("f"), node("g")],
      },
      builds: { "a/b/c/d/e/f": [build(1, T1, 1)], "a/b/c/d/e/g": [build(1, T1, 2)] },
    });
    // Two jobs and five folders: the cap of 2 counts the jobs only.
    await sync(j, cfg(), null, NOW, { maxJobs: 2 });
    expect(stored().map((l) => l[0])).toEqual(["a/b/c/d/e/f", "a/b/c/d/e/g"]);
    const capped = await sync(j, cfg(), null, NOW, { maxJobs: 1 });
    expect(gaps(capped)[HOST]).toBe(JENKINS_COST_GAPS.jobCap(HOST));
  });

  test("a folder that is gone or refused on expansion adds no jobs; its stored lines are kept", async () => {
    const deep = node("a", [node("b", [node("c", [{ ...node("d"), _class: FOLDER }])])]);
    const j = jenkins({ jobs: [deep], missing: ["a/b/c/d"] });
    const r = await sync(j, cfg());
    expect(gaps(r)).toEqual({});
    const denied = jenkins({ jobs: [deep], denied: ["a/b/c/d"] });
    expect(gaps(await sync(denied, cfg()))).toEqual({});
  });

  test("401 on the listing is a gap; 404 too; 429 penalises and retries", async () => {
    expect(
      gaps(
        await sync(
          fake(() => ({ status: 401 })),
          cfg(),
        ),
      )[HOST],
    ).toBe(JENKINS_COST_GAPS.access(HOST));
    expect(
      gaps(
        await sync(
          fake(() => ({ status: 404 })),
          cfg(),
        ),
      )[HOST],
    ).toBe(JENKINS_COST_GAPS.notFound(HOST));
    const r = await sync(
      fake(() => ({ status: 429, headers: { "retry-after": "5" } })),
      cfg(),
    );
    expect(gaps(r)).toEqual({});
    expect(pending(r)).toContain("2026-11");
  });

  test("a cross-origin redirect is a stated gap", async () => {
    const r = await sync(
      fake(() => "redirect"),
      cfg(),
    );
    expect(gaps(r)[HOST]).toBe(JENKINS_COST_GAPS.redirect(HOST));
    expect(stored()).toEqual([]);
  });

  test("a rate added later re-prices the stored lines with no new fetch needed", async () => {
    const j = () => jenkins({ jobs: [node("a")], builds: { a: [build(1, T1, 10, "big")] } });
    const first = await sync(j(), cfg());
    expect(stored()).toEqual([["a", "2026-11-02", 10, 0, false]]);
    const second = await sync(
      j(),
      cfg({ agentRates: [["big", 0.5]] }),
      first.cursor ?? null,
      NOW + DAY,
    );
    expect(stored()).toEqual([["a", "2026-11-02", 10, 5, true]]);
    expect(second.cursor).not.toBe(first.cursor);
  });
});
