import { describe, expect, test } from "bun:test";

import { costRunner } from "./cost.ts";
import { parseCostReportArgs, runCostReportWith } from "./cost-report-cli.ts";

function sink() {
  const s = { out: "", err: "" };
  return {
    s,
    sink: {
      out: (x: string) => {
        s.out += x;
      },
      err: (x: string) => {
        s.err += x;
      },
    },
  };
}

const fake = (r: unknown) => {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call(method: string, params?: unknown) {
      calls.push([method, params]);
      if (r instanceof Error) throw r;
      return r;
    },
  };
};

const LIST = {
  reports: [
    {
      name: "checkout-weekly",
      scope: { product: "checkout" },
      period: "week",
      schedule: "0 8 * * 1",
      tz: "Europe/Berlin",
      channels: [
        { kind: "slack", format: "markdown" },
        { kind: "outlook", format: "html" },
      ],
    },
  ],
  configError: null,
};

const MODEL = {
  name: "checkout-weekly",
  scope: { product: "checkout" },
  range: { fromDay: "2026-11-16", toDay: "2026-11-22", label: "week of Monday 2026-11-16" },
  previous: { fromDay: "2026-11-09", toDay: "2026-11-15", label: "the week before" },
  weekStart: "2026-11-16",
  byCurrency: {
    USD: {
      total: 120,
      previous: 60,
      change: 60,
      changePct: 100,
      topMovers: [{ service: "payment-service", part: "Amazon EC2", provider: "aws", change: 40 }],
      breakdown: [
        { part: "payment-service", provider: "aws", env: "prod", amount: 100 },
        { part: "=HYPERLINK(1)\u001b[31m", provider: "aws", env: null, amount: 20 },
      ],
      unassigned: 7,
      unassignedPct: 3.954,
    },
  },
  provisionalFrom: null,
  freshness: [{ source: "focus", lastDay: "2026-11-24", provisionalFrom: "2026-11-23" }],
  empty: false,
  configError: null,
  command: "nimbus cost report checkout-weekly",
};

const channel = (over: Record<string, unknown>) => ({
  kind: "slack",
  format: "markdown",
  to: "C0123ABC",
  subject: null,
  body: "*Checkout*: 120.00 USD\n- payment-service (aws, prod): 100.00 USD",
  truncated: { breakdown: 0, topMovers: 0 },
  error: null,
  doorRefusal: null,
  ...over,
});
const RENDER = {
  model: MODEL,
  channels: [
    channel({}),
    channel({
      kind: "outlook",
      format: "html",
      to: ["cfo@example.com"],
      subject: "Checkout cost, week of 2026-11-16",
      body: "<p>Checkout: 120.00 USD</p>",
    }),
  ],
};

describe("parseCostReportArgs", () => {
  test("list, render, one channel, json and csv", () => {
    expect(parseCostReportArgs([])).toEqual({ mode: "list", json: false });
    expect(parseCostReportArgs(["--json"])).toEqual({ mode: "list", json: true });
    expect(parseCostReportArgs(["checkout-weekly"])).toEqual({
      mode: "render",
      name: "checkout-weekly",
      channel: null,
      format: "text",
    });
    expect(parseCostReportArgs(["checkout-weekly", "--channel", "slack", "--json"])).toEqual({
      mode: "render",
      name: "checkout-weekly",
      channel: "slack",
      format: "json",
    });
    expect(parseCostReportArgs(["checkout-weekly", "--csv"])?.mode).toBe("render");
    for (const argv of [
      ["a", "b"],
      ["a", "--channel"],
      ["a", "--channel", "sms"],
      ["a", "--json", "--csv"],
      ["a", "--channel", "slack", "--csv"],
      ["--csv"],
      ["a", "--nope"],
    ]) {
      expect(parseCostReportArgs(argv)).toBeUndefined();
    }
    expect(costRunner(["report"], sink().sink)).toBeFunction();
    expect(costRunner(["report", "a", "b"], sink().sink)).toBeUndefined();
  });
});

describe("runCostReportWith: list", () => {
  test("one line per report; none configured is not an error", async () => {
    const { s, sink: k } = sink();
    expect(await runCostReportWith(fake(LIST), { mode: "list", json: false }, k)).toBe(0);
    expect(s.out).toContain(
      "checkout-weekly  product=checkout  week  schedule 0 8 * * 1 (Europe/Berlin)  slack (markdown), outlook (html)",
    );
    const empty = sink();
    expect(
      await runCostReportWith(
        fake({ reports: [], configError: null }),
        { mode: "list", json: false },
        empty.sink,
      ),
    ).toBe(0);
    expect(empty.s.out).toContain("No cost reports are configured");
    const refused = sink();
    expect(
      await runCostReportWith(
        fake({ reports: [], configError: "bad" }),
        { mode: "list", json: false },
        refused.sink,
      ),
    ).toBe(1);
    expect(refused.s.err).toContain("bad");
  });
});

describe("runCostReportWith: render", () => {
  const args = {
    mode: "render" as const,
    name: "checkout-weekly",
    channel: null,
    format: "text" as const,
  };

  test("the model, then each channel's body as it would be posted", async () => {
    const ipc = fake(RENDER);
    const { s, sink: k } = sink();
    expect(await runCostReportWith(ipc, args, k)).toBe(0);
    expect(ipc.calls).toEqual([["cost.reportRender", { name: "checkout-weekly" }]]);
    const o = s.out;
    expect(o).toContain(
      "Cost report checkout-weekly: week of Monday 2026-11-16 (2026-11-16 to 2026-11-22)",
    );
    expect(o).toContain("compared with the week before (2026-11-09 to 2026-11-15)");
    expect(o).toContain("USD  120.00 vs 60.00  +60.00 (+100.0%)");
    expect(o).toContain("Unassigned USD (in no product or service): 7.00 (4.0%)");
    expect(o).toContain("--- slack to C0123ABC (markdown) ---");
    expect(o).toContain("*Checkout*: 120.00 USD\n- payment-service (aws, prod): 100.00 USD");
    expect(o).toContain(
      "--- outlook to cfo@example.com (html) ---\nSubject: Checkout cost, week of 2026-11-16",
    );
    expect(o).toContain("Source focus: data up to 2026-11-24 (provisional from 2026-11-23)");
    expect(o).not.toContain("\u001b");
  });

  test("a channel error or door refusal, no data or a refused config exit 1", async () => {
    const bad = sink();
    const withError = {
      ...RENDER,
      channels: [channel({ body: null, error: "unknown placeholder {x}" })],
    };
    expect(await runCostReportWith(fake(withError), args, bad.sink)).toBe(1);
    expect(bad.s.out).toContain("not rendered: unknown placeholder {x}");
    const door = sink();
    const withDoor = {
      ...RENDER,
      channels: [channel({ doorRefusal: "the template notifies a whole channel" })],
    };
    expect(await runCostReportWith(fake(withDoor), args, door.sink)).toBe(1);
    expect(door.s.out).toContain(
      "the send door would refuse it: the template notifies a whole channel",
    );
    const empty = sink();
    expect(
      await runCostReportWith(
        fake({ ...RENDER, model: { ...MODEL, empty: true, byCurrency: {} } }),
        args,
        empty.sink,
      ),
    ).toBe(1);
    expect(empty.s.err).toContain("No cost data imported");
    const err = sink();
    expect(await runCostReportWith(fake(new Error('no report named "x"')), args, err.sink)).toBe(1);
    expect(err.s.err).toContain('no report named "x"');
  });

  test("--channel prints that body raw; --csv the breakdown; --json the result", async () => {
    const one = sink();
    const ipc = fake({ ...RENDER, channels: [RENDER.channels[0]] });
    expect(await runCostReportWith(ipc, { ...args, channel: "slack" }, one.sink)).toBe(0);
    expect(ipc.calls[0]).toEqual([
      "cost.reportRender",
      { name: "checkout-weekly", channel: "slack" },
    ]);
    expect(one.s.out).toBe("*Checkout*: 120.00 USD\n- payment-service (aws, prod): 100.00 USD\n");
    const csv = sink();
    expect(await runCostReportWith(fake(RENDER), { ...args, format: "csv" }, csv.sink)).toBe(0);
    expect(csv.s.out).toBe(
      "currency,part,provider,env,amount\nUSD,payment-service,aws,prod,100.00\nUSD,'=HYPERLINK(1)[31m,aws,,20.00\n",
    );
    const json = sink();
    expect(await runCostReportWith(fake(RENDER), { ...args, format: "json" }, json.sink)).toBe(0);
    expect(JSON.parse(json.s.out)).toEqual(RENDER);
  });
});
