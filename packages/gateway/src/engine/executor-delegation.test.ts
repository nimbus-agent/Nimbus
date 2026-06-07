import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
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
    const exec = new ToolExecutor(consent, audit, connectors, {
      store,
      isOperatorValid: () => true,
      requestRemote: remote,
    });
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
    const exec = new ToolExecutor(consent, audit, connectors, {
      store,
      isOperatorValid: () => true,
      requestRemote: async (): Promise<RemoteApprovalOutcome> => ({ kind: "timeout" }),
    });
    const r = await exec.gate({ type: "email.send", payload: {} });
    expect(r).toBe("proceed");
    expect(localPrompted).toBe(true);
  });

  it("no delegation dep → always uses the local owner prompt (back-compat)", async () => {
    let localPrompted = false;
    const consent = {
      requestApproval: async () => {
        localPrompted = true;
        return true;
      },
    };
    const exec = new ToolExecutor(consent, audit, connectors);
    const r = await exec.gate({ type: "email.send", payload: {} });
    expect(r).toBe("proceed");
    expect(localPrompted).toBe(true);
  });
});
