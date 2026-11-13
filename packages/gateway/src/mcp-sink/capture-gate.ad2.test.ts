/** Agent door AD2: ownership of ids, `capture.mine`, the per-connection cap, the proposal view, the hook. */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { type CaptureCapability, resolveCaptureCapability } from "./capture-capability.ts";
import {
  acceptCapture,
  type CaptureGateDeps,
  captureMine,
  captureStateFor,
  listActionProposals,
  rejectCapture,
  submitCapture,
} from "./capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import { CaptureStore } from "./capture-store.ts";
import { CaptureError } from "./capture-types.ts";

const OPEN = { capabilitiesDisabled: new Set<string>() };
const MCP = { clientId: "c-mcp", kind: "mcp" as const };
const OTHER = { clientId: "c-other", kind: "mcp" as const };
const OWNER = { clientId: "c-cli", kind: "cli" as const };
const ACT = {
  kind: "action",
  payload: { actionType: "slack.message.post", input: { text: "hi" }, summary: "why" },
};
const HOUR = 3_600_000;

let db: Database;
let deps: CaptureGateDeps;
let cap: CaptureCapability;
let clock: number;
let seq: number;
let hookCalls: number[];

function onConfig(over: Partial<typeof DEFAULT_MCP_SINK_CONFIG> = {}): CaptureCapability {
  return resolveCaptureCapability(
    {
      ok: true,
      config: {
        ...DEFAULT_MCP_SINK_CONFIG,
        enabled: true,
        kinds: ["note", "decision", "action"],
        ...over,
      },
    },
    OPEN,
  );
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  clock = 1_000_000;
  seq = 0;
  hookCalls = [];
  cap = onConfig({ actionMaxPending: 10 });
  deps = {
    db,
    store: new CaptureStore(db),
    capability: () => cap,
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq)}`,
    now: () => clock,
    classifyAction: () => ({ kind: "proposable" }),
    isServiceConfigured: () => Promise.resolve(true),
    actionDestinationRefusal: () => undefined,
    onActionProposed: (n) => hookCalls.push(n),
  };
});
afterEach(() => db.close());

function errOf(fn: () => unknown): CaptureError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaptureError) return e;
    throw e;
  }
  throw new Error("expected CaptureError");
}

async function errOfAsync(fn: () => Promise<unknown>): Promise<CaptureError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CaptureError) return e;
    throw e;
  }
  throw new Error("expected CaptureError");
}

describe("captureStateFor: only the submitting connection", () => {
  test("the submitter gets its row; another mcp connection gets the SAME error as an absent id", async () => {
    const { id } = await submitCapture(deps, MCP, ACT);
    expect(captureStateFor(deps, MCP, id).state).toBe("proposed");
    const other = errOf(() => captureStateFor(deps, OTHER, id));
    expect(other.code).toBe("ERR_CAPTURE_NOT_FOUND");
    const absent = "cap_0000";
    const gone = errOf(() => captureStateFor(deps, OTHER, absent));
    expect(other.message.replace(id, "X")).toBe(gone.message.replace(absent, "X"));
  });
  test("an owner caller is still refused, and an expired row still answers its submitter", async () => {
    const { id } = await submitCapture(deps, MCP, ACT);
    expect(errOf(() => captureStateFor(deps, OWNER, id)).code).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    clock += 25 * HOUR;
    expect(captureStateFor(deps, MCP, id).state).toBe("expired");
  });
});

describe("captureMine", () => {
  test("only the caller's rows, newest first, no payload keys, owner refused", async () => {
    clock = 10;
    const a = await submitCapture(deps, MCP, ACT);
    clock = 20;
    await submitCapture(deps, OTHER, ACT);
    clock = 30;
    const c = await submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    const mine = captureMine(deps, MCP).captures;
    expect(mine.map((r) => r.id)).toEqual([c.id, a.id]);
    for (const r of mine) {
      expect(Object.keys(r).sort((x, y) => x.localeCompare(y))).toEqual(
        r.kind === "action"
          ? ["createdAt", "expiresAt", "id", "kind", "state"]
          : ["createdAt", "id", "kind", "state"],
      );
    }
    expect(errOf(() => captureMine(deps, OWNER)).code).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
  });
  test("carries outcomeRef once set, and is capped at 50", async () => {
    const { id } = await submitCapture(deps, MCP, ACT);
    deps.store.claimAction(id, clock);
    deps.store.finalizeAction(id, "executed", { outcomeRef: "https://x.example/1" }, clock);
    expect(captureMine(deps, MCP).captures[0]).toMatchObject({ outcomeRef: "https://x.example/1" });
    for (let i = 0; i < 60; i++) {
      deps.store.insert({
        id: `cap_bulk${String(i)}`,
        kind: "decision",
        state: "proposed",
        itemId: null,
        payloadJson: "{}",
        payloadBytes: 2,
        clientLabel: null,
        sessionId: MCP.clientId,
        createdAt: clock + i,
        expiresAt: null,
        agentDoorLegacy: false,
      });
    }
    expect(captureMine(deps, MCP).captures).toHaveLength(50);
  });
  test("carries errorCode on a failed action", async () => {
    const { id } = await submitCapture(deps, MCP, ACT);
    deps.store.claimAction(id, clock);
    deps.store.finalizeAction(id, "failed", { errorCode: "ERR_ACTION_DISPATCH" }, clock);
    expect(captureMine(deps, MCP).captures[0]).toMatchObject({ errorCode: "ERR_ACTION_DISPATCH" });
  });
});

describe("per-connection action cap (min(3, actionMaxPending))", () => {
  test("a fourth proposed action from one connection is refused; another connection may still propose", async () => {
    for (let i = 0; i < 3; i++) await submitCapture(deps, MCP, ACT);
    expect((await errOfAsync(() => submitCapture(deps, MCP, ACT))).code).toBe(
      "ERR_CAPTURE_QUEUE_FULL",
    );
    expect((await submitCapture(deps, OTHER, ACT)).state).toBe("proposed");
  });
  test("the refusal has its own message and writes the standard audited row", async () => {
    for (let i = 0; i < 3; i++) await submitCapture(deps, MCP, ACT);
    const e = await errOfAsync(() => submitCapture(deps, MCP, ACT));
    expect(e.message).toContain(
      "this connection already has 3 proposed actions waiting for the owner",
    );
    const row = db
      .query("SELECT action_type, hitl_status, session_id FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { action_type: string; hitl_status: string; session_id: string };
    expect(row).toEqual({
      action_type: "capture.submit",
      hitl_status: "rejected",
      session_id: MCP.clientId,
    });
  });
  test("with actionMaxPending 2 the per-connection cap is 2", async () => {
    cap = onConfig({ actionMaxPending: 2 });
    await submitCapture(deps, MCP, ACT);
    await submitCapture(deps, MCP, ACT);
    expect((await errOfAsync(() => submitCapture(deps, MCP, ACT))).code).toBe(
      "ERR_CAPTURE_QUEUE_FULL",
    );
  });
  test("an expired or decided action frees a slot; notes and decisions never count", async () => {
    const a = await submitCapture(deps, MCP, ACT);
    await submitCapture(deps, MCP, ACT);
    await submitCapture(deps, MCP, ACT);
    await submitCapture(deps, MCP, { kind: "note", payload: { body: "b" } });
    await submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    rejectCapture(deps, OWNER, a.id);
    expect((await submitCapture(deps, MCP, ACT)).state).toBe("proposed");
    clock += 25 * HOUR;
    expect((await submitCapture(deps, MCP, ACT)).state).toBe("proposed");
  });
});

describe("CaptureStore per-session queries", () => {
  test("countPendingActionsBySession ignores other sessions, non-actions and expired rows", async () => {
    await submitCapture(deps, MCP, ACT);
    await submitCapture(deps, OTHER, ACT);
    await submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    expect(deps.store.countPendingActionsBySession(MCP.clientId, clock)).toBe(1);
    expect(deps.store.countPendingActionsBySession(MCP.clientId, clock + 25 * HOUR)).toBe(0);
    expect(deps.store.countPendingActionsBySession("nobody", clock)).toBe(0);
  });
  test("listBySession is newest first and bounded", async () => {
    clock = 5;
    const a = await submitCapture(deps, MCP, ACT);
    clock = 6;
    const b = await submitCapture(deps, MCP, ACT);
    expect(deps.store.listBySession(MCP.clientId, 10).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(deps.store.listBySession(MCP.clientId, 1)).toHaveLength(1);
  });
  test("V97 relaxed the V69 CHECK: a rejected action may carry an error_code (AD3a-2 writes one)", async () => {
    const { id } = await submitCapture(deps, MCP, ACT);
    deps.store.claimAction(id, clock);
    expect(deps.store.finalizeAction(id, "rejected", { errorCode: "ERR_X" }, clock)).toBe(true);
    expect(deps.store.get(id)?.errorCode).toBe("ERR_X");
  });
  test("V97 still refuses a code on an executed action", async () => {
    const { id } = await submitCapture(deps, MCP, ACT);
    deps.store.claimAction(id, clock);
    expect(() =>
      deps.store.finalizeAction(id, "executed", { errorCode: "ERR_X" }, clock),
    ).toThrow();
  });
});

describe("listActionProposals", () => {
  test("owner only; proposed, unexpired actions only; oldest first; raw fields", async () => {
    clock = 10;
    const a = await submitCapture(deps, MCP, { ...ACT, clientLabel: "lab el" });
    clock = 20;
    await submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    clock = 30;
    const c = await submitCapture(deps, OTHER, ACT);
    const out = listActionProposals(deps, OWNER).proposals;
    expect(out.map((p) => p.id)).toEqual([a.id, c.id]);
    expect(out[0]).toEqual({
      id: a.id,
      actionType: "slack.message.post",
      summary: "why",
      clientLabel: "lab el",
      createdAt: 10,
      expiresAt: 10 + 24 * HOUR,
      agentDoorLegacy: false,
    });
    expect(errOf(() => listActionProposals(deps, MCP)).code).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    clock += 25 * HOUR;
    expect(listActionProposals(deps, OWNER).proposals).toEqual([]);
  });
  test("a row whose payload does not parse is skipped, not thrown", async () => {
    await submitCapture(deps, MCP, ACT);
    deps.store.insert({
      id: "cap_bad",
      kind: "action",
      state: "proposed",
      itemId: null,
      payloadJson: "not json",
      payloadBytes: 8,
      clientLabel: null,
      sessionId: "x",
      createdAt: clock,
      expiresAt: clock + HOUR,
      agentDoorLegacy: false,
    });
    expect(listActionProposals(deps, OWNER).proposals).toHaveLength(1);
  });
});

describe("onActionProposed hook", () => {
  test("called once per queued ACTION with the pending count; never for a note, decision or refusal", async () => {
    await submitCapture(deps, MCP, { kind: "note", payload: { body: "b" } });
    await submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    expect(hookCalls).toEqual([]);
    await submitCapture(deps, MCP, ACT);
    await submitCapture(deps, OTHER, ACT);
    expect(hookCalls).toEqual([1, 2]);
    deps = { ...deps, classifyAction: () => ({ kind: "denied", class: "x" }) };
    await errOfAsync(() => submitCapture(deps, MCP, ACT));
    expect(hookCalls).toEqual([1, 2]);
  });
  test("a throwing hook still returns the id", async () => {
    deps = {
      ...deps,
      onActionProposed: () => {
        throw new Error("toast down");
      },
    };
    const out = await submitCapture(deps, MCP, ACT);
    expect(out.state).toBe("proposed");
    expect(deps.store.get(out.id)?.state).toBe("proposed");
  });
  test("a rejected outcome's reason reaches the accept result and is never stored", async () => {
    const { id } = await submitCapture(deps, MCP, ACT);
    const out = await acceptCapture(deps, OWNER, id, {
      execute: () => Promise.resolve({ status: "rejected", reason: "r" }),
    });
    expect(out).toMatchObject({ state: "rejected", reason: "r" });
    const row = deps.store.get(id);
    expect(row?.state).toBe("rejected");
    expect(row?.errorCode).toBeNull();
    expect(JSON.stringify(captureStateFor(deps, MCP, id))).not.toContain("reason");
  });
});
