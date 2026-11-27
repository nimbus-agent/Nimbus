// I55 — the `report` value source (Phase 7 slice 4). A standing rule may approve a scheduled cost report post:
// the body is rendered by the gateway from the template EMBEDDED in the workflow (bound by the workflow hash)
// and the local cost index; a `report` value fills only the body (and a draft's subject) of the report kind's
// own row; every destination and routing field is a constant; the door still runs on the final text.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkStandingApprovals } from "../../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import { runWorkflowExecution } from "../automation/workflow-runner.ts";
import {
  parseWorkflowSteps,
  type WriteWorkflowStep,
  workflowStepsSha256,
} from "../automation/workflow-steps.ts";
import { upsertWorkflowByName } from "../automation/workflow-store.ts";
import { buildWriteActions } from "../automation/workflow-write-step.ts";
import { costReportToolFor } from "../connectors/connector-writes/cost-report-rows.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { openDeps } from "../connectors/connector-writes/standing-scenarios.test-helpers.ts";
import { buildUnattendedWorkflowWriteExecutor } from "../engine/run-ask.ts";
import { standingRuleStep } from "../engine/standing-rule-step.ts";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { importFocusPath } from "../finops/cost-import.ts";
import { LocalIndex } from "../index/local-index.ts";
import { deriveRule } from "../standing/standing-rule-derive.ts";
import { insertRule } from "../standing/standing-rule-store.ts";
import { renderRuleText } from "../standing/standing-rule-text.ts";

const NOW = Date.UTC(2026, 10, 26, 12);
const NAME = "cost-checkout-weekly-slack";
const HEADER =
  "BilledCost,BillingAccountId,BillingCurrency,ChargePeriodStart,ProviderName,ServiceName,Tags";

let db: Database;
let localIndex: LocalIndex;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-i55-report-"));
  writeFileSync(
    join(dir, "nimbus.toml"),
    '[[cost.rule]]\nmatch = { tag = { product = "*" } }\nset = { product = "{tag.product}" }\n',
  );
  const rows = ["2026-11-20", "2026-11-21"].map(
    (d) => `10,111,USD,${d}T00:00:00Z,AWS,<!here> @channel,"{""product"":""checkout""}"`,
  );
  writeFileSync(join(dir, "a.csv"), [HEADER, ...rows].join("\n"));
  importFocusPath(db, join(dir, "a.csv"), { dryRun: false, now: () => NOW });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function steps(template = "Checkout: {total}\n{breakdown}"): unknown[] {
  return [
    {
      kind: "report",
      label: "render",
      report: {
        name: "checkout-weekly",
        scope: { product: "checkout" },
        period: "7d",
        tz: "UTC",
        kind: "slack",
        format: "text",
        breakdown: "list",
        template,
        subject: null,
      },
    },
    {
      kind: "write",
      label: "post",
      tool: costReportToolFor("slack"),
      input: { channel: { const: "C0123ABC" }, text: { report: "render", part: "body" } },
    },
  ];
}

function seed(template?: string): { id: string; stepsJson: string } {
  const stepsJson = JSON.stringify(steps(template));
  return { id: upsertWorkflowByName(db, NAME, null, stepsJson, NOW), stepsJson };
}

function rule(): void {
  const derived = deriveRule(db, { workflow: NAME, step: "post" }, () => true, NOW - 1000);
  insertRule(db, { ...derived.rule, approvalAuditId: 1 });
}

/** The action a scheduled run's write step builds from a rendered body. */
function actionFor(stepsJson: string, id: string, body = "Checkout: 20.00 USD"): PlannedAction {
  const parsed = parseWorkflowSteps(stepsJson);
  const [action] = buildWriteActions(parsed[1] as WriteWorkflowStep, {
    workflowId: id,
    workflowSha256: workflowStepsSha256(parsed),
    stepIndex: 1,
    runId: "run-1",
    trigger: "schedule",
    queries: new Map(),
    reports: new Map([["render", { index: 0, body, subject: null }]]),
  });
  return action as PlannedAction;
}

const ctx = () => ({
  deps: openDeps(db, { now: () => NOW }),
  rows: CONNECTOR_WRITE_ROWS,
  frozenHitl: true,
});

/** A copy of `a` whose provenance field sources are replaced. */
function withSources(a: PlannedAction, fieldSources: Record<string, unknown>): PlannedAction {
  const p = (a as { provenance: Record<string, unknown> }).provenance;
  return { ...a, provenance: { ...p, fieldSources } } as unknown as PlannedAction;
}

describe("I55 report source: the rule", () => {
  test("a rule for the report-fed step records the report source and is described by it", () => {
    seed();
    const derived = deriveRule(db, { workflow: NAME, step: "post" }, () => true, NOW - 1000);
    expect(derived.rule.scope).toEqual({
      channel: { const: "C0123ABC" },
      text: { report: 0, part: "body" },
    });
    expect(renderRuleText(derived.text, NOW).join(" | ")).toContain(
      "text: the report body rendered by step 1",
    );
  });

  test("matches the action a run builds, whatever the rendered body", () => {
    const wf = seed();
    rule();
    expect(standingRuleStep(actionFor(wf.stepsJson, wf.id), ctx())).toBeDefined();
    expect(
      standingRuleStep(actionFor(wf.stepsJson, wf.id, "a different week"), ctx()),
    ).toBeDefined();
  });

  test("a report source on a destination field, another part or another step is never approved", () => {
    const wf = seed();
    rule();
    const a = actionFor(wf.stepsJson, wf.id);
    const body = { report: 0, part: "body" };
    for (const sources of [
      { channel: body, text: body }, // a destination field claiming a report value
      { channel: "constant", text: { report: 0, part: "subject" } }, // the wrong part
      { channel: "constant", text: { report: 2, part: "body" } }, // another step
      { channel: "constant", text: { report: -1, part: "body" } }, // no report output
      { channel: "constant", text: { report: 0, part: "footer" } },
      { channel: "constant", text: "constant" }, // the body claimed as a constant
    ]) {
      expect(
        standingRuleStep(withSources(a, sources), ctx()),
        JSON.stringify(sources),
      ).toBeUndefined();
    }
  });

  test("defence in depth: a forged rule naming a report value on a destination field still never matches", () => {
    const wf = seed();
    rule();
    const body = { report: 0, part: "body" };
    db.run("UPDATE standing_rule SET scope_json = ?", [
      JSON.stringify({ channel: body, text: body }),
    ]);
    const forged = withSources(actionFor(wf.stepsJson, wf.id), { channel: body, text: body });
    expect(standingRuleStep(forged, ctx())).toBeUndefined();
  });

  test("a changed template is a different workflow: the rule stops matching", () => {
    const wf = seed();
    rule();
    const edited = seed("Other: {total}");
    expect(edited.id).toBe(wf.id);
    expect(standingRuleStep(actionFor(edited.stepsJson, edited.id), ctx())).toBeUndefined();
  });
});

describe("I55 report source: a scheduled run", () => {
  function run(dispatched: PlannedAction[], egress: unknown[]) {
    const dispatcher: ConnectorDispatcher = {
      async dispatch(action) {
        dispatched.push(action);
        return { ok: true };
      },
    };
    return runWorkflowExecution({
      db,
      writeExecutor: buildUnattendedWorkflowWriteExecutor({
        localIndex,
        dispatcher,
        egressSink: { append: (e: unknown) => void egress.push(e) } as never,
        getTribalKbConfig: () => undefined,
        enforcedPolicy: () =>
          ({
            capabilitiesDisabled: new Set<string>(),
            chatops: { channels: new Map(), ownership: new Map() },
          }) as never,
      }),
      trigger: "schedule",
      workflowName: NAME,
      triggeredBy: "scheduler",
      dryRun: false,
      stream: false,
      sendChunk: () => {},
      costConfigDir: dir,
      now: () => NOW,
    });
  }

  test("posts under the rule with no prompt: standing-approved, audited and ledgered; vendor text is inert", async () => {
    seed();
    rule();
    const dispatched: PlannedAction[] = [];
    const egress: unknown[] = [];
    const out = await run(dispatched, egress);
    expect(out.status).toBe("done");
    const posts = dispatched.filter((a) => a.type === "slack.message.post");
    expect(posts).toHaveLength(1);
    const [post] = posts;
    if (post === undefined) throw new Error("no post");
    const text = (post.payload as { input: { text: string } }).input.text;
    expect(text).toStartWith("Checkout: 20.00 USD");
    expect(text).not.toContain("<!here>");
    expect(text).not.toContain("@channel");
    expect(egress.length).toBeGreaterThanOrEqual(1);
    const audit = db
      .query("SELECT hitl_status FROM audit_log WHERE action_type = 'slack.message.post'")
      .all() as { hitl_status: string }[];
    expect(audit.map((r) => r.hitl_status)).toEqual(["standing_approved"]);
  });

  test("a template that would notify a whole channel is refused by the door: the run blocks", async () => {
    seed("<!channel> Checkout: {total}");
    rule();
    const dispatched: PlannedAction[] = [];
    const out = await run(dispatched, []);
    expect(out.status).toBe("blocked_on_approval");
    expect(dispatched.filter((a) => a.type === "slack.message.post")).toEqual([]);
  });
});

describe("D44 (h) standing-report-source-confined", () => {
  const SRC = "packages/gateway/src/";
  async function tree(): Promise<{ relPath: string; contents: string }[]> {
    return (await readDirFiles("packages/gateway/src")).map((f) => ({
      relPath: `${SRC}${f.rel}`,
      contents: f.contents,
    }));
  }
  const rules = (files: { relPath: string; contents: string }[]) => [
    ...new Set(checkStandingApprovals(files).map((v) => v.rule)),
  ];

  test("the production tree is clean, and the audit names the clause", async () => {
    expect(checkStandingApprovals(await tree())).toEqual([]);
    expect(await read("scripts/structure-audit/invariants/report-3.ts")).toContain(
      "standing-report-source-confined",
    );
  });

  test("FAILS when a report output is produced, or the report step run, anywhere else", async () => {
    const base = await tree();
    for (const [path, body] of [
      ["engine/other.ts", 'reports.set("render", { index: 0, body: "x", subject: null });'],
      ["engine/other.ts", 'run.reports?.set("render", forged);'],
      ["automation/workflow-write-step.ts", 'reports . set("render", forged);'],
      ["ipc/other.ts", "executeReportStep(deps, id, 0, step, map);"],
    ] as const) {
      const files = [...base, { relPath: `${SRC}${path}`, contents: `${body}\n` }];
      expect(rules(files), body).toEqual(["standing-report-source-confined"]);
    }
    const comment = [...base, { relPath: `${SRC}engine/other.ts`, contents: "// reports.set(\n" }];
    expect(rules(comment)).toEqual([]);
  });
});
