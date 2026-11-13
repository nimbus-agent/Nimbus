/**
 * Agent door AD3a-2a, the approve path (D-5): step 4 re-derives the verdict, the configured check,
 * the refusal for the approval-time basis, the human-only rule and the definition check, every one of
 * which leaves the row proposed; and finalize stores the code of a rejected action.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { type ActGateDeps, acceptAction } from "./capture-act.ts";
import { type CaptureCapability, resolveCaptureCapability } from "./capture-capability.ts";
import { captureStateFor } from "./capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import { CaptureStore } from "./capture-store.ts";
import {
  type ActDeps,
  type ActionBasis,
  type ActionProvenance,
  type ActionVerdict,
  CaptureError,
  type CaptureErrorCode,
  type CaptureRow,
} from "./capture-types.ts";

const OWNER = { clientId: "c-cli", kind: "unknown" as const };
let db: Database;
let cap: CaptureCapability;
let calls: string[];
let verdict: ActionVerdict;
let configured: boolean;
let refusal: string | undefined;
let refusalBasis: Array<ActionBasis | undefined>;
let verify: NonNullable<ActGateDeps["verifyActionDefinition"]>;
let deps: ActGateDeps;

function insertAction(legacy: boolean): void {
  deps.store.insert({
    id: "cap_a",
    kind: "action",
    state: "proposed",
    itemId: null,
    payloadJson: JSON.stringify({
      actionType: "github.issue.create",
      input: { title: "t" },
      summary: "why",
    }),
    payloadBytes: 10,
    clientLabel: "agent",
    sessionId: "s",
    createdAt: 500,
    expiresAt: 2_000,
    agentDoorLegacy: legacy,
  });
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  cap = resolveCaptureCapability(
    {
      ok: true,
      config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
    },
    { capabilitiesDisabled: new Set<string>() },
  );
  calls = [];
  verdict = { kind: "proposable", basis: "approved" };
  configured = true;
  refusal = undefined;
  refusalBasis = [];
  verify = async () => {
    calls.push("verify");
    return { ok: true };
  };
  deps = {
    db,
    store: new CaptureStore(db),
    capability: () => cap,
    classifyAction: () => {
      calls.push("classify");
      return verdict;
    },
    isServiceConfigured: async () => {
      calls.push("configured");
      return configured;
    },
    now: () => 1_000,
    actionDestinationRefusal: (_t, _i, basis) => {
      calls.push("refusal");
      refusalBasis.push(basis);
      return refusal;
    },
    verifyActionDefinition: (t) => verify(t),
  };
  insertAction(false);
});
afterEach(() => db.close());

const row = (): CaptureRow => deps.store.get("cap_a") as CaptureRow;

function act(
  out: Awaited<ReturnType<ActDeps["execute"]>>,
  humanOnly: boolean | "absent" = true,
): ActDeps & { provenance: ActionProvenance[] } {
  const provenance: ActionProvenance[] = [];
  return {
    provenance,
    ...(humanOnly === "absent" ? {} : { humanOnly }),
    execute: async (_t, _i, p) => {
      provenance.push(p);
      return out;
    },
  };
}

async function codeOf(p: Promise<unknown>): Promise<CaptureError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CaptureError) return e;
    throw e;
  }
  throw new Error("expected CaptureError");
}

function acceptAudits(): number {
  return (
    db
      .query("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'capture.action.accept'")
      .get() as {
      n: number;
    }
  ).n;
}

describe("step 4: each refusal leaves the row proposed, claims nothing and writes no accept row", () => {
  async function expectRefused(
    code: CaptureErrorCode,
    a: ActDeps = act({ status: "ok", result: {} }),
  ) {
    const err = await codeOf(acceptAction(deps, OWNER, row(), a));
    expect(err.code).toBe(code);
    expect(row().state).toBe("proposed");
    expect(acceptAudits()).toBe(0);
    return err;
  }

  test("4a a suspended verdict is ERR_AGENT_TOOL_SUSPENDED", async () => {
    verdict = { kind: "suspended" };
    await expectRefused("ERR_AGENT_TOOL_SUSPENDED");
    expect(calls).toEqual(["classify"]);
  });
  test("4a a denied or unknown verdict is NOT_PROPOSABLE", async () => {
    verdict = { kind: "denied", class: "agent_not_approved" };
    await expectRefused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
    verdict = { kind: "unknown" };
    await expectRefused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
  });
  test("4b an unconfigured service", async () => {
    configured = false;
    await expectRefused("ERR_CAPTURE_CONNECTOR_UNCONFIGURED");
    expect(calls).toEqual(["classify", "configured"]);
  });
  test("4c the refusal for the approval-time basis", async () => {
    refusal = "fixed";
    await expectRefused("ERR_CAPTURE_ACTION_REFUSED");
    expect(refusalBasis).toEqual(["approved"]);
    expect(calls).toEqual(["classify", "configured", "refusal"]);
  });
  test("4e a definition check that fails at approval refuses with its code", async () => {
    verify = async () => ({
      ok: false,
      code: "ERR_AGENT_TOOL_SUSPENDED",
      detail: "changed since approval",
    });
    const err = await expectRefused("ERR_AGENT_TOOL_SUSPENDED");
    expect(err.message).toContain("changed since approval");
    verify = async () => ({
      ok: false,
      code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      detail: "not listed",
    });
    await expectRefused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
  });
  test("4e a definition check that throws, and an absent one, refuse an approved basis", async () => {
    verify = async () => {
      throw new Error("mesh");
    };
    await expectRefused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
    Reflect.deleteProperty(deps, "verifyActionDefinition");
    await expectRefused("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
  });
  test("4d an approved basis needs a human-only executor, and the refusal names the owner's command", async () => {
    const err = await expectRefused(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
      act({ status: "ok", result: {} }, false),
    );
    expect(err.message).toContain("nimbus approvals cap_a");
    await expectRefused(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
      act({ status: "ok", result: {} }, "absent"),
    );
  });
  test("4d is checked before the connector is listed", async () => {
    await codeOf(acceptAction(deps, OWNER, row(), act({ status: "ok", result: {} }, false)));
    expect(calls).not.toContain("verify");
  });
});

describe("the basis used after step 4 is the approval-time one", () => {
  test("a legacy basis never calls the definition check and is not held to the human-only rule", async () => {
    verdict = { kind: "proposable", basis: "legacy_unapproved" };
    const a = act({ status: "rejected" }, false);
    const out = await acceptAction(deps, OWNER, row(), a);
    expect(out.state).toBe("rejected");
    expect(calls).not.toContain("verify");
    expect(a.provenance[0]?.basis).toBe("legacy_unapproved");
  });

  test("a row queued approved whose approval was withdrawn is accepted as legacy", async () => {
    verdict = { kind: "proposable", basis: "legacy_mail_send" };
    const a = act({ status: "ok", result: {} });
    await acceptAction(deps, OWNER, row(), a);
    expect(a.provenance[0]?.basis).toBe("legacy_mail_send");
    expect(refusalBasis).toEqual(["legacy_mail_send"]);
  });

  test("a row queued legacy and since approved by name is held to the approved rules", async () => {
    db.run("DELETE FROM capture");
    insertAction(true);
    const a = act({ status: "ok", result: {} }, false);
    expect((await codeOf(acceptAction(deps, OWNER, row(), a))).code).toBe(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
    );
    const b = act({ status: "ok", result: {} });
    await acceptAction(deps, OWNER, row(), b);
    expect(refusalBasis.at(-1)).toBe("approved");
    expect(calls).toContain("verify");
    expect(b.provenance[0]?.basis).toBe("approved");
  });

  test("a verdict with no basis (user-MCP, today's wiring) is unchanged: no definition check, no human-only rule", async () => {
    verdict = { kind: "proposable", userMcp: true };
    Reflect.deleteProperty(deps, "verifyActionDefinition");
    const a = act({ status: "ok", result: {} }, "absent");
    expect((await acceptAction(deps, OWNER, row(), a)).state).toBe("executed");
    expect(a.provenance[0]?.basis).toBeUndefined();
    expect(refusalBasis).toEqual([undefined]);
  });

  test("a basis-less verdict without the user-MCP marker is refused at approval and the row stays proposed", async () => {
    verdict = { kind: "proposable" };
    const a = act({ status: "ok", result: {} }, "absent");
    const e = await codeOf(acceptAction(deps, OWNER, row(), a));
    expect(e.code).toBe("ERR_CAPTURE_ACTION_NOT_PROPOSABLE");
    expect(e.message).toContain("agent_no_basis");
    expect(a.provenance).toHaveLength(0);
    expect(row().state).toBe("proposed");
    expect(acceptAudits()).toBe(0);
  });

  test("the order: verdict, configured, refusal, human-only, definition, then the claim", async () => {
    await acceptAction(deps, OWNER, row(), act({ status: "ok", result: {} }));
    expect(calls).toEqual(["classify", "configured", "refusal", "verify"]);
    expect(acceptAudits()).toBe(1);
  });
});

describe("finalize stores the code of a rejected action", () => {
  test("a code is stored, audited and visible to the submitting agent; the reason stays on the owner's reply", async () => {
    const out = await acceptAction(
      deps,
      OWNER,
      row(),
      act({ status: "rejected", reason: "fixed owner text", code: "ERR_AGENT_TOOL_SUSPENDED" }),
    );
    expect(out).toMatchObject({
      state: "rejected",
      errorCode: "ERR_AGENT_TOOL_SUSPENDED",
      reason: "fixed owner text",
    });
    expect(row().state).toBe("rejected");
    expect(row().errorCode).toBe("ERR_AGENT_TOOL_SUSPENDED");
    const audit = db
      .query("SELECT action_json FROM audit_log WHERE action_type = 'capture.action.outcome'")
      .get() as { action_json: string };
    expect(JSON.parse(audit.action_json)).toMatchObject({
      outcome: "rejected",
      errorCode: "ERR_AGENT_TOOL_SUSPENDED",
    });
    const deps2 = {
      ...deps,
      limiter: new CaptureAttemptLimiter(),
      refusals: new CaptureRefusalCounter(),
      newId: () => "x",
    };
    expect(captureStateFor(deps2 as never, { clientId: "s", kind: "mcp" }, "cap_a")).toMatchObject({
      state: "rejected",
      errorCode: "ERR_AGENT_TOOL_SUSPENDED",
    });
  });

  test("a plain decline stores no code", async () => {
    const out = await acceptAction(deps, OWNER, row(), act({ status: "rejected", reason: "no" }));
    expect(out.errorCode).toBeUndefined();
    expect(row().errorCode).toBeNull();
  });
});
