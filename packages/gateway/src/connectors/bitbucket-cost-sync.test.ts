// The Bitbucket Pipelines sync over the REAL capabilities, store and index; only Bitbucket is faked (an injected
// fetch). Response bodies are DOCUMENTATION-SHAPED (Atlassian's OpenAPI spec), not recorded live responses.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import type { NimbusCostBitbucketConfig } from "../config/cost-bitbucket-toml.ts";
import { readCostLines } from "../finops/cost-line-store.ts";
import { COST_SYNC_CURSOR_PREFIXES, decodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { BITBUCKET_COST_GAPS } from "./bitbucket-cost-fetch.ts";
import { createBitbucketCostSyncable } from "./bitbucket-cost-sync.ts";
import { fetchSameOriginOnly } from "./same-origin-fetch.ts";

const NOW = Date.UTC(2026, 10, 20, 9); // 2026-11-20, past the restatement window
const DAY = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.bitbucket_billing;
const ROOT = "https://api.bitbucket.org/2.0";

let db: Database;
let vault: NimbusVault;
beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  await vault.set("bitbucket.email", "me@acme.test");
  await vault.set("bitbucket.api_token", "tok-secret");
});
afterEach(() => db.close());

function ctx(limiter = new ProviderRateLimiter()): SyncContext {
  upsertSchedulerRegistration(db, "bitbucket_billing", DAY, Date.now(), false);
  return {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, "bitbucket_billing"),
    logger: pino({ level: "silent" }),
    rateLimiter: limiter,
    depth: "full",
  } as SyncContext;
}

type Call = { url: string; headers: Record<string, string> };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function fakeBitbucket(respond: (url: URL) => Reply) {
  const calls: Call[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    calls.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = respond(new URL(input));
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers ?? {},
    });
  }) as unknown as typeof fetchSameOriginOnly;
  return { calls, fetch };
}

type Repo = { uuid: string; full_name: string };
const web: Repo = { uuid: "{r-web}", full_name: "acme/web" };
const api: Repo = { uuid: "{r-api}", full_name: "acme/api" };

const pipe = (uuid: string, completed: string, seconds: number, created = completed) => ({
  uuid,
  build_number: 1,
  created_on: created,
  completed_on: completed,
  build_seconds_used: seconds,
});

/** A Bitbucket fake: `repos` per workspace and `pipelines` per repo full name, each served `size` rows a page. */
function bitbucket(
  data: {
    repos?: Record<string, Repo[]>;
    pipelines?: Record<string, unknown[]>;
    missing?: string[];
  },
  size = 100,
) {
  return fakeBitbucket((url) => {
    expect(url.origin).toBe("https://api.bitbucket.org");
    const parts = url.pathname.replace("/2.0/repositories/", "").split("/");
    const all: unknown[] | undefined =
      parts.length === 1
        ? data.repos?.[parts[0] ?? ""]
        : data.pipelines?.[`${parts[0]}/${parts[1]}`];
    if (all === undefined || data.missing?.includes(`${parts[0]}/${parts[1]}`) === true) {
      return { status: 404 };
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    const values = all.slice((page - 1) * size, page * size);
    const next = page * size < all.length ? new URL(url) : null;
    next?.searchParams.set("page", String(page + 1));
    return {
      status: 200,
      body: { values, pagelen: size, ...(next ? { next: next.toString() } : {}) },
    };
  });
}

const cfg = (over: Partial<NimbusCostBitbucketConfig> = {}): NimbusCostBitbucketConfig => ({
  workspaces: ["acme"],
  ratePerMinute: null,
  currency: "USD",
  sizeRates: [],
  ...over,
});

async function sync(
  bb: { fetch: typeof fetchSameOriginOnly },
  config: NimbusCostBitbucketConfig,
  cursor: string | null = null,
  now = NOW,
  extra: { apiRoot?: string; maxPipelinePages?: number } = {},
) {
  return createBitbucketCostSyncable({
    bitbucket: () => config,
    now: () => now,
    fetch: bb.fetch,
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
  decodeCostSyncCursor(PREFIX, r.cursor ?? null).pending["acme"];

const D1 = "2026-11-02T10:00:00.000000+00:00";
const D2 = "2026-11-03T10:00:00.000000+00:00";

describe("bitbucket_billing sync: what it fetches", () => {
  test("no workspaces, or no credential, makes no request", async () => {
    const bb = bitbucket({});
    await sync(bb, cfg({ workspaces: [] }));
    await vault.delete("bitbucket.api_token");
    await sync(bb, cfg());
    expect(bb.calls).toEqual([]);
  });

  test("an unreadable cost config keeps the cursor whole, so a pending month is still fetched later", async () => {
    const refused = await sync(
      fakeBitbucket(() => ({ status: 503 })),
      cfg(),
    );
    expect(pending(refused)).toContain("2026-10");
    const bb = bitbucket({});
    const r = await createBitbucketCostSyncable({
      bitbucket: () => null,
      now: () => NOW,
      fetch: bb.fetch,
    }).sync(ctx(), refused.cursor ?? null);
    expect(bb.calls).toEqual([]);
    expect(r.cursor).toBe(refused.cursor);
  });

  test("one workspace, two repositories: a line per repository and day, unpriced, with Basic auth", async () => {
    const bb = bitbucket({
      repos: { acme: [web, api] },
      pipelines: {
        "acme/web": [pipe("{p1}", D1, 120), pipe("{p2}", D1, 60), pipe("{p3}", D2, 600)],
        "acme/api": [pipe("{p4}", D1, 300)],
      },
    });
    const r = await sync(bb, cfg());
    expect(stored()).toEqual([
      ["acme/api", "2026-11-02", 5, 0, false],
      ["acme/web", "2026-11-02", 3, 0, false],
      ["acme/web", "2026-11-03", 10, 0, false],
    ]);
    const expected = `Basic ${Buffer.from("me@acme.test:tok-secret").toString("base64")}`;
    expect(new Set(bb.calls.map((c) => c.headers["Authorization"]))).toEqual(new Set([expected]));
    expect(decodeCostSyncCursor(PREFIX, r.cursor ?? null).synced).toEqual({ acme: "2026-11-20" });
  });

  test("the old app password pair still works, as a fallback", async () => {
    await vault.delete("bitbucket.email");
    await vault.delete("bitbucket.api_token");
    await vault.set("bitbucket.username", "olduser");
    await vault.set("bitbucket.app_password", "oldpw");
    const bb = bitbucket({
      repos: { acme: [web] },
      pipelines: { "acme/web": [pipe("{p1}", D1, 60)] },
    });
    await sync(bb, cfg());
    expect(stored()).toEqual([["acme/web", "2026-11-02", 1, 0, false]]);
    expect(bb.calls[0]?.headers["Authorization"]).toBe(
      `Basic ${Buffer.from("olduser:oldpw").toString("base64")}`,
    );
  });

  test("a repository missing from a later listing keeps its stored lines", async () => {
    const first = await sync(
      bitbucket({
        repos: { acme: [web, api] },
        pipelines: { "acme/web": [pipe("{p1}", D1, 60)], "acme/api": [pipe("{p4}", D1, 300)] },
      }),
      cfg(),
    );
    await sync(
      bitbucket({ repos: { acme: [web] }, pipelines: { "acme/web": [pipe("{p1}", D1, 120)] } }),
      cfg(),
      first.cursor ?? null,
      NOW + DAY,
    );
    expect(stored()).toEqual([
      ["acme/api", "2026-11-02", 5, 0, false],
      ["acme/web", "2026-11-02", 2, 0, false],
    ]);
  });

  test("an empty listing never clears a month that holds lines", async () => {
    const first = await sync(
      bitbucket({ repos: { acme: [web] }, pipelines: { "acme/web": [pipe("{p1}", D1, 60)] } }),
      cfg(),
    );
    const r = await sync(
      bitbucket({ repos: { acme: [] } }),
      cfg(),
      first.cursor ?? null,
      NOW + DAY,
    );
    expect(stored()).toEqual([["acme/web", "2026-11-02", 1, 0, false]]);
    expect(pending(r)).toContain("2026-11");
  });

  test("a month that reads as empty although it holds lines is kept, not cleared", async () => {
    const first = await sync(
      bitbucket({ repos: { acme: [web] }, pipelines: { "acme/web": [pipe("{p1}", D1, 60)] } }),
      cfg(),
    );
    await sync(
      bitbucket({ repos: { acme: [web] }, pipelines: { "acme/web": [] } }),
      cfg(),
      first.cursor ?? null,
      NOW + DAY,
    );
    expect(stored()).toEqual([["acme/web", "2026-11-02", 1, 0, false]]);
  });

  test("a repository whose pipelines are not found keeps its stored lines and blocks nothing", async () => {
    const first = await sync(
      bitbucket({
        repos: { acme: [web, api] },
        pipelines: { "acme/web": [pipe("{p1}", D1, 60)], "acme/api": [pipe("{p4}", D1, 300)] },
      }),
      cfg(),
    );
    const r = await sync(
      bitbucket({
        repos: { acme: [web, api] },
        pipelines: { "acme/web": [pipe("{p1}", D1, 120)], "acme/api": [] },
        missing: ["acme/api"],
      }),
      cfg(),
      first.cursor ?? null,
      NOW + DAY,
    );
    expect(gaps(r)).toEqual({});
    expect(stored()).toEqual([
      ["acme/api", "2026-11-02", 5, 0, false],
      ["acme/web", "2026-11-02", 2, 0, false],
    ]);
  });

  test("a repository and a pipeline repeated across pages count once", async () => {
    const bb = bitbucket(
      {
        repos: { acme: [web, web] },
        pipelines: {
          "acme/web": [pipe("{p1}", D1, 60), pipe("{p1}", D1, 60), pipe("{p2}", D1, 60)],
        },
      },
      1,
    );
    await sync(bb, cfg());
    expect(stored()).toEqual([["acme/web", "2026-11-02", 2, 0, false]]);
  });

  test("a next link that does not advance is a retry: nothing is written", async () => {
    const stuck = fakeBitbucket((url) => ({
      status: 200,
      body: { values: [web], next: url.toString() },
    }));
    const r = await sync(stuck, cfg());
    expect(stored()).toEqual([]);
    expect(pending(r)).toContain("2026-11");
    expect(gaps(r)).toEqual({});
  });

  test("the repository cap is a month gap for every month: no write", async () => {
    const many = Array.from({ length: 2001 }, (_, i) => ({
      uuid: `{r${String(i)}}`,
      full_name: `acme/r${String(i)}`,
    }));
    const bb = bitbucket({ repos: { acme: many } }, 100);
    const fast = new ProviderRateLimiter({
      bitbucket: { requestsPerMinute: 600_000, burstSize: 50 },
    });
    const r = await createBitbucketCostSyncable({
      bitbucket: () => cfg(),
      now: () => NOW,
      fetch: bb.fetch,
    }).sync(ctx(fast), null);
    expect(stored()).toEqual([]);
    expect(bb.calls).toHaveLength(20);
    expect(pending(r)).toContain("2026-11");
    expect(gaps(r)).toEqual({ acme: BITBUCKET_COST_GAPS.repoCap("acme") });
  });

  test("the pipeline page cap is a month gap: the stored month is kept", async () => {
    const first = await sync(
      bitbucket({ repos: { acme: [web] }, pipelines: { "acme/web": [pipe("{p1}", D1, 60)] } }),
      cfg(),
    );
    const recent = Array.from({ length: 4 }, (_, i) => pipe(`{n${String(i)}}`, D2, 60, D2));
    const capped = bitbucket({ repos: { acme: [web] }, pipelines: { "acme/web": recent } }, 1);
    const r = await sync(capped, cfg(), first.cursor ?? null, NOW + DAY, { maxPipelinePages: 2 });
    expect(stored()).toEqual([["acme/web", "2026-11-02", 1, 0, false]]);
    expect(pending(r)).toContain("2026-11");
  });
});

describe("bitbucket_billing sync: rates", () => {
  test("a rate added later prices the stored lines, with no request for the re-price itself", async () => {
    const data = { repos: { acme: [web] }, pipelines: { "acme/web": [pipe("{p1}", D1, 6000)] } };
    const first = await sync(bitbucket(data), cfg());
    expect(stored()).toEqual([["acme/web", "2026-11-02", 100, 0, false]]);
    const bb = bitbucket(data);
    await sync(bb, cfg({ ratePerMinute: 0.01 }), first.cursor ?? null);
    expect(stored()).toEqual([["acme/web", "2026-11-02", 100, 1, true]]);
    expect(bb.calls).toHaveLength(2); // the repositories and one pipeline page, as on any run
  });

  test("a size the listing carries keeps its key and prices at its size rate", async () => {
    const data = {
      repos: { acme: [web] },
      pipelines: { "acme/web": [{ ...pipe("{p1}", D1, 6000), size: "2x" }] },
    };
    const first = await sync(bitbucket(data), cfg({ ratePerMinute: 0.01 }));
    expect(stored()).toEqual([["acme/web", "2026-11-02", 100, 1, true]]);
    await sync(
      bitbucket(data),
      cfg({ ratePerMinute: 0.01, sizeRates: [["2x", 0.02]] }),
      first.cursor ?? null,
    );
    expect(stored()).toEqual([["acme/web", "2026-11-02", 100, 2, true]]);
  });
});

describe("bitbucket_billing sync: refusals and transport", () => {
  test("401/403/404 are gaps, 429 penalises and retries, a 5xx retries; none writes", async () => {
    for (const [status, gap] of [
      [401, BITBUCKET_COST_GAPS.access("acme")],
      [403, BITBUCKET_COST_GAPS.access("acme")],
      [404, BITBUCKET_COST_GAPS.notFound("acme")],
    ] as const) {
      const r = await sync(
        fakeBitbucket(() => ({ status })),
        cfg(),
      );
      expect(gaps(r)).toEqual({ acme: gap });
    }
    const limiter = new ProviderRateLimiter();
    for (const status of [429, 502]) {
      const r = await createBitbucketCostSyncable({
        bitbucket: () => cfg(),
        now: () => NOW,
        fetch: fakeBitbucket(() => ({ status, headers: { "retry-after": "1" } })).fetch,
      }).sync(ctx(limiter), null);
      expect(gaps(r)).toEqual({});
      expect(pending(r)).toContain("2026-11");
    }
    expect(stored()).toEqual([]);
  });

  test("an API base that is not https is a stated gap; the credential is never sent", async () => {
    const bb = bitbucket({});
    const r = await sync(bb, cfg(), null, NOW, { apiRoot: "http://api.bitbucket.example/2.0" });
    expect(bb.calls).toEqual([]);
    expect(gaps(r)).toEqual({ acme: BITBUCKET_COST_GAPS.insecureBase });
  });

  test("the credential never follows a redirect to another origin", async () => {
    const seen: string[] = [];
    const raw = (async (input: string) => {
      seen.push(new URL(input).host);
      return new Response("", { status: 302, headers: { location: "https://evil.example/x" } });
    }) as unknown as typeof globalThis.fetch;
    const r = await createBitbucketCostSyncable({
      bitbucket: () => cfg(),
      now: () => NOW,
      fetch: (u, i) => fetchSameOriginOnly(u, i, raw),
    }).sync(ctx(), null);
    expect(seen.every((h) => h === "api.bitbucket.org")).toBe(true);
    expect(gaps(r)).toEqual({ acme: BITBUCKET_COST_GAPS.redirect("acme") });
  });

  test("a next link on another origin is a gap, and is never requested", async () => {
    const bb = fakeBitbucket(() => ({
      status: 200,
      body: { values: [web], next: "https://evil.example/2.0/repositories/acme?page=2" },
    }));
    const r = await sync(bb, cfg());
    expect(bb.calls.every((c) => new URL(c.url).host === "api.bitbucket.org")).toBe(true);
    expect(gaps(r)).toEqual({ acme: BITBUCKET_COST_GAPS.redirect("acme") });
    expect(stored()).toEqual([]);
  });

  test("a body that is not the documented shape is a retry, never a write", async () => {
    const r = await sync(
      fakeBitbucket(() => ({ status: 200, body: { values: "none" } })),
      cfg(),
    );
    expect(stored()).toEqual([]);
    expect(pending(r)).toContain("2026-11");
    expect(gaps(r)).toEqual({});
    expect(ROOT).toContain("api.bitbucket.org");
  });
});
