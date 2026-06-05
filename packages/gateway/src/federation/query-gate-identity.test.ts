import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { SessionConsentCache } from "./consent-cache.ts";
import { NamespaceStore } from "./namespace-store.ts";
import { answerFederatedQuery } from "./query-gate.ts";

function baseCtx(db: Database) {
  const store = new NamespaceStore(db);
  store.publish("ns", [{ kind: "service", value: "github" }]);
  store.grant("ns", "peer:alice", "viewer", true);
  return {
    db,
    store,
    consentCache: new SessionConsentCache(),
    prompt: async () => "approved" as const,
    consentTimeoutMs: 100,
  };
}
function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}
const q = { peerId: "peer:alice", request: { namespace: "ns", purpose: "p" } };

describe("I18 — operator identity gates federated answering", () => {
  test("invalid operator → opaque no_grant (peer learns nothing); audited as identity_invalid", async () => {
    const db = freshDb();
    const ctx = { ...baseCtx(db), identity: { enabled: true, isOperatorValid: () => false } };
    const r = await answerFederatedQuery(ctx, q);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toBe("no_grant");
    const row = db.query("SELECT action_type FROM audit_log ORDER BY id DESC LIMIT 1").get() as {
      action_type: string;
    };
    expect(row.action_type).toContain("identity_invalid");
  });

  test("valid operator → answers normally", async () => {
    const db = freshDb();
    const ctx = { ...baseCtx(db), identity: { enabled: true, isOperatorValid: () => true } };
    expect((await answerFederatedQuery(ctx, q)).kind).toBe("ok");
  });

  test("identity disabled → unaffected (answers)", async () => {
    const db = freshDb();
    expect((await answerFederatedQuery(baseCtx(db), q)).kind).toBe("ok");
  });
});
