/**
 * Flagship 100% coverage for engine/executor.ts (the HITL consent gate — invariants I2/I3/I4).
 * Pairs with engine.test.ts / executor-delegation.test.ts / audit-payload-safety.test.ts; this
 * file closes the last uncovered lines + branches (the HITL_REQUIRED facade methods, the
 * redact value-shape arms, the serviceOf helper, and the agent-request sessionId audit stamp)
 * so the file is pinned at 100% line+branch by the coverage-targets overlay.
 */
import { describe, expect, test } from "bun:test";

import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { agentRequestContext } from "./agent-request-context.ts";
import { redactPayloadForConsentDisplay } from "./executor.ts";
import { HITL_REQUIRED, ToolExecutor } from "./index.ts";
import { serviceOf } from "./service-of.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel } from "./types.ts";

type AuditRecord = Parameters<AuditSink["recordAudit"]>[0];

function approvingExecutor(auditCalls: AuditRecord[]): ToolExecutor {
  const consent: ConsentChannel = { requestApproval: () => Promise.resolve(true) };
  const audit: AuditSink = { recordAudit: (e) => auditCalls.push(e) };
  const connectors: ConnectorDispatcher = { dispatch: () => Promise.resolve({ ok: true }) };
  return new ToolExecutor(consent, audit, connectors, undefined, NULL_EGRESS_SINK);
}

describe("HITL_REQUIRED — frozen-set facade (full surface)", () => {
  test("size reflects the backing set and matches the iterator length", () => {
    expect(HITL_REQUIRED.size).toBeGreaterThan(80);
    expect([...HITL_REQUIRED]).toHaveLength(HITL_REQUIRED.size);
  });

  test("entries() yields [value, value] pairs (Set semantics)", () => {
    const entries = [...HITL_REQUIRED.entries()];
    expect(entries).toHaveLength(HITL_REQUIRED.size);
    expect(entries).toContainEqual(["email.send", "email.send"]);
  });

  test("keys() and values() both enumerate the action types", () => {
    const keys = [...HITL_REQUIRED.keys()];
    const values = [...HITL_REQUIRED.values()];
    expect(keys).toHaveLength(HITL_REQUIRED.size);
    expect(values).toHaveLength(HITL_REQUIRED.size);
    expect(keys).toContain("file.delete");
    expect(values).toContain("file.delete");
  });

  test("forEach visits every entry, binds thisArg, and passes (value, value, set)", () => {
    const collected: string[] = [];
    const thisArg = { marker: "bound" };
    const boundThis: unknown[] = [];
    HITL_REQUIRED.forEach(function callback(this: unknown, value, value2, set) {
      collected.push(value);
      boundThis.push(this);
      expect(value).toBe(value2); // Set.forEach passes the value twice
      expect(set).toBe(HITL_REQUIRED);
    }, thisArg);
    expect(collected).toHaveLength(HITL_REQUIRED.size);
    expect(collected).toContain("vault.delete");
    expect(boundThis.every((t) => t === thisArg)).toBe(true);
  });
});

describe("redactPayloadForConsentDisplay — every value shape", () => {
  test("returns null and primitives unchanged", () => {
    expect(redactPayloadForConsentDisplay(null)).toBeNull();
    expect(redactPayloadForConsentDisplay("plain")).toBe("plain");
    expect(redactPayloadForConsentDisplay(42)).toBe(42);
    expect(redactPayloadForConsentDisplay(true)).toBe(true);
    expect(redactPayloadForConsentDisplay(undefined)).toBeUndefined();
  });

  test("recurses into arrays, redacting sensitive keys inside object elements", () => {
    const out = redactPayloadForConsentDisplay([
      { apiToken: "leak", safe: "ok" },
      "scalar",
      ["nested", { secret: "leak2" }],
    ]) as unknown[];
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).toEqual({ apiToken: "[REDACTED]", safe: "ok" });
    expect(out[1]).toBe("scalar");
    expect((out[2] as unknown[])[1]).toEqual({ secret: "[REDACTED]" });
  });
});

describe("serviceOf", () => {
  test("returns the segment before the first dot", () => {
    expect(serviceOf("email.send")).toBe("email");
    expect(serviceOf("iac.terraform.apply")).toBe("iac");
  });

  test("returns the whole string when there is no dot", () => {
    expect(serviceOf("filesystem")).toBe("filesystem");
    expect(serviceOf("")).toBe("");
  });

  test('matches the legacy split(".")[0] semantics it replaced', () => {
    for (const t of ["email.send", "a.b.c", "nodot", "", ".leading", "trailing."]) {
      expect(serviceOf(t)).toBe(t.split(".")[0] ?? "");
    }
  });
});

describe("gate() — agent-request sessionId audit stamp", () => {
  test("stamps the audit record with the active agent-request sessionId", async () => {
    const auditCalls: AuditRecord[] = [];
    const exec = approvingExecutor(auditCalls);
    const result = await agentRequestContext.run({ sessionId: "session-xyz" }, () =>
      exec.gate({ type: "file.delete", payload: { path: "/tmp/x" } }),
    );
    expect(result).toBe("proceed");
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.sessionId).toBe("session-xyz");
  });

  test("omits sessionId entirely when there is no agent-request context", async () => {
    const auditCalls: AuditRecord[] = [];
    const exec = approvingExecutor(auditCalls);
    await exec.gate({ type: "filesystem.search" });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.sessionId).toBeUndefined();
    expect(Object.hasOwn(auditCalls[0] ?? {}, "sessionId")).toBe(false);
  });
});
