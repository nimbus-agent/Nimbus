// Phase 10 SA3: `standing.*` through the real dispatcher, a real consent coordinator and a real
// local index (the gate-only owner executor around THIS connection's consent channel).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ARCHIVE_STEPS,
  seedWorkflow,
} from "../../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { ensureFullSqlite } from "../../platform/sqlite-runtime.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ClientKind } from "./client-kind.ts";
import { phase4RpcSkipped, type ServerCtx } from "./context.ts";
import { tryDispatchStandingRpc } from "./dispatchers.ts";
import { RpcMethodError } from "./rpc-error.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  dbs.length = 0;
});

type Harness = {
  readonly ctx: ServerCtx;
  readonly db: Database;
  readonly prompts: string[];
};

function harness(opts: {
  readonly kind?: ClientKind;
  readonly policy?: "on" | "off" | "absent";
  readonly answerSource?: "human" | "auto" | "script";
  readonly approve?: boolean;
  readonly noIndex?: boolean;
}): Harness {
  ensureFullSqlite();
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 88);
  dbs.push(db);
  seedWorkflow(db, ARCHIVE_STEPS);
  const prompts: string[] = [];
  let coordinator: ConsentCoordinatorImpl;
  coordinator = new ConsentCoordinatorImpl(() => (n) => {
    const p = n.params as Record<string, unknown>;
    prompts.push(String(p["prompt"]));
    queueMicrotask(() =>
      coordinator.handleRespond("c1", {
        requestId: String(p["requestId"]),
        approved: opts.approve ?? true,
        answerSource: opts.answerSource ?? "human",
      }),
    );
  });
  const localIndex = new LocalIndex(db);
  const policy = opts.policy ?? "on";
  const ctx: ServerCtx = {
    options: {
      listenPath: "",
      vault: createMockVault(),
      version: "test",
      ...(opts.noIndex === true ? {} : { localIndex }),
      ...(policy === "absent"
        ? {}
        : {
            enforcedPolicy: () =>
              ({
                capabilitiesDisabled: new Set(policy === "off" ? ["standing_approvals"] : []),
                chatops: [],
              }) as never,
          }),
    },
    consentImpl: coordinator,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => opts.kind ?? "cli",
  };
  return { ctx, db, prompts };
}

const CREATE = { workflow: "weekly-mail-clean", step: "archive" };

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof RpcMethodError ? (e.rpcData?.["code"] as string) : String(e);
  }
}

describe("tryDispatchStandingRpc", () => {
  test("another namespace, or no local index, is skipped", async () => {
    expect(await tryDispatchStandingRpc(harness({}).ctx, "captures.list", {}, "c1")).toBe(
      phase4RpcSkipped,
    );
    expect(
      await tryDispatchStandingRpc(harness({ noIndex: true }).ctx, "standing.list", {}, "c1"),
    ).toBe(phase4RpcSkipped);
    expect(await tryDispatchStandingRpc(harness({}).ctx, "standing.nope", {}, "c1")).toBe(
      phase4RpcSkipped,
    );
  });

  test("create on a cli connection with a human approval stores the rule and shows the rule text", async () => {
    const h = harness({});
    const out = (await tryDispatchStandingRpc(h.ctx, "standing.create", CREATE, "c1")) as {
      rule: { id: string; state: string };
    };
    expect(out.rule.state).toBe("live");
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("Type: standing.rule.create");
    expect(h.prompts[0]).toContain("Workflow: weekly-mail-clean");
    const row = h.db.query("SELECT approval_audit_id FROM standing_rule").get() as {
      approval_audit_id: number;
    };
    const audit = h.db
      .query("SELECT action_type, hitl_status, action_json FROM audit_log WHERE id = ?")
      .get(row.approval_audit_id) as {
      action_type: string;
      hitl_status: string;
      action_json: string;
    };
    expect(audit.action_type).toBe("standing.rule.create");
    expect(audit.hitl_status).toBe("approved");
    expect(JSON.parse(audit.action_json).answerSource).toBe("human");
    // The rule text is shown to the owner, not stored in the audit row.
    expect(audit.action_json).not.toContain("each value of column");
  });

  test("the declared kind decides: anything but cli is refused before a prompt", async () => {
    for (const kind of ["ui", "unknown", "mcp"] as const) {
      const h = harness({ kind });
      expect(await code(tryDispatchStandingRpc(h.ctx, "standing.create", CREATE, "c1")), kind).toBe(
        "ERR_STANDING_CLI_ONLY",
      );
      expect(h.prompts, kind).toHaveLength(0);
    }
  });

  test("a policy lock-off, and an absent policy accessor, refuse create (fail closed)", async () => {
    for (const policy of ["off", "absent"] as const) {
      const h = harness({ policy });
      expect(
        await code(tryDispatchStandingRpc(h.ctx, "standing.create", CREATE, "c1")),
        policy,
      ).toBe("ERR_STANDING_POLICY_DISABLED");
      expect(h.prompts, policy).toHaveLength(0);
    }
  });

  test("an answer from --yes or a script is refused and recorded rejected; a decline stores nothing", async () => {
    for (const answerSource of ["auto", "script"] as const) {
      const h = harness({ answerSource });
      expect(
        await code(tryDispatchStandingRpc(h.ctx, "standing.create", CREATE, "c1")),
        answerSource,
      ).toBe("ERR_STANDING_NEEDS_HUMAN");
      const audit = h.db
        .query("SELECT hitl_status FROM audit_log WHERE action_type = 'standing.rule.create'")
        .get() as { hitl_status: string };
      expect(audit.hitl_status).toBe("rejected");
      expect(h.db.query("SELECT COUNT(*) AS n FROM standing_rule").get()).toEqual({ n: 0 });
    }
    const declined = harness({ approve: false });
    expect(await code(tryDispatchStandingRpc(declined.ctx, "standing.create", CREATE, "c1"))).toBe(
      "ERR_STANDING_DECLINED",
    );
  });

  test("pause and revoke write an audit row of their own; list shows the state", async () => {
    const h = harness({});
    const created = (await tryDispatchStandingRpc(h.ctx, "standing.create", CREATE, "c1")) as {
      rule: { id: string };
    };
    await tryDispatchStandingRpc(h.ctx, "standing.pause", { id: created.rule.id }, "c1");
    const listed = (await tryDispatchStandingRpc(h.ctx, "standing.list", {}, "c1")) as {
      rules: Array<{ state: string }>;
    };
    expect(listed.rules[0]?.state).toBe("paused");
    await tryDispatchStandingRpc(h.ctx, "standing.revoke", { id: created.rule.id }, "c1");
    const rows = h.db
      .query(
        "SELECT action_type, hitl_status FROM audit_log WHERE action_type LIKE 'standing.rule.%' ORDER BY id",
      )
      .all() as Array<{ action_type: string; hitl_status: string }>;
    expect(rows).toEqual([
      { action_type: "standing.rule.create", hitl_status: "approved" },
      { action_type: "standing.rule.pause", hitl_status: "not_required" },
      { action_type: "standing.rule.revoke", hitl_status: "not_required" },
    ]);
  });
});
