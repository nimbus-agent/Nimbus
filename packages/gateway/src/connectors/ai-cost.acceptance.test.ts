// Phase 7 slice 6 acceptance: fake OpenAI and Anthropic APIs (documentation-shaped responses, no network)
// return yesterday's costs for two models, one OpenAI project and one Anthropic workspace. After the real
// syncables run through the real capability and store, `cost.products` shows each vendor's cost under its
// product (a `[[cost.rule]]` on `sub_account`), a second identical sync changes nothing, and a refused key shows
// its gap in the freshness. Dates are relative to the real clock (the intake replaces days up to today, UTC).
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { LocalIndex } from "../index/local-index.ts";
import { dispatchCostRpc } from "../ipc/cost-rpc.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { updateSchedulerState, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { Syncable, SyncContext } from "../sync/types.ts";
import { createMockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createAnthropicCostSyncable } from "./anthropic-cost-sync.ts";
import { createOpenaiCostSyncable } from "./openai-cost-sync.ts";
import type { fetchSameOriginOnly } from "./same-origin-fetch.ts";

const DAY = 86_400_000;
const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);

let db: Database;
let dir: string;
let vault: NimbusVault;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  vault = createMockVault();
  dir = mkdtempSync(join(tmpdir(), "nimbus-ai-cost-"));
  writeFileSync(
    join(dir, "nimbus.toml"),
    [
      "[[cost.rule]]",
      'match = { sub_account = "proj_checkout" }',
      'set = { product = "checkout" }',
      "",
      "[[cost.rule]]",
      'match = { sub_account = "wrkspc_search" }',
      'set = { product = "search" }',
      "",
    ].join("\n"),
  );
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The month a request covers (both vendors' range starts on the month's first day). */
const requestedMonth = (u: URL): string => {
  const openai = u.searchParams.get("start_time");
  if (openai !== null) return new Date(Number(openai) * 1000).toISOString().slice(0, 7);
  return String(u.searchParams.get("starting_at")).slice(0, 7);
};

function vendors(openaiStatus = 200) {
  return (async (input: string) => {
    const u = new URL(input);
    const inMonth = requestedMonth(u) === yesterday.slice(0, 7);
    if (u.hostname === "api.openai.com") {
      if (openaiStatus !== 200)
        return new Response('{"error":{"message":"invalid key"}}', { status: openaiStatus });
      const start = Date.parse(`${yesterday}T00:00:00Z`) / 1000;
      const data = inMonth
        ? [
            {
              object: "bucket",
              start_time: start,
              end_time: start + 86_400,
              results: [
                {
                  amount: { value: 3, currency: "usd" },
                  line_item: "gpt-6.2-astra, input",
                  project_id: "proj_checkout",
                },
                {
                  amount: { value: 1, currency: "usd" },
                  line_item: "gpt-6.2-astra, output",
                  project_id: "proj_checkout",
                },
              ],
            },
          ]
        : [];
      return new Response(
        JSON.stringify({ object: "page", data, has_more: false, next_page: null }),
      );
    }
    const data = inMonth
      ? [
          {
            starting_at: `${yesterday}T00:00:00Z`,
            ending_at: `${yesterday}T23:59:59Z`,
            results: [
              {
                amount: "250",
                currency: "USD",
                workspace_id: "wrkspc_search",
                description: "Claude Opus 5.5 Usage - Input Tokens",
                model: "claude-opus-5-5",
                cost_type: "tokens",
              },
            ],
          },
        ]
      : [];
    return new Response(JSON.stringify({ data, has_more: false, next_page: null }));
  }) as unknown as typeof fetchSameOriginOnly;
}

async function syncOnce(
  service: "openai_billing" | "anthropic_billing",
  syncable: Syncable,
  cursor: string | null,
): Promise<string | null> {
  const ctx = {
    ...buildSyncCapabilities({ vault, db, depth: "full" }, service),
    logger: pino({ level: "silent" }),
    rateLimiter: Object.assign(
      Object.create(ProviderRateLimiter.prototype) as ProviderRateLimiter,
      {
        acquire: async () => {},
        penalise: () => {},
      },
    ),
    depth: "full",
  } as unknown as SyncContext;
  const out = await syncable.sync(ctx, cursor);
  upsertSchedulerRegistration(db, service, DAY, Date.now(), false);
  updateSchedulerState(db, {
    serviceId: service,
    cursor: out.cursor,
    intervalMs: DAY,
    lastSyncAt: Date.now(),
    nextSyncAt: Date.now() + DAY,
    status: "ok",
    errorMsg: null,
    consecutiveFailures: 0,
    paused: false,
  });
  return out.cursor;
}

type Products = {
  byCurrency: Record<string, { rows: { key: string; provider: string; amount: number }[] }>;
  freshness: { source: string; gap?: string }[];
};
const products = async (): Promise<Products> => {
  const out = await dispatchCostRpc(
    "cost.products",
    { period: "7d" },
    {
      db,
      configDir: dir,
      caller: { kind: "cli" },
    },
  );
  if (out.kind !== "hit") throw new Error("not routed");
  return out.value as Products;
};
const byProduct = (p: Products) =>
  (p.byCurrency["USD"]?.rows ?? [])
    .map((r) => [r.key, r.provider, r.amount] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

describe("acceptance: OpenAI and Anthropic costs as cost lines", () => {
  test("each vendor's cost lands under its product; a re-sync changes nothing", async () => {
    await vault.set("openai_billing.admin_key", "sk-admin");
    await vault.set("anthropic_billing.admin_key", "sk-ant-admin01");
    const openai = createOpenaiCostSyncable({ fetch: vendors() });
    const anthropic = createAnthropicCostSyncable({ fetch: vendors() });
    const oc = await syncOnce("openai_billing", openai, null);
    const ac = await syncOnce("anthropic_billing", anthropic, null);
    const first = await products();
    expect(byProduct(first)).toEqual([
      ["checkout", "openai", 4],
      ["search", "anthropic", 2.5],
    ]);
    await syncOnce("openai_billing", openai, oc);
    await syncOnce("anthropic_billing", anthropic, ac);
    expect(byProduct(await products())).toEqual(byProduct(first));
  });

  test("a refused OpenAI key shows its gap in the freshness", async () => {
    await vault.set("openai_billing.admin_key", "sk-not-admin");
    await syncOnce("openai_billing", createOpenaiCostSyncable({ fetch: vendors(401) }), null);
    const p = await products();
    expect(p.freshness.find((f) => f.source === "openai_billing")?.gap).toContain(
      "organization admin key",
    );
  });
});
