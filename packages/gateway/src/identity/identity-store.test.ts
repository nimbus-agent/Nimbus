// identity-store.test.ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { IdentityStore } from "./identity-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return db;
}

describe("IdentityStore", () => {
  let db: Database;
  let store: IdentityStore;
  beforeEach(() => {
    db = freshDb();
    store = new IdentityStore(db);
  });

  test("upsertSession + getSession round-trips", () => {
    store.upsertSession({
      issuer: "https://acme",
      externalId: "sub-1",
      email: "a@acme.com",
      validatedAt: 1000,
      expiresAt: 2000,
      status: "active",
    });
    const s = store.getSession("https://acme");
    expect(s?.externalId).toBe("sub-1");
    expect(s?.status).toBe("active");
  });

  test("scim upsert + setActive + getByExternalId", () => {
    store.upsertScimUser(
      { externalId: "u1", userName: "alice", email: "a@acme.com", active: true, attrs: {} },
      10,
    );
    store.setScimActive("u1", false, 20);
    expect(store.getScimUser("u1")?.active).toBe(false);
  });

  test("bindings: bind, list active by externalId, revoke", () => {
    store.bind("u1", "peer:aa", "admin", 30);
    store.bind("u1", "peer:bb", "handshake", 31);
    expect(store.activePeerIdsFor("u1").sort((a, b) => a.localeCompare(b))).toEqual([
      "peer:aa",
      "peer:bb",
    ]);
    store.revokeBinding("peer:aa", 40);
    expect(store.activePeerIdsFor("u1")).toEqual(["peer:bb"]);
  });
});
