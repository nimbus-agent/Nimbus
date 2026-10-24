import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { RemoteApprovalOutcome } from "./delegated-approval.ts";
import { DelegationStore } from "./delegation-store.ts";
import { HITL_REQUIRED, NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { PlannedAction } from "./types.ts";

/**
 * `pack.install` — the role-pack install consent. A frozen-set member (I2) that no delegate ever
 * approves (I20), with its own prompt body, and whose prompt text never reaches the audit row.
 */

const PROMPT_TEXT = "Install pack pm 1.0.0\n  sets [agents] synthesis = local";
const PACK_ACTION: PlannedAction = {
  type: "pack.install",
  payload: {
    packId: "pm",
    version: "1.0.0",
    source: "bundled",
    digest: "abc123",
    promptText: PROMPT_TEXT,
  },
};

function capture(): {
  prompts: string[];
  details: Array<Record<string, unknown> | undefined>;
  auditJson: string[];
  exec: ToolExecutor;
  withDelegate: (store: DelegationStore, onRemote: () => void) => ToolExecutor;
} {
  const prompts: string[] = [];
  const details: Array<Record<string, unknown> | undefined> = [];
  const auditJson: string[] = [];
  const consent = {
    requestApproval: async (prompt: string, d?: Record<string, unknown>) => {
      prompts.push(prompt);
      details.push(d);
      return false;
    },
  };
  const audit = { recordAudit: (row: { actionJson: string }) => auditJson.push(row.actionJson) };
  const connectors = { dispatch: async () => ({}) };
  const exec = new ToolExecutor(
    consent,
    audit,
    connectors,
    undefined,
    NULL_EGRESS_SINK,
    NO_POLICY_OVERLAY,
  );
  const withDelegate = (store: DelegationStore, onRemote: () => void): ToolExecutor =>
    new ToolExecutor(
      consent,
      audit,
      connectors,
      {
        store,
        isOperatorValid: () => true,
        requestRemote: async (): Promise<RemoteApprovalOutcome> => {
          onRemote();
          return { kind: "answered", peerId: "peer:bob", approved: true };
        },
      },
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
  return { prompts, details, auditJson, exec, withDelegate };
}

describe("pack.install consent", () => {
  test("pack.install is HITL-required", () => {
    expect(HITL_REQUIRED.has("pack.install")).toBe(true);
  });

  test("a delegate never approves pack.install", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 35);
    const store = new DelegationStore(db);
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "action_type",
      scopeValue: "pack.install",
      expiresAt: 9e15,
      nowMs: 1,
    });
    expect(store.activeDelegateePeer("pack.install", "pack", Date.now())).toBe("peer:bob");
    let remoteCalls = 0;
    const h = capture();
    const res = await h
      .withDelegate(store, () => {
        remoteCalls += 1;
      })
      .execute(PACK_ACTION);
    expect(remoteCalls).toBe(0);
    expect(h.prompts).toHaveLength(1);
    expect(res.status).toBe("rejected");
    db.close();
  });

  test("the prompt prints promptText, not a Details JSON line", async () => {
    const h = capture();
    await h.exec.execute(PACK_ACTION);
    expect(h.prompts[0]).toBe(
      `Action requires your approval\n\nType: pack.install\n\n${PROMPT_TEXT}`,
    );
    expect(h.prompts[0]).not.toContain("Details:");
    expect(JSON.stringify(h.details[0])).not.toContain("promptText");
  });

  test("a pack.install payload without a string promptText falls back to the generic format", async () => {
    const h = capture();
    await h.exec.execute({ type: "pack.install", payload: { packId: "pm", promptText: 5 } });
    expect(h.prompts[0]).toContain("Details:");
    expect(h.prompts[0]).toContain('"packId":"pm"');
  });

  test("another action type with a promptText payload still gets the generic Details line", async () => {
    const h = capture();
    await h.exec.execute({ type: "email.send", payload: { promptText: "hello" } });
    expect(h.prompts[0]).toContain("Details:");
    expect(h.prompts[0]).toContain("hello");
  });

  test("the pack.install audit row carries packId/version/source/digest and no promptText", async () => {
    const h = capture();
    await h.exec.execute(PACK_ACTION);
    expect(h.auditJson).toHaveLength(1);
    const row = h.auditJson[0] ?? "";
    for (const v of ["pm", "1.0.0", "bundled", "abc123"]) expect(row).toContain(v);
    expect(row).not.toContain("promptText");
    expect(row).not.toContain("synthesis");
  });
});
