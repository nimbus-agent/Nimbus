import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWorkflowSteps, workflowStepsSha256 } from "../automation/workflow-steps.ts";
import {
  getWorkflowByName,
  listScheduledWorkflows,
  upsertWorkflowByName,
} from "../automation/workflow-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { ChatopsPolicy } from "../policy/types.ts";
import type { ScheduledChannel } from "./cost-report-schedule-rpc.ts";
import { CostRpcError, dispatchCostRpc } from "./cost-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

const NOW = Date.UTC(2026, 10, 26, 12);
const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };

function report(extra: string[], channels: string[][]): string {
  return [
    "[[cost.report]]",
    'name = "checkout-weekly"',
    'scope = { product = "checkout" }',
    'period = "week"',
    ...extra,
    "",
    ...channels.flatMap((c) => ["[[cost.report.channel]]", 'report = "checkout-weekly"', ...c, ""]),
  ].join("\n");
}
const SLACK = [
  'kind = "slack"',
  'to = "C0123ABC"',
  'format = "markdown"',
  'template = "*Checkout*: {total}"',
];
const OUTLOOK = [
  'kind = "outlook"',
  'to = "cfo@example.com"',
  'format = "html"',
  'template_file = "weekly.html"',
  'subject = "Checkout cost, week of {week_start}"',
];

let db: Database;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dir = mkdtempSync(join(tmpdir(), "nimbus-cost-schedule-"));
  mkdirSync(join(dir, "cost-templates"));
  writeFileSync(join(dir, "cost-templates", "weekly.html"), "<p>Checkout: {total}</p>");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(toml: string): void {
  writeFileSync(join(dir, "nimbus.toml"), toml);
}

async function schedule(
  params: Record<string, unknown>,
  over: { kind?: ClientKind; demo?: boolean; chatops?: ChatopsPolicy } = {},
): Promise<{ report: string; channels: ScheduledChannel[] }> {
  const out = await dispatchCostRpc("cost.reportSchedule", params, {
    db,
    configDir: dir,
    now: () => NOW,
    caller: { kind: over.kind ?? "cli" },
    chatops: () => over.chatops ?? NO_CHATOPS,
    ...(over.demo === true ? { demo: true } : {}),
  });
  if (out.kind !== "hit") throw new Error("not routed");
  return out.value as { report: string; channels: ScheduledChannel[] };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CostRpcError) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
}

type Steps = [
  { report: { tz: string; template: string; subject: string | null } },
  { tool: string; input: Record<string, unknown> },
];
const stepsOf = (name: string): Steps =>
  JSON.parse(getWorkflowByName(db, name)?.steps_json ?? "null") as Steps;

describe("cost.reportSchedule", () => {
  test("one workflow per channel, with the embedded template text, the frozen zone and the schedule", async () => {
    writeConfig(report(['tz = "Europe/Berlin"', 'schedule = "0 9 * * 1"'], [SLACK, OUTLOOK]));
    const r = await schedule({ name: "checkout-weekly" });
    expect(r.channels).toEqual([
      {
        kind: "slack",
        workflow: "cost-checkout-weekly-slack",
        status: "new",
        schedule: "0 9 * * 1",
        tz: "Europe/Berlin",
        approve: "nimbus approve add --workflow cost-checkout-weekly-slack --step 2",
      },
      {
        kind: "outlook",
        workflow: "cost-checkout-weekly-outlook",
        status: "new",
        schedule: "0 9 * * 1",
        tz: "Europe/Berlin",
        approve: "nimbus approve add --workflow cost-checkout-weekly-outlook --step 2",
      },
    ]);
    const outlook = stepsOf("cost-checkout-weekly-outlook");
    // The template FILE was read once, at generation: its text is in the workflow.
    expect(outlook[0].report.template).toBe("<p>Checkout: {total}</p>");
    expect(outlook[1].input["contentType"]).toEqual({ const: "html" });
    expect(outlook[1].input["to"]).toEqual({ const: "cfo@example.com" });
    const scheduled = listScheduledWorkflows(db).map((w) => [w.name, w.schedule, w.schedule_tz]);
    expect(scheduled.sort()).toEqual([
      ["cost-checkout-weekly-outlook", "0 9 * * 1", "Europe/Berlin"],
      ["cost-checkout-weekly-slack", "0 9 * * 1", "Europe/Berlin"],
    ]);
  });

  test("no tz: frozen to the gateway zone at generation; no schedule: Mondays at 08:00", async () => {
    writeConfig(report([], [SLACK]));
    const [ch] = (await schedule({ name: "checkout-weekly" })).channels;
    if (ch === undefined || ch.status === "skipped") throw new Error("expected a saved channel");
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(ch.schedule).toBe("0 8 * * 1");
    expect(stepsOf("cost-checkout-weekly-slack")[0].report.tz).toBe(ch.tz);
    expect(typeof ch.tz === "string" && ch.tz.length > 0).toBe(true);
    expect([zone, "UTC"]).toContain(ch.tz);
  });

  test("--channel limits it to one channel", async () => {
    writeConfig(report(['tz = "UTC"'], [SLACK, OUTLOOK]));
    const r = await schedule({ name: "checkout-weekly", channel: "outlook" });
    expect(r.channels.map((c) => c.workflow)).toEqual(["cost-checkout-weekly-outlook"]);
    expect(getWorkflowByName(db, "cost-checkout-weekly-slack")).toBeNull();
  });

  test("a channel the door would refuse is skipped with the reason; the others are saved", async () => {
    const mention = [
      'kind = "slack"',
      'to = "C0123ABC"',
      'format = "text"',
      'template = "<!channel> {total}"',
    ];
    const remote = [
      ...OUTLOOK.slice(0, 3),
      'template = "<img src=\\"https://x.example/a.png\\"> {total}"',
      OUTLOOK[4] ?? "",
    ];
    writeConfig(report(['tz = "UTC"'], [mention, remote]));
    const r = await schedule({ name: "checkout-weekly" });
    expect(r.channels.map((c) => c.status)).toEqual(["skipped", "skipped"]);
    expect(r.channels[0]).toMatchObject({ reason: expect.stringContaining("broadcast mention") });
    expect(r.channels[1]).toMatchObject({ reason: expect.stringContaining("remote content") });
    expect(getWorkflowByName(db, "cost-checkout-weekly-slack")).toBeNull();

    // A ChatOps destination: only that channel is skipped.
    writeConfig(report(['tz = "UTC"'], [SLACK, OUTLOOK]));
    const chatops: ChatopsPolicy = {
      channels: new Map([
        ["C0123ABC", { namespace: "project:pay", unmapped: "refuse" as const, notify: [] }],
      ]),
      ownership: new Map(),
    };
    const r2 = await schedule({ name: "checkout-weekly" }, { chatops });
    expect(r2.channels.map((c) => [c.kind, c.status])).toEqual([
      ["slack", "skipped"],
      ["outlook", "new"],
    ]);
    expect(r2.channels[0]).toMatchObject({ reason: expect.stringContaining("ChatOps") });
  });

  test("regenerating keeps the id; a changed template is 'replaced' (new hash), the same one 'unchanged'", async () => {
    writeConfig(report(['tz = "UTC"'], [SLACK]));
    await schedule({ name: "checkout-weekly" });
    const first = getWorkflowByName(db, "cost-checkout-weekly-slack");
    expect((await schedule({ name: "checkout-weekly" })).channels[0]?.status).toBe("unchanged");
    writeConfig(report(['tz = "UTC"'], [[...SLACK.slice(0, 3), 'template = "Other: {total}"']]));
    expect((await schedule({ name: "checkout-weekly" })).channels[0]?.status).toBe("replaced");
    const second = getWorkflowByName(db, "cost-checkout-weekly-slack");
    expect(second?.id).toBe(first?.id);
    const hash = (j: string | undefined) => workflowStepsSha256(parseWorkflowSteps(j ?? "[]"));
    expect(hash(second?.steps_json)).not.toBe(hash(first?.steps_json));
  });

  test("cli only; a demo gateway refuses; an unknown report names the known ones", async () => {
    writeConfig(report(['tz = "UTC"'], [SLACK]));
    for (const kind of ["ui", "mcp", "unknown", "http"] as const) {
      expect(await refusal(schedule({ name: "checkout-weekly" }, { kind }))).toContain(
        "ERR_COST_FORBIDDEN_CLIENT",
      );
    }
    expect(await refusal(schedule({ name: "checkout-weekly" }, { demo: true }))).toContain(
      "ERR_COST_DEMO",
    );
    expect(await refusal(schedule({ name: "nope" }))).toContain(
      'cost.reportSchedule: no report named "nope" (known: checkout-weekly)',
    );
    expect(await refusal(schedule({ name: "checkout-weekly", extra: 1 }))).toContain(
      'unknown parameter "extra"',
    );
    expect(getWorkflowByName(db, "cost-checkout-weekly-slack")).toBeNull();
  });
});

describe("cost.reportSchedule: channels it cannot generate, and what it replaces", () => {
  test("a missing template file and a template that cannot render are skipped with the reason", async () => {
    const missing = [...OUTLOOK.slice(0, 3), 'template_file = "nope.html"', OUTLOOK[4] ?? ""];
    const typo = [
      'kind = "slack"',
      'to = "C0123ABC"',
      'format = "text"',
      'template = "Cost {totl}"',
    ];
    writeConfig(report(['tz = "UTC"'], [typo, missing]));
    const r = await schedule({ name: "checkout-weekly" });
    expect(r.channels.map((c) => [c.kind, c.status])).toEqual([
      ["slack", "skipped"],
      ["outlook", "skipped"],
    ]);
    expect(r.channels[0]).toMatchObject({ reason: expect.stringContaining("{totl}") });
    expect(r.channels[1]).toMatchObject({ reason: expect.stringContaining("nope.html") });
    expect(getWorkflowByName(db, "cost-checkout-weekly-slack")).toBeNull();
  });

  test("a stored workflow of that name whose steps no longer parse is reported replaced, never unchanged", async () => {
    upsertWorkflowByName(db, "cost-checkout-weekly-slack", null, "not json", NOW);
    writeConfig(report(['tz = "UTC"'], [SLACK]));
    const [ch] = (await schedule({ name: "checkout-weekly" })).channels;
    expect(ch?.status).toBe("replaced");
  });

  test("no params at all is refused naming the missing report name", async () => {
    writeConfig(report(['tz = "UTC"'], [SLACK]));
    const out = dispatchCostRpc("cost.reportSchedule", undefined, {
      db,
      configDir: dir,
      caller: { kind: "cli" },
    });
    expect(await refusal(out)).toContain("cost.reportSchedule: name must be a report name");
  });
});
