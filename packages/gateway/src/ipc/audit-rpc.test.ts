import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { AuditRpcError, dispatchAuditRpc } from "./audit-rpc.ts";

function seededIndex(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const idx = new LocalIndex(db);
  idx.recordAudit({ actionType: "x", hitlStatus: "approved", actionJson: "{}", timestamp: 1 });
  return idx;
}

describe("dispatchAuditRpc", () => {
  test("returns miss for non-audit method", async () => {
    const out = await dispatchAuditRpc("foo.bar", {}, { index: seededIndex() });
    expect(out.kind).toBe("miss");
  });

  test("audit.verify returns { ok: true, verifiedRows: 1 }", async () => {
    const idx = seededIndex();
    const out = await dispatchAuditRpc("audit.verify", {}, { index: idx });
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const value = out.value as { ok: boolean; verifiedRows: number };
      expect(value.ok).toBe(true);
      expect(value.verifiedRows).toBe(1);
    }
  });

  test("audit.verify --full reruns from 0 regardless of cursor", async () => {
    const idx = seededIndex();
    idx.setAuditVerifiedThroughId(999);
    const out = await dispatchAuditRpc("audit.verify", { full: true }, { index: idx });
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      expect((out.value as { verifiedRows: number }).verifiedRows).toBe(1);
    }
  });

  test("audit.exportAll returns every row with chain fields", async () => {
    const out = await dispatchAuditRpc("audit.exportAll", {}, { index: seededIndex() });
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const rows = out.value as Array<{ rowHash: string; prevHash: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rowHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("throws AuditRpcError when index not configured", async () => {
    await expect(dispatchAuditRpc("audit.verify", {}, { index: undefined })).rejects.toBeInstanceOf(
      AuditRpcError,
    );
  });
});

describe("audit.getSummary", () => {
  test("returns counts grouped by outcome and total", async () => {
    const idx = seededIndex();
    const r = await dispatchAuditRpc("audit.getSummary", null, { index: idx });
    expect(r.kind).toBe("hit");
    const v = (
      r as {
        kind: "hit";
        value: {
          byOutcome: Record<string, number>;
          byService: Record<string, number>;
          total: number;
        };
      }
    ).value;
    expect(v.total).toBe(1);
    expect(typeof v.byOutcome).toBe("object");
    expect(typeof v.byService).toBe("object");
  });

  test("throws AuditRpcError when index not configured", async () => {
    await expect(
      dispatchAuditRpc("audit.getSummary", null, { index: undefined }),
    ).rejects.toBeInstanceOf(AuditRpcError);
  });
});

describe("audit.export alias", () => {
  test("audit.export returns same shape as audit.exportAll", async () => {
    const idx = seededIndex();
    const r1 = await dispatchAuditRpc("audit.exportAll", null, { index: seededIndex() });
    const r2 = await dispatchAuditRpc("audit.export", null, { index: idx });
    expect(r1.kind).toBe("hit");
    expect(r2.kind).toBe("hit");
    const rows1 = (r1 as { kind: "hit"; value: unknown }).value as Array<{ rowHash: string }>;
    const rows2 = (r2 as { kind: "hit"; value: unknown }).value as Array<{ rowHash: string }>;
    expect(rows1).toHaveLength(rows2.length);
  });
});

describe("Phase 28 AD4: audit.proveByProposer and audit.listByDoor", () => {
  const METHODS = ["audit.proveByProposer", "audit.listByDoor"] as const;
  const PARAMS: Record<(typeof METHODS)[number], unknown> = {
    "audit.proveByProposer": {},
    "audit.listByDoor": { door: "agent" },
  };

  test("both answer a connection that declared cli or ui", async () => {
    for (const kind of ["cli", "ui"] as const) {
      for (const m of METHODS) {
        const out = await dispatchAuditRpc(m, PARAMS[m], {
          index: seededIndex(),
          callerKind: kind,
        });
        expect(out.kind).toBe("hit");
        if (out.kind === "hit") {
          expect((out.value as { labelsVerified: boolean }).labelsVerified).toBe(false);
        }
      }
    }
  });

  test("both refuse every other kind, and a missing kind, BEFORE any read", async () => {
    for (const kind of ["mcp", "unknown", "http", "chatops", "fleet", "push", undefined] as const) {
      for (const m of METHODS) {
        // No index at all: a refusal that came after the index check would be -32603, not -32001.
        const err = await dispatchAuditRpc(m, PARAMS[m], {
          index: undefined,
          ...(kind === undefined ? {} : { callerKind: kind }),
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AuditRpcError);
        expect((err as AuditRpcError).rpcCode).toBe(-32001);
      }
    }
  });

  test("bad params are -32602 (the kind is checked first)", async () => {
    const ctx = { index: seededIndex(), callerKind: "cli" as const };
    const bad: Array<[string, unknown]> = [
      ["audit.proveByProposer", "x"],
      ["audit.proveByProposer", { sinceMs: -1 }],
      ["audit.proveByProposer", { sinceMs: 1.5 }],
      ["audit.proveByProposer", { untilMs: "x" }],
      ["audit.proveByProposer", { sinceMs: 10, untilMs: 5 }],
      ["audit.proveByProposer", { proposer: 5 }],
      ["audit.proveByProposer", { proposer: "" }],
      ["audit.listByDoor", undefined],
      ["audit.listByDoor", {}],
      ["audit.listByDoor", { door: "owner" }],
      ["audit.listByDoor", { door: "agent", limit: 0 }],
      ["audit.listByDoor", { door: "agent", limit: 1001 }],
      ["audit.listByDoor", { door: "model", proposer: "x" }],
      ["audit.listByDoor", { door: "agent", proposer: "x".repeat(401) }],
    ];
    for (const [m, p] of bad) {
      const err = await dispatchAuditRpc(m, p, ctx).catch((e: unknown) => e);
      expect((err as AuditRpcError).rpcCode, `${m} ${JSON.stringify(p)}`).toBe(-32602);
    }
  });

  test("without an index it fails with -32603 once the kind is right", async () => {
    const err = await dispatchAuditRpc(
      "audit.listByDoor",
      { door: "agent" },
      {
        index: undefined,
        callerKind: "cli",
      },
    ).catch((e: unknown) => e);
    expect((err as AuditRpcError).rpcCode).toBe(-32603);
  });

  test("the proof runs both chain verifies and reports a broken chain as indeterminate", async () => {
    const idx = seededIndex();
    idx.rawDb.run("UPDATE audit_log SET action_json = '{\"t\":1}' WHERE id = 1");
    const out = await dispatchAuditRpc(
      "audit.proveByProposer",
      {},
      { index: idx, callerKind: "cli" },
    );
    if (out.kind !== "hit") throw new Error("expected hit");
    const proof = out.value as { completeness: { status: string; causes: string[] } };
    expect(proof.completeness.status).toBe("indeterminate");
    expect(proof.completeness.causes).toContain("audit_chain_broken");
    expect(proof.completeness.causes).toContain("coverage_none");
  });

  test("the unmodified audit methods still answer without a kind", async () => {
    const out = await dispatchAuditRpc("audit.getSummary", {}, { index: seededIndex() });
    expect(out.kind).toBe("hit");
  });
});
