import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { CostRpcError, dispatchCostRpc } from "./cost-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

// Thursday 2026-11-26: a `week` report covers Monday 2026-11-16 to Sunday 2026-11-22.
const NOW = Date.UTC(2026, 10, 26, 12);
const DAY = 86_400_000;
const HEADER =
  "BilledCost,BillingAccountId,BillingCurrency,ChargePeriodStart,ProviderName,ServiceName,Tags";

function row(cost: number, day: string, service: string, tags: Record<string, string>): string {
  return `${String(cost)},111,USD,${day}T00:00:00Z,AWS,${service},"${JSON.stringify(tags).replaceAll('"', '""')}"`;
}

function csv(): string {
  const rows = [HEADER];
  for (let d = 1; d <= 21; d++) {
    const day = new Date(Date.UTC(2026, 10, 26) - d * DAY).toISOString().slice(0, 10);
    rows.push(
      row(d <= 10 ? 20 : 10, day, "Amazon EC2", {
        product: "checkout",
        service: "payment-service",
      }),
    );
    rows.push(row(1, day, "<!here> @channel", { product: "checkout" }));
  }
  return rows.join("\n");
}

const RULES = [
  "[[cost.rule]]",
  'match = { tag = { product = "*", service = "*" } }',
  'set = { product = "{tag.product}", service = "{tag.service}" }',
  "",
  "[[cost.rule]]",
  'match = { tag = { product = "*" } }',
  'set = { product = "{tag.product}" }',
  "",
].join("\n");

function report(channels: string): string {
  return [
    "[[cost.report]]",
    'name = "checkout-weekly"',
    'scope = { product = "checkout" }',
    'period = "week"',
    'tz = "UTC"',
    "",
    channels,
  ].join("\n");
}

const SLACK = [
  "[[cost.report.channel]]",
  'report = "checkout-weekly"',
  'kind = "slack"',
  'to = "C0123ABC"',
  'format = "markdown"',
  'template = "*Checkout*, week of {week_start}: {total} ({change}).\\n{breakdown}"',
  "",
].join("\n");
const OUTLOOK = [
  "[[cost.report.channel]]",
  'report = "checkout-weekly"',
  'kind = "outlook"',
  'to = "cfo@example.com"',
  'format = "html"',
  'template_file = "weekly.html"',
  'subject = "Checkout cost, week of {week_start}"',
  "",
].join("\n");

let db: Database;
let dir: string;
let realFetch: typeof fetch;
let fetchCalls = 0;

function writeConfig(text: string): void {
  writeFileSync(join(dir, "nimbus.toml"), RULES + text);
}

beforeEach(async () => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dir = mkdtempSync(join(tmpdir(), "nimbus-cost-report-rpc-"));
  mkdirSync(join(dir, "cost-templates"));
  writeFileSync(join(dir, "cost-templates", "weekly.html"), "<p>Checkout: {total}</p>{breakdown}");
  writeFileSync(join(dir, "a.csv"), csv());
  writeConfig(report(SLACK + OUTLOOK));
  await call("cost.import", { path: join(dir, "a.csv") }, "cli");
  realFetch = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("a cost report render must not reach the network");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, params: unknown, kind?: ClientKind): Promise<unknown> {
  const out = await dispatchCostRpc(method, params, {
    db,
    configDir: dir,
    now: () => NOW,
    ...(kind === undefined ? {} : { caller: { kind } }),
  });
  if (out.kind !== "hit") throw new Error("miss");
  return out.value;
}

async function rpcError(p: Promise<unknown>): Promise<CostRpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CostRpcError) return e;
    throw e;
  }
  throw new Error("expected a CostRpcError");
}

type Channel = {
  kind: string;
  format: string;
  to: unknown;
  subject: string | null;
  body: string | null;
  error: string | null;
  doorRefusal: string | null;
};
type Rendered = {
  model: {
    range: { fromDay: string; toDay: string };
    byCurrency: Record<string, { total: number }>;
  };
  channels: Channel[];
};
const egressRows = (): number =>
  (db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;

describe("cost.reportList", () => {
  test("lists each report with its channel kinds, for cli and ui only", async () => {
    expect(await call("cost.reportList", {}, "cli")).toEqual({
      reports: [
        {
          name: "checkout-weekly",
          scope: { product: "checkout" },
          period: "week",
          schedule: null,
          tz: "UTC",
          channels: [
            { kind: "slack", format: "markdown" },
            { kind: "outlook", format: "html" },
          ],
        },
      ],
      configError: null,
    });
    await call("cost.reportList", undefined, "ui");
    for (const kind of ["mcp", "http", undefined] as (ClientKind | undefined)[]) {
      expect((await rpcError(call("cost.reportList", {}, kind))).message).toContain(
        "ERR_COST_FORBIDDEN_CLIENT",
      );
    }
  });
});

describe("cost.reportRender", () => {
  test("renders every channel for the previous full week, with no network and no egress row", async () => {
    const r = (await call("cost.reportRender", { name: "checkout-weekly" }, "cli")) as Rendered;
    expect(r.model.range).toMatchObject({ fromDay: "2026-11-16", toDay: "2026-11-22" });
    // 2026-11-16..22 are days 4..10 before the 26th: 7 × (20 + 1).
    expect(r.model.byCurrency["USD"]?.total).toBe(147);
    const [slack, outlook] = r.channels;
    expect(slack).toMatchObject({
      kind: "slack",
      to: "C0123ABC",
      subject: null,
      error: null,
      doorRefusal: null,
    });
    expect(slack?.body).toStartWith("*Checkout*, week of 2026-11-16: 147.00 USD (+70.00 USD).");
    // The vendor service name `<!here> @channel` is in the breakdown, inert.
    expect(slack?.body).toContain("‹!here› (at)channel");
    expect(outlook).toMatchObject({
      kind: "outlook",
      to: ["cfo@example.com"],
      subject: "Checkout cost, week of 2026-11-16",
      error: null,
      doorRefusal: null,
    });
    expect(outlook?.body).toStartWith("<p>Checkout: 147.00 USD</p><ul><li>");
    expect(egressRows()).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("one channel by kind; an unknown report or channel is -32602", async () => {
    const r = (await call(
      "cost.reportRender",
      { name: "checkout-weekly", channel: "outlook" },
      "ui",
    )) as Rendered;
    expect(r.channels.map((c) => c.kind)).toEqual(["outlook"]);
    const e = await rpcError(call("cost.reportRender", { name: "nope" }, "cli"));
    expect(e.rpcCode).toBe(-32602);
    expect(e.message).toContain("known: checkout-weekly");
    expect(
      (
        await rpcError(
          call("cost.reportRender", { name: "checkout-weekly", channel: "teams" }, "cli"),
        )
      ).rpcCode,
    ).toBe(-32602);
    for (const p of [undefined, {}, { name: 3 }, { name: "checkout-weekly", extra: 1 }]) {
      expect((await rpcError(call("cost.reportRender", p, "cli"))).rpcCode).toBe(-32602);
    }
    expect(
      (await rpcError(call("cost.reportRender", { name: "checkout-weekly" }, "mcp"))).message,
    ).toContain("ERR_COST_FORBIDDEN_CLIENT");
  });

  test("a template that itself mentions a whole channel or loads remote content is a door refusal", async () => {
    writeConfig(
      report(
        `${SLACK.replace("*Checkout*", "<!channel> Checkout")}[[cost.report.channel]]\nreport = "checkout-weekly"\nkind = "teams"\nto = { team = "t1", channel = "c1" }\nformat = "html"\ntemplate = "<img src='https://x.example/a.png'>{total}"\n`,
      ),
    );
    const r = (await call("cost.reportRender", { name: "checkout-weekly" }, "cli")) as Rendered;
    expect(r.channels.map((c) => [c.kind, c.doorRefusal !== null])).toEqual([
      ["slack", true],
      ["teams", true],
    ]);
    expect(r.channels[0]?.doorRefusal).toContain("notifies a whole channel");
    expect(r.channels[1]?.doorRefusal).toContain("loads remote content");
  });

  test("a template error is reported for that channel only", async () => {
    rmSync(join(dir, "cost-templates", "weekly.html"));
    writeConfig(report(SLACK.replace("{breakdown}", "{breakdwn}") + OUTLOOK));
    const r = (await call("cost.reportRender", { name: "checkout-weekly" }, "cli")) as Rendered;
    expect(r.channels[0]?.error).toContain("unknown placeholder {breakdwn}");
    expect(r.channels[0]?.body).toBeNull();
    expect(r.channels[1]?.error).toContain("no template file weekly.html");
  });
});
