// deprovision.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SessionConsentCache } from "../federation/consent-cache.ts";
import { NamespaceStore } from "../federation/namespace-store.ts";
import { answerFederatedQuery } from "../federation/query-gate.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { deprovisionUser } from "./deprovision.ts";
import { IdentityStore } from "./identity-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}

describe("deprovisionUser", () => {
  test("revokes all bound peers' grants; the peer's next query returns no_grant", async () => {
    const db = freshDb();
    const ns = new NamespaceStore(db);
    const ids = new IdentityStore(db);
    ns.publish("project:zurich", [{ kind: "service", value: "github" }]);
    ns.grant("project:zurich", "peer:alice", "viewer", true);
    ids.upsertScimUser(
      { externalId: "u-alice", userName: "alice", email: "a@acme.com", active: true, attrs: {} },
      1,
    );
    ids.bind("u-alice", "peer:alice", "admin", 1);

    const ctx = {
      db,
      store: ns,
      consentCache: new SessionConsentCache(),
      prompt: async () => "approved" as const,
      consentTimeoutMs: 1000,
    };
    // Before deprovision: a standing-consent grant answers (ok).
    const before = await answerFederatedQuery(ctx, {
      peerId: "peer:alice",
      request: { namespace: "project:zurich", purpose: "p" },
    });
    expect(before.kind).toBe("ok");

    const revoked = deprovisionUser({ db, store: ns, identity: ids, nowMs: 2 }, "u-alice");
    expect(revoked).toContain("peer:alice");

    const after = await answerFederatedQuery(ctx, {
      peerId: "peer:alice",
      request: { namespace: "project:zurich", purpose: "p" },
    });
    expect(after.kind).toBe("error");
    if (after.kind === "error") expect(after.error).toBe("no_grant");
    expect(ids.getScimUser("u-alice")?.active).toBe(false);
  });

  test("skips continue branch for namespaces where peer has no active grant", () => {
    const db = freshDb();
    const ns = new NamespaceStore(db);
    const ids = new IdentityStore(db);
    // Publish two namespaces; grant the peer only in ns:has (ns:none has no grant).
    ns.publish("ns:has", [{ kind: "service", value: "github" }]);
    ns.publish("ns:none", [{ kind: "service", value: "github" }]);
    ns.grant("ns:has", "peer:alice", "viewer", true);
    ids.upsertScimUser(
      { externalId: "u-alice", userName: "alice", email: "a@acme.com", active: true, attrs: {} },
      1,
    );
    ids.bind("u-alice", "peer:alice", "admin", 1);

    const revoked = deprovisionUser({ db, store: ns, identity: ids, nowMs: 2 }, "u-alice");

    // The peer is still returned even though ns:none was skipped via continue.
    expect(revoked).toContain("peer:alice");
    // The grant in ns:has was revoked (continue was NOT taken here).
    expect(ns.getActiveGrant("ns:has", "peer:alice")).toBeUndefined();
    // The SCIM user was deactivated.
    expect(ids.getScimUser("u-alice")?.active).toBe(false);
    // ns:none had no grant, so the continue branch was taken — revoke was never called for it.
    // Confirm it remains undefined (nothing to revoke, nothing changed).
    expect(ns.getActiveGrant("ns:none", "peer:alice")).toBeUndefined();
  });

  test("rolls back atomically — a mid-cascade failure leaves NO grant revoked (review P1)", () => {
    const db = freshDb();
    const ids = new IdentityStore(db);
    // A store whose revoke throws on the 2nd namespace, simulating a mid-loop write failure.
    let calls = 0;
    const failingStore = Object.assign(new NamespaceStore(db), {
      revoke(name: string, peerId: string, nowMs?: number): void {
        calls += 1;
        if (calls === 2) throw new Error("simulated write failure");
        NamespaceStore.prototype.revoke.call(this, name, peerId, nowMs);
      },
    });
    failingStore.publish("ns:a", [{ kind: "service", value: "github" }]);
    failingStore.publish("ns:b", [{ kind: "service", value: "github" }]);
    failingStore.grant("ns:a", "peer:alice", "viewer", true);
    failingStore.grant("ns:b", "peer:alice", "viewer", true);
    ids.upsertScimUser(
      { externalId: "u-alice", userName: "alice", email: "a@acme.com", active: true, attrs: {} },
      1,
    );
    ids.bind("u-alice", "peer:alice", "admin", 1);

    expect(() =>
      deprovisionUser({ db, store: failingStore, identity: ids, nowMs: 2 }, "u-alice"),
    ).toThrow();
    // Transaction rolled back: BOTH grants remain, scim_user still active, binding intact.
    expect(failingStore.getActiveGrant("ns:a", "peer:alice")).toBeDefined();
    expect(failingStore.getActiveGrant("ns:b", "peer:alice")).toBeDefined();
    expect(ids.getScimUser("u-alice")?.active).toBe(true);
    expect(ids.activePeerIdsFor("u-alice")).toEqual(["peer:alice"]);
  });
});
