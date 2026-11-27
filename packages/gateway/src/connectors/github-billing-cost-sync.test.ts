// The GitHub billing sync over the REAL capability, store and index; only GitHub is faked (an injected fetch).
// Response bodies are DOCUMENTATION-SHAPED (the REST reference's schema), not recorded live responses.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { readCostLines } from "../finops/cost-line-store.ts";
import {
  decodeGithubBillingCursor,
  encodeGithubBillingCursor,
} from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  createGithubBillingCostSyncable,
  GITHUB_BILLING_GAPS,
  githubBillingMonths,
} from "./github-billing-cost-sync.ts";

const NOW = Date.UTC(2026, 10, 20, 9); // 2026-11-20, past the restatement window
type Call = { url: string; auth: string | undefined };

type Fixture = {
  db: Database;
  vault: NimbusVault;
  rateLimiter: ProviderRateLimiter;
  createSyncContext(serviceId: "github_billing"): SyncContext;
};
let fx: Fixture;
beforeEach(() => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const rateLimiter = new ProviderRateLimiter();
  const logger = pino({ level: "silent" });
  fx = {
    db,
    vault,
    rateLimiter,
    createSyncContext: (serviceId) =>
      ({
        ...buildSyncCapabilities({ vault, db, depth: "full" }, serviceId),
        logger,
        rateLimiter,
        depth: "full",
      }) as SyncContext,
  };
});
afterEach(() => fx.db.close());

const usage = (org: string, day: string, net: number, repo = `${org}/checkout`) => ({
  date: `${day}T00:00:00Z`,
  product: "actions",
  sku: "actions_linux",
  quantity: 100,
  unitType: "minutes",
  pricePerUnit: 0.008,
  grossAmount: net,
  discountAmount: 0,
  netAmount: net,
  organizationName: org,
  repositoryName: repo,
});

function fakeGithub(
  respond: (url: URL) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: Call[] = [];
  const fetch = (async (input: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: input, auth: init?.headers?.["Authorization"] });
    const r = respond(new URL(input));
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers ?? {},
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

async function run(
  orgs: string[],
  gh: ReturnType<typeof fakeGithub>,
  cursor: string | null = null,
  now = NOW,
) {
  const s = createGithubBillingCostSyncable({
    githubOrgs: () => orgs,
    now: () => now,
    fetch: gh.fetch,
  });
  return s.sync(fx.createSyncContext("github_billing"), cursor);
}

const lines = () =>
  readCostLines(fx.db, { fromDay: "2026-01-01", toDay: "2026-12-31" }).map((l) => [
    l.billingAccountId,
    l.chargeDay,
    l.repo,
    l.billedCost,
  ]);

describe("githubBillingMonths", () => {
  test("the current month; the previous one too until the 5th and on a first sync", () => {
    expect(githubBillingMonths(NOW, false)).toEqual(["2026-11"]);
    expect(githubBillingMonths(NOW, true)).toEqual(["2026-11", "2026-10"]);
    expect(githubBillingMonths(Date.UTC(2026, 11, 5, 23), false)).toEqual(["2026-12", "2026-11"]);
    expect(githubBillingMonths(Date.UTC(2026, 0, 3), false)).toEqual(["2026-01", "2025-12"]);
  });
});

describe("the GitHub billing sync", () => {
  test("no orgs configured: no request at all", async () => {
    await fx.vault.set("github.pat", "tok");
    const gh = fakeGithub(() => ({ status: 200, body: { usageItems: [] } }));
    await run([], gh);
    expect(gh.calls).toEqual([]);
  });

  test("no PAT: no request", async () => {
    const gh = fakeGithub(() => ({ status: 200, body: { usageItems: [] } }));
    await run(["acme"], gh);
    expect(gh.calls).toEqual([]);
  });

  test("a GitHub Enterprise Server base: a gap per org, and nothing is sent anywhere", async () => {
    await fx.vault.set("github.pat", "tok");
    await fx.vault.set("github.api_base", "https://ghe.example.com/api/v3");
    const gh = fakeGithub(() => ({ status: 200, body: { usageItems: [] } }));
    const out = await run(["acme"], gh);
    expect(gh.calls).toEqual([]);
    expect(decodeGithubBillingCursor(out.cursor).gaps).toEqual({
      acme: GITHUB_BILLING_GAPS.enterpriseServer,
    });
  });

  test("a first sync fetches this month and last, writes the lines and records the org as synced", async () => {
    await fx.vault.set("github.pat", "tok");
    const gh = fakeGithub((u) => {
      const month = u.searchParams.get("month");
      const day = month === "11" ? "2026-11-19" : "2026-10-31";
      return { status: 200, body: { usageItems: [usage("acme", day, 2)] } };
    });
    const out = await run(["Acme"], gh);
    expect(gh.calls.map((c) => new URL(c.url).pathname + new URL(c.url).search)).toEqual([
      "/organizations/Acme/settings/billing/usage?year=2026&month=11",
      "/organizations/Acme/settings/billing/usage?year=2026&month=10",
    ]);
    expect(gh.calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    expect(new URL(gh.calls[0]?.url ?? "").origin).toBe("https://api.github.com");
    expect(lines().sort()).toEqual([
      ["acme", "2026-10-31", "acme/checkout", 2],
      ["acme", "2026-11-19", "acme/checkout", 2],
    ]);
    const cur = decodeGithubBillingCursor(out.cursor);
    expect(cur).toEqual({ gaps: {}, synced: { Acme: "2026-11-20" } });

    // The next run fetches only this month, and an identical answer changes nothing.
    const again = fakeGithub(() => ({
      status: 200,
      body: { usageItems: [usage("acme", "2026-11-19", 2)] },
    }));
    await run(["Acme"], again, out.cursor);
    expect(again.calls).toHaveLength(1);
    expect(lines()).toHaveLength(2);
  });

  test("403 or 404 is a gap for that org only, never a throw; a later success clears it", async () => {
    await fx.vault.set("github.pat", "tok");
    const gh = fakeGithub((u) => {
      if (u.pathname.includes("/denied/"))
        return { status: 403, body: { message: "Must be an org admin" } };
      if (u.pathname.includes("/missing/")) return { status: 404, body: { message: "Not Found" } };
      return { status: 200, body: { usageItems: [usage("acme", "2026-11-19", 1)] } };
    });
    const out = await run(["denied", "acme", "missing"], gh);
    const cur = decodeGithubBillingCursor(out.cursor);
    expect(cur.gaps).toEqual({
      denied: GITHUB_BILLING_GAPS.access("denied"),
      missing: GITHUB_BILLING_GAPS.access("missing"),
    });
    expect(Object.keys(cur.synced)).toEqual(["acme"]);
    expect(lines()).toEqual([["acme", "2026-11-19", "acme/checkout", 1]]);

    const ok = fakeGithub(() => ({ status: 200, body: { usageItems: [] } }));
    const next = decodeGithubBillingCursor((await run(["denied"], ok, out.cursor)).cursor);
    expect(next.gaps).toEqual({});
  });

  test("a rate-limited 403 penalises the github limiter and is not a permission gap", async () => {
    await fx.vault.set("github.pat", "tok");
    const gh = fakeGithub(() => ({
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "retry-after": "30" },
    }));
    const penalised: [string, number][] = [];
    const orig = fx.rateLimiter.penalise.bind(fx.rateLimiter);
    fx.rateLimiter.penalise = (p: string, ms: number) => {
      penalised.push([p, ms]);
      orig(p as never, ms);
    };
    const out = await run(["acme"], gh);
    expect(penalised).toEqual([["github", 30_000]]);
    expect(decodeGithubBillingCursor(out.cursor)).toEqual({ gaps: {}, synced: {} });
  });

  test("a 5xx or a body that is not JSON writes nothing, keeps the earlier gap, and retries next run", async () => {
    await fx.vault.set("github.pat", "tok");
    const seed = fakeGithub(() => ({
      status: 200,
      body: { usageItems: [usage("acme", "2026-11-19", 1)] },
    }));
    const first = await run(["acme"], seed);
    const prior = encodeGithubBillingCursor({
      gaps: { acme: "old gap" },
      synced: decodeGithubBillingCursor(first.cursor).synced,
    });
    for (const res of [{ status: 503 }, { status: 200, body: undefined }]) {
      const gh = fakeGithub(() => res);
      const out = await run(["acme"], gh, prior);
      expect(decodeGithubBillingCursor(out.cursor).gaps).toEqual({ acme: "old gap" });
      expect(lines()).toEqual([["acme", "2026-11-19", "acme/checkout", 1]]);
    }
  });

  test("a day GitHub no longer reports is cleared, and another org's rows are never written", async () => {
    await fx.vault.set("github.pat", "tok");
    const first = fakeGithub(() => ({
      status: 200,
      body: { usageItems: [usage("acme", "2026-11-18", 1), usage("acme", "2026-11-19", 1)] },
    }));
    const out = await run(["acme"], first);
    const second = fakeGithub(() => ({
      status: 200,
      body: { usageItems: [usage("acme", "2026-11-19", 4), usage("evil-corp", "2026-11-19", 99)] },
    }));
    await run(["acme"], second, out.cursor);
    expect(lines()).toEqual([["acme", "2026-11-19", "acme/checkout", 4]]);
  });

  test("emptying the org list or losing the PAT clears old gaps; removed orgs leave `synced`", async () => {
    const stale = encodeGithubBillingCursor({
      gaps: { acme: "old gap" },
      synced: { acme: "2026-11-19", gone: "2026-11-19" },
    });
    const none = fakeGithub(() => ({ status: 200, body: { usageItems: [] } }));
    expect(decodeGithubBillingCursor((await run([], none, stale)).cursor)).toEqual({
      gaps: {},
      synced: {},
    });
    // No PAT stored: no request, and no gap is kept for the listed org.
    expect(decodeGithubBillingCursor((await run(["acme"], none, stale)).cursor)).toEqual({
      gaps: {},
      synced: { acme: "2026-11-19" },
    });
    expect(none.calls).toEqual([]);
    // A removed org is dropped from `synced`, so adding it back is a first sync (two months).
    await fx.vault.set("github.pat", "tok");
    const out = await run(["acme"], none, stale);
    expect(decodeGithubBillingCursor(out.cursor).synced).toEqual({ acme: "2026-11-20" });
    const back = fakeGithub(() => ({ status: 200, body: { usageItems: [] } }));
    await run(["acme", "gone"], back, out.cursor);
    expect(back.calls.filter((c) => c.url.includes("/gone/"))).toHaveLength(2);
  });

  test("a 429 waits on the github limiter; a 400 is a stated gap", async () => {
    await fx.vault.set("github.pat", "tok");
    const penalised: string[] = [];
    const orig = fx.rateLimiter.penalise.bind(fx.rateLimiter);
    fx.rateLimiter.penalise = (p: string, ms: number) => {
      penalised.push(p);
      orig(p as never, ms);
    };
    const gh = fakeGithub((u) =>
      u.pathname.includes("/busy/") ? { status: 429 } : { status: 400, body: { message: "Bad" } },
    );
    const cur = decodeGithubBillingCursor((await run(["acme", "busy"], gh)).cursor);
    expect(penalised).toEqual(["github"]);
    expect(cur.gaps).toEqual({ acme: GITHUB_BILLING_GAPS.refused("acme") });
  });
});
