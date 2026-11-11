import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { appendAuditEntry } from "../db/audit-chain.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  classifyStepRun,
  type LearningConfig,
  type LearningStepRun,
  learnFromStepRun,
} from "./approval-learning.ts";
import { insertRule, pauseRule } from "./standing-rule-store.ts";
import {
  dismissSuggestion,
  listSuggestions,
  markAccepted,
  openSuggestion,
  streakOf,
} from "./standing-suggestion-store.ts";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const T0 = 1_000_000;
const TYPE = "gmail.thread.archive";

function fresh(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 90);
  return db;
}

function runOf(over: Partial<LearningStepRun> = {}): LearningStepRun {
  return {
    runId: "run-1",
    workflowId: "wf",
    workflowSha256: H1,
    stepIndex: 1,
    actionType: TYPE,
    workflowName: "archive-old",
    stepLabel: "archive",
    trigger: "owner_cli",
    startedAt: T0,
    ...over,
  };
}

type RowSpec = {
  status?: "approved" | "rejected" | "standing_approved" | "not_required";
  answerSource?: string | undefined;
  prov?: Record<string, unknown> | null;
  type?: string;
  raw?: string;
  ts?: number;
};

function addRow(db: Database, spec: RowSpec = {}, run: LearningStepRun = runOf()): void {
  const provenance =
    spec.prov === null
      ? undefined
      : {
          kind: "owner_workflow",
          workflowId: run.workflowId,
          workflowSha256: run.workflowSha256,
          stepIndex: run.stepIndex,
          runId: run.runId,
          trigger: "owner_cli",
          ...spec.prov,
        };
  const json =
    spec.raw ??
    JSON.stringify({
      action: { type: TYPE, ...(provenance === undefined ? {} : { provenance }), threadId: "t1" },
      ...(spec.answerSource === undefined ? {} : { answerSource: spec.answerSource }),
    });
  appendAuditEntry(db, {
    actionType: spec.type ?? TYPE,
    hitlStatus: spec.status ?? "approved",
    actionJson: json,
    timestamp: spec.ts ?? T0 + 5,
  });
}

function cfg(over: Partial<LearningConfig> = {}): LearningConfig {
  return {
    enabled: () => true,
    suggestAfter: () => 3,
    now: () => T0 + 100,
    ...over,
  };
}

const human = (status: RowSpec["status"] = "approved"): RowSpec => ({
  status,
  answerSource: "human",
});

function verdictOf(rows: RowSpec[]): string {
  const db = fresh();
  for (const r of rows) addRow(db, r);
  const found = db
    .query("SELECT hitl_status, action_json FROM audit_log ORDER BY id")
    .all() as Array<{ hitl_status: string; action_json: string }>;
  return classifyStepRun(found, runOf());
}

describe("classifyStepRun: one run of one step", () => {
  test("every asked action approved by a human counts, however many actions", () => {
    expect(verdictOf([human()])).toBe("counts");
    expect(verdictOf([human(), human(), human()])).toBe("counts");
  });

  test("a human rejection resets, even beside human approvals", () => {
    expect(verdictOf([human("rejected")])).toBe("resets");
    expect(verdictOf([human(), human("rejected")])).toBe("resets");
    expect(verdictOf([human("rejected"), human()])).toBe("resets");
  });

  test("approvals by --yes, a script, unknown, a delegate or a remote answer change nothing", () => {
    for (const src of ["auto", "script", "unknown", "delegate", "remote"]) {
      expect(verdictOf([{ status: "approved", answerSource: src }])).toBe("no_change");
      expect(verdictOf([{ status: "rejected", answerSource: src }])).toBe("no_change");
    }
  });

  test("a human approval mixed with an automatic one is no change", () => {
    expect(verdictOf([human(), { status: "approved", answerSource: "auto" }])).toBe("no_change");
  });

  test("a rejection by a human beats a mixed non-human approval (the owner said no)", () => {
    expect(verdictOf([{ status: "approved", answerSource: "auto" }, human("rejected")])).toBe(
      "resets",
    );
  });

  test("a guard refusal with no answer source, a standing approval and no rows are no change", () => {
    expect(verdictOf([{ status: "rejected" }])).toBe("no_change");
    expect(verdictOf([{ status: "rejected", answerSource: "none" }])).toBe("no_change");
    expect(verdictOf([{ status: "standing_approved", answerSource: "human" }])).toBe("no_change");
    expect(verdictOf([])).toBe("no_change");
  });

  test("a standing-approved action beside human approvals does not stop the run counting", () => {
    expect(verdictOf([human(), { status: "standing_approved" }])).toBe("counts");
  });

  test("rows of another run, step, workflow, hash or with no provenance are not this run's", () => {
    expect(verdictOf([{ ...human(), prov: { runId: "other" } }])).toBe("no_change");
    expect(verdictOf([{ ...human(), prov: { stepIndex: 9 } }])).toBe("no_change");
    expect(verdictOf([{ ...human(), prov: { workflowId: "other" } }])).toBe("no_change");
    expect(verdictOf([{ ...human(), prov: { workflowSha256: H2 } }])).toBe("no_change");
    expect(verdictOf([{ ...human(), prov: null }])).toBe("no_change");
    expect(verdictOf([{ ...human(), prov: { kind: "something_else" } }])).toBe("no_change");
  });

  test("a foreign row beside ours does not change the run's verdict", () => {
    expect(verdictOf([{ ...human(), prov: { runId: "other" } }, human()])).toBe("counts");
  });

  test("a truncated or malformed row of the step's type makes the run no change, whatever else", () => {
    expect(
      verdictOf([human(), { raw: `{"action":{"type":"${TYPE}","body":"xxxx…[truncated]` }]),
    ).toBe("no_change");
    expect(verdictOf([human("rejected"), { raw: "not json" }])).toBe("no_change");
    expect(verdictOf([human(), { raw: "[1,2]" }])).toBe("no_change");
    expect(verdictOf([human(), { raw: '{"answerSource":"human"}' }])).toBe("no_change");
  });
});

describe("learnFromStepRun: the streak and the suggestion", () => {
  function runHuman(db: Database, n: number, over: Partial<LearningStepRun> = {}) {
    const run = runOf({ runId: `run-${String(n)}`, ...over });
    addRow(db, human(), run);
    return learnFromStepRun(db, run, cfg());
  }

  test("a suggestion appears on the Nth hand-approved run, not before", () => {
    const db = fresh();
    expect(runHuman(db, 1)).toMatchObject({ kind: "learned", verdict: "counts", streak: 1 });
    expect(runHuman(db, 2)).toMatchObject({ streak: 2 });
    expect(listSuggestions(db)).toHaveLength(0);
    const third = runHuman(db, 3);
    expect(third).toMatchObject({ streak: 3 });
    expect(third.kind === "learned" && third.suggestionId).toMatch(/^ss_/);
    expect(listSuggestions(db, "open")).toHaveLength(1);
    // A fourth does not make a second one.
    runHuman(db, 4);
    expect(listSuggestions(db)).toHaveLength(1);
  });

  test("a human rejection resets the streak to zero", () => {
    const db = fresh();
    runHuman(db, 1);
    runHuman(db, 2);
    const run = runOf({ runId: "run-3" });
    addRow(db, human("rejected"), run);
    expect(learnFromStepRun(db, run, cfg())).toMatchObject({ verdict: "resets", streak: 0 });
    expect(streakOf(db, runOf())).toBe(0);
    runHuman(db, 4);
    runHuman(db, 5);
    expect(listSuggestions(db)).toHaveLength(0);
  });

  test("a run answered by --yes neither counts nor resets", () => {
    const db = fresh();
    runHuman(db, 1);
    runHuman(db, 2);
    const run = runOf({ runId: "run-3" });
    addRow(db, { status: "approved", answerSource: "auto" }, run);
    expect(learnFromStepRun(db, run, cfg())).toMatchObject({ verdict: "no_change", streak: 2 });
    expect(runHuman(db, 4)).toMatchObject({ streak: 3 });
    expect(listSuggestions(db, "open")).toHaveLength(1);
  });

  test("a run with no asked action (no rows) changes nothing", () => {
    const db = fresh();
    runHuman(db, 1);
    expect(learnFromStepRun(db, runOf({ runId: "run-2" }), cfg())).toMatchObject({
      verdict: "no_change",
      streak: 1,
    });
  });

  test("rows older than the run's start are not read", () => {
    const db = fresh();
    addRow(db, { ...human(), ts: T0 - 1 });
    expect(learnFromStepRun(db, runOf(), cfg())).toMatchObject({ verdict: "no_change" });
  });

  test("one capped row of the step's type in the window: neither counts nor resets", () => {
    const db = fresh();
    runHuman(db, 1);
    runHuman(db, 2);
    const run = runOf({ runId: "run-3" });
    addRow(db, human(), run);
    // A 4 KiB-capped row: the serialized string is cut and never parses.
    addRow(db, { raw: `{"action":{"type":"${TYPE}","body":"${"x".repeat(100)}…[truncated]` }, run);
    expect(learnFromStepRun(db, run, cfg())).toMatchObject({ verdict: "no_change", streak: 2 });
    expect(listSuggestions(db)).toHaveLength(0);
    const run4 = runOf({ runId: "run-4" });
    addRow(db, human("rejected"), run4);
    addRow(db, { raw: '{"action":{"type":"x","b":"…[truncated]' }, run4);
    expect(learnFromStepRun(db, run4, cfg())).toMatchObject({ verdict: "no_change", streak: 2 });
  });

  test("the audit row cap really cuts a large payload, so the row cannot parse", async () => {
    const { formatAuditPayload } = await import("../audit/format-audit-payload.ts");
    const big = formatAuditPayload({ action: { type: TYPE, body: "y".repeat(10_000) } });
    expect(big.endsWith("…[truncated]")).toBe(true);
    expect(() => JSON.parse(big)).toThrow();
  });

  test("a scheduled run, an absent trigger and a dry-run-like absent trigger learn nothing", () => {
    const db = fresh();
    for (const trigger of ["schedule", undefined] as const) {
      const run = runOf({ trigger });
      addRow(db, human(), run);
      expect(learnFromStepRun(db, run, cfg())).toEqual({ kind: "off" });
    }
    expect(streakOf(db, runOf())).toBe(0);
  });

  test("owner_ui counts like owner_cli", () => {
    const db = fresh();
    const run = runOf({ trigger: "owner_ui" });
    addRow(db, human(), run);
    expect(learnFromStepRun(db, run, cfg())).toMatchObject({ streak: 1 });
  });

  test("learning off (lockoff or demo), or suggest_after 0, touches nothing", () => {
    const db = fresh();
    addRow(db, human());
    expect(learnFromStepRun(db, runOf(), cfg({ enabled: () => false }))).toEqual({ kind: "off" });
    expect(learnFromStepRun(db, runOf(), cfg({ suggestAfter: () => 0 }))).toEqual({ kind: "off" });
    expect(streakOf(db, runOf())).toBe(0);
  });

  test("a live rule for the step suppresses a suggestion; a paused or other-hash rule does not", () => {
    const db = fresh();
    const rule = insertRule(db, {
      createdAt: T0 - 10,
      workflowId: "wf",
      workflowSha256: H1,
      stepIndex: 1,
      actionType: TYPE,
      toolId: "gmail_thread_archive",
      scope: {},
      window: undefined,
      expiresAt: T0 + 1_000_000,
      maxActions: 5,
      approvalAuditId: 1,
    });
    runHuman(db, 1);
    runHuman(db, 2);
    runHuman(db, 3);
    expect(listSuggestions(db)).toHaveLength(0);
    pauseRule(db, rule.id, T0 + 50);
    runHuman(db, 4);
    expect(listSuggestions(db, "open")).toHaveLength(1);
  });

  test("a dismissed suggestion does not return for the same hash, and a new hash starts at zero", () => {
    const db = fresh();
    for (let i = 1; i <= 3; i += 1) runHuman(db, i);
    const first = listSuggestions(db, "open")[0];
    dismissSuggestion(db, first?.id ?? "", T0 + 50);
    for (let i = 4; i <= 8; i += 1) runHuman(db, i);
    expect(listSuggestions(db, "open")).toHaveLength(0);
    expect(streakOf(db, runOf())).toBe(8);
    // The workflow is edited: a new hash is a new key.
    const edited = { workflowSha256: H2 };
    expect(runHuman(db, 9, edited)).toMatchObject({ streak: 1 });
    expect(streakOf(db, runOf())).toBe(0);
    runHuman(db, 10, edited);
    runHuman(db, 11, edited);
    expect(listSuggestions(db, "open")).toHaveLength(1);
  });

  test("a hash change makes the old hash's open suggestion stale", () => {
    const db = fresh();
    for (let i = 1; i <= 3; i += 1) runHuman(db, i);
    expect(listSuggestions(db, "open")).toHaveLength(1);
    runHuman(db, 4, { workflowSha256: H2 });
    expect(listSuggestions(db, "open")).toHaveLength(0);
    expect(listSuggestions(db, "stale")).toHaveLength(1);
  });

  test("an accepted suggestion restarts the count; the next needs N more hand approvals", () => {
    const db = fresh();
    for (let i = 1; i <= 3; i += 1) runHuman(db, i);
    const s = listSuggestions(db, "open")[0];
    markAccepted(db, s?.id ?? "", "sr_0123456789abcdef", T0 + 60);
    runHuman(db, 4);
    runHuman(db, 5);
    expect(listSuggestions(db, "open")).toHaveLength(0);
    runHuman(db, 6);
    expect(listSuggestions(db, "open")).toHaveLength(1);
  });

  test("the pass logs the suggestion with the workflow and step names and no payload values", () => {
    const db = fresh();
    const lines: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 3; i += 1) {
      const run = runOf({ runId: `run-${String(i)}` });
      addRow(db, human(), run);
      learnFromStepRun(db, run, cfg({ log: (f) => lines.push(f) }));
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ workflow: "archive-old", step: "archive", streak: 3 });
    expect(JSON.stringify(lines[0])).not.toContain("t1");
  });

  test("openSuggestion is not reachable from a streak below the threshold", () => {
    const db = fresh();
    expect(openSuggestion(db, runOf(), 1, T0)?.streak).toBe(1);
  });
});
