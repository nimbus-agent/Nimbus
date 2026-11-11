// Phase 10 acceptance (standing approvals spec § 9, SA4): a standing rule for "archive read Gmail threads
// older than 60 days" executes its next SCHEDULED run with no prompt, every archived thread is in the
// audit log under the rule id, and a write step without a rule blocks and notifies instead of
// executing silently. Real index, real workflow save, real rule store, real executors, real
// scheduler on an injected clock, real egress ledger; only the Gmail connector is a stub.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runWorkflowExecution } from "../../../src/automation/workflow-runner.ts";
import { WorkflowScheduler } from "../../../src/automation/workflow-scheduler.ts";
import { createRule } from "../../../src/connectors/connector-writes/standing-fixtures.test-helpers.ts";
import { makeEgressSink } from "../../../src/egress/egress-ledger.ts";
import {
  buildUnattendedWorkflowWriteExecutor,
  buildWorkflowWriteExecutor,
} from "../../../src/engine/run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "../../../src/engine/types.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { dispatchAutomationRpc } from "../../../src/ipc/automation-rpc.ts";
import type { ConsentCoordinator } from "../../../src/ipc/consent.ts";
import type { ServerCtx } from "../../../src/ipc/server/context.ts";
import { dispatchWorkflowResumeRpc } from "../../../src/ipc/server/inline-handlers.ts";
import type { WorkflowRunContext } from "../../../src/ipc/workflow-invoke.ts";
import { revokeRule } from "../../../src/standing/standing-rule-store.ts";

const DAY = 86_400_000;
const MINUTE = 60_000;

/** The acceptance workflow: archive the old, read threads that are still in the inbox. */
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

const ARCHIVED = ["t-old-read-1", "t-old-read-2", "t-old-read-3"];
const UNTOUCHED = ["t-old-unread", "t-recent-read", "t-old-already-archived"];

let db: Database;
let localIndex: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});
afterEach(() => db.close());

function seedThread(threadId: string, ageDays: number, labelIds: readonly string[]): void {
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
     VALUES (?, 'gmail', 'email', ?, 't', ?, ?, ?)`,
  ).run(
    `gmail:${threadId}`,
    threadId,
    Date.now() - ageDays * DAY,
    JSON.stringify({ threadId, labelIds }),
    Date.now(),
  );
}

function seedMailbox(): void {
  for (const id of ARCHIVED) seedThread(id, 90, ["INBOX", "CATEGORY_UPDATES"]);
  seedThread("t-old-unread", 90, ["INBOX", "UNREAD"]);
  seedThread("t-recent-read", 5, ["INBOX"]);
  seedThread("t-old-already-archived", 90, ["CATEGORY_UPDATES"]);
}

type Fixture = ReturnType<typeof fixture>;

function fixture() {
  const dispatched: PlannedAction[] = [];
  const consents: string[] = [];
  const notes: string[] = [];
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
    egressSink: makeEgressSink(db),
    getTribalKbConfig: () => undefined,
    enforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>(), chatops: [] }) as never,
  };
  const coordinator: ConsentCoordinator = {
    requestConsent: async (_c, p) => {
      consents.push(p.prompt);
      return { approved: true, answerSource: "human" };
    },
    requestConfirmedConsent: async () => ({ approved: false, typed: "", answerSource: "human" }),
    rejectAllPending(): void {},
    pendingCount: () => 0,
  };
  const clock = { now: Date.now() };
  const scheduler = new WorkflowScheduler({
    db,
    now: () => clock.now,
    makeExecutor: () => buildUnattendedWorkflowWriteExecutor(common),
    notify: (title, body) => {
      notes.push(`${title} | ${body}`);
    },
  });
  /** The `workflow.resume` target, wired exactly as `gateway-main.ts` wires `workflow.run`. */
  const resumeCtx = {
    options: { localIndex },
    getClientKind: () => "cli",
    getWorkflowRunHandler: () => (ctx: WorkflowRunContext) =>
      runWorkflowExecution({
        db,
        writeExecutor: buildWorkflowWriteExecutor({
          ...common,
          clientId: ctx.clientId,
          consentCoordinator: coordinator,
        }),
        ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
        ...(ctx.resume === undefined ? {} : { resume: ctx.resume }),
        workflowName: ctx.workflowName,
        triggeredBy: ctx.triggeredBy,
        dryRun: false,
        stream: false,
        sendChunk: () => {},
      }),
  } as unknown as ServerCtx;
  return { dispatched, consents, notes, clock, scheduler, resumeCtx };
}

const archives = (f: Fixture): string[] =>
  f.dispatched
    .filter((a) => a.type === "gmail.thread.archive")
    .map(
      (a) =>
        ((a.payload as { input: { threadId: string } }).input as { threadId: string }).threadId,
    );

async function saveScheduled(): Promise<number> {
  const out = await dispatchAutomationRpc({
    method: "workflow.save",
    params: {
      name: "weekly-mail-clean",
      stepsJson: JSON.stringify(STEPS),
      schedule: "0 6 * * *",
      scheduleTz: "UTC",
    },
    db,
    clientKind: "cli",
  });
  expect(out).toMatchObject({ kind: "hit", value: { scheduled: true } });
  return (
    db
      .query("SELECT schedule_next_at AS n FROM workflow WHERE name = 'weekly-mail-clean'")
      .get() as {
      n: number;
    }
  ).n;
}

describe("Phase 10 acceptance: a standing rule runs the next scheduled fire with no prompt", () => {
  test("rule, scheduled fire, revoke, blocked fire with one notification, then resume on the owner's socket", async () => {
    seedMailbox();
    const f = fixture();
    const firstFire = await saveScheduled();
    const rule = createRule(
      db,
      { workflow: "weekly-mail-clean", step: "archive" },
      { now: Date.now() - 1000 },
    );

    // ---- the scheduled fire: no prompt, every thread archived under the rule id ------------------
    f.clock.now = firstFire + MINUTE;
    const first = await f.scheduler.tick();
    expect(first).toEqual([{ workflow: "weekly-mail-clean", kind: "ran", status: "done" }]);
    expect(f.consents).toHaveLength(0);
    expect(f.notes).toHaveLength(0);
    expect(archives(f).sort((a, b) => a.localeCompare(b))).toEqual(ARCHIVED);
    for (const id of UNTOUCHED) expect(archives(f)).not.toContain(id);

    const audit = db
      .query(
        `SELECT hitl_status, action_json FROM audit_log WHERE action_type = 'gmail.thread.archive' ORDER BY id`,
      )
      .all() as Array<{ hitl_status: string; action_json: string }>;
    expect(audit).toHaveLength(ARCHIVED.length);
    expect(audit.map((r) => r.hitl_status)).toEqual(ARCHIVED.map(() => "standing_approved"));
    const fireIds = audit.map((r) => {
      const json = JSON.parse(r.action_json) as {
        standingRule: { ruleId: string; fireId: string };
        action: { provenance: { trigger: string } };
      };
      expect(json.standingRule.ruleId).toBe(rule.id);
      expect(json.action.provenance.trigger).toBe("schedule");
      return json.standingRule.fireId;
    });
    expect(new Set(fireIds).size).toBe(ARCHIVED.length);

    const egress = db
      .query(
        `SELECT hitl_status, payload_summary FROM egress_ledger
         WHERE destination = 'gmail' AND hitl_status = 'standing_approved' ORDER BY id`,
      )
      .all() as Array<{ hitl_status: string; payload_summary: string }>;
    expect(egress).toHaveLength(ARCHIVED.length);
    for (const row of egress) {
      expect(row.payload_summary).toContain(rule.id);
      expect(fireIds.some((id) => row.payload_summary.includes(id))).toBe(true);
    }
    expect(
      (
        db.query("SELECT actions_used FROM standing_rule WHERE id = ?").get(rule.id) as {
          actions_used: number;
        }
      ).actions_used,
    ).toBe(ARCHIVED.length);
    expect(db.query("SELECT status, trigger FROM workflow_run ORDER BY started_at").all()).toEqual([
      { status: "done", trigger: "schedule" },
    ]);

    // ---- revoke the rule: the next fire blocks, notifies once, dispatches no write ----------------
    expect(revokeRule(db, rule.id, Date.now())).toBe(true);
    const archivesBefore = archives(f).length;
    f.clock.now += DAY;
    const second = await f.scheduler.tick();
    expect(second).toEqual([
      { workflow: "weekly-mail-clean", kind: "ran", status: "blocked_on_approval" },
    ]);
    expect(archives(f)).toHaveLength(archivesBefore);
    expect(f.consents).toHaveLength(0);
    expect(f.notes).toHaveLength(1);
    const blocked = db
      .query("SELECT id, blocked_step FROM workflow_run WHERE status = 'blocked_on_approval'")
      .get() as { id: string; blocked_step: number };
    expect(blocked.blocked_step).toBe(1);
    expect(f.notes[0]).toContain("Workflow weekly-mail-clean is waiting for you: step archive");
    expect(f.notes[0]).toContain(`nimbus workflow resume ${blocked.id}`);

    // A later fire while it waits is skipped: no new run, no second notification.
    f.clock.now += DAY;
    const third = await f.scheduler.tick();
    expect(third).toEqual([
      {
        workflow: "weekly-mail-clean",
        kind: "skipped",
        reason: `skipped: waiting for approval (${blocked.id})`,
      },
    ]);
    expect(f.notes).toHaveLength(1);

    // ---- resume on the owner's socket: a normal prompt, and on approval the write dispatches -----
    const resumed = (await dispatchWorkflowResumeRpc(f.resumeCtx, "owner-cli", {} as never, {
      runId: blocked.id,
    })) as { status: string; resumedFrom: string };
    expect(resumed.status).toBe("done");
    expect(resumed.resumedFrom).toBe(blocked.id);
    expect(f.consents).toHaveLength(ARCHIVED.length);
    expect(archives(f)).toHaveLength(archivesBefore + ARCHIVED.length);
    expect(
      (
        db.query("SELECT status FROM workflow_run WHERE id = ?").get(blocked.id) as {
          status: string;
        }
      ).status,
    ).toBe("abandoned");
  });

  test("with no rule at all, the very first scheduled fire blocks and archives nothing", async () => {
    seedMailbox();
    const f = fixture();
    const firstFire = await saveScheduled();
    f.clock.now = firstFire + MINUTE;
    const out = await f.scheduler.tick();
    expect(out).toEqual([
      { workflow: "weekly-mail-clean", kind: "ran", status: "blocked_on_approval" },
    ]);
    expect(archives(f)).toEqual([]);
    expect(f.consents).toHaveLength(0);
    expect(f.notes).toHaveLength(1);
  });
});
