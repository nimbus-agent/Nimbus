// Phase 10 SA5: `standing.suggestions`, `standing.dismissSuggestion` and `standing.create
// { fromSuggestion }`. A suggestion only names a workflow and step; the create path is the SAME
// owner-approved path as any rule, so every refusal of it holds here too.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  freshDb,
  NOW,
  type SeededWorkflow,
  seedWorkflow,
} from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { listRules } from "../standing/standing-rule-store.ts";
import {
  dismissSuggestion,
  getSuggestion,
  listSuggestions,
  openSuggestion,
} from "../standing/standing-suggestion-store.ts";
import { checkLanMethodAllowed } from "./lan-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";
import { RpcMethodError } from "./server/rpc-error.ts";
import { dispatchStandingRpc, type OwnerApproval, type StandingRpcCtx } from "./standing-rpc.ts";

type H = {
  db: Database;
  wf: SeededWorkflow;
  ctx: StandingRpcCtx;
  asked: PlannedAction[];
  narrowings: Array<{ type: string; json: string }>;
};

function harness(over: { kind?: ClientKind; policy?: boolean; answer?: OwnerApproval } = {}): H {
  const db = freshDb();
  const wf = seedWorkflow(db);
  const asked: PlannedAction[] = [];
  const narrowings: Array<{ type: string; json: string }> = [];
  const ctx: StandingRpcCtx = {
    db,
    callerKind: over.kind ?? "cli",
    policyAllows: () => over.policy ?? true,
    askOwner: async (a) => {
      asked.push(a);
      return over.answer ?? { approved: true, auditId: 77 };
    },
    recordNarrowing: (type, json) => void narrowings.push({ type, json }),
    frozenHitl: (t) => HITL_REQUIRED.has(t),
    now: () => NOW,
  };
  return { db, wf, ctx, asked, narrowings };
}

function suggest(h: H, streak = 5, sha = h.wf.sha): string {
  const s = openSuggestion(
    h.db,
    { workflowId: h.wf.id, workflowSha256: sha, stepIndex: 1 },
    streak,
    NOW - 1000,
  );
  return s?.id ?? "";
}

type Json = {
  suggestions: Array<Record<string, unknown>>;
  rule: { id: string; maxActions: number; stepIndex: number };
  id: string;
  changed: boolean;
};

async function call(h: H, method: string, params: unknown): Promise<Json> {
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

describe("standing.suggestions", () => {
  test("lists open suggestions with the workflow, step label, tool and streak", async () => {
    const h = harness();
    const id = suggest(h, 6);
    const { suggestions } = await call(h, "standing.suggestions", {});
    expect(suggestions).toEqual([
      {
        id,
        workflowId: h.wf.id,
        workflowName: "weekly-mail-clean",
        workflowSha256: h.wf.sha,
        stepIndex: 1,
        stepLabel: "archive",
        toolId: "gmail_thread_archive",
        streak: 6,
        createdAt: NOW - 1000,
        status: "open",
      },
    ]);
  });

  test("a suggestion whose workflow changed or was deleted is not listed", async () => {
    const h = harness();
    suggest(h, 5, "f".repeat(64));
    expect((await call(h, "standing.suggestions", {})).suggestions).toEqual([]);
    const h2 = harness();
    suggest(h2);
    h2.db.run("DELETE FROM workflow WHERE id = ?", [h2.wf.id]);
    expect((await call(h2, "standing.suggestions", {})).suggestions).toEqual([]);
  });

  test("a stored workflow that no longer parses hides its suggestion; closed ones are not listed", async () => {
    const h = harness();
    const id = suggest(h);
    h.db.run("UPDATE workflow SET steps_json = '{not json' WHERE id = ?", [h.wf.id]);
    expect((await call(h, "standing.suggestions", {})).suggestions).toEqual([]);
    const h2 = harness();
    const id2 = suggest(h2);
    await call(h2, "standing.dismissSuggestion", { id: id2 });
    expect((await call(h2, "standing.suggestions", {})).suggestions).toEqual([]);
    expect(id).not.toBe("");
  });

  test("any connection kind may read them (the desktop does)", async () => {
    const h = harness({ kind: "ui" });
    suggest(h);
    expect((await call(h, "standing.suggestions", {})).suggestions).toHaveLength(1);
  });
});

describe("standing.dismissSuggestion", () => {
  test("needs no prompt, is audited as a narrowing, and works from the desktop", async () => {
    const h = harness({ kind: "ui" });
    const id = suggest(h);
    const out = await call(h, "standing.dismissSuggestion", { id });
    expect<unknown>(out).toEqual({ id, changed: true });
    expect(h.asked).toHaveLength(0);
    expect(h.narrowings).toEqual([
      { type: "standing.suggestion.dismiss", json: JSON.stringify({ suggestionId: id }) },
    ]);
    expect(getSuggestion(h.db, id)?.status).toBe("dismissed");
    // A second dismissal changes nothing and is not audited again.
    expect<unknown>(await call(h, "standing.dismissSuggestion", { id })).toEqual({
      id,
      changed: false,
    });
    expect(h.narrowings).toHaveLength(1);
  });

  test("a bad or unknown id is refused", async () => {
    const h = harness();
    expect(await code(call(h, "standing.dismissSuggestion", { id: "sr_0123456789abcdef" }))).toBe(
      "ERR_STANDING_BAD_ID",
    );
    expect(await code(call(h, "standing.dismissSuggestion", {}))).toBe("ERR_STANDING_BAD_ID");
    expect(await code(call(h, "standing.dismissSuggestion", { id: "ss_0000000000000000" }))).toBe(
      "ERR_STANDING_NOT_FOUND",
    );
  });
});

describe("standing.create { fromSuggestion }", () => {
  test("asks the owner once with the suggested-after line, creates the rule, accepts the suggestion", async () => {
    const h = harness();
    const id = suggest(h, 5);
    const { rule } = await call(h, "standing.create", { fromSuggestion: id, days: 7, max: 9 });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.type).toBe("standing.rule.create");
    const prompt = String(h.asked[0]?.payload?.["promptText"]);
    expect(prompt.split("\n")[0]).toBe("Suggested after 5 approvals in a row");
    expect(prompt).toContain("Workflow: weekly-mail-clean");
    expect(h.asked[0]?.payload?.["suggestionId"]).toBe(id);
    expect(rule.maxActions).toBe(9);
    expect(rule.stepIndex).toBe(1);
    const s = getSuggestion(h.db, id);
    expect(s?.status).toBe("accepted");
    expect(s?.ruleId).toBe(rule.id);
    expect(listRules(h.db)).toHaveLength(1);
  });

  test("a suggestion closed while the owner was asked yields no rule (two accepts make ONE rule)", async () => {
    const h = harness();
    const id = suggest(h, 5);
    // The owner is still being asked when another request dismisses the suggestion.
    const ask = h.ctx.askOwner;
    h.ctx = {
      ...h.ctx,
      askOwner: async (a) => {
        dismissSuggestion(h.db, id, NOW);
        return ask(a);
      },
    };
    expect(await code(call(h, "standing.create", { fromSuggestion: id }))).toBe(
      "ERR_SUGGESTION_NOT_OPEN",
    );
    expect(listRules(h.db)).toHaveLength(0);
    expect(getSuggestion(h.db, id)?.status).toBe("dismissed");

    // Two concurrent accepts of one suggestion: both are asked, exactly one rule is stored.
    const h2 = harness();
    const id2 = suggest(h2, 5);
    const outcomes = await Promise.all([
      code(call(h2, "standing.create", { fromSuggestion: id2 })),
      code(call(h2, "standing.create", { fromSuggestion: id2 })),
    ]);
    expect(outcomes.filter((o) => o === undefined)).toHaveLength(1);
    expect(outcomes).toContain("ERR_SUGGESTION_NOT_OPEN");
    expect(listRules(h2.db)).toHaveLength(1);
  });

  test("a plain create has no suggested-after line", async () => {
    const h = harness();
    await call(h, "standing.create", { workflow: "weekly-mail-clean", step: "archive" });
    expect(String(h.asked[0]?.payload?.["promptText"])).not.toContain("Suggested after");
    expect(h.asked[0]?.payload?.["suggestionId"]).toBeUndefined();
  });

  test("a declined prompt leaves the suggestion open and creates no rule", async () => {
    const h = harness({ answer: { approved: false, reason: "declined" } });
    const id = suggest(h);
    expect(await code(call(h, "standing.create", { fromSuggestion: id }))).toBe(
      "ERR_STANDING_DECLINED",
    );
    expect(getSuggestion(h.db, id)?.status).toBe("open");
    expect(listRules(h.db)).toHaveLength(0);
  });

  test("a --yes or scripted answer (not human) creates nothing and leaves it open", async () => {
    const h = harness({ answer: { approved: false, reason: "not_human" } });
    const id = suggest(h);
    expect(await code(call(h, "standing.create", { fromSuggestion: id }))).toBe(
      "ERR_STANDING_NEEDS_HUMAN",
    );
    expect(getSuggestion(h.db, id)?.status).toBe("open");
  });

  test("only the CLI, and only while policy allows, exactly as for any rule", async () => {
    const ui = harness({ kind: "ui" });
    const id = suggest(ui);
    expect(await code(call(ui, "standing.create", { fromSuggestion: id }))).toBe(
      "ERR_STANDING_CLI_ONLY",
    );
    const off = harness({ policy: false });
    const id2 = suggest(off);
    expect(await code(call(off, "standing.create", { fromSuggestion: id2 }))).toBe(
      "ERR_STANDING_POLICY_DISABLED",
    );
    expect(ui.asked.length + off.asked.length).toBe(0);
  });

  test("a changed workflow refuses with ERR_SUGGESTION_STALE and marks the suggestion stale", async () => {
    const h = harness();
    const id = suggest(h);
    seedWorkflow(
      h.db,
      [
        ...h.wf.steps.slice(0, 1),
        {
          kind: "write",
          label: "archive",
          tool: "gmail_thread_archive",
          input: { threadId: { const: "x" } },
        },
      ],
      "weekly-mail-clean",
    );
    expect(await code(call(h, "standing.create", { fromSuggestion: id }))).toBe(
      "ERR_SUGGESTION_STALE",
    );
    expect(getSuggestion(h.db, id)?.status).toBe("stale");
    expect(h.asked).toHaveLength(0);
    // A deleted workflow is stale too.
    const h2 = harness();
    const id2 = suggest(h2);
    h2.db.run("DELETE FROM workflow WHERE id = ?", [h2.wf.id]);
    expect(await code(call(h2, "standing.create", { fromSuggestion: id2 }))).toBe(
      "ERR_SUGGESTION_STALE",
    );
  });

  test("fromSuggestion with workflow or step is refused; so are a bad, unknown or closed id", async () => {
    const h = harness();
    const id = suggest(h);
    expect(await code(call(h, "standing.create", { fromSuggestion: id, workflow: "x" }))).toBe(
      "ERR_STANDING_REFUSED",
    );
    expect(await code(call(h, "standing.create", { fromSuggestion: id, step: 2 }))).toBe(
      "ERR_STANDING_REFUSED",
    );
    expect(await code(call(h, "standing.create", { fromSuggestion: 5 }))).toBe(
      "ERR_STANDING_BAD_ID",
    );
    expect(await code(call(h, "standing.create", { fromSuggestion: "ss_0000000000000000" }))).toBe(
      "ERR_STANDING_NOT_FOUND",
    );
    await call(h, "standing.dismissSuggestion", { id });
    expect(await code(call(h, "standing.create", { fromSuggestion: id }))).toBe(
      "ERR_STANDING_REFUSED",
    );
    expect(h.asked).toHaveLength(0);
    expect(listSuggestions(h.db, "dismissed")).toHaveLength(1);
  });

  test("the caller's limits are still enforced on the suggested rule", async () => {
    const h = harness();
    const id = suggest(h);
    expect(await code(call(h, "standing.create", { fromSuggestion: id, days: 400 }))).toBe(
      "ERR_STANDING_REFUSED",
    );
    expect(getSuggestion(h.db, id)?.status).toBe("open");
  });
});

describe("the LAN", () => {
  test("a LAN peer, even with write permission, cannot reach any suggestion method", () => {
    const peer = { peerId: "p1", writeAllowed: true };
    for (const m of [
      "standing.suggestions",
      "standing.dismissSuggestion",
      "standing.create",
      "standing.list",
    ]) {
      expect(() => checkLanMethodAllowed(m, peer), m).toThrow(/not callable over LAN/);
    }
  });
});
