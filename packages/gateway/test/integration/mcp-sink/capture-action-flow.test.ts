/**
 * The act door end to end through `dispatchCaptureRpc`: a REAL `ToolExecutor` (via `buildActDeps`),
 * a REAL egress ledger and audit chain over a migrated SQLite, and a FAKE dispatcher.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_MCP_SINK_CONFIG } from "../../../src/config/mcp-sink-toml.ts";
import { appendAuditEntry } from "../../../src/db/audit-chain.ts";
import { makeEgressSink } from "../../../src/egress/egress-ledger.ts";
import { NO_POLICY_OVERLAY } from "../../../src/engine/executor.ts";
import type { PlannedAction } from "../../../src/engine/types.ts";
import { openMigratedMemoryDb } from "../../../src/index/migrated-db-template.ts";
import {
  type CaptureActWiring,
  type CaptureRpcCtx,
  dispatchCaptureRpc,
} from "../../../src/ipc/capture-rpc.ts";
import { type ConsentCoordinator, ConsentDisconnectedError } from "../../../src/ipc/consent.ts";
import { RpcMethodError } from "../../../src/ipc/server/rpc-error.ts";
import { reconcileActionsAtBoot } from "../../../src/mcp-sink/capture-act.ts";
import { resolveCaptureCapability } from "../../../src/mcp-sink/capture-capability.ts";
import type { CaptureGateDeps } from "../../../src/mcp-sink/capture-gate.ts";
import {
  CaptureAttemptLimiter,
  CaptureRefusalCounter,
} from "../../../src/mcp-sink/capture-rate-limit.ts";
import { CaptureStore, REJECTED_RETENTION_MS } from "../../../src/mcp-sink/capture-store.ts";

const MCP = { clientId: "m", kind: "mcp" as const };
const OWNER = { clientId: "o", kind: "cli" as const };
const HOUR = 3_600_000;

let db: Database;
let clock = 1_000;
let dispatched: PlannedAction[];
let ledgerCountAtDispatch: number[];
let dispatchBehaviour: () => unknown;
let consentBehaviour: () => Promise<boolean>;
let gate: CaptureGateDeps;
let ctx: CaptureRpcCtx;

const coordinator = {
  requestConsent: () => consentBehaviour(),
} as unknown as ConsentCoordinator;

beforeEach(() => {
  db = openMigratedMemoryDb();
  clock = 1_000;
  dispatched = [];
  ledgerCountAtDispatch = [];
  dispatchBehaviour = () => ({ url: "https://example.test/x" });
  consentBehaviour = () => Promise.resolve(true);
  let seq = 0;
  gate = {
    db,
    store: new CaptureStore(db),
    capability: () =>
      resolveCaptureCapability(
        {
          ok: true,
          config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
        },
        { capabilitiesDisabled: new Set() },
      ),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq)}`,
    now: () => clock,
    classifyAction: () => ({ kind: "proposable" }),
    isServiceConfigured: () => Promise.resolve(true),
  };
  const act: CaptureActWiring = {
    dispatcher: {
      dispatch: (a) => {
        dispatched.push(a);
        const n = db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number };
        ledgerCountAtDispatch.push(n.n);
        return Promise.resolve(dispatchBehaviour());
      },
    },
    egressSink: makeEgressSink(db),
    audit: { recordAudit: (e) => appendAuditEntry(db, e) },
    policyHitl: NO_POLICY_OVERLAY,
  };
  ctx = { gate, act };
});
afterEach(() => db.close());

async function propose(): Promise<string> {
  const out = await dispatchCaptureRpc(
    "capture.submit",
    {
      kind: "action",
      payload: { actionType: "slack.message.post", input: { text: "hi" }, summary: "why" },
    },
    ctx,
    MCP,
  );
  if (out.kind !== "hit") throw new Error("submit missed");
  return (out.value as { id: string }).id;
}

async function accept(id: string): Promise<unknown> {
  const out = await dispatchCaptureRpc("captures.accept", { id }, ctx, OWNER, coordinator);
  if (out.kind !== "hit") throw new Error("accept missed");
  return out.value;
}

function ledger(): Array<{ id: number; hitl_status: string; result_status: string }> {
  return db
    .query("SELECT id, hitl_status, result_status FROM egress_ledger ORDER BY id")
    .all() as Array<{ id: number; hitl_status: string; result_status: string }>;
}

describe("act door flow (real executor + real ledger, fake dispatcher)", () => {
  test("approve: executes, and the ledger row is appended BEFORE the dispatch", async () => {
    const id = await propose();
    expect(await accept(id)).toMatchObject({ id, state: "executed" });
    expect(dispatched).toHaveLength(1);
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hitl_status).toBe("approved");
    expect(ledgerCountAtDispatch).toEqual([1]);
  });

  test("decline: rejected, one blocked ledger row, nothing dispatched", async () => {
    consentBehaviour = () => Promise.resolve(false);
    const id = await propose();
    expect(await accept(id)).toMatchObject({ id, state: "rejected" });
    expect(dispatched).toEqual([]);
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result_status).toBe("blocked");
    expect(gate.store.get(id)?.state).toBe("rejected");
  });

  test("disconnect: a ConsentDisconnectedError is a rejection", async () => {
    consentBehaviour = () => Promise.reject(new ConsentDisconnectedError());
    const id = await propose();
    expect(await accept(id)).toMatchObject({ id, state: "rejected" });
    expect(dispatched).toEqual([]);
  });

  test("delegation is not consulted: the per-accept executor is built with no delegate", () => {
    const src = readFileSync(join(import.meta.dir, "../../../src/ipc/capture-rpc.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).toMatch(/new ToolExecutor\(\s*consent,\s*w\.audit,\s*w\.dispatcher,\s*undefined,/);
  });

  test("a dispatcher timeout stores ERR_ACTION_TIMEOUT and no message text", async () => {
    dispatchBehaviour = () => {
      throw new Error("slack.message.post exceeded 30000ms timeout");
    };
    const id = await propose();
    expect(await accept(id)).toMatchObject({
      id,
      state: "failed",
      errorCode: "ERR_ACTION_TIMEOUT",
    });
    const row = db.query("SELECT state, error_code FROM capture WHERE id = ?").get(id);
    expect(row).toEqual({ state: "failed", error_code: "ERR_ACTION_TIMEOUT" });
    const audit = db
      .query("SELECT action_json FROM audit_log WHERE action_type = 'capture.action.outcome'")
      .all() as Array<{ action_json: string }>;
    expect(audit.map((a) => a.action_json).join("")).not.toContain("exceeded");
  });

  test("lazy expiry: list shows expired with one expire audit row; accept refuses EXPIRED", async () => {
    const id = await propose();
    clock += 25 * HOUR;
    const listed = await dispatchCaptureRpc("captures.list", { kind: "action" }, ctx, OWNER);
    expect(JSON.stringify(listed)).toContain('"expired"');
    const expireRows = db
      .query("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'capture.action.expire'")
      .get() as { n: number };
    expect(expireRows.n).toBe(1);
    let caught: unknown;
    try {
      await accept(id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    expect((caught as RpcMethodError).rpcData).toMatchObject({ code: "ERR_CAPTURE_STATE" });
    expect(dispatched).toEqual([]);
  });

  test("lazy expiry at accept time: a due proposed action refuses ERR_CAPTURE_EXPIRED", async () => {
    const id = await propose();
    clock += 25 * HOUR;
    let caught: unknown;
    try {
      await accept(id);
    } catch (e) {
      caught = e;
    }
    expect((caught as RpcMethodError).rpcData).toMatchObject({ code: "ERR_CAPTURE_EXPIRED" });
    expect(gate.store.get(id)?.state).toBe("expired");
    expect(dispatched).toEqual([]);
  });

  test("boot reconcile: an executing row becomes failed/ERR_ACTION_INTERRUPTED, never proposed", async () => {
    const id = await propose();
    expect(gate.store.claimAction(id, clock)).toBe(true);
    expect(reconcileActionsAtBoot(gate, clock + 10)).toEqual({ expired: 0, interrupted: 1 });
    const row = db.query("SELECT state, error_code FROM capture WHERE id = ?").get(id);
    expect(row).toEqual({ state: "failed", error_code: "ERR_ACTION_INTERRUPTED" });
  });

  test("retention: expired and rejected actions are pruned; executed and failed are kept", async () => {
    const ids: Record<string, string> = {};
    for (const s of ["expired", "rejected", "executed", "failed"]) {
      const id = await propose();
      ids[s] = id;
      dbSetState(id, s);
    }
    const pruned = gate.store.pruneRejected(clock + REJECTED_RETENTION_MS + 1);
    expect(pruned).toBe(2);
    expect(gate.store.get(ids["expired"] as string)).toBeUndefined();
    expect(gate.store.get(ids["rejected"] as string)).toBeUndefined();
    expect(gate.store.get(ids["executed"] as string)?.state).toBe("executed");
    expect(gate.store.get(ids["failed"] as string)?.state).toBe("failed");
  });
});

function dbSetState(id: string, state: string): void {
  db.run("UPDATE capture SET state = ?, decided_at = ? WHERE id = ?", [state, clock, id]);
}
