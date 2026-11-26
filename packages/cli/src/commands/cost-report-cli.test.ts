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

describe("runCostReportWith: the remaining list and render paths", () => {
  const args = {
    mode: "render" as const,
    name: "checkout-weekly",
    channel: null,
    format: "text" as const,
  };

  test("list --json exits 1 only for a refused config; a bare list names missing schedule and channels", async () => {
    const ok = sink();
    expect(await runCostReportWith(fake(LIST), { mode: "list", json: true }, ok.sink)).toBe(0);
    expect(JSON.parse(ok.s.out)).toEqual(LIST);
    const refused = sink();
    const bad = { reports: [], configError: "bad" };
    expect(await runCostReportWith(fake(bad), { mode: "list", json: true }, refused.sink)).toBe(1);
    expect(JSON.parse(refused.s.out)).toEqual(bad);
    const bare = sink();
    const BARE = {
      reports: [
        { name: "a", scope: { env: "prod" }, period: "7d", schedule: null, tz: null, channels: [] },
        {
          name: "b",
          scope: { product: "x" },
          period: "month",
          schedule: "0 8 1 * *",
          tz: null,
          channels: [{ kind: "teams", format: "html" }],
        },
      ],
      configError: null,
    };
    expect(await runCostReportWith(fake(BARE), { mode: "list", json: false }, bare.sink)).toBe(0);
    expect(bare.s.out).toContain("a  env=prod  7d  no schedule  no channel\n");
    expect(bare.s.out).toContain(
      "b  product=x  month  schedule 0 8 1 * * (gateway zone)  teams (html)\n",
    );
  });

  test("a falling, new or unattributed currency, many rows, a Teams target and a shortened body", async () => {
    const rows = Array.from({ length: 23 }, (_, i) => ({
      part: `svc-${String(i)}`,
      provider: "gcp",
      env: null,
      amount: 1,
    }));
    const model = {
      ...MODEL,
      byCurrency: {
        EUR: {
          total: 10,
          previous: 30,
          change: -20,
          changePct: null,
          topMovers: [{ service: null, part: "BigQuery", provider: "gcp", change: -20 }],
          breakdown: rows,
          unassigned: 0,
          unassignedPct: null,
        },
      },
      provisionalFrom: "2026-11-21",
      freshness: [{ source: "focus", lastDay: null, provisionalFrom: null }],
    };
    const r = {
      model,
      channels: [
        channel({
          kind: "teams",
          format: "html",
          to: { team: "Finance", channel: "Cost" },
          truncated: { breakdown: 3, topMovers: 1 },
        }),
        channel({ body: null }),
      ],
    };
    const { s, sink: k } = sink();
    expect(await runCostReportWith(fake(r), args, k)).toBe(0);
    expect(s.out).toContain("EUR  10.00 vs 30.00  -20.00 (new)");
    expect(s.out).toContain("  mover: BigQuery (gcp) -20.00\n");
    expect(s.out).toContain("  svc-19 (gcp): 1.00\n");
    expect(s.out).not.toContain("svc-20");
    expect(s.out).toContain("  … and 3 more (--csv lists them all)\n");
    expect(s.out).toContain("Unassigned EUR (in no product or service): 0.00\n");
    expect(s.out).toContain("The days from 2026-11-21 are provisional.\n");
    expect(s.out).toContain("Source focus: data up to none\n");
    expect(s.out).toContain("--- teams to Finance/Cost (html) ---");
    expect(s.out).toContain("(shortened to fit: 3 breakdown rows and 1 movers left out)\n");
  });

  test("a refused config in the model exits 1 before any channel", async () => {
    const { s, sink: k } = sink();
    const r = { ...RENDER, model: { ...MODEL, configError: "rule 2 is bad" } };
    expect(await runCostReportWith(fake(r), args, k)).toBe(1);
    expect(s.err).toContain("The [cost] config is refused, so no rule applies: rule 2 is bad");
    expect(s.out).toBe("");
  });

  test("--channel: an error, no channel or a door refusal exits 1", async () => {
    const one = { ...args, channel: "slack" };
    const errored = sink();
    const withError = { ...RENDER, channels: [channel({ body: null, error: "over the cap" })] };
    expect(await runCostReportWith(fake(withError), one, errored.sink)).toBe(1);
    expect(errored.s.err).toBe("not rendered: over the cap\n");
    const none = sink();
    expect(await runCostReportWith(fake({ ...RENDER, channels: [] }), one, none.sink)).toBe(1);
    expect(none.s.err).toBe("not rendered: no such channel\n");
    const door = sink();
    const withDoor = { ...RENDER, channels: [channel({ doorRefusal: "a broadcast mention" })] };
    expect(await runCostReportWith(fake(withDoor), one, door.sink)).toBe(1);
    expect(door.s.out).toContain("*Checkout*");
    expect(door.s.err).toBe("the send door would refuse it: a broadcast mention\n");
  });

  test("--csv and --json exit 1 for no data, a refused config or a channel that did not render", async () => {
    const csv = { ...args, format: "csv" as const };
    const json = { ...args, format: "json" as const };
    const empty = { ...RENDER, model: { ...MODEL, empty: true, byCurrency: {} } };
    const refused = { ...RENDER, model: { ...MODEL, configError: "bad" } };
    const csvEmpty = sink();
    expect(await runCostReportWith(fake(empty), csv, csvEmpty.sink)).toBe(1);
    expect(csvEmpty.s.out).toBe("currency,part,provider,env,amount\n");
    expect(await runCostReportWith(fake(refused), csv, sink().sink)).toBe(1);
    expect(await runCostReportWith(fake(empty), json, sink().sink)).toBe(1);
    expect(await runCostReportWith(fake(refused), json, sink().sink)).toBe(1);
    const withError = { ...RENDER, channels: [channel({ error: "x", body: null })] };
    expect(await runCostReportWith(fake(withError), json, sink().sink)).toBe(1);
    const withDoor = { ...RENDER, channels: [channel({ doorRefusal: "y" })] };
    expect(await runCostReportWith(fake(withDoor), json, sink().sink)).toBe(1);
  });

  test("a non-Error thrown by the IPC is reported and exits 1", async () => {
    const { s, sink: k } = sink();
    const ipc = {
      async call(): Promise<unknown> {
        throw "socket closed";
      },
    };
    expect(await runCostReportWith(ipc, { mode: "list", json: false }, k)).toBe(1);
    expect(s.err).toBe("nimbus cost report: socket closed\n");
  });
});

describe("runCostReportWith: --channel honours the documented exit codes", () => {
  const one = {
    mode: "render" as const,
    name: "checkout-weekly",
    channel: "slack",
    format: "text" as const,
  };
  test("no cost data and a refused config exit 1 before any body is printed", async () => {
    const empty = sink();
    const noData = {
      ...RENDER,
      model: { ...MODEL, empty: true, byCurrency: {} },
      channels: [RENDER.channels[0]],
    };
    expect(await runCostReportWith(fake(noData), one, empty.sink)).toBe(1);
    expect(empty.s.err).toContain("No cost data imported");
    expect(empty.s.out).toBe("");
    const refused = sink();
    const bad = {
      ...RENDER,
      model: { ...MODEL, configError: "bad [cost]" },
      channels: [RENDER.channels[0]],
    };
    expect(await runCostReportWith(fake(bad), one, refused.sink)).toBe(1);
    expect(refused.s.err).toContain("bad [cost]");
    expect(refused.s.out).toBe("");
  });
});
