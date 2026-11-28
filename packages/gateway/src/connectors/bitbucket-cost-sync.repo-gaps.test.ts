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
import type { fetchSameOriginOnly } from "./same-origin-fetch.ts";

const NOW = Date.UTC(2026, 10, 20, 9); // 2026-11-20, past the restatement window
const DAY = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.bitbucket_billing;

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
    denied?: string[];
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
    if (data.denied?.includes(`${parts[0]}/${parts[1]}`) === true) return { status: 403 };
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

describe("bitbucket_billing sync: one repository incomplete", () => {
  const recent = Array.from({ length: 4 }, (_, i) => pipe(`{n${String(i)}}`, D2, 60, D2));
  const seed = () =>
    sync(
      bitbucket({
        repos: { acme: [web, api] },
        pipelines: { "acme/web": [pipe("{p1}", D1, 60)], "acme/api": [pipe("{p4}", D1, 300)] },
      }),
      cfg(),
    );

  test("a capped repository keeps its stored lines and is named; the normal repository is still written", async () => {
    const first = await seed();
    // Only the web repository exceeds the page cap (1 page): it has a next page.
    const small = fakeBitbucket((url) => {
      if (!url.pathname.includes("/pipelines"))
        return { status: 200, body: { values: [web, api] } };
      return url.pathname.includes("/acme/web/")
        ? {
            status: 200,
            body: { values: recent.slice(0, 2), next: `${url.origin}${url.pathname}?page=2` },
          }
        : { status: 200, body: { values: [pipe("{p4}", D1, 300), pipe("{p5}", D2, 600)] } };
    });
    const r = await sync(small, cfg(), first.cursor ?? null, NOW + DAY, { maxPipelinePages: 1 });
    expect(stored()).toEqual([
      ["acme/api", "2026-11-02", 5, 0, false],
      ["acme/api", "2026-11-03", 10, 0, false],
      ["acme/web", "2026-11-02", 1, 0, false],
    ]);
    expect(gaps(r)["acme"]).toBe(BITBUCKET_COST_GAPS.pipelineCap("acme/web", "2026-11"));
    expect(pending(r)).toBeUndefined();
  });

  test("a repository refused with 403 keeps its stored lines and is named; the normal repository is still written", async () => {
    const first = await seed();
    const r = await sync(
      bitbucket({
        repos: { acme: [web, api] },
        pipelines: { "acme/web": [], "acme/api": [pipe("{p4}", D1, 300), pipe("{p5}", D2, 600)] },
        denied: ["acme/web"],
      }),
      cfg(),
      first.cursor ?? null,
      NOW + DAY,
    );
    expect(stored()).toEqual([
      ["acme/api", "2026-11-02", 5, 0, false],
      ["acme/api", "2026-11-03", 10, 0, false],
      ["acme/web", "2026-11-02", 1, 0, false],
    ]);
    expect(gaps(r)["acme"]).toBe(BITBUCKET_COST_GAPS.repoDenied("acme/web"));
    expect(pending(r)).toBeUndefined();
  });

  test("a pending old month does not block the current month when one repository is capped", async () => {
    const refused = await sync(
      fakeBitbucket(() => ({ status: 503 })),
      cfg(),
    );
    expect(pending(refused)).toContain("2026-10");
    const bb = fakeBitbucket((url) => {
      if (!url.pathname.includes("/pipelines")) {
        return { status: 200, body: { values: [web, api] } };
      }
      return url.pathname.includes("/acme/web/")
        ? {
            status: 200,
            body: { values: recent.slice(0, 2), next: `${url.origin}${url.pathname}?page=2` },
          }
        : { status: 200, body: { values: [pipe("{p5}", D2, 600)] } };
    });
    const r = await sync(bb, cfg(), refused.cursor ?? null, NOW, { maxPipelinePages: 1 });
    expect(stored()).toEqual([["acme/api", "2026-11-03", 10, 0, false]]);
    expect(pending(r)).toBeUndefined();
    expect(gaps(r)["acme"]).toContain("acme/web: more than 5,000 pipelines since");
  });
});
