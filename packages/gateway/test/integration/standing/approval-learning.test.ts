// Phase 10 SA5 (approval learning, spec § 6.4): five owner-started runs in which the owner approves
// every archive by hand make ONE suggestion; accepting it goes through the same owner approval as any
// rule, and the sixth run fires the rule with no prompt. The same five runs answered by --yes (`auto`)
// make nothing. Real index, real workflow runner, real executor and audit log, real rule store and
// real RPC handler; only the Gmail connector and the consent answer are stubs.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runWorkflowExecution } from "../../../src/automation/workflow-runner.ts";
import { upsertWorkflowByName } from "../../../src/automation/workflow-store.ts";
import { makeEgressSink } from "../../../src/egress/egress-ledger.ts";
import { HITL_REQUIRED } from "../../../src/engine/executor.ts";
import { buildWorkflowWriteExecutor } from "../../../src/engine/run-ask.ts";
import type {
  AnswerSource,
  ConnectorDispatcher,
  PlannedAction,
} from "../../../src/engine/types.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import type { ConsentCoordinator } from "../../../src/ipc/consent.ts";
import { createStandingOwnerAsk, dispatchStandingRpc } from "../../../src/ipc/standing-rpc.ts";
import type { LearningConfig } from "../../../src/standing/approval-learning.ts";
import { listRules } from "../../../src/standing/standing-rule-store.ts";
import {
  getSuggestion,
  listSuggestions,
  streakOf,
} from "../../../src/standing/standing-suggestion-store.ts";

const DAY = 86_400_000;

const STEPS = [
  {
    kind: "query",
    label: "old-read-mail",
    query: {
      service: "gmail",
      type: "email",
      where: [
        { metadata: "labelIds", notContains: "UNREAD" },
        { metadata: "labelIds", contains: "INBOX" },
        { olderThanDays: 60 },
      ],
      select: "metadata.threadId",
      distinct: true,
      limit: 200,
    },
  },
  {
    kind: "write",
    label: "archive",
    tool: "gmail_thread_archive",
    input: { threadId: { from: "old-read-mail", column: "metadata.threadId" } },
  },
];

let db: Database;
let localIndex: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
  for (const id of ["t1", "t2", "t3"]) {
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
  upsertWorkflowByName(db, "weekly-mail-clean", null, JSON.stringify(STEPS), Date.now());
});
afterEach(() => db.close());

function harness(source: AnswerSource, approve = true) {
  const dispatched: PlannedAction[] = [];
  const prompts: string[] = [];
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action) {
      dispatched.push(action);
      if (action.type === "gmail.before.read") {
        return { messages: [{ id: "m", labelIds: ["INBOX"], payload: {} }] };
      }
      return { archived: true };
    },
  };
  const coordinator: ConsentCoordinator = {
    requestConsent: async (_c, p) => {
      prompts.push(p.prompt);
      return { approved: approve, answerSource: source };
    },
    requestConfirmedConsent: async () => ({ approved: false, typed: "", answerSource: "human" }),
    rejectAllPending(): void {},
    pendingCount: () => 0,
  };
  const learning: LearningConfig = { enabled: () => true, suggestAfter: () => 5 };
  const runOnce = () =>
    runWorkflowExecution({
      db,
      writeExecutor: buildWorkflowWriteExecutor({
        clientId: "cli-1",
        consentCoordinator: coordinator,
        localIndex,
        dispatcher,
        egressSink: makeEgressSink(db),
        getTribalKbConfig: () => undefined,
        enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>(), chatops: [] }) as never,
      }),
      trigger: "owner_cli",
      learning,
      workflowName: "weekly-mail-clean",
      triggeredBy: "cli",
      dryRun: false,
      stream: false,
      sendChunk: () => {},
    });
  const archives = (): number => dispatched.filter((a) => a.type === "gmail.thread.archive").length;
  return { runOnce, prompts, archives };
}

function key(): { workflowId: string; workflowSha256: string; stepIndex: number } {
  const row = db
    .query("SELECT workflow_id AS w, workflow_sha256 AS s FROM workflow_run LIMIT 1")
    .get() as { w: string; s: string };
  return { workflowId: row.w, workflowSha256: row.s, stepIndex: 1 };
}

function ownerCtx() {
  return {
    db,
    callerKind: "cli" as const,
    policyAllows: () => true,
    askOwner: createStandingOwnerAsk({
      consent: {
        requestApproval: async () => ({ approved: true, answerSource: "human" as const }),
      },
      audit: localIndex,
      db,
    }),
    recordNarrowing: () => {},
    frozenHitl: (t: string) => HITL_REQUIRED.has(t),
  };
}

describe("approval learning, end to end", () => {
  test("five hand-approved runs make one suggestion; accepting it makes the rule; the sixth run asks nothing", async () => {
    const h = harness("human");
    for (let i = 1; i <= 4; i += 1) {
      expect((await h.runOnce()).status).toBe("done");
      expect(listSuggestions(db)).toHaveLength(0);
    }
    expect((await h.runOnce()).status).toBe("done");
    // Three threads per run, one prompt each: 15 prompts, but ONE run per streak step.
    expect(h.prompts).toHaveLength(15);
    expect(streakOf(db, key())).toBe(5);
    const open = listSuggestions(db, "open");
    expect(open).toHaveLength(1);
    expect(open[0]?.streak).toBe(5);

    // The real audit rows the pass read carry the provenance and the human answer source.
    const row = db
      .query(
        "SELECT hitl_status AS s, action_json AS j FROM audit_log WHERE action_type = 'gmail.thread.archive' ORDER BY id DESC LIMIT 1",
      )
      .get() as { s: string; j: string };
    const parsed = JSON.parse(row.j) as {
      answerSource: string;
      action: { provenance: { kind: string; trigger: string } };
    };
    expect(row.s).toBe("approved");
    expect(parsed.answerSource).toBe("human");
    expect(parsed.action.provenance).toMatchObject({
      kind: "owner_workflow",
      trigger: "owner_cli",
    });

    // Nothing was created by learning.
    expect(listRules(db)).toHaveLength(0);

    // Accept it: the same owner approval as any rule.
    const created = (await dispatchStandingRpc(
      "standing.create",
      { fromSuggestion: open[0]?.id },
      ownerCtx(),
    )) as { kind: string; value: { rule: { id: string } } };
    expect(created.kind).toBe("hit");
    expect(listRules(db)).toHaveLength(1);
    expect(getSuggestion(db, open[0]?.id ?? "")?.status).toBe("accepted");
    const ruleAudit = db
      .query("SELECT hitl_status AS s FROM audit_log WHERE action_type = 'standing.rule.create'")
      .get() as { s: string };
    expect(ruleAudit.s).toBe("approved");

    // The sixth run fires the rule: no prompt, three more archives, audited as standing approvals.
    const promptsBefore = h.prompts.length;
    expect((await h.runOnce()).status).toBe("done");
    expect(h.prompts).toHaveLength(promptsBefore);
    expect(h.archives()).toBe(18);
    const standing = db
      .query("SELECT count(*) AS n FROM audit_log WHERE hitl_status = 'standing_approved'")
      .get() as { n: number };
    expect(standing.n).toBe(3);
    // A run the rule covered neither counts nor resets, and learning does not suggest again.
    expect(listSuggestions(db, "open")).toHaveLength(0);
  });

  test("the same five runs answered by --yes make no suggestion", async () => {
    const h = harness("auto");
    for (let i = 1; i <= 5; i += 1) await h.runOnce();
    expect(h.archives()).toBe(15);
    expect(listSuggestions(db)).toHaveLength(0);
    expect(db.query("SELECT count(*) AS n FROM standing_streak").get()).toEqual({ n: 0 });
  });

  test("a human rejection in the fifth run resets the streak", async () => {
    const yes = harness("human");
    for (let i = 1; i <= 4; i += 1) await yes.runOnce();
    expect(streakOf(db, key())).toBe(4);
    const no = harness("human", false);
    await no.runOnce();
    expect(streakOf(db, key())).toBe(0);
    expect(listSuggestions(db)).toHaveLength(0);
  });

  test("editing the workflow starts a new count and a suggestion for the old content goes stale", async () => {
    const h = harness("human");
    for (let i = 1; i <= 5; i += 1) await h.runOnce();
    expect(listSuggestions(db, "open")).toHaveLength(1);
    upsertWorkflowByName(
      db,
      "weekly-mail-clean",
      null,
      JSON.stringify([STEPS[0], { ...STEPS[1], label: "archive-all" }]),
      Date.now(),
    );
    await h.runOnce();
    expect(listSuggestions(db, "open")).toHaveLength(0);
    expect(listSuggestions(db, "stale")).toHaveLength(1);
  });
});
