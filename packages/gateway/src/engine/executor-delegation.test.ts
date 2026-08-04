import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { RemoteApprovalOutcome } from "./delegated-approval.ts";
import { DelegationStore } from "./delegation-store.ts";
import { ToolExecutor } from "./executor.ts";

function db35() {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  return db;
}
const audit = { recordAudit: () => {} };
const connectors = { dispatch: async () => ({}) };

describe("executor gate — delegation branch", () => {
  it("routes a HITL action to an active delegate and honors their approval (no local prompt)", async () => {
    const db = db35();
    const store = new DelegationStore(db);
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "action_type",
      scopeValue: "email.send",
      expiresAt: 9e15, // far-future absolute ms; gate uses real Date.now()
      nowMs: 1,
    });
    let localPrompted = false;
    const consent = {
      requestApproval: async () => {
        localPrompted = true;
        return false;
      },
    };
    const remote = async (): Promise<RemoteApprovalOutcome> => ({
      kind: "answered",
      peerId: "peer:bob",
      approved: true,
    });
    const exec = new ToolExecutor(
      consent,
      audit,
      connectors,
      {
        store,
        isOperatorValid: () => true,
        requestRemote: remote,
      },
      NULL_EGRESS_SINK,
    );
    const r = await exec.gate({ type: "email.send", payload: {} });
    expect(r).toBe("proceed");
    expect(localPrompted).toBe(false);
  });

  it("falls back to the local owner prompt when the delegate is offline (D10)", async () => {
    const db = db35();
    const store = new DelegationStore(db);
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "action_type",
      scopeValue: "email.send",
      expiresAt: 9e15, // far-future absolute ms; gate uses real Date.now()
      nowMs: 1,
    });
    let localPrompted = false;
    const consent = {
      requestApproval: async () => {
        localPrompted = true;
        return true;
      },
    };
    const exec = new ToolExecutor(
      consent,
      audit,
      connectors,
      {
        store,
        isOperatorValid: () => true,
        requestRemote: async (): Promise<RemoteApprovalOutcome> => ({ kind: "timeout" }),
      },
      NULL_EGRESS_SINK,
    );
    const r = await exec.gate({ type: "email.send", payload: {} });
    expect(r).toBe("proceed");
    expect(localPrompted).toBe(true);
  });

  it("delegation dep present but NO active delegate → falls back to the local owner prompt", async () => {
    const db = db35();
    const store = new DelegationStore(db); // empty: no delegation was ever created
    let localPrompted = false;
    const consent = {
      requestApproval: async () => {
        localPrompted = true;
        return true;
      },
    };
    const exec = new ToolExecutor(
      consent,
      audit,
      connectors,
      {
        store,
        isOperatorValid: () => true,
        // requestRemote must never be reached: activeDelegateePeer() returns undefined first.
        requestRemote: async (): Promise<RemoteApprovalOutcome> => {
          throw new Error("requestRemote must not be called when there is no active delegate");
        },
      },
      NULL_EGRESS_SINK,
    );
    const r = await exec.gate({ type: "email.send", payload: {} });
    expect(r).toBe("proceed");
    expect(localPrompted).toBe(true);
  });

  it("honors a delegate's REJECTION (no local prompt; default reject reason; I20)", async () => {
    const db = db35();
    const store = new DelegationStore(db);
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "action_type",
      scopeValue: "email.send",
      expiresAt: 9e15,
      nowMs: 1,
    });
    let localPrompted = false;
    const consent = {
      requestApproval: async () => {
        localPrompted = true;
        return true; // would approve — must be bypassed by the delegate's deny
      },
    };
    const remote = async (): Promise<RemoteApprovalOutcome> => ({
      kind: "answered",
      peerId: "peer:bob",
      approved: false,
    });
    const exec = new ToolExecutor(
      consent,
      audit,
      connectors,
      {
        store,
        isOperatorValid: () => true,
        requestRemote: remote,
      },
      NULL_EGRESS_SINK,
    );
    const r = await exec.gate({ type: "email.send", payload: {} });
    expect(r).not.toBe("proceed");
    expect((r as { status: string; reason: string }).status).toBe("rejected");
    // The delegate-rejection path never sets rejectReason explicitly — proves the default holds.
    expect((r as { status: string; reason: string }).reason).toBe("User declined consent gate.");
    expect(localPrompted).toBe(false);
  });

  it("no delegation dep → always uses the local owner prompt (back-compat)", async () => {
    let localPrompted = false;
    const consent = {
      requestApproval: async () => {
        localPrompted = true;
        return true;
      },
    };
    const exec = new ToolExecutor(consent, audit, connectors, undefined, NULL_EGRESS_SINK);
    const r = await exec.gate({ type: "email.send", payload: {} });
    expect(r).toBe("proceed");
    expect(localPrompted).toBe(true);
  });
});
