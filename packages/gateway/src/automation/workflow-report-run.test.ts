// Phase 7 slice 4, Task 2: a `report` step renders a cost report from the EMBEDDED template and the local
// cost lines; its body and subject reach a later write only through the `{ report }` source; a period with no
// cost line ends the run `skipped` (nothing dispatched, the owner notified once). Real runner, real
// executors, real index, a real FOCUS import.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costReportToolFor } from "../connectors/connector-writes/cost-report-rows.ts";
import {
  buildUnattendedWorkflowWriteExecutor,
  buildWorkflowWriteExecutor,
} from "../engine/run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { importFocusPath } from "../finops/cost-import.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import {
  type BlockedRunInfo,
  runWorkflowExecution,
  type SkippedRunInfo,
} from "./workflow-runner.ts";
import { parseWorkflowSteps, workflowStepsSha256 } from "./workflow-steps.ts";
import { getWorkflowByName, upsertWorkflowByName } from "./workflow-store.ts";

// Thursday 2026-11-26 noon UTC: a `7d` report covers 2026-11-19 to 2026-11-25.
const NOW = Date.UTC(2026, 10, 26, 12);
const HEADER =
  "BilledCost,BillingAccountId,BillingCurrency,ChargePeriodStart,ProviderName,ServiceName,Tags";
const RULE =
  '[[cost.rule]]\nmatch = { tag = { product = "*" } }\nset = { product = "{tag.product}" }\n';

let db: Database;
let localIndex: LocalIndex;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-report-run-"));
  writeFileSync(join(dir, "nimbus.toml"), RULE);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function importDays(days: readonly string[]): void {
  const rows = days.map(
    (d) => `10,111,USD,${d}T00:00:00Z,AWS,Amazon EC2,"{""product"":""checkout""}"`,
  );
  writeFileSync(join(dir, "a.csv"), [HEADER, ...rows].join("\n"));
  importFocusPath(db, join(dir, "a.csv"), { dryRun: false, now: () => NOW });
}

const REPORT_STEP = {
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
    template: "Checkout {period_start} to {period_end}: {total}",
    subject: null,
  },
};
const POST_STEP = {
  kind: "write",
  label: "post",
  tool: costReportToolFor("slack"),
  input: { channel: { const: "C0123ABC" }, text: { report: "render", part: "body" } },
};

function harness() {
  const dispatched: PlannedAction[] = [];
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action) {
      dispatched.push(action);
      return { ok: true };
    },
  };
  const common = {
    localIndex,
    dispatcher,
    egressSink: { append: () => {} },
    getTribalKbConfig: () => undefined,
    enforcedPolicy: () =>
      ({
        capabilitiesDisabled: new Set<string>(),
        chatops: { channels: new Map(), ownership: new Map() },
      }) as never,
  };
  const coordinator: ConsentCoordinator = {
    requestConsent: async () => ({ approved: true, answerSource: "human" }),
    requestConfirmedConsent: async () => ({ approved: false, typed: "", answerSource: "human" }),
    rejectAllPending(): void {},
    pendingCount: () => 0,
  };
  return {
    dispatched,
    unattended: buildUnattendedWorkflowWriteExecutor(common),
    attended: buildWorkflowWriteExecutor({
      ...common,
      clientId: "owner-cli",
      consentCoordinator: coordinator,
    }),
  };
}

function save(steps: unknown[]): void {
  upsertWorkflowByName(db, "cost-checkout-weekly-slack", null, JSON.stringify(steps), NOW);
}

const posts = (d: readonly PlannedAction[]) => d.filter((a) => a.type === "slack.message.post");

describe("a report step in a run", () => {
  test("an owner-started run posts the rendered body in the write's body field", async () => {
    importDays(["2026-11-19", "2026-11-20", "2026-11-24"]);
    save([REPORT_STEP, POST_STEP]);
    const h = harness();
    const out = await runWorkflowExecution({
      db,
      writeExecutor: h.attended,
      trigger: "owner_cli",
      workflowName: "cost-checkout-weekly-slack",
      triggeredBy: "cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {},
      costConfigDir: dir,
      now: () => NOW,
    });
    expect(out.status).toBe("done");
    const [post] = posts(h.dispatched);
    expect(post?.payload).toEqual({
      mcpToolId: costReportToolFor("slack"),
      input: {
        channel: "C0123ABC",
        text: "Checkout 2026-11-19 to 2026-11-25: 30.00 USD (provisional from 2026-11-24)",
      },
    });
  });

  test("a period with no cost line ends the run skipped, dispatches nothing and tells the owner once", async () => {
    importDays(["2026-10-01"]); // data exists, but none in the report's period
    save([REPORT_STEP, POST_STEP]);
    const h = harness();
    const skipped: SkippedRunInfo[] = [];
    const out = await runWorkflowExecution({
      db,
      writeExecutor: h.unattended,
      trigger: "schedule",
      workflowName: "cost-checkout-weekly-slack",
      triggeredBy: "scheduler",
      dryRun: false,
      stream: false,
      sendChunk: () => {},
      costConfigDir: dir,
      now: () => NOW,
      onSkipped: (s) => skipped.push(s),
    });
    expect(out.status).toBe("skipped");
    expect(h.dispatched).toEqual([]);
    expect(skipped).toEqual([
      {
        runId: out.runId,
        workflowName: "cost-checkout-weekly-slack",
        reason: "no cost data for 2026-11-19 to 2026-11-25; nothing was posted",
      },
    ]);
    const row = db
      .query("SELECT status, error_msg FROM workflow_run WHERE id = ?")
      .get(out.runId) as {
      status: string;
      error_msg: string;
    };
    expect(row).toEqual({
      status: "skipped",
      error_msg: "no cost data for 2026-11-19 to 2026-11-25; nothing was posted",
    });
  });

  test("an empty store skips too; a notifier that throws does not change the outcome", async () => {
    save([REPORT_STEP, POST_STEP]);
    const out = await runWorkflowExecution({
      db,
      writeExecutor: harness().unattended,
      trigger: "schedule",
      workflowName: "cost-checkout-weekly-slack",
      triggeredBy: "scheduler",
      dryRun: false,
      stream: false,
      sendChunk: () => {},
      costConfigDir: dir,
      now: () => NOW,
      onSkipped: () => {
        throw new Error("notifier down");
      },
    });
    expect(out.status).toBe("skipped");
  });

  test("a scheduled run with data blocks (no standing rule yet) and posts nothing", async () => {
    importDays(["2026-11-20"]);
    save([REPORT_STEP, POST_STEP]);
    const h = harness();
    const blocked: BlockedRunInfo[] = [];
    const out = await runWorkflowExecution({
      db,
      writeExecutor: h.unattended,
      trigger: "schedule",
      workflowName: "cost-checkout-weekly-slack",
      triggeredBy: "scheduler",
      dryRun: false,
      stream: false,
      sendChunk: () => {},
      costConfigDir: dir,
      now: () => NOW,
      onBlocked: (b) => blocked.push(b),
    });
    expect(out.status).toBe("blocked_on_approval");
    expect(posts(h.dispatched)).toEqual([]);
    expect(blocked.map((b) => b.stepIndex)).toEqual([1]);
  });

  test("a gateway with no config directory cannot run a report step", async () => {
    importDays(["2026-11-20"]);
    save([REPORT_STEP, POST_STEP]);
    const out = await runWorkflowExecution({
      db,
      writeExecutor: harness().attended,
      trigger: "owner_cli",
      workflowName: "cost-checkout-weekly-slack",
      triggeredBy: "cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {},
      now: () => NOW,
    });
    expect(out.status).toBe("error");
    expect(out.stepResults[0]?.error).toContain("cannot run report steps");
  });

  test("an owner resume of a blocked scheduled report run re-renders the report and posts it", async () => {
    importDays(["2026-11-20"]);
    save([REPORT_STEP, POST_STEP]);
    const h = harness();
    const common = {
      db,
      workflowName: "cost-checkout-weekly-slack",
      dryRun: false,
      stream: false,
      sendChunk: () => {},
      costConfigDir: dir,
      now: () => NOW,
    };
    const blocked = await runWorkflowExecution({
      ...common,
      writeExecutor: h.unattended,
      trigger: "schedule",
      triggeredBy: "scheduler",
    });
    expect(blocked.status).toBe("blocked_on_approval");
    const stored = getWorkflowByName(db, "cost-checkout-weekly-slack")?.steps_json ?? "[]";
    const resumed = await runWorkflowExecution({
      ...common,
      writeExecutor: h.attended,
      trigger: "owner_cli",
      triggeredBy: "cli",
      resume: {
        runId: blocked.runId,
        blockedStep: 1,
        expectedSha256: workflowStepsSha256(parseWorkflowSteps(stored)),
      },
    });
    expect(resumed.status).toBe("done");
    expect(posts(h.dispatched)).toHaveLength(1);
  });

  test("source pin: both production run paths give the runner the config directory", () => {
    const main = readFileSync(join(import.meta.dir, "..", "gateway-main.ts"), "utf8");
    const handler = main.slice(main.indexOf("setWorkflowRunHandler("));
    const handlerBody = handler.slice(0, handler.indexOf("sendChunk: ctx.sendChunk"));
    expect(handlerBody).toContain("costConfigDir: platform.paths.configDir");
    const scheduler = main.slice(main.indexOf("new WorkflowScheduler("));
    expect(scheduler.slice(0, scheduler.indexOf("onError:"))).toContain(
      "costConfigDir: platform.paths.configDir",
    );
  });

  test("a failure while rendering halts the run with the error, and posts nothing", async () => {
    importDays(["2026-11-20"]);
    save([REPORT_STEP, POST_STEP]);
    for (const [thrown, text] of [
      [new Error("clock unavailable"), "clock unavailable"],
      ["a bare string", "a bare string"],
    ] as const) {
      const h = harness();
      const out = await runWorkflowExecution({
        db,
        writeExecutor: h.attended,
        trigger: "owner_cli",
        workflowName: "cost-checkout-weekly-slack",
        triggeredBy: "cli",
        dryRun: false,
        stream: false,
        sendChunk: () => {},
        costConfigDir: dir,
        now: () => {
          throw thrown;
        },
      });
      expect(out.status).toBe("error");
      expect(out.stepResults[0]?.error).toContain(text);
      expect(h.dispatched).toEqual([]);
    }
  });
});
