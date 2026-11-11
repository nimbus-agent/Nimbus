import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  freshDb,
  NOW,
  seedWorkflow,
} from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import type { AnswerSource, ConsentChannel, PlannedAction } from "../engine/types.ts";
import { claimFire, getRule, listRules } from "../standing/standing-rule-store.ts";
import type { ClientKind } from "./server/client-kind.ts";
import { RpcMethodError } from "./server/rpc-error.ts";
import {
  createStandingOwnerAsk,
  dispatchStandingRpc,
  type OwnerApproval,
  type StandingRpcCtx,
} from "./standing-rpc.ts";

type Harness = {
  readonly db: Database;
  readonly ctx: StandingRpcCtx;
  readonly asked: PlannedAction[];
  readonly narrowings: Array<{ type: string; json: string }>;
};

function harness(
  over: { kind?: ClientKind; policy?: boolean; answer?: OwnerApproval } = {},
): Harness {
  const db = freshDb();
  seedWorkflow(db);
  const asked: PlannedAction[] = [];
  const narrowings: Array<{ type: string; json: string }> = [];
  const ctx: StandingRpcCtx = {
    db,
    callerKind: over.kind ?? "cli",
    policyAllows: () => over.policy ?? true,
    askOwner: async (action) => {
      asked.push(action);
      return over.answer ?? { approved: true, auditId: 41 };
    },
    recordNarrowing: (type, json) => void narrowings.push({ type, json }),
    frozenHitl: (t) => HITL_REQUIRED.has(t),
    now: () => NOW,
  };
  return { db, ctx, asked, narrowings };
}

type RuleView = {
  id: string;
  state: string;
  changed?: boolean;
  workflowName: string | null;
  workflowSha256: string;
  stepIndex: number;
  toolId: string;
  scope: unknown;
  window: { label: string } | null;
  expiresAt: number;
  maxActions: number;
  actionsUsed: number;
  lastFiredAt: number | null;
  pausedAt: number | null;
  revokedAt: number | null;
};
type FireView = { fireId: string; audit: { id: number } | null };
type Json = { rule: RuleView; rules: RuleView[]; fires: FireView[] };

async function call(h: Harness, method: string, params: unknown): Promise<Json> {
  const out = await dispatchStandingRpc(method, params, h.ctx);
  if (out.kind !== "hit") throw new Error(`${method} was not routed`);
  return out.value as Json;
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof RpcMethodError ? (e.rpcData?.["code"] as string) : String(e);
  }
}

function promptOf(action: PlannedAction | undefined): string {
  return String(action?.payload?.["promptText"]);
}

const REQUEST = { workflow: "weekly-mail-clean", step: "archive" };

describe("standing.create", () => {
  test("derives the rule from the stored workflow, asks the owner once, stores the audit id", async () => {
    const h = harness();
    const { rule } = await call(h, "standing.create", REQUEST);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.type).toBe("standing.rule.create");
    const prompt = promptOf(h.asked[0]);
    expect(prompt).toContain("Workflow: weekly-mail-clean");
    expect(prompt).toContain("gmail_thread_archive");
    expect(prompt).toContain("Ceiling: 100 actions");
    expect(prompt).toContain("30 days from now");
    const stored = getRule(h.db, rule.id);
    expect(stored?.approvalAuditId).toBe(41);
    expect(stored?.toolId).toBe("gmail_thread_archive");
    expect(stored?.maxActions).toBe(100);
    expect(stored?.expiresAt).toBe(NOW + 30 * 86_400_000);
    expect(rule.state).toBe("live");
  });

  test("the caller's days, max and window are honoured within the limits", async () => {
    const h = harness();
    const window = { days: [1, 2], from: "06:00", to: "10:00", tz: "UTC" };
    const { rule } = await call(h, "standing.create", { ...REQUEST, days: 7, max: 5, window });
    expect(rule.maxActions).toBe(5);
    expect(rule.expiresAt).toBe(NOW + 7 * 86_400_000);
    expect(rule.window?.label).toBe("Mon-Tue 06:00-10:00 UTC");
  });

  test("a scope, hash, tool or type from the caller is never read", async () => {
    const h = harness();
    const { rule } = await call(h, "standing.create", {
      ...REQUEST,
      scope: { threadId: { const: "x" } },
      workflowSha256: "f".repeat(64),
      toolId: "gmail_message_send",
      actionType: "gmail.message.send",
    });
    expect(rule.toolId).toBe("gmail_thread_archive");
    expect(rule.scope).toEqual({ threadId: { query: 0, column: "metadata.threadId" } });
    expect(rule.workflowSha256).not.toBe("f".repeat(64));
  });

  test("a connection that did not declare the CLI is refused before anything is asked", async () => {
    for (const kind of ["ui", "unknown", "mcp", "http", "chatops", "fleet", "push"] as const) {
      const h = harness({ kind });
      expect(await code(call(h, "standing.create", REQUEST)), kind).toBe("ERR_STANDING_CLI_ONLY");
      expect(h.asked, kind).toHaveLength(0);
      expect(listRules(h.db), kind).toHaveLength(0);
    }
  });

  test("org policy that locks standing approvals off refuses create and asks nothing", async () => {
    const h = harness({ policy: false });
    expect(await code(call(h, "standing.create", REQUEST))).toBe("ERR_STANDING_POLICY_DISABLED");
    expect(h.asked).toHaveLength(0);
  });

  test("a decline stores nothing; a non-human answer says so", async () => {
    const declined = harness({ answer: { approved: false, reason: "declined" } });
    expect(await code(call(declined, "standing.create", REQUEST))).toBe("ERR_STANDING_DECLINED");
    expect(listRules(declined.db)).toHaveLength(0);
    const notHuman = harness({ answer: { approved: false, reason: "not_human" } });
    expect(await code(call(notHuman, "standing.create", REQUEST))).toBe("ERR_STANDING_NEEDS_HUMAN");
    expect(listRules(notHuman.db)).toHaveLength(0);
  });

  test("bad requests are refused before the prompt", async () => {
    const h = harness();
    const bad: unknown[] = [
      {},
      { workflow: "", step: "archive" },
      { workflow: "weekly-mail-clean" },
      { workflow: "weekly-mail-clean", step: {} },
      { workflow: "no-such-workflow", step: "archive" },
      { workflow: "weekly-mail-clean", step: "no-such-step" },
      { workflow: "weekly-mail-clean", step: "old-read-mail" },
      { ...REQUEST, days: 91 },
      { ...REQUEST, max: 501 },
      { ...REQUEST, window: { days: [1], from: "10:00", to: "06:00", tz: "UTC" } },
    ];
    for (const params of bad) {
      expect(await code(call(h, "standing.create", params)), JSON.stringify(params)).toBe(
        "ERR_STANDING_REFUSED",
      );
    }
    expect(h.asked).toHaveLength(0);
  });

  test("a step number names the step as well as its label", async () => {
    const h = harness();
    const { rule } = await call(h, "standing.create", { ...REQUEST, step: 2 });
    expect(rule.stepIndex).toBe(1);
  });

  test("an ineligible write step cannot have a rule (a wave 4 write, a never-offered send)", async () => {
    const h = harness();
    h.db.run("UPDATE workflow SET steps_json = ? WHERE name = ?", [
      JSON.stringify([{ kind: "write", label: "send", tool: "gmail_message_send", input: {} }]),
      "weekly-mail-clean",
    ]);
    expect(
      await code(call(h, "standing.create", { workflow: "weekly-mail-clean", step: "send" })),
    ).toBe("ERR_STANDING_REFUSED");
    expect(h.asked).toHaveLength(0);
  });
});

describe("standing.pause, resume and revoke", () => {
  async function created(h: Harness): Promise<string> {
    return (await call(h, "standing.create", REQUEST)).rule.id as string;
  }

  test("pause and revoke need no prompt, are audited, and show in the view", async () => {
    const h = harness();
    const id = await created(h);
    h.asked.length = 0;
    const paused = await call(h, "standing.pause", { id });
    expect(paused.rule.state).toBe("paused");
    expect(paused.rule.changed).toBe(true);
    const again = await call(h, "standing.pause", { id });
    expect(again.rule.changed).toBe(false);
    const revoked = await call(h, "standing.revoke", { id });
    expect(revoked.rule.state).toBe("revoked");
    expect(h.asked).toHaveLength(0);
    expect(h.narrowings.map((n) => n.type)).toEqual([
      "standing.rule.pause",
      "standing.rule.revoke",
    ]);
    expect(JSON.parse(h.narrowings[0]?.json ?? "{}")).toEqual({ ruleId: id });
  });

  test("pause and revoke work from any connection kind, including the desktop's", async () => {
    const h = harness();
    const id = await created(h);
    const ui = { ...h, ctx: { ...h.ctx, callerKind: "ui" as const } };
    expect((await call(ui, "standing.pause", { id })).rule.state).toBe("paused");
    expect((await call(ui, "standing.revoke", { id })).rule.state).toBe("revoked");
  });

  test("resume asks the owner (CLI only, policy on), and a revoked rule never resumes", async () => {
    const h = harness();
    const id = await created(h);
    await call(h, "standing.pause", { id });
    h.asked.length = 0;
    const resumed = await call(h, "standing.resume", { id });
    expect(resumed.rule.state).toBe("live");
    expect(h.asked.map((a) => a.type)).toEqual(["standing.rule.resume"]);
    const text = promptOf(h.asked[0]);
    expect(text).toContain("Resume this standing rule.");
    expect(text).toContain("(0 used)");
    await call(h, "standing.revoke", { id });
    expect(await code(call(h, "standing.resume", { id }))).toBe("ERR_STANDING_REVOKED");
  });

  test("resume of a rule that is not paused is refused before the prompt", async () => {
    const h = harness();
    const id = await created(h);
    h.asked.length = 0;
    expect(await code(call(h, "standing.resume", { id }))).toBe("ERR_STANDING_NOT_PAUSED");
    expect(h.asked).toHaveLength(0);
  });

  test("resume is CLI-only, policy-gated, human-only and declinable", async () => {
    const h = harness();
    const id = await created(h);
    await call(h, "standing.pause", { id });
    const ui = { ...h, ctx: { ...h.ctx, callerKind: "ui" as const } };
    expect(await code(call(ui, "standing.resume", { id }))).toBe("ERR_STANDING_CLI_ONLY");
    const off = { ...h, ctx: { ...h.ctx, policyAllows: () => false } };
    expect(await code(call(off, "standing.resume", { id }))).toBe("ERR_STANDING_POLICY_DISABLED");
    const no = {
      ...h,
      ctx: { ...h.ctx, askOwner: async () => ({ approved: false, reason: "not_human" }) as const },
    };
    expect(await code(call(no, "standing.resume", { id }))).toBe("ERR_STANDING_NEEDS_HUMAN");
    expect(getRule(h.db, id)?.pausedAt).toBeDefined();
  });

  test("bad ids and unknown rules are refused", async () => {
    const h = harness();
    expect(await code(call(h, "standing.show", { id: "nope" }))).toBe("ERR_STANDING_BAD_ID");
    expect(await code(call(h, "standing.show", {}))).toBe("ERR_STANDING_BAD_ID");
    expect(await code(call(h, "standing.revoke", { id: "sr_0123456789abcdef" }))).toBe(
      "ERR_STANDING_NOT_FOUND",
    );
  });
});

describe("standing.list, show and fires", () => {
  test("list shows state, usage and the workflow's name; show returns one rule", async () => {
    const h = harness();
    const id = (await call(h, "standing.create", REQUEST)).rule.id as string;
    const list = await call(h, "standing.list", {});
    expect(list.rules).toHaveLength(1);
    expect(list.rules[0]).toMatchObject({
      id,
      state: "live",
      workflowName: "weekly-mail-clean",
      actionsUsed: 0,
      maxActions: 100,
      lastFiredAt: null,
      pausedAt: null,
      revokedAt: null,
    });
    expect((await call(h, "standing.show", { id })).rule.id).toBe(id);
  });

  test("fires join each fire to the audit row that names it, and show a fire with none as such", async () => {
    const h = harness();
    const id = (await call(h, "standing.create", REQUEST)).rule.id as string;
    const fireA = claimFire(h.db, id, NOW + 1, "gmail.thread.archive", "a".repeat(64)) as string;
    const fireB = claimFire(h.db, id, NOW + 2, "gmail.thread.archive", "a".repeat(64)) as string;
    appendAuditEntry(h.db, {
      actionType: "gmail.thread.archive",
      hitlStatus: "standing_approved",
      actionJson: JSON.stringify({ standingRule: { ruleId: id, fireId: fireA } }),
      timestamp: NOW + 1,
    });
    // A truncated row (the audit cap cuts the tail) still names its fire first.
    appendAuditEntry(h.db, {
      actionType: "gmail.thread.archive",
      hitlStatus: "approved",
      actionJson: `{"standingRule":{"ruleId":"${id}","fireId":"${fireB}"}`,
      timestamp: NOW + 2,
    });
    const { fires } = await call(h, "standing.fires", { id });
    expect(fires).toHaveLength(2);
    const a = fires.find((f) => f.fireId === fireA);
    const b = fires.find((f) => f.fireId === fireB);
    expect(a?.audit).toMatchObject({ id: expect.any(Number) });
    // Only standing_approved rows are joined: an `approved` row naming a fire is not evidence.
    expect(b?.audit).toBeNull();
    expect((await call(h, "standing.fires", {})).fires).toHaveLength(2);
    expect(await code(call(h, "standing.fires", { id: "sr_0123456789abcdef" }))).toBe(
      "ERR_STANDING_NOT_FOUND",
    );
  });
});

describe("dispatch", () => {
  test("a method outside the namespace is a miss", async () => {
    const h = harness();
    expect((await dispatchStandingRpc("standing.nope", {}, h.ctx)).kind).toBe("miss");
    expect((await dispatchStandingRpc("workflow.run", {}, h.ctx)).kind).toBe("miss");
  });
});

describe("createStandingOwnerAsk — a person must answer", () => {
  function ask(answer: { approved: boolean; answerSource: AnswerSource }) {
    const db = freshDb();
    const prompts: string[] = [];
    const consent: ConsentChannel = {
      requestApproval: async (prompt) => {
        prompts.push(prompt);
        return answer;
      },
    };
    const own = createStandingOwnerAsk({
      consent,
      db,
      audit: { recordAudit: (e) => void appendAuditEntry(db, e) },
    });
    return { own, db, prompts };
  }
  const action: PlannedAction = {
    type: "standing.rule.create",
    payload: { promptText: "Workflow: x" },
  };

  test("a human approval is honoured and returns the approval's audit row id", async () => {
    const { own, db, prompts } = ask({ approved: true, answerSource: "human" });
    const out = await own(action);
    expect(out.approved).toBe(true);
    const row = db.query("SELECT id, hitl_status, action_json FROM audit_log").get() as {
      id: number;
      hitl_status: string;
      action_json: string;
    };
    expect(out).toEqual({ approved: true, auditId: row.id });
    expect(row.hitl_status).toBe("approved");
    // The prompt is the rule text itself, with the answer's source recorded on the audit row.
    expect(prompts[0]).toContain("Workflow: x");
    expect(JSON.parse(row.action_json).answerSource).toBe("human");
  });

  test("--yes (auto), a script, an old client (unknown) and a delegate are refused", async () => {
    for (const answerSource of [
      "auto",
      "script",
      "unknown",
      "delegate",
      "remote",
      "none",
    ] as const) {
      const { own, db } = ask({ approved: true, answerSource });
      expect(await own(action), answerSource).toEqual({ approved: false, reason: "not_human" });
      const row = db.query("SELECT hitl_status FROM audit_log").get() as { hitl_status: string };
      expect(row.hitl_status, answerSource).toBe("rejected");
    }
  });

  test("a human decline is a plain decline", async () => {
    const { own } = ask({ approved: false, answerSource: "human" });
    expect(await own(action)).toEqual({ approved: false, reason: "declined" });
  });
});
