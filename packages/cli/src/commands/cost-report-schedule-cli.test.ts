import { describe, expect, test } from "bun:test";

import { costRunner } from "./cost.ts";
import {
  parseCostReportScheduleArgs,
  runCostReportScheduleWith,
} from "./cost-report-schedule-cli.ts";

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

const SAVED = {
  kind: "slack",
  workflow: "cost-checkout-weekly-slack",
  status: "new",
  schedule: "0 8 * * 1",
  tz: "Europe/Berlin",
  approve: "nimbus approve add --workflow cost-checkout-weekly-slack --step 2",
};
const SKIPPED = {
  kind: "teams",
  workflow: "cost-checkout-weekly-teams",
  status: "skipped",
  reason: "the send door would refuse it: the destination is a ChatOps channel\u0007",
};

describe("parseCostReportScheduleArgs", () => {
  test("a name, an optional channel and --json", () => {
    expect(parseCostReportScheduleArgs(["checkout-weekly"])).toEqual({
      name: "checkout-weekly",
      channel: null,
      json: false,
    });
    expect(parseCostReportScheduleArgs(["w", "--channel", "outlook", "--json"])).toEqual({
      name: "w",
      channel: "outlook",
      json: true,
    });
    for (const bad of [[], ["--json"], ["w", "--channel", "sms"], ["w", "--channel"], ["w", "x"]]) {
      expect(parseCostReportScheduleArgs(bad), bad.join(" ")).toBeUndefined();
    }
  });

  test("costRunner routes `report schedule <name>`; `report schedule` alone still renders a report named schedule", () => {
    expect(costRunner(["report", "schedule", "w"], sink().sink)).toBeFunction();
    expect(costRunner(["report", "schedule", "w", "--csv"], sink().sink)).toBeUndefined();
    expect(costRunner(["report", "schedule"], sink().sink)).toBeFunction();
  });
});

describe("runCostReportScheduleWith", () => {
  test("prints each saved workflow, its schedule and the approve line; exit 0", async () => {
    const ipc = fake({ report: "checkout-weekly", channels: [SAVED] });
    const { s, sink: out } = sink();
    const code = await runCostReportScheduleWith(
      ipc,
      { name: "checkout-weekly", channel: "slack", json: false },
      out,
    );
    expect(code).toBe(0);
    expect(ipc.calls).toEqual([
      ["cost.reportSchedule", { name: "checkout-weekly", channel: "slack" }],
    ]);
    expect(s.out).toContain("cost-checkout-weekly-slack: saved, runs 0 8 * * 1 (Europe/Berlin)");
    expect(s.out).toContain(
      "To let it post without asking you each time: nimbus approve add --workflow cost-checkout-weekly-slack --step 2",
    );
    expect(s.out).toContain("waits for you (nimbus workflow resume <run id>)");
  });

  test("a replaced workflow says its standing rule must be approved again", async () => {
    const ipc = fake({ report: "r", channels: [{ ...SAVED, status: "replaced" }] });
    const { s, sink: out } = sink();
    await runCostReportScheduleWith(ipc, { name: "r", channel: null, json: false }, out);
    expect(s.out).toContain("no longer applies: approve it again");
  });

  test("a skipped channel goes to stderr with its reason (control characters stripped); exit 1", async () => {
    const ipc = fake({ report: "r", channels: [SAVED, SKIPPED] });
    const { s, sink: out } = sink();
    expect(
      await runCostReportScheduleWith(ipc, { name: "r", channel: null, json: false }, out),
    ).toBe(1);
    expect(s.err).toBe(
      "cost-checkout-weekly-teams: not generated: the send door would refuse it: the destination is a ChatOps channel\n",
    );
    expect(s.out).toContain("cost-checkout-weekly-slack: saved");
  });

  test("--json prints the result; an IPC error is reported with exit 1", async () => {
    const result = { report: "r", channels: [SAVED] };
    const { s, sink: out } = sink();
    expect(
      await runCostReportScheduleWith(fake(result), { name: "r", channel: null, json: true }, out),
    ).toBe(0);
    expect(JSON.parse(s.out)).toEqual(result);
    const e = sink();
    const err = new Error(
      "ERR_COST_DEMO: cost.reportSchedule is not available on the demo gateway",
    );
    expect(
      await runCostReportScheduleWith(fake(err), { name: "r", channel: null, json: false }, e.sink),
    ).toBe(1);
    expect(e.s.err).toContain("nimbus cost report schedule: ERR_COST_DEMO");
  });
});
