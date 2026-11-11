// Phase 10 SA5: the runner calls the approval-learning pass after each write step, only when it is
// given a `learning` config and the run is an owner-started, real run; a throw never changes a run.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appendAuditEntry } from "../db/audit-chain.ts";
import type { ActionResult, PlannedAction } from "../engine/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { LearningConfig } from "../standing/approval-learning.ts";
import { listSuggestions } from "../standing/standing-suggestion-store.ts";
import { type RunWorkflowExecutionParams, runWorkflowExecution } from "./workflow-runner.ts";
import { upsertWorkflowByName } from "./workflow-store.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
     VALUES ('gmail:m1', 'gmail', 'email', 'm1', 't', ?, ?, ?)`,
  ).run(Date.now() - 90 * 86_400_000, JSON.stringify({ threadId: "t-a", labelIds: ["INBOX"] }), 1);
});
afterEach(() => db.close());

const STEPS = [
  {
    kind: "query",
    label: "old-read",
    query: {
      service: "gmail",
      type: "email",
      where: [{ olderThanDays: 60 }],
      select: "metadata.threadId",
      distinct: true,
      limit: 50,
    },
  },
  {
    kind: "write",
    label: "archive",
    tool: "gmail_thread_archive",
    input: { threadId: { from: "old-read", column: "metadata.threadId" } },
  },
];

/** A write executor that records what the real gate would: one audit row per action, by hand. */
function handApprover(answerSource: string): {
  execute(a: PlannedAction): Promise<ActionResult>;
} {
  return {
    execute: async (a) => {
      appendAuditEntry(db, {
        actionType: a.type,
        hitlStatus: "approved",
        actionJson: JSON.stringify({ action: a, answerSource }),
        timestamp: Date.now(),
      });
      return { status: "ok", result: {} };
    },
  };
}

function params(over: Partial<RunWorkflowExecutionParams> = {}): RunWorkflowExecutionParams {
  return {
    db,
    workflowName: "archive-old",
    triggeredBy: "cli",
    trigger: "owner_cli",
    dryRun: false,
    stream: false,
    sendChunk: () => {},
    writeExecutor: handApprover("human"),
    ...over,
  };
}

const LEARN: LearningConfig = { enabled: () => true, suggestAfter: () => 3 };

describe("the runner and approval learning", () => {
  beforeEach(() => {
    upsertWorkflowByName(db, "archive-old", null, JSON.stringify(STEPS), Date.now());
  });

  test("three hand-approved owner runs make one suggestion", async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await runWorkflowExecution(params({ learning: LEARN }));
      expect(r.status).toBe("done");
    }
    const open = listSuggestions(db, "open");
    expect(open).toHaveLength(1);
    expect(open[0]?.streak).toBe(3);
    expect(open[0]?.stepIndex).toBe(1);
  });

  test("no learning config means nothing is learned", async () => {
    for (let i = 0; i < 3; i += 1) await runWorkflowExecution(params());
    expect(listSuggestions(db)).toHaveLength(0);
    expect(db.query("SELECT count(*) AS n FROM standing_streak").get()).toEqual({ n: 0 });
  });

  test("a dry run, a scheduled run and a run answered by --yes learn nothing counted", async () => {
    await runWorkflowExecution(params({ learning: LEARN, dryRun: true }));
    await runWorkflowExecution(params({ learning: LEARN, trigger: "schedule" }));
    await runWorkflowExecution(params({ learning: LEARN, writeExecutor: handApprover("auto") }));
    expect(db.query("SELECT count(*) AS n FROM standing_streak").get()).toEqual({ n: 0 });
  });

  test("a learning pass that throws is logged and the run still finishes done", async () => {
    const lines: string[] = [];
    const r = await runWorkflowExecution(
      params({
        learning: {
          enabled: () => {
            throw new Error("policy exploded");
          },
          suggestAfter: () => 3,
          log: (_f, m) => lines.push(m),
        },
      }),
    );
    expect(r.status).toBe("done");
    expect(lines).toEqual(["approval learning failed; the run is unaffected"]);
  });

  test("a failing write step is still learned from (any status)", async () => {
    const failing = {
      execute: async (a: PlannedAction): Promise<ActionResult> => {
        appendAuditEntry(db, {
          actionType: a.type,
          hitlStatus: "rejected",
          actionJson: JSON.stringify({ action: a, answerSource: "human" }),
          timestamp: Date.now(),
        });
        return { status: "error", error: "declined" } as unknown as ActionResult;
      },
    };
    await runWorkflowExecution(params({ learning: LEARN, writeExecutor: failing }));
    const row = db.query("SELECT streak FROM standing_streak").get() as { streak: number };
    expect(row.streak).toBe(0);
  });
});
