/**
 * Agent door AD3a-2a, the submit path (D-4): the verdict (with a `suspended` arm and a basis), the
 * refusal by basis, the configured check, and the definition check LAST, so every other refusal is
 * free of connector I/O.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { type CaptureCapability, resolveCaptureCapability } from "./capture-capability.ts";
import { type CaptureGateDeps, submitCapture } from "./capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import { CaptureStore } from "./capture-store.ts";
import { type ActionBasis, type ActionVerdict, CaptureError } from "./capture-types.ts";

const OPEN = { capabilitiesDisabled: new Set<string>() };
const MCP = { clientId: "c-mcp", kind: "mcp" as const };
const ACT = {
  kind: "action",
  payload: { actionType: "github.issue.create", input: { title: "t" }, summary: "why" },
};

type Verify = NonNullable<CaptureGateDeps["verifyActionDefinition"]>;

let db: Database;
let deps: CaptureGateDeps;
let cap: CaptureCapability;
let calls: string[];
let verdict: ActionVerdict;
let verify: Verify;
let configured: boolean;
let refusal: string | undefined;
let refusalBasis: Array<ActionBasis | undefined>;

beforeEach(() => {
  db = openMigratedMemoryDb();
  cap = resolveCaptureCapability(
    {
      ok: true,
      config: {
        ...DEFAULT_MCP_SINK_CONFIG,
        enabled: true,
        kinds: ["note", "action"],
        actionMaxPending: 10,
      },
    },
    OPEN,
  );
  calls = [];
  verdict = { kind: "proposable", basis: "approved" };
  verify = async () => {
    calls.push("verify");
    return { ok: true };
  };
  configured = true;
  refusal = undefined;
  refusalBasis = [];
  let seq = 0;
  deps = {
    db,
    store: new CaptureStore(db),
    capability: () => cap,
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq)}`,
    now: () => 1_000_000,
    classifyAction: () => {
      calls.push("classify");
      return verdict;
    },
    isServiceConfigured: async () => {
      calls.push("configured");
      return configured;
    },
    actionDestinationRefusal: (_t, _i, basis) => {
      calls.push("refusal");
      refusalBasis.push(basis);
      return refusal;
    },
    verifyActionDefinition: (t) => verify(t),
  };
});
afterEach(() => db.close());

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  throw new Error("expected a CaptureError");
}

function auditRows(): Array<{ action_type: string; hitl_status: string; action_json: string }> {
  return db
    .query(
      "SELECT action_type, hitl_status, action_json FROM audit_log WHERE action_type = 'capture.submit' ORDER BY id",
    )
    .all() as Array<{ action_type: string; hitl_status: string; action_json: string }>;
}

function captureCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM capture").get() as { n: number }).n;
}

describe("the order of the submit checks", () => {
  test("verdict, then refusal, then configured, then the definition check LAST", async () => {
    const out = await submitCapture(deps, MCP, ACT);
    expect(out.state).toBe("proposed");
    expect(calls).toEqual(["classify", "refusal", "configured", "verify"]);
  });

  test("a suspended verdict is ERR_AGENT_TOOL_SUSPENDED, audited, nothing queued, and the connector is never touched", async () => {
    verdict = { kind: "suspended" };
    expect(await codeOf(submitCapture(deps, MCP, ACT))).toBe("ERR_AGENT_TOOL_SUSPENDED");
    expect(calls).toEqual(["classify"]);
    expect(captureCount()).toBe(0);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hitl_status).toBe("rejected");
    expect(JSON.parse(rows[0]?.action_json as string)).toMatchObject({
      kind: "action",
      outcome: "ERR_AGENT_TOOL_SUSPENDED",
    });
  });

  test.each([
    ["a denied verdict", { kind: "denied", class: "agent_not_approved" } as ActionVerdict],
    ["an unknown verdict", { kind: "unknown" } as ActionVerdict],
  ])("%s refuses with zero connector I/O", async (_n, v) => {
    verdict = v;
    expect(await codeOf(submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
    expect(calls).toEqual(["classify"]);
    expect(captureCount()).toBe(0);
    expect(auditRows()).toHaveLength(1);
  });

  test("a refusal reads zero verify calls and queues nothing", async () => {
    refusal = "fixed refusal text";
    expect(await codeOf(submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_ACTION_REFUSED");
    expect(calls).toEqual(["classify", "refusal"]);
    expect(captureCount()).toBe(0);
  });

  test("an unconfigured service reads zero verify calls", async () => {
    configured = false;
    expect(await codeOf(submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_CONNECTOR_UNCONFIGURED");
    expect(calls).toEqual(["classify", "refusal", "configured"]);
    expect(captureCount()).toBe(0);
  });

  test("the refusal is given the verdict's basis", async () => {
    await submitCapture(deps, MCP, ACT);
    verdict = { kind: "proposable", basis: "legacy_unapproved" };
    await submitCapture(deps, { clientId: "c2", kind: "mcp" }, ACT);
    verdict = { kind: "proposable" };
    await submitCapture(deps, { clientId: "c3", kind: "mcp" }, ACT);
    expect(refusalBasis).toEqual(["approved", "legacy_unapproved", undefined]);
  });
});

describe("the definition check (5c)", () => {
  test("an approved basis with no verifyActionDefinition is refused (fail closed)", async () => {
    Reflect.deleteProperty(deps, "verifyActionDefinition");
    expect(await codeOf(submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
    expect(captureCount()).toBe(0);
    expect(auditRows()).toHaveLength(1);
  });

  test.each([
    ["ERR_AGENT_TOOL_SUSPENDED" as const],
    ["ERR_CAPTURE_ACTION_NOT_PROPOSABLE" as const],
  ])("a failed check refuses with %s, audited, nothing queued", async (code) => {
    verify = async () => ({ ok: false, code, detail: "fixed detail" });
    expect(await codeOf(submitCapture(deps, MCP, ACT))).toBe(code);
    expect(captureCount()).toBe(0);
    expect(JSON.parse(auditRows()[0]?.action_json as string)).toMatchObject({ outcome: code });
  });

  test("a check that throws is a refusal, not a crash", async () => {
    verify = async () => {
      throw new Error("mesh exploded");
    };
    expect(await codeOf(submitCapture(deps, MCP, ACT))).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
    expect(captureCount()).toBe(0);
  });

  test.each([["legacy_unapproved" as const], ["legacy_mail_send" as const]])(
    "a %s basis never calls it and stores legacy = 1",
    async (basis) => {
      verdict = { kind: "proposable", basis };
      const out = await submitCapture(deps, MCP, ACT);
      expect(calls).not.toContain("verify");
      expect(out.legacy).toBe(true);
      expect(new CaptureStore(db).get(out.id)?.agentDoorLegacy).toBe(true);
      const audit = JSON.parse(auditRows().at(-1)?.action_json as string);
      expect(audit).toMatchObject({ outcome: "proposed", basis });
    },
  );

  test("an approved proposal stores legacy = 0, replies without the key, and its audit row names the basis", async () => {
    const out = await submitCapture(deps, MCP, ACT);
    expect(Object.keys(out).sort((a, b) => a.localeCompare(b))).toEqual([
      "expiresAt",
      "id",
      "state",
    ]);
    expect(new CaptureStore(db).get(out.id)?.agentDoorLegacy).toBe(false);
    expect(JSON.parse(auditRows().at(-1)?.action_json as string)).toMatchObject({
      basis: "approved",
    });
  });

  test("a verdict with no basis (user-MCP, and today's production wiring) behaves exactly as before", async () => {
    verdict = { kind: "proposable" };
    Reflect.deleteProperty(deps, "verifyActionDefinition");
    const out = await submitCapture(deps, MCP, ACT);
    expect(calls).toEqual(["classify", "refusal", "configured"]);
    expect(Object.keys(out).sort((a, b) => a.localeCompare(b))).toEqual([
      "expiresAt",
      "id",
      "state",
    ]);
    expect(new CaptureStore(db).get(out.id)?.agentDoorLegacy).toBe(false);
    expect(Object.hasOwn(JSON.parse(auditRows().at(-1)?.action_json as string), "basis")).toBe(
      false,
    );
  });
});

describe("the caps still follow the awaits", () => {
  test("two concurrent submits with one queue slot: exactly one is queued", async () => {
    cap = resolveCaptureCapability(
      {
        ok: true,
        config: {
          ...DEFAULT_MCP_SINK_CONFIG,
          enabled: true,
          kinds: ["action"],
          actionMaxPending: 1,
        },
      },
      OPEN,
    );
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    verify = async () => {
      await gate;
      return { ok: true };
    };
    const a = submitCapture(deps, MCP, ACT).then(
      () => "ok",
      (e: CaptureError) => e.code,
    );
    const b = submitCapture(deps, { clientId: "c-two", kind: "mcp" }, ACT).then(
      () => "ok",
      (e: CaptureError) => e.code,
    );
    release();
    const results = (await Promise.all([a, b])).sort((x, y) => x.localeCompare(y));
    expect(results).toEqual(["ERR_CAPTURE_QUEUE_FULL", "ok"]);
    expect(captureCount()).toBe(1);
  });
});
