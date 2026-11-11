// Phase 10 SA4 (static D44(d)): the scheduler's write executor. Real ToolExecutor, real rows, a real
// standing rule created through the real store. An unattended executor approves a write only through
// a standing rule; with no rule it refuses before it would ask anyone, and nothing is dispatched.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  archiveAction,
  createRule,
  NOW,
  seedWorkflow,
} from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import { UNATTENDED_NO_RULE_REASON } from "./executor.ts";
import { buildUnattendedWorkflowWriteExecutor, buildWorkflowWriteExecutor } from "./run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "./types.ts";

let db: Database;
let localIndex: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});
afterEach(() => db.close());

const POLICY_ON = () => ({ capabilitiesDisabled: new Set<string>(), chatops: [] }) as never;

function harness() {
  const asked: string[] = [];
  const dispatched: PlannedAction[] = [];
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action) {
      dispatched.push(action);
      if (action.type === "gmail.before.read") {
        return { id: "thread-1", messages: [{ id: "m1", labelIds: ["INBOX"], payload: {} }] };
      }
      return { archived: true };
    },
  };
  const common = {
    localIndex,
    dispatcher,
    egressSink: { append: () => {} },
    getTribalKbConfig: () => undefined,
    enforcedPolicy: POLICY_ON,
    standingNow: () => NOW,
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
    asked,
    dispatched,
    unattended: buildUnattendedWorkflowWriteExecutor(common),
    attended: buildWorkflowWriteExecutor({
      ...common,
      clientId: "owner-cli",
      consentCoordinator: coordinator,
    }),
  };
}

function writes(dispatched: readonly PlannedAction[]): PlannedAction[] {
  return dispatched.filter((a) => a.type === "gmail.thread.archive");
}

function auditRows(): Array<{ hitl_status: string; action_json: string }> {
  return db
    .query(
      "SELECT hitl_status, action_json FROM audit_log WHERE action_type = 'gmail.thread.archive' ORDER BY id",
    )
    .all() as Array<{ hitl_status: string; action_json: string }>;
}

describe("buildUnattendedWorkflowWriteExecutor (D44(d))", () => {
  test("with no standing rule a write is refused with the fixed reason and nothing is dispatched", async () => {
    const wf = seedWorkflow(db);
    const h = harness();
    const out = await h.unattended.execute(archiveAction(wf, { trigger: "schedule" }));
    expect(out).toMatchObject({ status: "rejected", reason: UNATTENDED_NO_RULE_REASON });
    expect(writes(h.dispatched)).toHaveLength(0);
    expect(h.asked).toHaveLength(0);
    const [row] = auditRows();
    expect(row?.hitl_status).toBe("rejected");
  });

  test("with a matching rule the write is approved by the rule, never asked, and recorded standing_approved", async () => {
    const wf = seedWorkflow(db);
    const rule = createRule(db);
    const h = harness();
    const out = await h.unattended.execute(archiveAction(wf, { trigger: "schedule" }));
    expect(out.status).toBe("ok");
    expect(writes(h.dispatched)).toHaveLength(1);
    expect(h.asked).toHaveLength(0);
    const [row] = auditRows();
    expect(row?.hitl_status).toBe("standing_approved");
    expect(row?.action_json).toContain(rule.id);
  });

  test("a spent rule falls through to the refusal, not to a prompt", async () => {
    const wf = seedWorkflow(db);
    createRule(db, { max: 1 });
    const h = harness();
    const first = await h.unattended.execute(archiveAction(wf, { trigger: "schedule" }));
    expect(first.status).toBe("ok");
    const second = await h.unattended.execute(
      archiveAction(wf, { trigger: "schedule", threadId: "thread-2" }),
    );
    expect(second).toMatchObject({ status: "rejected", reason: UNATTENDED_NO_RULE_REASON });
    expect(writes(h.dispatched)).toHaveLength(1);
    expect(h.asked).toHaveLength(0);
  });

  test("an action from the model never matches a rule and is refused too", async () => {
    const wf = seedWorkflow(db);
    createRule(db);
    const h = harness();
    const out = await h.unattended.execute({
      ...archiveAction(wf, { trigger: "schedule" }),
      origin: "model",
    });
    expect(out).toMatchObject({ status: "rejected", reason: UNATTENDED_NO_RULE_REASON });
    expect(writes(h.dispatched)).toHaveLength(0);
  });

  test("the attended executor, given the same missing rule, still asks the owner", async () => {
    const wf = seedWorkflow(db);
    const h = harness();
    const out = await h.attended.execute(archiveAction(wf, { trigger: "owner_cli" }));
    expect(out.status).toBe("ok");
    expect(h.asked).toHaveLength(1);
    expect(writes(h.dispatched)).toHaveLength(1);
  });

  test("the org policy locking standing approvals off leaves an unattended write refused", async () => {
    const wf = seedWorkflow(db);
    createRule(db);
    const h = harness();
    const off = buildUnattendedWorkflowWriteExecutor({
      localIndex,
      dispatcher: {
        dispatch: async (a) => (a.type === "gmail.before.read" ? { messages: [] } : {}),
      },
      egressSink: { append: () => {} },
      getTribalKbConfig: () => undefined,
      enforcedPolicy: () =>
        ({ capabilitiesDisabled: new Set(["standing_approvals"]), chatops: [] }) as never,
      standingNow: () => NOW,
    });
    const out = await off.execute(archiveAction(wf, { trigger: "schedule" }));
    expect(out).toMatchObject({ status: "rejected", reason: UNATTENDED_NO_RULE_REASON });
    expect(h.dispatched).toHaveLength(0);
  });
});
