// Signed workflow import (I59): what is shown is what is stored, hashed and run (plan task 5), and the
// import's non-interaction with standing rules and approval learning (plan task 6, I55).
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { createRule, NOW } from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import { openDeps } from "../connectors/connector-writes/standing-scenarios.test-helpers.ts";
import {
  FIXTURE_STEPS,
  fixtureBody,
  fixtureKey,
  signFixture,
} from "../connectors/connector-writes/workflow-bundle.test-helpers.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { standingRuleStep } from "../engine/standing-rule-step.ts";
import type { ActionResult, PlannedAction } from "../engine/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import type { LearningConfig } from "../standing/approval-learning.ts";
import { listSuggestions } from "../standing/standing-suggestion-store.ts";
import { canonicalJson } from "../util/canonical-json.ts";
import { importWorkflowBundle } from "./workflow-import.ts";
import { renderStepsVerbatim } from "./workflow-import-prompt.ts";
import { runWorkflowExecution } from "./workflow-runner.ts";
import {
  parseWorkflowSteps,
  type WriteWorkflowStep,
  workflowStepsSha256,
} from "./workflow-steps.ts";
import { getWorkflowByName } from "./workflow-store.ts";
import { buildWriteActions } from "./workflow-write-step.ts";

let db: Database;
let prompts: string[];

beforeEach(() => {
  ensureFullSqlite();
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  prompts = [];
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
     VALUES ('gmail:m1', 'gmail', 'email', 'm1', 't', ?, ?, ?)`,
  ).run(NOW - 90 * 86_400_000, JSON.stringify({ threadId: "t-a", labelIds: ["INBOX"] }), 1);
});
afterEach(() => db.close());

function bundle(over: Record<string, unknown> = {}, steps: readonly unknown[] = FIXTURE_STEPS) {
  return signFixture(fixtureBody(over, steps), fixtureKey());
}

async function doImport(text: string, extra: { replace?: boolean } = {}) {
  return importWorkflowBundle(
    {
      db,
      now: () => NOW,
      clientKind: "cli",
      askOwner: async (a: PlannedAction) => {
        prompts.push(String((a.payload as Record<string, unknown>)["promptText"]));
        return { approved: true, auditId: 1 };
      },
    },
    { bundleText: text, ...extra },
  );
}

function handApprover(): { execute(a: PlannedAction): Promise<ActionResult> } {
  return {
    execute: async (a) => {
      appendAuditEntry(db, {
        actionType: a.type,
        hitlStatus: "approved",
        actionJson: JSON.stringify({ action: a, answerSource: "human" }),
        // The learning pass reads the audit rows written since the run began: the real clock.
        timestamp: Date.now(),
      });
      return { status: "ok", result: {} };
    },
  };
}

const runParams = (over: Record<string, unknown> = {}) => ({
  db,
  workflowName: "weekly-cleanup",
  triggeredBy: "cli",
  trigger: "owner_cli" as const,
  dryRun: false,
  stream: false,
  sendChunk: () => {},
  writeExecutor: handApprover(),
  ...over,
});

describe("stored equals shown equals hashed", () => {
  test("the stored text, the printed hash, the steps section and a run's workflow_sha256 agree", async () => {
    const text = bundle();
    await doImport(text);
    const stored = getWorkflowByName(db, "weekly-cleanup");
    const body = JSON.parse(text).body as { steps: unknown[]; stepsSha256: string };
    // The stored string IS the canonical text of the signed steps.
    expect(stored?.steps_json).toBe(canonicalJson(body.steps));
    const parsed = parseWorkflowSteps(stored?.steps_json ?? "");
    // The hash the prompt printed is the hash of what is stored.
    expect(workflowStepsSha256(parsed)).toBe(body.stepsSha256);
    expect(prompts[0]).toContain(`Content hash: ${body.stepsSha256}`);
    // Re-rendering the steps from the STORED row yields the section that was shown.
    expect(prompts[0]).toContain(renderStepsVerbatim(parsed).join("\n"));
    // A real run records that same hash.
    const r = await runWorkflowExecution(runParams());
    expect(r.status).toBe("done");
    const run = db
      .query("SELECT workflow_sha256 FROM workflow_run ORDER BY started_at DESC LIMIT 1")
      .get() as { workflow_sha256: string };
    expect(run.workflow_sha256).toBe(body.stepsSha256);
  });

  test("a guarded step keeps the chain: stored text parses, the printed hash is its parsed hash", async () => {
    const steps = [
      FIXTURE_STEPS[0],
      { ...(FIXTURE_STEPS[1] as object), when: [{ count: "old-mail", gt: 0 }] },
    ];
    const text = bundle({}, steps);
    await doImport(text);
    const stored = getWorkflowByName(db, "weekly-cleanup");
    const parsed = parseWorkflowSteps(stored?.steps_json ?? "");
    expect(prompts[0]).toContain(`Content hash: ${workflowStepsSha256(parsed)}`);
    expect(prompts[0]).toContain('when: [count("old-mail") gt 0]');
  });
});

function ruleAction(wfId: string, sha: string) {
  const parsed = parseWorkflowSteps(getWorkflowByName(db, "weekly-cleanup")?.steps_json ?? "");
  const [action] = buildWriteActions(parsed[1] as WriteWorkflowStep, {
    workflowId: wfId,
    workflowSha256: sha,
    stepIndex: 1,
    runId: "run-1",
    trigger: "owner_cli",
    queries: new Map([["old-mail", { index: 0, values: ["thread-1"] }]]),
  });
  return action as PlannedAction;
}

function fires(action: PlannedAction): boolean {
  return (
    standingRuleStep(action, {
      deps: openDeps(db),
      rows: CONNECTOR_WRITE_ROWS,
      frozenHitl: true,
    }) !== undefined
  );
}

describe("I55: an import never touches a rule and never satisfies one", () => {
  test("an import writes no standing_rule, streak, fire or suggestion row", async () => {
    await doImport(bundle());
    for (const t of [
      "standing_rule",
      "standing_rule_fire",
      "standing_streak",
      "standing_suggestion",
    ]) {
      expect(db.query(`SELECT count(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 });
    }
  });

  test("a live rule stops firing after a REPLACING import changes the content (the hash changes)", async () => {
    await doImport(bundle());
    const wf = getWorkflowByName(db, "weekly-cleanup");
    const oldSha = workflowStepsSha256(parseWorkflowSteps(wf?.steps_json ?? ""));
    createRule(db, { workflow: "weekly-cleanup", step: "archive" });
    expect(fires(ruleAction(wf?.id ?? "", oldSha))).toBe(true);
    // A newer bundle with different steps (a different query limit) replaces the content.
    const changed = [
      {
        ...(FIXTURE_STEPS[0] as { query: object }),
        query: { ...(FIXTURE_STEPS[0] as { query: object }).query, limit: 5 },
      },
      FIXTURE_STEPS[1],
    ];
    await doImport(bundle({ issuedAt: NOW - 10 }, changed), { replace: true });
    const after = getWorkflowByName(db, "weekly-cleanup");
    expect(after?.id).toBe(wf?.id);
    const newSha = workflowStepsSha256(parseWorkflowSteps(after?.steps_json ?? ""));
    expect(newSha).not.toBe(oldSha);
    expect(fires(ruleAction(after?.id ?? "", newSha))).toBe(false);
  });

  test("a new-name import has a fresh workflow id and no rule", async () => {
    await doImport(bundle());
    const first = getWorkflowByName(db, "weekly-cleanup");
    createRule(db, { workflow: "weekly-cleanup", step: "archive" });
    await doImport(bundle({ name: "second-copy" }));
    const second = getWorkflowByName(db, "second-copy");
    expect(second?.id).not.toBe(first?.id);
    expect(
      db
        .query("SELECT count(*) AS n FROM standing_rule WHERE workflow_id = ?")
        .get(second?.id ?? ""),
    ).toEqual({ n: 0 });
  });

  test("an identical-content replace keeps the owner's rule (the rule is the owner's earlier approval of those bytes)", async () => {
    await doImport(bundle());
    const wf = getWorkflowByName(db, "weekly-cleanup");
    const sha = workflowStepsSha256(parseWorkflowSteps(wf?.steps_json ?? ""));
    createRule(db, { workflow: "weekly-cleanup", step: "archive" });
    await doImport(bundle({ issuedAt: NOW - 10 }), { replace: true });
    expect(prompts[1]).toContain("Content is identical to your current workflow.");
    expect(fires(ruleAction(wf?.id ?? "", sha))).toBe(true);
  });
});

describe("approval learning counts runs of an imported workflow (owner ruling OR-WFI-2)", () => {
  const LEARN: LearningConfig = { enabled: () => true, suggestAfter: () => 2 };

  test("human-approved owner runs earn a suggestion, and only a suggestion", async () => {
    await doImport(bundle());
    for (let i = 0; i < 2; i += 1) {
      const r = await runWorkflowExecution(runParams({ learning: LEARN }));
      expect(r.status).toBe("done");
    }
    expect(listSuggestions(db, "open")).toHaveLength(1);
    expect(db.query("SELECT count(*) AS n FROM standing_rule").get()).toEqual({ n: 0 });
  });
});
