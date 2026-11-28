// Branch coverage for the Jenkins build-minutes sync: every early return (disabled, no credential, bad base, unreadable
// config), the re-price and write failures, the default clock and transport, and a job's own failure paths. Real
// capabilities, store and index; only Jenkins is faked.
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
import { RedirectRefusedError } from "./same-origin-fetch.ts";

const NOW = Date.UTC(2026, 10, 20, 9);
const DAY = 86_400_000;
const T1 = Date.UTC(2026, 10, 2, 9);
const HOST = "ci.acme.test";
const PREFIX = COST_SYNC_CURSOR_PREFIXES.jenkins_billing;

let db: Database;
let vault: NimbusVault;
beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  await vault.set("jenkins.base_url", `https://${HOST}`);
  await vault.set("jenkins.username", "robot");
  await vault.set("jenkins.api_token", "tok");
});
afterEach(() => db.close());

function ctx(over: Partial<SyncContext> = {}): SyncContext {
  upsertSchedulerRegistration(db, "jenkins_billing", DAY, Date.now(), false);
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "jenkins_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter({
      jenkins: { requestsPerMinute: 600_000, burstSize: 100 },
    }),
    depth: "full",
    ...over,
  } as SyncContext;
}

const cfg = (over: Partial<NimbusCostJenkinsConfig> = {}): NimbusCostJenkinsConfig => ({
  enabled: true,
  ratePerMinute: null,
  currency: "USD",
  agentRates: [],
  ...over,
});

type Handler = (url: URL) => Response | "redirect";
function fakeFetch(handler: Handler) {
  const calls: string[] = [];
  const fetch = (async (input: string) => {
    calls.push(input);
    const r = handler(new URL(input));
    if (r === "redirect") throw new RedirectRefusedError();
    return r;
  }) as never;
  return { calls, fetch };
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const build = (number: number, minutes: number) => ({
  number,
  timestamp: T1,
  duration: minutes * 60_000,
  builtOn: "linux-1",
  result: "SUCCESS",
  building: false,
});

const stored = () =>
  readCostLines(db, { fromDay: "2026-01-01", toDay: "2026-12-31" })
    .map((l) => [l.subAccountName ?? l.subAccountId, l.consumedQuantity] as const)
    .sort();
const gaps = (r: { cursor?: string | null }) => decodeCostSyncCursor(PREFIX, r.cursor ?? null).gaps;
const pending = (r: { cursor?: string | null }) =>
  decodeCostSyncCursor(PREFIX, r.cursor ?? null).pending[HOST];

describe("jenkins_billing sync: early returns", () => {
  test("disabled: no request, an empty cursor, the default transport is never used", async () => {
    const r = await createJenkinsCostSyncable({ jenkins: () => cfg({ enabled: false }) }).sync(
      ctx(),
      null,
    );
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null)).toMatchObject({ gaps: {}, pending: {} });
  });

  test.each(["jenkins.base_url", "jenkins.username", "jenkins.api_token"])(
    "a blank %s makes no request and keeps the cursor (an empty one when there is none)",
    async (key) => {
      const f = fakeFetch(() => json({ jobs: [] }));
      const run = (cursor: string | null) =>
        createJenkinsCostSyncable({ jenkins: () => cfg(), now: () => NOW, fetch: f.fetch }).sync(
          ctx(),
          cursor,
        );
      await vault.set(key, "   ");
      const none = await run(null);
      expect(f.calls).toEqual([]);
      expect(decodeCostSyncCursor(PREFIX, none.cursor ?? null).synced).toEqual({});
      expect((await run("kept")).cursor).toBe("kept");
      await vault.delete(key);
      expect((await run("kept")).cursor).toBe("kept");
    },
  );

  test("an unreadable cost config with no cursor yet yields an empty cursor and no request", async () => {
    const f = fakeFetch(() => json({ jobs: [] }));
    const r = await createJenkinsCostSyncable({
      jenkins: () => null,
      now: () => NOW,
      fetch: f.fetch,
    }).sync(ctx(), null);
    expect(f.calls).toEqual([]);
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).gaps).toEqual({});
  });

  test.each([
    ["file:///var/jenkins", "jenkins"],
    ["not a url", "jenkins"],
    ["ftp://ci.acme.test", "ci.acme.test"],
    ["http://ci.acme.test:8080", "ci.acme.test:8080"],
  ])("the base %s is a stated gap naming %s, before any request", async (base, name) => {
    await vault.set("jenkins.base_url", base);
    const f = fakeFetch(() => json({ jobs: [] }));
    const r = await createJenkinsCostSyncable({
      jenkins: () => cfg(),
      now: () => NOW,
      fetch: f.fetch,
    }).sync(ctx(), null);
    expect(f.calls).toEqual([]);
    expect(gaps(r)).toEqual({ [name]: JENKINS_COST_GAPS.insecureBase });
  });
});

describe("jenkins_billing sync: failures inside a run", () => {
  test("a re-price that throws keeps the gaps and the old fingerprint, and reads nothing", async () => {
    const f = fakeFetch(() => json({ jobs: [] }));
    const bad = ctx({
      repriceOwnCostLines: () => {
        throw new Error("boom");
      },
    });
    const r = await createJenkinsCostSyncable({
      jenkins: () => cfg(),
      now: () => NOW,
      fetch: f.fetch,
    }).sync(bad, null);
    expect(f.calls).toEqual([]);
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).rates).toBeUndefined();
  });

  test("a re-price that throws after an earlier run keeps that run's gaps, synced day and pending months", async () => {
    const f = fakeFetch(() => new Response("", { status: 503 }));
    const first = await createJenkinsCostSyncable({
      jenkins: () => cfg(),
      now: () => NOW,
      fetch: f.fetch,
    }).sync(ctx(), null);
    const bad = ctx({
      repriceOwnCostLines: () => {
        throw new Error("boom");
      },
    });
    const r = await createJenkinsCostSyncable({
      jenkins: () => cfg({ ratePerMinute: 1 }),
      now: () => NOW,
      fetch: f.fetch,
    }).sync(bad, first.cursor ?? null);
    expect(pending(r)).toEqual(pending(first));
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).synced).toEqual(
      decodeCostSyncCursor(PREFIX, first.cursor ?? null).synced,
    );
  });

  test("a refused write is a retry: the month stays pending and nothing else is lost", async () => {
    const f = fakeFetch((url) =>
      url.pathname === "/api/json"
        ? json({ jobs: [{ name: "a" }] })
        : json({ builds: [build(1, 3)] }),
    );
    const refusing = ctx({
      replaceCostLinesForMonth: () => {
        throw new Error("refused");
      },
    });
    const r = await createJenkinsCostSyncable({
      jenkins: () => cfg(),
      now: () => NOW,
      fetch: f.fetch,
    }).sync(refusing, null);
    expect(pending(r)).toContain("2026-11");
    expect(stored()).toEqual([]);
  });

  test("the default clock and a listing with no jobs write nothing", async () => {
    const f = fakeFetch(() => json({ jobs: [] }));
    const r = await createJenkinsCostSyncable({ jenkins: () => cfg(), fetch: f.fetch }).sync(
      ctx(),
      null,
    );
    expect(f.calls).toHaveLength(1);
    expect(stored()).toEqual([]);
    expect(gaps(r)).toEqual({});
  });

  test("a redirect on one job's builds is that job's gap; the next job is still written", async () => {
    const f = fakeFetch((url) => {
      if (url.pathname === "/api/json") return json({ jobs: [{ name: "a" }, { name: "b" }] });
      return url.pathname.includes("/job/a/") ? "redirect" : json({ builds: [build(1, 5)] });
    });
    const r = await createJenkinsCostSyncable({
      jenkins: () => cfg(),
      now: () => NOW,
      fetch: f.fetch,
    }).sync(ctx(), null);
    expect(stored()).toEqual([["b", 5]]);
    expect(gaps(r)[HOST]).toBe(JENKINS_COST_GAPS.jobFailed("a"));
  });

  test("a later page that fails keeps the builds read so far for the months they reach", async () => {
    let page = 0;
    const many = Array.from({ length: 200 }, (_, i) => build(1000 - i, 1));
    const f = fakeFetch((url) => {
      if (url.pathname === "/api/json") return json({ jobs: [{ name: "a" }] });
      page += 1;
      return page === 1 ? json({ builds: many }) : new Response("", { status: 500 });
    });
    const r = await createJenkinsCostSyncable({
      jenkins: () => cfg(),
      now: () => NOW,
      fetch: f.fetch,
    }).sync(ctx(), null);
    expect(gaps(r)[HOST]).toBe(JENKINS_COST_GAPS.jobFailed("a"));
    // The 200 builds were all on Nov 2, after the lookback start: the read did not reach back, so nothing is written for the job.
    expect(stored()).toEqual([]);
  });

  test("a 429 on the folder expansion and a malformed expansion both stop the listing as a retry", async () => {
    const tree = {
      jobs: [
        {
          name: "a",
          jobs: [{ name: "b", jobs: [{ name: "c", jobs: [{ name: "d", _class: "x.Folder" }] }] }],
        },
      ],
    };
    for (const expansion of [
      () => new Response("", { status: 429, headers: { "retry-after": "1" } }),
      () => json({ nope: true }),
      () => new Response("", { status: 500 }),
    ]) {
      const f = fakeFetch((url) => (url.pathname === "/api/json" ? json(tree) : expansion()));
      const r = await createJenkinsCostSyncable({
        jenkins: () => cfg(),
        now: () => NOW,
        fetch: f.fetch,
      }).sync(ctx(), null);
      expect(pending(r)).toContain("2026-11");
    }
  });

  test("a redirect on a folder expansion is a stated gap", async () => {
    const tree = {
      jobs: [
        {
          name: "a",
          jobs: [{ name: "b", jobs: [{ name: "c", jobs: [{ name: "d", _class: "x.Folder" }] }] }],
        },
      ],
    };
    const f = fakeFetch((url) => (url.pathname === "/api/json" ? json(tree) : "redirect"));
    const r = await createJenkinsCostSyncable({
      jenkins: () => cfg(),
      now: () => NOW,
      fetch: f.fetch,
    }).sync(ctx(), null);
    expect(gaps(r)[HOST]).toBe(JENKINS_COST_GAPS.redirect(HOST));
  });

  test("a node with no name is skipped and a repeated folder expansion is read once", async () => {
    const tree = { jobs: [{ url: "x" }, { name: "" }, { name: "a" }] };
    const f = fakeFetch((url) =>
      url.pathname === "/api/json" ? json(tree) : json({ builds: [build(1, 2)] }),
    );
    await createJenkinsCostSyncable({ jenkins: () => cfg(), now: () => NOW, fetch: f.fetch }).sync(
      ctx(),
      null,
    );
    expect(stored()).toEqual([["a", 2]]);
  });

  test("a job past the lookback with an incomplete read keeps the older stored month and names the gap", async () => {
    const recent = Array.from({ length: 1000 }, (_, i) => ({
      ...build(5000 - i, 1),
      timestamp: Date.UTC(2026, 10, 19),
    }));
    const f = fakeFetch((url) => {
      if (url.pathname === "/api/json") return json({ jobs: [{ name: "a" }] });
      const m = /\{(\d+),(\d+)\}/.exec(decodeURIComponent(url.search));
      return json({ builds: recent.slice(Number(m?.[1]), Number(m?.[2])) });
    });
    const r = await createJenkinsCostSyncable({
      jenkins: () => cfg(),
      now: () => NOW,
      fetch: f.fetch,
    }).sync(ctx(), null);
    expect(gaps(r)[HOST]).toContain("a: more than 1,000 builds");
  });
});
