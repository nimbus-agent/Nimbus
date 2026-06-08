import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { answerFederatedAuditExport, exportFederationAudit } from "./audit-export.ts";
import { SessionConsentCache } from "./consent-cache.ts";
import { NamespaceStore } from "./namespace-store.ts";
import type { ConsentPrompter } from "./query-gate.ts";

function dbWithAudit(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  appendAuditEntry(db, {
    actionType: "federation.query",
    hitlStatus: "not_required",
    actionJson: '{"q":"secret"}',
    timestamp: 100,
  });
  appendAuditEntry(db, {
    actionType: "ask",
    hitlStatus: "not_required",
    actionJson: "{}",
    timestamp: 200,
  });
  return db;
}

describe("exportFederationAudit", () => {
  test("returns ONLY federation-prefixed entries, metadata only (no action_json)", () => {
    const rows = exportFederationAudit(dbWithAudit(), { sinceMs: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionType).toBe("federation.query");
    expect(JSON.stringify(rows[0])).not.toContain("secret");
    expect((rows[0] as unknown as Record<string, unknown>)["actionJson"]).toBeUndefined();
  });

  test("respects sinceMs", () => {
    const db = dbWithAudit();
    appendAuditEntry(db, {
      actionType: "federation.invoke",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: 300,
    });
    expect(exportFederationAudit(db, { sinceMs: 250 }).map((r) => r.actionType)).toEqual([
      "federation.invoke",
    ]);
  });
});

const autoApprove: ConsentPrompter = async () => "approved";

/** A db pre-seeded with one federation row + one non-federation row (so an "answered" export has
 *  exactly one metadata-only entry to return) at schema V36. */
function gateDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  appendAuditEntry(db, {
    actionType: "federation.query",
    hitlStatus: "not_required",
    actionJson: '{"q":"secret"}',
    timestamp: 100,
  });
  appendAuditEntry(db, {
    actionType: "ask",
    hitlStatus: "not_required",
    actionJson: "{}",
    timestamp: 200,
  });
  return db;
}

function gateCtx(
  db: Database,
  store: NamespaceStore,
  opts: {
    consent?: ConsentPrompter;
    cache?: SessionConsentCache;
    identity?: { enabled: boolean; isOperatorValid: () => boolean };
  } = {},
) {
  return {
    db,
    store,
    consentCache: opts.cache ?? new SessionConsentCache(),
    prompt: opts.consent ?? autoApprove,
    consentTimeoutMs: 1000,
    now: () => 500,
    ...(opts.identity ? { identity: opts.identity } : {}),
  };
}

/** Count of gate-decision audit rows this handler wrote (method=federation.auditExport). */
function auditExportRows(db: Database): { decision: string }[] {
  return db
    .query(
      "SELECT federation_json FROM audit_log WHERE federation_json IS NOT NULL ORDER BY id ASC",
    )
    .all()
    .map((r) => JSON.parse((r as { federation_json: string }).federation_json))
    .filter((j: { method: string }) => j.method === "federation.auditExport")
    .map((j: { decision: string }) => ({ decision: j.decision }));
}

const req = {
  peerId: "peerA",
  namespace: "project:zurich",
  purpose: "audit-review",
  sinceMs: 0,
};

describe("answerFederatedAuditExport — gate paths (mirrors query-gate)", () => {
  test("(a) no grant for the namespace => no_grant, no entries leak, audited", async () => {
    const db = gateDb();
    const store = new NamespaceStore(db);
    store.publish("project:zurich", [{ kind: "service", value: "github" }]);
    // no grant issued for peerA
    const res = await answerFederatedAuditExport(gateCtx(db, store), req);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.error).toBe("no_grant");
    // No "answered" outcome leaks data: the result carries no entries field.
    expect((res as unknown as Record<string, unknown>)["entries"]).toBeUndefined();
    // FIX 1: a federation.auditExport gate-decision row was written for this rejection.
    expect(auditExportRows(db)).toEqual([{ decision: "no_grant" }]);
  });

  test("(b) standing consent => ok with federation metadata-only entries", async () => {
    const db = gateDb();
    const store = new NamespaceStore(db);
    store.publish("project:zurich", [{ kind: "service", value: "github" }]);
    store.grant("project:zurich", "peerA", "viewer", true);
    const res = await answerFederatedAuditExport(gateCtx(db, store), req);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // Only federation-prefixed rows are returned (the non-federation "ask" row is excluded).
    // The seed `federation.query` row is present; the gate also audits its own "answered"
    // decision as a `federation.answer.answered` row, which is itself federation-prefixed.
    const types = res.entries.map((e) => e.actionType);
    expect(types).toContain("federation.query");
    expect(types.every((t) => t.startsWith("federation."))).toBe(true);
    expect(types).not.toContain("ask");
    // Metadata-only: no action_json field, no leaked row content.
    for (const e of res.entries) {
      expect((e as unknown as Record<string, unknown>)["actionJson"]).toBeUndefined();
      expect(Object.keys(e).sort((a, b) => a.localeCompare(b))).toEqual([
        "actionType",
        "hash",
        "hitlStatus",
        "timestamp",
      ]);
    }
    expect(JSON.stringify(res.entries)).not.toContain("secret");
    // FIX 1: the answered path audited its own decision.
    expect(auditExportRows(db).map((r) => r.decision)).toContain("answered");
  });

  test("(c) identity guard invalid (identity enabled) => opaque no_grant, audited as identity_invalid", async () => {
    const db = gateDb();
    const store = new NamespaceStore(db);
    store.publish("project:zurich", [{ kind: "service", value: "github" }]);
    store.grant("project:zurich", "peerA", "viewer", true);
    const res = await answerFederatedAuditExport(
      gateCtx(db, store, { identity: { enabled: true, isOperatorValid: () => false } }),
      req,
    );
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.error).toBe("no_grant");
    expect(auditExportRows(db)).toEqual([{ decision: "identity_invalid" }]);
  });

  test("(d) cached consent denial => consent_denied, audited", async () => {
    const db = gateDb();
    const store = new NamespaceStore(db);
    store.publish("project:zurich", [{ kind: "service", value: "github" }]);
    store.grant("project:zurich", "peerA", "viewer", false);
    const cache = new SessionConsentCache();
    cache.set("peerA", "project:zurich", false);
    const res = await answerFederatedAuditExport(gateCtx(db, store, { cache }), req);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.error).toBe("consent_denied");
    expect(auditExportRows(db)).toEqual([{ decision: "consent_denied" }]);
  });
});
