// Workflow conditionals (`when`): the runner decides a guard BEFORE anything is built. Real runner,
// real executors, real index, real rules; a not-taken step never reaches the model, the executor,
// the standing-rule check or the learner. Covers dry-run evaluation and the resume stop.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Agent } from "@mastra/core/agent";

import {
  createRule,
  NOW,
  seedWorkflow,
} from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import {
  buildUnattendedWorkflowWriteExecutor,
  buildWorkflowWriteExecutor,
} from "../engine/run-ask.ts";
import type { ConnectorDispatcher, PlannedAction, WorkflowTrigger } from "../engine/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import { listSuggestions } from "../standing/standing-suggestion-store.ts";
import { runDeclaredQuery } from "./declared-query.ts";
import { type BlockedRunInfo, runWorkflowExecution } from "./workflow-runner.ts";
import { listScheduleView } from "./workflow-schedule-view.ts";
import type { DeclaredQuery } from "./workflow-steps.ts";

const DAY = 86_400_000;
const QUERY = {
  kind: "query",
  label: "old-read-mail",
  query: {
    service: "gmail",
    type: "email",
    where: [{ metadata: "labelIds", notContains: "UNREAD" }, { olderThanDays: 60 }],
    select: "metadata.threadId",
    distinct: true,
    limit: 200,
  },
};
const FROM = { threadId: { from: "old-read-mail", column: "metadata.threadId" } };

/** A query, a write guarded by `when`, and (optionally) more steps. */
function guardedSteps(when: unknown, more: readonly unknown[] = []): unknown[] {
  return [
    QUERY,
    { kind: "write", label: "archive", when, tool: "gmail_thread_archive", input: FROM },
    ...more,
  ];
}
const GT0 = { count: "old-read-mail", gt: 0 };

let db: Database;
let localIndex: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});
afterEach(() => db.close());

function seedThreads(ids: readonly string[]): void {
  for (const id of ids) {
    db.query(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES (?, 'gmail', 'email', ?, 't', ?, ?, ?)`,
    ).run(
      `gmail:${id}`,
      id,
      Date.now() - 90 * DAY,
      JSON.stringify({ threadId: id, labelIds: ["INBOX"] }),
      Date.now(),
    );
  }
}
const clearThreads = (): void => void db.run("DELETE FROM item WHERE service = 'gmail'");

function harness() {
  const dispatched: PlannedAction[] = [];
  const asked: string[] = [];
  const egress: unknown[] = [];
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action) {
      dispatched.push(action);
      if (action.type === "gmail.before.read") {
        return { messages: [{ id: "m", labelIds: ["INBOX"], payload: {} }] };
      }
      return { archived: true };
    },
  };
  const common = {
    localIndex,
    dispatcher,
    egressSink: { append: (r: unknown) => void egress.push(r) } as never,
    getTribalKbConfig: () => undefined,
    enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>(), chatops: [] }) as never,
  };
  const coordinator: ConsentCoordinator = {
    requestConsent: async (_c, p) => {
      asked.push(p.prompt);
      return { approved: true, answerSource: "human" };
    },
    requestConfirmedConsent: async () => ({ approved: false, typed: "", answerSource: "human" }),
    rejectAllPending(): void {},
    pendingCount: () => 0,
  };
  return {
    dispatched,
    asked,
    egress,
    unattended: buildUnattendedWorkflowWriteExecutor(common),
    attended: buildWorkflowWriteExecutor({
      ...common,
      clientId: "owner-cli",
      consentCoordinator: coordinator,
    }),
  };
}
type Harness = ReturnType<typeof harness>;

const archives = (d: readonly PlannedAction[]) =>
  d.filter((a) => a.type === "gmail.thread.archive");

type RunOpts = Omit<Partial<Parameters<typeof runWorkflowExecution>[0]>, "trigger"> & {
  trigger?: WorkflowTrigger | undefined;
};

function run(h: Harness, opts: RunOpts = {}) {
  const { trigger: given, ...rest } = opts;
  const trigger = "trigger" in opts ? given : ("owner_cli" as WorkflowTrigger);
  return runWorkflowExecution({
    db,
    writeExecutor: h.attended,
    ...(trigger !== undefined && { trigger }),
    workflowName: "weekly-mail-clean",
    triggeredBy: "owner-cli",
    dryRun: false,
    stream: false,
    sendChunk: () => {},
    ...rest,
  });
}
const scheduled = (h: Harness, blocked: BlockedRunInfo[] = []) =>
  run(h, {
    writeExecutor: h.unattended,
    trigger: "schedule",
    triggeredBy: "scheduler",
    onBlocked: (b) => blocked.push(b),
  });

const stepRows = (runId: string) =>
  db
    .query(
      "SELECT step_index, label, status, result_json FROM workflow_run_step WHERE run_id = ? ORDER BY step_index",
    )
    .all(runId) as Array<{
    step_index: number;
    label: string;
    status: string;
    result_json: string;
  }>;
const auditOf = (type: string) =>
  db
    .query("SELECT action_json, hitl_status FROM audit_log WHERE action_type = ?")
    .all(type) as Array<{
    action_json: string;
    hitl_status: string;
  }>;

describe("a guarded write", () => {
  test("guard true: the write runs and carries the observed counts in its audit provenance", async () => {
    seedThreads(["t1", "t2"]);
    seedWorkflow(db, guardedSteps(GT0));
    const h = harness();
    const out = await run(h);
    expect(out.status).toBe("done");
    expect(archives(h.dispatched)).toHaveLength(2);
    const [row] = auditOf("gmail.thread.archive");
    expect(row?.action_json).toContain(
      '"guard":[{"query":0,"op":"gt","value":0,"observed":2,"capped":false}]',
    );
    expect(row?.action_json).not.toContain("fieldSources");
  });

  test("guard false: nothing is built, asked, audited or sent; the step is not_taken and the run is done", async () => {
    seedWorkflow(db, guardedSteps(GT0));
    const h = harness();
    const out = await run(h);
    expect(out.status).toBe("done");
    expect(out.stepResults.map((s) => s.status)).toEqual(["done", "not_taken"]);
    expect(out.stepResults[1]?.guard).toBe("count(old-read-mail) > 0");
    expect(out.stepResults[1]?.output).toContain("selected 0");
    expect(archives(h.dispatched)).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.asked).toHaveLength(0);
    expect(h.egress).toHaveLength(0);
    expect(auditOf("gmail.thread.archive")).toHaveLength(0);
    const rows = stepRows(out.runId);
    expect(rows.map((r) => [r.step_index, r.status])).toEqual([
      [0, "done"],
      [1, "not_taken"],
    ]);
    expect(JSON.parse(rows[1]?.result_json ?? "{}")).toEqual({
      guard: "count(old-read-mail) > 0",
      observed: [{ query: "old-read-mail", count: 0, capped: false, holds: false }],
    });
    const [completed] = auditOf("workflow.run.completed");
    expect(completed?.action_json).toContain('"stepsNotTaken":1');
    expect(completed?.action_json).toContain('"status":"done"');
  });

  test("a run in which every guarded step is not taken is still done; later steps still run; indexes are contiguous", async () => {
    seedWorkflow(
      db,
      guardedSteps(GT0, [
        {
          kind: "write",
          label: "fixed",
          tool: "gmail_thread_archive",
          input: { threadId: { const: "fixed-1" } },
        },
      ]),
    );
    const h = harness();
    const out = await run(h);
    expect(out.status).toBe("done");
    expect(out.stepResults.map((s) => s.status)).toEqual(["done", "not_taken", "done"]);
    expect(archives(h.dispatched)).toHaveLength(1);
    expect(stepRows(out.runId).map((r) => r.step_index)).toEqual([0, 1, 2]);
  });

  test("a guard with a list: every comparison must hold; each failing one alone makes the step not_taken", async () => {
    seedThreads(["t1", "t2", "t3"]);
    const all = [
      { count: "old-read-mail", gt: 0 },
      { count: "old-read-mail", gte: 3 },
      { count: "old-read-mail", lt: 9 },
      { count: "old-read-mail", ne: 7 },
    ];
    seedWorkflow(db, guardedSteps(all));
    const h = harness();
    expect((await run(h)).stepResults[1]?.status).toBe("done");
    const broken: unknown[][] = [
      [{ ...all[0], gt: 5 }, all[1], all[2], all[3]],
      [all[0], { count: "old-read-mail", gte: 4 }, all[2], all[3]],
      [all[0], all[1], { count: "old-read-mail", lt: 3 }, all[3]],
      [all[0], all[1], all[2], { count: "old-read-mail", ne: 3 }],
    ];
    for (const when of broken) {
      seedWorkflow(db, guardedSteps(when));
      const before = archives(h.dispatched).length;
      const out = await run(h);
      expect(out.stepResults[1]?.status).toBe("not_taken");
      expect(archives(h.dispatched)).toHaveLength(before);
    }
  });

  test("a capped query: gt holds on its lower bound, ne 0 holds, eq and lt do not; the record says capped", async () => {
    // 5 rows share one thread id: distinct leaves 1 value, but the query hit its limit of 5.
    for (let i = 0; i < 5; i++) {
      db.query(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
         VALUES (?, 'gmail', 'email', ?, 't', ?, ?, ?)`,
      ).run(
        `gmail:m${String(i)}`,
        `m${String(i)}`,
        Date.now() - 90 * DAY,
        JSON.stringify({ threadId: "same", labelIds: [] }),
        Date.now(),
      );
    }
    const q = { ...QUERY, query: { ...QUERY.query, limit: 5 } };
    const withGuard = (when: unknown) => [
      q,
      { kind: "write", label: "archive", when, tool: "gmail_thread_archive", input: FROM },
    ];
    const h = harness();
    const outcome = async (when: unknown) => {
      seedWorkflow(db, withGuard(when));
      const out = await run(h);
      return out.stepResults[1];
    };
    expect((await outcome({ count: "old-read-mail", gt: 0 }))?.status).toBe("done");
    expect((await outcome({ count: "old-read-mail", ne: 0 }))?.status).toBe("done");
    for (const when of [
      { count: "old-read-mail", eq: 1 },
      { count: "old-read-mail", lt: 4 },
      { count: "old-read-mail", lte: 4 },
      { count: "old-read-mail", ne: 3 },
    ]) {
      const step = await outcome(when);
      expect(step?.status).toBe("not_taken");
      expect(step?.output).toContain("capped");
    }
  });

  test("an uncapped query with fewer rows than its limit evaluates every operator exactly", async () => {
    seedThreads(["t1"]);
    const h = harness();
    for (const [when, expected] of [
      [{ count: "old-read-mail", eq: 1 }, "done"],
      [{ count: "old-read-mail", lt: 2 }, "done"],
      [{ count: "old-read-mail", ne: 3 }, "done"],
      [{ count: "old-read-mail", eq: 2 }, "not_taken"],
    ] as const) {
      seedWorkflow(db, guardedSteps(when));
      expect((await run(h)).stepResults[1]?.status).toBe(expected);
    }
  });
});

describe("a guarded model (run) step", () => {
  const steps = (when: unknown) => [QUERY, { kind: "run", label: "say", run: "say hi", when }];

  test("guard false: the model is never invoked and no chunk is sent; guard true: once", async () => {
    let calls = 0;
    const chunks: string[] = [];
    const base = {
      agent: {} as Agent,
      stream: true,
      sendChunk: (t: string) => chunks.push(t),
      conversationalRunner: async () => {
        calls++;
        return { reply: "hi" };
      },
    };
    seedWorkflow(db, steps({ count: "old-read-mail", gt: 0 }));
    const off = await run(harness(), base);
    expect(off.stepResults[1]?.status).toBe("not_taken");
    expect(calls).toBe(0);
    expect(chunks).toEqual([]);
    seedThreads(["t1"]);
    const on = await run(harness(), base);
    expect(on.stepResults[1]?.status).toBe("done");
    expect(calls).toBe(1);
  });
});

describe("approval learning", () => {
  const learning = (enabled: { n: number }) => ({
    enabled: () => {
      enabled.n++;
      return true;
    },
    suggestAfter: () => 2,
  });

  test("a not-taken step never reaches the learner; a taken, hand-approved one counts", async () => {
    const wf = seedWorkflow(db, guardedSteps(GT0));
    const h = harness();
    const calls = { n: 0 };
    await run(h, { learning: learning(calls) });
    expect(calls.n).toBe(0);
    seedThreads(["t1"]);
    await run(h, { learning: learning(calls) });
    expect(calls.n).toBeGreaterThan(0);
    expect(wf.id).toBeDefined();
  });

  test("a not-taken run neither counts nor resets the streak", async () => {
    seedWorkflow(db, guardedSteps(GT0));
    const h = harness();
    const cfg = learning({ n: 0 });
    seedThreads(["t1"]);
    await run(h, { learning: cfg });
    clearThreads();
    await run(h, { learning: cfg }); // guard false: not counted, not reset
    seedThreads(["t2"]);
    await run(h, { learning: cfg });
    expect(listSuggestions(db, "open")).toHaveLength(1); // two counted runs reached suggest_after = 2
  });

  test("an absence-satisfiable step earns no streak and no suggestion however many hand approvals", async () => {
    seedWorkflow(db, guardedSteps({ count: "old-read-mail", lte: 5 }));
    const h = harness();
    const cfg = learning({ n: 0 });
    for (const t of ["a", "b", "c", "d"]) {
      seedThreads([t]);
      expect((await run(h, { learning: cfg })).status).toBe("done");
    }
    expect(listSuggestions(db, "open")).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS n FROM standing_streak").get()).toEqual({ n: 0 });
  });
});

describe("standing rules and guards", () => {
  const rows = (): number =>
    (
      db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE hitl_status = 'standing_approved'")
        .get() as { n: number }
    ).n;
  const fires = (): number =>
    (db.query("SELECT COUNT(*) AS n FROM standing_rule_fire").get() as { n: number }).n;

  test("guard false on a rule-covered write: no fire, no standing_approved row, nothing dispatched or asked", async () => {
    seedWorkflow(db, guardedSteps(GT0));
    createRule(db, {}, { now: Date.now() - 1000 });
    const h = harness();
    const out = await scheduled(h);
    expect(out.status).toBe("done");
    expect(out.stepResults[1]?.status).toBe("not_taken");
    expect(fires()).toBe(0);
    expect(rows()).toBe(0);
    expect(h.dispatched).toHaveLength(0);
    expect(h.asked).toHaveLength(0);
    expect(h.egress).toHaveLength(0);
  });

  test("guard true on a rule-covered write: it fires under the rule and the row carries the observed counts", async () => {
    seedThreads(["t1", "t2"]);
    seedWorkflow(db, guardedSteps(GT0));
    createRule(db, {}, { now: Date.now() - 1000 });
    const h = harness();
    const blocked: BlockedRunInfo[] = [];
    const out = await scheduled(h, blocked);
    expect(out.status).toBe("done");
    expect(archives(h.dispatched)).toHaveLength(2);
    expect(rows()).toBe(2);
    expect(fires()).toBe(2);
    expect(h.asked).toHaveLength(0);
    const [row] = auditOf("gmail.thread.archive");
    expect(row?.hitl_status).toBe("standing_approved");
    expect(row?.action_json).toContain('"observed":2');
  });

  test("a one-byte edit of the guard changes the hash: the old rule no longer matches and an unattended run blocks", async () => {
    seedThreads(["t1"]);
    seedWorkflow(db, guardedSteps(GT0));
    createRule(db, {}, { now: Date.now() - 1000 });
    seedWorkflow(db, guardedSteps({ count: "old-read-mail", gt: 1 }), "weekly-mail-clean");
    seedThreads(["t2", "t3"]);
    const h = harness();
    const blocked: BlockedRunInfo[] = [];
    const out = await scheduled(h, blocked);
    expect(out.status).toBe("blocked_on_approval");
    expect(archives(h.dispatched)).toHaveLength(0);
    expect(blocked).toHaveLength(1);
    expect(fires()).toBe(0);
  });

  test("an absence guard that holds on an unattended run blocks (no rule can exist) and dispatches nothing", async () => {
    seedWorkflow(db, [
      QUERY,
      {
        kind: "write",
        label: "all-clear",
        when: { count: "old-read-mail", eq: 0 },
        tool: "gmail_thread_archive",
        input: { threadId: { const: "fixed-1" } },
      },
    ]);
    const h = harness();
    const blocked: BlockedRunInfo[] = [];
    // Even a rule over the same step cannot be made: see standing-rule-derive tests.
    const out = await scheduled(h, blocked);
    expect(out.status).toBe("blocked_on_approval");
    expect(archives(h.dispatched)).toHaveLength(0);
    expect(blocked).toHaveLength(1);
  });
});

describe("resuming a blocked run whose guard changed", () => {
  const LATER = {
    kind: "write",
    label: "fixed",
    tool: "gmail_thread_archive",
    input: { threadId: { const: "fixed-1" } },
  };

  async function blockThenResume(mutate: () => void) {
    seedThreads(["t1"]);
    const wf = seedWorkflow(db, guardedSteps(GT0, [LATER]));
    const h = harness();
    const first = await scheduled(h);
    expect(first.status).toBe("blocked_on_approval");
    mutate();
    const second = await run(h, {
      resume: { runId: first.runId, blockedStep: 1, expectedSha256: wf.sha },
    });
    return { h, first, second };
  }

  test("guard no longer holds: the resumed run stops, runs nothing, asks nothing, and ends condition_lapsed", async () => {
    const { h, first, second } = await blockThenResume(clearThreads);
    expect(second.status).toBe("condition_lapsed");
    expect(second.resumedFrom).toBe(first.runId);
    expect(second.stepResults.map((s) => s.status)).toEqual([
      "done",
      "not_taken",
      "condition_lapsed",
    ]);
    expect(second.stepResults.at(-1)?.output).toContain("the condition no longer holds");
    expect(second.stepResults.at(-1)?.output).toContain("steps after it were not run");
    expect(h.dispatched.filter((a) => a.type === "gmail.thread.archive")).toHaveLength(0);
    expect(h.asked).toHaveLength(0);
    // No later step ran and none has a row: only the re-run query and the lapsed step.
    expect(stepRows(second.runId).map((r) => r.step_index)).toEqual([0, 1]);
    const runs = db.query("SELECT id, status, error_msg FROM workflow_run").all() as Array<{
      id: string;
      status: string;
      error_msg: string | null;
    }>;
    const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect(byId[first.runId]?.status).toBe("abandoned");
    expect(byId[second.runId]?.status).toBe("condition_lapsed");
    expect(byId[second.runId]?.error_msg).toContain("the condition no longer holds");
    expect(
      auditOf("workflow.run.completed").some((a) => a.action_json.includes("condition_lapsed")),
    ).toBe(true);
    // The lapsed run is not a blocked run: the schedule view shows it and the scheduler's lookup ignores it.
    db.run("UPDATE workflow SET schedule = '0 6 * * *', schedule_tz = 'UTC'");
    const [view] = listScheduleView(db);
    expect(view?.lastRunStatus).toBe("condition_lapsed");
    expect(view?.blockedRunId).toBeNull();
  });

  test("guard still holds: the owner is asked, and later steps evaluate their own guards", async () => {
    const { h, second } = await blockThenResume(() => seedThreads(["t2"]));
    expect(second.status).toBe("done");
    expect(h.asked.length).toBeGreaterThan(0);
    expect(archives(h.dispatched).length).toBeGreaterThanOrEqual(2);
  });

  test("a guard edit after blocking is refused as a changed workflow", async () => {
    seedThreads(["t1"]);
    const wf = seedWorkflow(db, guardedSteps(GT0));
    const h = harness();
    const first = await scheduled(h);
    seedWorkflow(db, guardedSteps({ count: "old-read-mail", gt: 1 }));
    await expect(
      run(h, { resume: { runId: first.runId, blockedStep: 1, expectedSha256: wf.sha } }),
    ).rejects.toThrow("ERR_WORKFLOW_CHANGED");
  });
});

describe("dry run", () => {
  const dry = (h: Harness, extra: RunOpts = {}) => run(h, { dryRun: true, ...extra });

  test("a CLI-declared caller gets evaluation lines and the queries run; nothing is written to the index", async () => {
    seedThreads(["t1", "t2"]);
    seedWorkflow(
      db,
      guardedSteps(GT0, [
        { kind: "run", label: "none", run: "x", when: { count: "old-read-mail", eq: 0 } },
      ]),
    );
    const before = db.query("SELECT COUNT(*) AS n FROM item").get();
    const out = await dry(harness());
    expect(out.status).toBe("preview");
    expect(out.stepResults[1]?.guard).toBe("count(old-read-mail) > 0");
    expect(out.stepResults[1]?.evaluation).toContain("would run (selects 2;");
    expect(out.stepResults[1]?.evaluation).toContain("as of now");
    expect(out.stepResults[2]?.evaluation).toContain("would not run (selects 2;");
    expect(db.query("SELECT COUNT(*) AS n FROM item").get()).toEqual(before);
    expect(out.stepResults[1]?.hitlActions).toEqual(["gmail.thread.archive"]);
  });

  test("a caller with no declared owner kind gets the guard text and no count; no query runs", async () => {
    seedThreads(["t1"]);
    seedWorkflow(db, guardedSteps(GT0));
    let queries = 0;
    const queryRunner = (d: Database, q: DeclaredQuery) => {
      queries++;
      return runDeclaredQuery(d, q);
    };
    const none = await dry(harness(), { trigger: undefined, queryRunner });
    expect(none.stepResults[1]?.guard).toBe("count(old-read-mail) > 0");
    expect(none.stepResults[1]?.evaluation).toContain("not evaluated");
    expect(queries).toBe(0);
    await dry(harness(), { trigger: "owner_ui", queryRunner });
    expect(queries).toBe(1); // a query is read once however many guards name it
  });

  test("a failing query reports cannot tell and the preview still succeeds", async () => {
    seedWorkflow(db, guardedSteps(GT0));
    const out = await dry(harness(), {
      queryRunner: () => {
        throw new Error("index unavailable");
      },
    });
    expect(out.status).toBe("preview");
    expect(out.stepResults[1]?.evaluation).toBe("cannot tell: index unavailable");
  });

  test("a capped query's failing comparison says it cannot be established", async () => {
    seedWorkflow(db, guardedSteps({ count: "old-read-mail", eq: 1 }));
    const out = await dry(harness(), {
      queryRunner: () => ({ values: ["a"], dropped: 0, rows: 200 }),
    });
    expect(out.stepResults[1]?.evaluation).toContain("cannot be established");
  });

  test("an unguarded step has no guard or evaluation fields", async () => {
    seedWorkflow(db, [
      QUERY,
      { kind: "write", label: "w", tool: "gmail_thread_archive", input: FROM },
    ]);
    const out = await dry(harness());
    expect(out.stepResults[1]).not.toHaveProperty("guard");
    expect(out.stepResults[1]).not.toHaveProperty("evaluation");
  });
});

void NOW;
