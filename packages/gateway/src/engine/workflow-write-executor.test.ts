// Phase 10 SA2: the workflow write step's executor (`buildWorkflowWriteExecutor`). Real ToolExecutor,
// real rows: the owner is asked on the run's own client, the before-state is read and shown, a
// delegate is never asked, nothing carries `origin: "model"`, and the audit row names the workflow
// run without the field sources.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import { buildWorkflowWriteExecutor } from "./run-ask.ts";
import type { ConnectorDispatcher, PlannedAction, WorkflowProvenance } from "./types.ts";

let db: Database;
let localIndex: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});
afterEach(() => db.close());

const THREAD_REPLY = {
  id: "18c0ffee",
  messages: [
    {
      id: "m1",
      labelIds: ["INBOX", "UNREAD"],
      payload: { headers: [{ name: "Subject", value: "Quarterly numbers" }] },
    },
  ],
};

function harness(approve: boolean) {
  const consents: Array<{ clientId: string; prompt: string; actionType: string | undefined }> = [];
  const dispatched: PlannedAction[] = [];
  const egress: Array<{ destination?: string }> = [];
  const coordinator: ConsentCoordinator = {
    requestConsent: async (clientId, p) => {
      consents.push({ clientId, prompt: p.prompt, actionType: p.actionType });
      return { approved: approve, answerSource: "human" };
    },
    requestConfirmedConsent: async () => ({ approved: false, typed: "", answerSource: "human" }),
    rejectAllPending(): void {},
    pendingCount: () => 0,
  };
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action) {
      dispatched.push(action);
      if (action.type === "gmail.before.read") return THREAD_REPLY;
      return { archived: true };
    },
  };
  const executor = buildWorkflowWriteExecutor({
    clientId: "owner-cli",
    consentCoordinator: coordinator,
    localIndex,
    dispatcher,
    egressSink: { append: (e) => egress.push(e as { destination?: string }) },
    getTribalKbConfig: () => undefined,
  });
  return { executor, consents, dispatched, egress };
}

const PROVENANCE: WorkflowProvenance = {
  kind: "owner_workflow",
  workflowId: "wf-1",
  workflowSha256: "a".repeat(64),
  stepIndex: 1,
  runId: "run-1",
  trigger: "owner_cli",
  fieldSources: { threadId: { query: 0, column: "metadata.threadId" } },
};

function archive(threadId: string, provenance?: WorkflowProvenance): PlannedAction {
  return {
    type: "gmail.thread.archive",
    payload: { mcpToolId: "gmail_thread_archive", input: { threadId } },
    ...(provenance === undefined ? {} : { provenance }),
  };
}

function auditRows(): Array<{ action_type: string; hitl_status: string; action_json: string }> {
  return db
    .query("SELECT action_type, hitl_status, action_json FROM audit_log ORDER BY id")
    .all() as Array<{ action_type: string; hitl_status: string; action_json: string }>;
}

describe("buildWorkflowWriteExecutor", () => {
  test("asks the owner once on the run's client, with the typed preview and the thread's current state", async () => {
    const h = harness(true);
    const out = await h.executor.execute(archive("18c0ffee", PROVENANCE));
    expect(out.status).toBe("ok");
    const asked = h.consents.filter((c) => c.actionType === "gmail.thread.archive");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.clientId).toBe("owner-cli");
    const prompt = asked[0]?.prompt ?? "";
    expect(prompt).toContain("Archive Gmail thread 18c0ffee");
    expect(prompt).toContain("nothing is deleted");
    // The before-state read ran through the gate and is shown: subject, unread, in the inbox.
    expect(prompt).toContain("Quarterly numbers");
    expect(prompt).toContain("yes: 1 of 1 messages");
    // Not the model door: no "Requested by: the model".
    expect(prompt).not.toContain("Requested by");
  });

  test("dispatches the write after the before-read, both ledgered before dispatch", async () => {
    const h = harness(true);
    await h.executor.execute(archive("18c0ffee", PROVENANCE));
    expect(h.dispatched.map((a) => a.type)).toEqual(["gmail.before.read", "gmail.thread.archive"]);
    expect(h.egress.length).toBeGreaterThanOrEqual(2);
  });

  test("the owner declining dispatches no write", async () => {
    const h = harness(false);
    const out = await h.executor.execute(archive("18c0ffee", PROVENANCE));
    expect(out.status).toBe("rejected");
    expect(h.dispatched.some((a) => a.type === "gmail.thread.archive")).toBe(false);
  });

  test("the audit row names the workflow run and omits the field sources", async () => {
    const h = harness(true);
    await h.executor.execute(archive("18c0ffee", PROVENANCE));
    const row = auditRows().find((r) => r.action_type === "gmail.thread.archive");
    expect(row?.hitl_status).toBe("approved");
    const json = JSON.parse(row?.action_json ?? "{}") as {
      action: { type: string; provenance: Record<string, unknown>; origin?: string };
    };
    expect(json.action.type).toBe("gmail.thread.archive");
    expect(json.action.origin).toBeUndefined();
    expect(json.action.provenance).toEqual({
      kind: "owner_workflow",
      workflowId: "wf-1",
      workflowSha256: "a".repeat(64),
      stepIndex: 1,
      runId: "run-1",
      trigger: "owner_cli",
    });
    // The history comes before the payload, which the row's size cap may cut.
    expect(row?.action_json.indexOf('"provenance"') ?? -1).toBeLessThan(
      row?.action_json.indexOf('"payload"') ?? -1,
    );
  });

  test("an action with no provenance audits as before", async () => {
    const h = harness(true);
    await h.executor.execute(archive("18c0ffee"));
    const row = auditRows().find((r) => r.action_type === "gmail.thread.archive");
    expect(row?.action_json).not.toContain("provenance");
  });

  test("the executor ignores provenance: the same action asks the owner either way", async () => {
    const withIt = harness(true);
    const without = harness(true);
    await withIt.executor.execute(archive("18c0ffee", PROVENANCE));
    await without.executor.execute(archive("18c0ffee"));
    expect(withIt.consents.map((c) => c.prompt)).toEqual(without.consents.map((c) => c.prompt));
  });

  test("a before-read that cannot be read still asks, saying so", async () => {
    const h = harness(true);
    const broken: ConnectorDispatcher = {
      async dispatch(action) {
        if (action.type === "gmail.before.read") throw new Error("down");
        return {};
      },
    };
    const ex = buildWorkflowWriteExecutor({
      clientId: "owner-cli",
      consentCoordinator: {
        requestConsent: async (_c, p) => {
          h.consents.push({ clientId: "owner-cli", prompt: p.prompt, actionType: p.actionType });
          return { approved: true, answerSource: "human" };
        },
        requestConfirmedConsent: async () => ({
          approved: false,
          typed: "",
          answerSource: "human",
        }),
        rejectAllPending(): void {},
        pendingCount: () => 0,
      },
      localIndex,
      dispatcher: broken,
      egressSink: { append: () => {} },
      getTribalKbConfig: () => undefined,
    });
    await ex.execute(archive("18c0ffee", PROVENANCE));
    expect(h.consents.at(-1)?.prompt).toContain("unavailable");
  });
});
