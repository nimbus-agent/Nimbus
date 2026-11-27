// The OpenAI and Anthropic cost syncs over the REAL capability, store and index; only the vendor is faked (an
// injected fetch). Response bodies are DOCUMENTATION-SHAPED, not recorded live responses.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import { readCostLines } from "../finops/cost-line-store.ts";
import { decodeCostSyncCursor, encodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { AI_COST_MAX_PAGES, aiCostEndDay } from "./ai-cost-sync.ts";
import { ANTHROPIC_COST_VENDOR, createAnthropicCostSyncable } from "./anthropic-cost-sync.ts";
import { createOpenaiCostSyncable, OPENAI_COST_VENDOR } from "./openai-cost-sync.ts";
import { fetchSameOriginOnly, RedirectRefusedError } from "./same-origin-fetch.ts";

const NOW = Date.UTC(2026, 10, 20, 9); // 2026-11-20
const NOV19 = Date.UTC(2026, 10, 19) / 1000;
type Call = { url: URL; headers: Record<string, string> };

let db: Database;
let vault: NimbusVault;
/** A limiter that records and never sleeps: these tests check the sync, not real rate limits. */
let limiter: ProviderRateLimiter & { penalised: string[] };
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  const penalised: string[] = [];
  limiter = Object.assign(Object.create(ProviderRateLimiter.prototype) as ProviderRateLimiter, {
    acquire: async () => {},
    penalise: (p: string) => {
      penalised.push(p);
    },
    penalised,
  });
});
afterEach(() => db.close());

const ctxFor = (serviceId: "openai_billing" | "anthropic_billing"): SyncContext =>
  ({
    ...buildSyncCapabilities({ vault, db, depth: "full" }, serviceId),
    logger: pino({ level: "silent" }),
    rateLimiter: limiter,
    depth: "full",
  }) as unknown as SyncContext;

function fakeVendor(
  respond: (url: URL) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: Call[] = [];
  const fetch = (async (input: string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(input);
    calls.push({ url, headers: init?.headers ?? {} });
    const r = respond(url);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers ?? {},
    });
  }) as unknown as typeof fetchSameOriginOnly;
  return { calls, fetch };
}

const openaiPage = (value: number, next: string | null = null) => ({
  object: "page",
  data: [
    {
      object: "bucket",
      start_time: NOV19,
      end_time: NOV19 + 86_400,
      results: [
        {
          object: "organization.costs.result",
          amount: { value, currency: "usd" },
          line_item: "gpt-6.2-astra, input",
          project_id: "proj_checkout",
          quantity_unit: "tokens",
        },
      ],
    },
  ],
  has_more: next !== null,
  next_page: next,
});
const anthropicPage = (amount: string) => ({
  data: [
    {
      starting_at: "2026-11-19T00:00:00Z",
      ending_at: "2026-11-20T00:00:00Z",
      results: [
        {
          amount,
          currency: "USD",
          workspace_id: "wrkspc_checkout",
          description: "Claude Opus 5.5 Usage - Input Tokens",
          model: "claude-opus-5-5",
          cost_type: "tokens",
          service_tier: "standard",
        },
      ],
    },
  ],
  has_more: false,
  next_page: null,
});

const lines = (source: string) =>
  readCostLines(db, { fromDay: "2026-01-01", toDay: "2026-12-31" })
    .filter((l) => l.source === source)
    .map((l) => [l.chargeDay, l.subAccountId, l.model, l.billedCost]);

describe("aiCostEndDay", () => {
  test("tomorrow for the current month; the next month's first day for an earlier one", () => {
    expect(aiCostEndDay("2026-11", NOW)).toBe("2026-11-21");
    expect(aiCostEndDay("2026-10", NOW)).toBe("2026-11-01");
    expect(aiCostEndDay("2025-12", NOW)).toBe("2026-01-01");
  });
});

describe("the OpenAI cost sync", () => {
  test("no admin key: no request, and no gap is kept", async () => {
    const v = fakeVendor(() => ({ status: 200, body: openaiPage(1) }));
    const stale = encodeCostSyncCursor(OPENAI_COST_VENDOR.cursorPrefix, {
      gaps: { openai: "old" },
      synced: {},
      pending: {},
    });
    const out = await createOpenaiCostSyncable({ now: () => NOW, fetch: v.fetch }).sync(
      ctxFor("openai_billing"),
      stale,
    );
    expect(v.calls).toEqual([]);
    expect(decodeCostSyncCursor(OPENAI_COST_VENDOR.cursorPrefix, out.cursor).gaps).toEqual({});
  });

  test("a first sync reads both months, every page, with the admin key as a Bearer token, and writes once", async () => {
    await vault.set("openai_billing.admin_key", "sk-admin-test");
    const v = fakeVendor((u) =>
      u.searchParams.get("page") === "p2"
        ? { status: 200, body: openaiPage(0.5) }
        : { status: 200, body: openaiPage(1, "p2") },
    );
    await createOpenaiCostSyncable({ now: () => NOW, fetch: v.fetch }).sync(
      ctxFor("openai_billing"),
      null,
    );
    const first = v.calls[0];
    expect(first?.url.origin).toBe("https://api.openai.com");
    expect(first?.url.pathname).toBe("/v1/organization/costs");
    expect(first?.url.searchParams.getAll("group_by")).toEqual(["project_id", "line_item"]);
    expect(first?.url.searchParams.get("start_time")).toBe(String(Date.UTC(2026, 10, 1) / 1000));
    expect(first?.url.searchParams.get("end_time")).toBe(String(Date.UTC(2026, 10, 21) / 1000));
    expect(first?.headers["Authorization"]).toBe("Bearer sk-admin-test");
    // Two pages for November (summed into one line), and October's first page.
    expect(v.calls.map((c) => c.url.searchParams.get("page"))).toEqual([null, "p2", null, "p2"]);
    expect(lines("openai_billing")).toEqual([
      ["2026-11-19", "proj_checkout", "gpt-6.2-astra", 1.5],
    ]);
  });

  test("401 is an access gap, 404 a missing gap, 400 a refused gap; nothing is written", async () => {
    await vault.set("openai_billing.admin_key", "sk-x");
    for (const [status, gap] of [
      [401, OPENAI_COST_VENDOR.gaps.access],
      [403, OPENAI_COST_VENDOR.gaps.access],
      [404, OPENAI_COST_VENDOR.gaps.missing],
      [400, OPENAI_COST_VENDOR.gaps.refused],
    ] as const) {
      const v = fakeVendor(() => ({ status, body: { error: "no" } }));
      const out = await createOpenaiCostSyncable({ now: () => NOW, fetch: v.fetch }).sync(
        ctxFor("openai_billing"),
        null,
      );
      expect(
        decodeCostSyncCursor(OPENAI_COST_VENDOR.cursorPrefix, out.cursor).gaps,
        String(status),
      ).toEqual({
        openai: gap,
      });
    }
    expect(lines("openai_billing")).toEqual([]);
  });

  test("a 429 penalises the vendor's limiter and retries; no gap", async () => {
    await vault.set("openai_billing.admin_key", "sk-x");
    const v = fakeVendor(() => ({ status: 429, headers: { "retry-after": "1" } }));
    const out = await createOpenaiCostSyncable({ now: () => NOW, fetch: v.fetch }).sync(
      ctxFor("openai_billing"),
      null,
    );
    expect(limiter.penalised).toEqual(["openai_billing"]);
    const cur = decodeCostSyncCursor(OPENAI_COST_VENDOR.cursorPrefix, out.cursor);
    expect(cur.gaps).toEqual({});
    expect(cur.pending).toEqual({ openai: ["2026-11", "2026-10"] });
  });

  test("a stored month is never cleared by a bad answer: 5xx, a non-page body, all-malformed rows, a broken cursor, the page cap", async () => {
    await vault.set("openai_billing.admin_key", "sk-x");
    const sync = (fetch: typeof fetchSameOriginOnly) =>
      createOpenaiCostSyncable({ now: () => NOW, fetch }).sync(ctxFor("openai_billing"), null);
    await sync(fakeVendor(() => ({ status: 200, body: openaiPage(2) })).fetch);
    expect(lines("openai_billing")).toHaveLength(1);
    let n = 0;
    for (const bad of [
      () => ({ status: 503 }),
      () => ({ status: 200, body: { object: "page" } }),
      () => ({
        status: 200,
        body: { data: [{ start_time: NOV19, results: [null, { amount: "x" }] }] },
      }),
      () => ({ status: 200, body: { data: [], has_more: true, next_page: null } }),
      () => ({ status: 200, body: openaiPage(9, `p${String(++n)}`) }),
    ]) {
      await sync(fakeVendor(bad).fetch);
      expect(lines("openai_billing")).toEqual([
        ["2026-11-19", "proj_checkout", "gpt-6.2-astra", 2],
      ]);
    }
    expect(n).toBeGreaterThanOrEqual(AI_COST_MAX_PAGES);
  });

  test("an empty report clears the month (a real zero)", async () => {
    await vault.set("openai_billing.admin_key", "sk-x");
    const sync = (fetch: typeof fetchSameOriginOnly) =>
      createOpenaiCostSyncable({ now: () => NOW, fetch }).sync(ctxFor("openai_billing"), null);
    await sync(fakeVendor(() => ({ status: 200, body: openaiPage(2) })).fetch);
    await sync(
      fakeVendor(() => ({ status: 200, body: { object: "page", data: [], has_more: false } }))
        .fetch,
    );
    expect(lines("openai_billing")).toEqual([]);
  });

  test("a redirect to another origin is refused: the key never reaches it", async () => {
    await vault.set("openai_billing.admin_key", "sk-secret");
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${new URL(url).origin} ${new Headers(init?.headers).get("authorization") ?? ""}`);
      return new Response("", { status: 302, headers: { location: "https://evil.example/steal" } });
    }) as typeof fetch;
    try {
      await expect(
        fetchSameOriginOnly("https://api.openai.com/v1/organization/costs", {
          headers: OPENAI_COST_VENDOR.headers("sk-secret"),
        }),
      ).rejects.toBeInstanceOf(RedirectRefusedError);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual(["https://api.openai.com Bearer sk-secret"]);
  });
});

describe("the Anthropic cost sync", () => {
  test("reads the legacy cost report with x-api-key, groups by workspace and description, cents to dollars", async () => {
    await vault.set("anthropic_billing.admin_key", "sk-ant-admin01-test");
    const v = fakeVendor(() => ({ status: 200, body: anthropicPage("12345.678") }));
    await createAnthropicCostSyncable({ now: () => NOW, fetch: v.fetch }).sync(
      ctxFor("anthropic_billing"),
      null,
    );
    const first = v.calls[0];
    expect(first?.url.origin).toBe("https://api.anthropic.com");
    expect(first?.url.pathname).toBe("/v1/organizations/cost_report");
    expect(first?.url.searchParams.getAll("group_by[]")).toEqual(["workspace_id", "description"]);
    expect(first?.url.searchParams.get("limit")).toBe("31");
    expect(first?.headers["x-api-key"]).toBe("sk-ant-admin01-test");
    expect(first?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(lines("anthropic_billing")).toEqual([
      ["2026-11-19", "wrkspc_checkout", "claude-opus-5-5", 123.45678],
    ]);
  });

  test("a 404 says the report is not available to individual or Team accounts", async () => {
    await vault.set("anthropic_billing.admin_key", "k");
    const v = fakeVendor(() => ({ status: 404 }));
    const out = await createAnthropicCostSyncable({ now: () => NOW, fetch: v.fetch }).sync(
      ctxFor("anthropic_billing"),
      null,
    );
    expect(decodeCostSyncCursor(ANTHROPIC_COST_VENDOR.cursorPrefix, out.cursor).gaps).toEqual({
      anthropic: ANTHROPIC_COST_VENDOR.gaps.missing,
    });
  });

  test("each sync writes only its own source: OpenAI's lines survive an Anthropic sync", async () => {
    await vault.set("openai_billing.admin_key", "sk-x");
    await vault.set("anthropic_billing.admin_key", "k");
    await createOpenaiCostSyncable({
      now: () => NOW,
      fetch: fakeVendor(() => ({ status: 200, body: openaiPage(1) })).fetch,
    }).sync(ctxFor("openai_billing"), null);
    await createAnthropicCostSyncable({
      now: () => NOW,
      fetch: fakeVendor(() => ({ status: 200, body: { data: [], has_more: false } })).fetch,
    }).sync(ctxFor("anthropic_billing"), null);
    expect(lines("openai_billing")).toHaveLength(1);
  });

  test("Anthropic pages follow next_page; both syncables build with their defaults", async () => {
    await vault.set("anthropic_billing.admin_key", "k");
    const v = fakeVendor((u) =>
      u.searchParams.get("page") === "p2"
        ? { status: 200, body: anthropicPage("50") }
        : { status: 200, body: { ...anthropicPage("100"), has_more: true, next_page: "p2" } },
    );
    await createAnthropicCostSyncable({ now: () => NOW, fetch: v.fetch }).sync(
      ctxFor("anthropic_billing"),
      null,
    );
    expect(v.calls.slice(0, 2).map((c) => c.url.searchParams.get("page"))).toEqual([null, "p2"]);
    expect(lines("anthropic_billing")).toEqual([
      ["2026-11-19", "wrkspc_checkout", "claude-opus-5-5", 1.5],
    ]);
    expect(createOpenaiCostSyncable().serviceId).toBe("openai_billing");
    expect(createAnthropicCostSyncable().serviceId).toBe("anthropic_billing");
  });
});
