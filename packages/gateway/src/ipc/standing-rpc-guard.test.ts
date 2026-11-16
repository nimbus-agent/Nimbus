// Workflow conditionals and standing rules (I55): a rule may cover a guarded write ONLY when every
// comparison of the guard needs presence (is false at a count of zero). Rule creation (including
// `create { fromSuggestion }`), rule resume, the rule text and the learner all use that one
// definition (`guardRequiresPresence`). An empty result is also what a failed sync, a lapsed
// credential and an empty index produce, so a guard that can hold at zero must never be covered.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  ARCHIVE_STEPS,
  freshDb,
  NOW,
  seedWorkflow,
} from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { deriveRule, GUARD_ABSENCE_REASON } from "../standing/standing-rule-derive.ts";
import { insertRule, listRules } from "../standing/standing-rule-store.ts";
import { StandingRuleError, WORKFLOW_EDITED_LINE } from "../standing/standing-rule-text.ts";
import { openSuggestion } from "../standing/standing-suggestion-store.ts";
import { RpcMethodError } from "./server/rpc-error.ts";
import { dispatchStandingRpc, type StandingRpcCtx } from "./standing-rpc.ts";

const QUERY = ARCHIVE_STEPS[0];
const WRITE = ARCHIVE_STEPS[1];
const guarded = (when: unknown) => [QUERY, { ...WRITE, when }];
const frozen = (t: string): boolean => HITL_REQUIRED.has(t);
const REQ = { workflow: "weekly-mail-clean", step: "archive" } as const;

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof StandingRuleError) return e.message;
    throw e;
  }
  return "";
}

describe("deriveRule and a guard (I55 presence rule)", () => {
  const derive = (db: Database) => deriveRule(db, REQ, frozen, NOW);
  const OLD = "old-read-mail";

  test("refuses, with the fixed message, every guard that can hold at zero", () => {
    const cases: unknown[] = [
      { count: OLD, eq: 0 },
      { count: OLD, lt: 3 },
      { count: OLD, lte: 2 },
      { count: OLD, ne: 2 },
      { count: OLD, lte: 0 },
      // The review's example: one presence comparison cannot rescue an absence one.
      [
        { count: OLD, gte: 3 },
        { count: OLD, eq: 0 },
      ],
      [
        { count: OLD, eq: 0 },
        { count: OLD, gte: 3 },
      ],
    ];
    for (const when of cases) {
      const db = freshDb();
      seedWorkflow(db, guarded(when));
      expect(refusal(() => derive(db))).toBe(GUARD_ABSENCE_REASON);
    }
  });

  test("accepts guards in which every comparison needs presence, and an unguarded step", () => {
    const cases: unknown[] = [
      { count: OLD, gt: 0 },
      { count: OLD, gte: 3 },
      { count: OLD, eq: 2 },
      { count: OLD, ne: 0 },
      [
        { count: OLD, gte: 3 },
        { count: OLD, gt: 0 },
      ],
    ];
    for (const when of cases) {
      const db = freshDb();
      seedWorkflow(db, guarded(when));
      expect(derive(db).rule.stepIndex).toBe(1);
    }
    const db = freshDb();
    seedWorkflow(db);
    expect(derive(db).text.guardLines).toBeUndefined();
  });

  test("the rule text carries the guard line; the stored hash covers the guard", () => {
    const db = freshDb();
    seedWorkflow(db, guarded({ count: OLD, gt: 0 }));
    const d = derive(db);
    expect(d.text.guardLines).toEqual([
      "Runs only when: query step 1 (old-read-mail) selects more than 0",
    ]);
    const other = freshDb();
    seedWorkflow(other, guarded({ count: OLD, gt: 1 }));
    expect(derive(other).rule.workflowSha256).not.toBe(d.rule.workflowSha256);
  });
});

function harness(steps: readonly unknown[]) {
  const db = freshDb();
  const wf = seedWorkflow(db, steps);
  const asked: PlannedAction[] = [];
  const ctx: StandingRpcCtx = {
    db,
    callerKind: "cli",
    policyAllows: () => true,
    askOwner: async (a) => {
      asked.push(a);
      return { approved: true, auditId: 9 };
    },
    recordNarrowing: () => {},
    frozenHitl: frozen,
    now: () => NOW,
  };
  return { db, wf, ctx, asked };
}
const call = async (ctx: StandingRpcCtx, method: string, params: unknown) => {
  const out = await dispatchStandingRpc(method, params, ctx);
  if (out.kind !== "hit") throw new Error("not routed");
  return out.value as { rule: { id: string } };
};
async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcMethodError) return e.message;
    throw e;
  }
  return "";
}
const promptOf = (a: PlannedAction | undefined): string => String(a?.payload?.["promptText"]);

describe("standing.create over a guarded step", () => {
  test("an absence guard is refused before any prompt; a presence guard shows its line to the owner", async () => {
    const bad = harness(guarded({ count: "old-read-mail", eq: 0 }));
    expect(await message(call(bad.ctx, "standing.create", REQ))).toContain(GUARD_ABSENCE_REASON);
    expect(bad.asked).toHaveLength(0);
    expect(listRules(bad.db)).toHaveLength(0);

    const ok = harness(guarded({ count: "old-read-mail", gt: 0 }));
    await call(ok.ctx, "standing.create", REQ);
    expect(promptOf(ok.asked[0])).toContain(
      "Runs only when: query step 1 (old-read-mail) selects more than 0",
    );
  });

  test("create { fromSuggestion } refuses the same way (a suggestion never widens)", async () => {
    const h = harness(guarded({ count: "old-read-mail", lte: 5 }));
    const s = openSuggestion(
      h.db,
      { workflowId: h.wf.id, workflowSha256: h.wf.sha, stepIndex: 1 },
      5,
      NOW - 1000,
    );
    expect(await message(call(h.ctx, "standing.create", { fromSuggestion: s?.id }))).toContain(
      GUARD_ABSENCE_REASON,
    );
    expect(h.asked).toHaveLength(0);
    expect(listRules(h.db)).toHaveLength(0);
  });
});

describe("standing.resume over a guarded step", () => {
  async function pausedRule(h: ReturnType<typeof harness>): Promise<string> {
    const { rule } = await call(h.ctx, "standing.create", REQ);
    await call(h.ctx, "standing.pause", { id: rule.id });
    h.asked.length = 0;
    return rule.id;
  }

  test("a matching workflow renders the guard in the resume prompt", async () => {
    const h = harness(guarded({ count: "old-read-mail", gte: 3 }));
    const id = await pausedRule(h);
    await call(h.ctx, "standing.resume", { id });
    expect(promptOf(h.asked[0])).toContain(
      "Runs only when: query step 1 (old-read-mail) selects at least 3",
    );
    expect(promptOf(h.asked[0])).not.toContain(WORKFLOW_EDITED_LINE);
  });

  test("a workflow edited after the rule was made shows the edited line and no guard", async () => {
    const h = harness(guarded({ count: "old-read-mail", gte: 3 }));
    const id = await pausedRule(h);
    seedWorkflow(h.db, guarded({ count: "old-read-mail", gte: 4 }));
    await call(h.ctx, "standing.resume", { id });
    expect(promptOf(h.asked[0])).toContain(WORKFLOW_EDITED_LINE);
    expect(promptOf(h.asked[0])).not.toContain("Runs only when");
  });

  test("defence in depth: a stored rule over an absence guard whose hash matches is refused at resume", async () => {
    // Such a rule cannot be made through the owner's path (creation refuses it); it is inserted
    // directly here, as a store changed outside the approval path would be.
    const h = harness(guarded({ count: "old-read-mail", eq: 0 }));
    const rule = insertRule(h.db, {
      createdAt: NOW - 1000,
      workflowId: h.wf.id,
      workflowSha256: h.wf.sha,
      stepIndex: 1,
      actionType: "gmail.thread.archive",
      toolId: "gmail_thread_archive",
      scope: { threadId: { query: 0, column: "metadata.threadId" } },
      window: undefined,
      expiresAt: NOW + 86_400_000,
      maxActions: 5,
      approvalAuditId: 1,
    });
    await call(h.ctx, "standing.pause", { id: rule.id });
    h.asked.length = 0;
    expect(await message(call(h.ctx, "standing.resume", { id: rule.id }))).toContain(
      GUARD_ABSENCE_REASON,
    );
    expect(h.asked).toHaveLength(0);
  });
});
