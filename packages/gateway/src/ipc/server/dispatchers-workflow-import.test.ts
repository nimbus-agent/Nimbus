// Signed workflow import (I59): `workflow.export` and `workflow.import` through the real dispatcher, a
// real consent coordinator, a real local index and a mock vault per "gateway" (plan task 8).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { verifyBundle } from "../../automation/workflow-bundle.ts";
import { getWorkflowByName, upsertWorkflowByName } from "../../automation/workflow-store.ts";
import { FIXTURE_STEPS } from "../../connectors/connector-writes/workflow-bundle.test-helpers.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { ensureFullSqlite } from "../../platform/sqlite-runtime.ts";
import { ensureShareKeypair } from "../../share/share-keypair.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ClientSession } from "../session.ts";
import type { ClientKind } from "./client-kind.ts";
import type { ServerCtx } from "./context.ts";
import { tryDispatchAutomationRpc } from "./dispatchers.ts";
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
  readonly vault: ReturnType<typeof createMockVault>;
};

function harness(
  opts: {
    kind?: ClientKind;
    answerSource?: "human" | "auto" | "script" | "unknown" | "delegate" | "remote";
    approve?: boolean;
  } = {},
): Harness {
  ensureFullSqlite();
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
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
  const vault = createMockVault();
  const ctx: ServerCtx = {
    options: { listenPath: "", vault, version: "test", localIndex: new LocalIndex(db) },
    consentImpl: coordinator,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => opts.kind ?? "cli",
  };
  return { ctx, db, prompts, vault };
}

const SESSION = {} as ClientSession;
const call = (h: Harness, method: string, params: unknown) =>
  tryDispatchAutomationRpc(h.ctx, "c1", SESSION, method, params);

async function errOf(p: Promise<unknown>): Promise<RpcMethodError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RpcMethodError);
    return e as RpcMethodError;
  }
  throw new Error("expected a refusal");
}
const codeOf = async (p: Promise<unknown>) => (await errOf(p)).rpcData?.["code"];

function seed(h: Harness, name = "weekly-cleanup", steps: readonly unknown[] = FIXTURE_STEPS) {
  return upsertWorkflowByName(h.db, name, "archive old mail", JSON.stringify(steps), 10);
}

type Exported = { bundle: string; fingerprint: string; stepsSha256: string; issuedAt: number };

describe("workflow.export", () => {
  test("signs the stored workflow with the share key, never carries the schedule, and audits hashes only", async () => {
    const h = harness();
    const id = seed(h);
    h.db.run("UPDATE workflow SET schedule = '0 6 * * *', schedule_tz = 'UTC' WHERE id = ?", [id]);
    const out = (await call(h, "workflow.export", {
      name: "weekly-cleanup",
      author: "lead",
    })) as Exported;
    const v = verifyBundle(out.bundle, Date.now());
    const kp = await ensureShareKeypair(h.vault);
    expect(v.signerFingerprint).toBe(publisherKeyFingerprint(kp.pubkeyB64));
    expect(out.fingerprint).toBe(v.signerFingerprint);
    expect(v.body.author).toBe("lead");
    expect(out.bundle).not.toContain("schedule");
    expect(out.bundle).not.toContain(kp.privkeyB64);
    const audit = h.db
      .query(
        "SELECT action_type, hitl_status, action_json FROM audit_log WHERE action_type = 'workflow.export'",
      )
      .all() as Array<{ action_type: string; hitl_status: string; action_json: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.hitl_status).toBe("not_required");
    expect(audit[0]?.action_json).toContain(out.stepsSha256);
    expect(audit[0]?.action_json).not.toContain("old-mail");
    expect(h.prompts).toHaveLength(0);
  });

  test("refuses a model step, a credential-looking constant and a name that is not saved", async () => {
    const h = harness();
    seed(h, "has-run", [{ run: "summarise" }]);
    expect(await codeOf(call(h, "workflow.export", { name: "has-run" }))).toBe(
      "ERR_WORKFLOW_BUNDLE_MODEL_STEP",
    );
    seed(h, "has-secret", [
      FIXTURE_STEPS[0],
      {
        kind: "write",
        label: "p",
        tool: "gmail_thread_archive",
        input: { threadId: { const: `ghp_${"a".repeat(36)}` } },
      },
    ]);
    expect(await codeOf(call(h, "workflow.export", { name: "has-secret" }))).toBe(
      "ERR_WORKFLOW_BUNDLE_CREDENTIAL",
    );
    expect(await codeOf(call(h, "workflow.export", { name: "nope" }))).toBe(
      "ERR_WORKFLOW_NOT_FOUND",
    );
    expect(
      h.db.query("SELECT count(*) AS n FROM audit_log WHERE action_type = 'workflow.export'").get(),
    ).toEqual({ n: 0 });
  });

  test("only cli and ui answer; a supplied clientKind or unknown key is refused with -32602", async () => {
    for (const kind of ["unknown", "mcp", "http", "chatops"] as const) {
      const h = harness({ kind });
      seed(h);
      expect(await codeOf(call(h, "workflow.export", { name: "weekly-cleanup" })), kind).toBe(
        "ERR_WORKFLOW_IMPORT_LOCAL_ONLY",
      );
    }
    const ui = harness({ kind: "ui" });
    seed(ui);
    expect(await call(ui, "workflow.export", { name: "weekly-cleanup" })).toBeDefined();
    const h = harness();
    seed(h);
    expect(
      (await errOf(call(h, "workflow.export", { name: "weekly-cleanup", clientKind: "cli" })))
        .rpcCode,
    ).toBe(-32602);
    expect(
      (await errOf(call(h, "workflow.export", { name: "weekly-cleanup", out: "/x" }))).rpcCode,
    ).toBe(-32602);
    expect((await errOf(call(h, "workflow.export", {}))).rpcCode).toBe(-32602);
  });
});

describe("workflow.import", () => {
  async function exportedFromElsewhere(): Promise<Exported> {
    const a = harness();
    seed(a);
    return (await call(a, "workflow.export", {
      name: "weekly-cleanup",
      author: "lead",
    })) as Exported;
  }

  test("a bundle exported on one gateway is imported on another after the owner's human approval", async () => {
    const { bundle, fingerprint } = await exportedFromElsewhere();
    const b = harness();
    const out = (await call(b, "workflow.import", { bundle })) as { id: string; replaced: boolean };
    expect(out.replaced).toBe(false);
    expect(b.prompts).toHaveLength(1);
    expect(b.prompts[0]).toContain("Type: workflow.import");
    expect(b.prompts[0]).toContain(fingerprint);
    expect(b.prompts[0]).toContain("Steps, verbatim:");
    expect(getWorkflowByName(b.db, "weekly-cleanup")?.id).toBe(out.id);
    const row = b.db.query("SELECT approval_audit_id FROM workflow_import").get() as {
      approval_audit_id: number;
    };
    const audit = b.db
      .query("SELECT action_type, hitl_status, action_json FROM audit_log WHERE id = ?")
      .get(row.approval_audit_id) as {
      action_type: string;
      hitl_status: string;
      action_json: string;
    };
    expect(audit.action_type).toBe("workflow.import");
    expect(audit.hitl_status).toBe("approved");
    expect(JSON.parse(audit.action_json).answerSource).toBe("human");
    // The long prompt text is shown to the owner, not stored in the audit row.
    expect(audit.action_json).not.toContain("Steps, verbatim");
    expect(audit.action_json).toContain("signerFingerprint");
  });

  test.each(["auto", "script", "unknown", "delegate", "remote"] as const)(
    "an answer from %s is declined and nothing is written",
    async (answerSource) => {
      const { bundle } = await exportedFromElsewhere();
      const b = harness({ answerSource });
      // `auto` (`--yes`) and `script` reach the owner-only ask and are turned into a decline there; a
      // reply naming any other source is already a denial at the consent coordinator. Either way nothing
      // is written.
      const code = await codeOf(call(b, "workflow.import", { bundle }));
      if (answerSource === "auto" || answerSource === "script") {
        expect(code).toBe("ERR_WORKFLOW_IMPORT_NEEDS_HUMAN");
      } else {
        expect(["ERR_WORKFLOW_IMPORT_NEEDS_HUMAN", "ERR_WORKFLOW_IMPORT_DECLINED"]).toContain(
          String(code),
        );
      }
      expect(getWorkflowByName(b.db, "weekly-cleanup")).toBeNull();
      expect(b.db.query("SELECT count(*) AS n FROM workflow_import").get()).toEqual({ n: 0 });
    },
  );

  test("a human decline writes nothing", async () => {
    const { bundle } = await exportedFromElsewhere();
    const b = harness({ approve: false });
    expect(await codeOf(call(b, "workflow.import", { bundle }))).toBe(
      "ERR_WORKFLOW_IMPORT_DECLINED",
    );
    expect(getWorkflowByName(b.db, "weekly-cleanup")).toBeNull();
  });

  test("only cli and ui may import; refused before any prompt", async () => {
    const { bundle } = await exportedFromElsewhere();
    for (const kind of ["unknown", "mcp", "http", "chatops", "fleet", "push"] as const) {
      const b = harness({ kind });
      expect(await codeOf(call(b, "workflow.import", { bundle })), kind).toBe(
        "ERR_WORKFLOW_IMPORT_LOCAL_ONLY",
      );
      expect(b.prompts, kind).toHaveLength(0);
    }
  });

  test("a supplied clientKind, an unknown parameter and a missing bundle are -32602", async () => {
    const { bundle } = await exportedFromElsewhere();
    const b = harness();
    for (const params of [{ bundle, clientKind: "cli" }, { bundle, trigger: "schedule" }, {}]) {
      expect((await errOf(call(b, "workflow.import", params))).rpcCode).toBe(-32602);
    }
    expect(b.prompts).toHaveLength(0);
  });

  test("--dry-run returns the text and asks nobody; --schedule is set in the same approval", async () => {
    const { bundle } = await exportedFromElsewhere();
    const b = harness();
    const dry = (await call(b, "workflow.import", { bundle, dryRun: true })) as {
      dryRun: boolean;
      promptText: string;
    };
    expect(dry.dryRun).toBe(true);
    expect(dry.promptText).toContain("Import the workflow");
    expect(b.prompts).toHaveLength(0);
    await call(b, "workflow.import", { bundle, schedule: "0 6 * * *", scheduleTz: "UTC" });
    expect(getWorkflowByName(b.db, "weekly-cleanup")).toMatchObject({ schedule: "0 6 * * *" });
    expect(b.prompts[0]).toContain('you asked for "0 6 * * *" in "UTC"');
  });

  test("a bundle refusal carries its stable code", async () => {
    const b = harness();
    expect(await codeOf(call(b, "workflow.import", { bundle: "{" }))).toBe(
      "ERR_WORKFLOW_BUNDLE_MALFORMED",
    );
  });
});

describe("workflow.list source field", () => {
  test("cli and ui see where content came from; any other connection sees no source key at all", async () => {
    const { bundle } = await (async () => {
      const a = harness();
      seed(a);
      return (await call(a, "workflow.export", { name: "weekly-cleanup" })) as Exported;
    })();
    const b = harness();
    await call(b, "workflow.import", { bundle });
    seed(b, "mine", [FIXTURE_STEPS[0]]);
    const listFor = async (kind: ClientKind) => {
      const ctx = { ...b.ctx, getClientKind: () => kind };
      const out = (await tryDispatchAutomationRpc(ctx, "c1", SESSION, "workflow.list", {})) as {
        workflows: Array<Record<string, unknown>>;
      };
      return out.workflows;
    };
    for (const kind of ["cli", "ui"] as const) {
      const rows = await listFor(kind);
      const imported = rows.find((r) => r["name"] === "weekly-cleanup");
      const local = rows.find((r) => r["name"] === "mine");
      expect(imported?.["source"], kind).toMatchObject({ kind: "imported", edited: false });
      expect(local?.["source"], kind).toEqual({ kind: "local" });
    }
    for (const kind of ["unknown", "mcp", "http"] as const) {
      for (const r of await listFor(kind)) expect(Object.hasOwn(r, "source"), kind).toBe(false);
    }
    // An edit after the import is `edited`.
    upsertWorkflowByName(b.db, "weekly-cleanup", null, JSON.stringify([FIXTURE_STEPS[0]]), 20);
    const edited = (await listFor("cli")).find((r) => r["name"] === "weekly-cleanup");
    expect(edited?.["source"]).toMatchObject({ kind: "imported", edited: true });
  });
});
