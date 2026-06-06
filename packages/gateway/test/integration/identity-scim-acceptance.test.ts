// identity-scim-acceptance.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SessionConsentCache } from "../../src/federation/consent-cache.ts";
import { NamespaceStore } from "../../src/federation/namespace-store.ts";
import { answerFederatedQuery } from "../../src/federation/query-gate.ts";
import { IdentityStore } from "../../src/identity/identity-store.ts";
import { runIndexedSchemaMigrations } from "../../src/index/migrations/runner.ts";
import { HttpWriteRateLimiter } from "../../src/ipc/http-rate-limit.ts";
import { dispatchWriteRoute } from "../../src/ipc/http-write-routes.ts";

describe("Slice 3 acceptance — SCIM deprovision revokes federation access", () => {
  test("IdP DELETE /scim/v2/Users/{id} → peer's next federated query is no_grant", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 34);
    const store = new NamespaceStore(db);
    const identity = new IdentityStore(db);
    store.publish("project:zurich", [{ kind: "service", value: "github" }]);
    store.grant("project:zurich", "peer:alice", "viewer", true);
    identity.upsertScimUser(
      { externalId: "u-alice", userName: "alice", email: "a@acme.com", active: true, attrs: {} },
      1,
    );
    identity.bind("u-alice", "peer:alice", "admin", 1);

    const req = new Request("http://127.0.0.1/scim/v2/Users/u-alice", {
      method: "DELETE",
      headers: { authorization: "Bearer scim-secret" },
    });
    const res = await dispatchWriteRoute(req, {
      writeDb: db,
      expectedToken: "",
      rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
      nowMs: () => 2,
      knownServices: () => [],
      scim: { token: "scim-secret", store, identity },
    });
    expect(res.status).toBe(204);

    const gate = {
      db,
      store,
      consentCache: new SessionConsentCache(),
      prompt: async () => "approved" as const,
      consentTimeoutMs: 100,
    };
    const after = await answerFederatedQuery(gate, {
      peerId: "peer:alice",
      request: { namespace: "project:zurich", purpose: "p" },
    });
    expect(after.kind).toBe("error");
    if (after.kind === "error") expect(after.error).toBe("no_grant");
  });
});
