import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { DelegationStore } from "./delegation-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  return db;
}

describe("DelegationStore", () => {
  let store: DelegationStore;
  beforeEach(() => {
    store = new DelegationStore(freshDb());
  });

  it("creates a delegation and finds the active delegate for an in-scope action", () => {
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "action_type",
      scopeValue: "iac.terraform.apply",
      expiresAt: 10_000,
      nowMs: 1000,
    });
    expect(store.activeDelegateFor("action_type", "iac.terraform.apply", "peer:bob", 5000)).toBe(
      true,
    );
    expect(store.activeDelegateFor("action_type", "iac.terraform.apply", "peer:eve", 5000)).toBe(
      false,
    );
    expect(store.activeDelegateFor("action_type", "email.send", "peer:bob", 5000)).toBe(false);
  });

  it("treats an expired delegation as inactive", () => {
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "service",
      scopeValue: "aws",
      expiresAt: 2000,
      nowMs: 1000,
    });
    expect(store.activeDelegateFor("service", "aws", "peer:bob", 3000)).toBe(false);
  });

  it("revoked delegation is inactive immediately", () => {
    const id = store.create({
      delegatePeer: "peer:bob",
      scopeKind: "service",
      scopeValue: "aws",
      expiresAt: 10_000,
      nowMs: 1000,
    });
    store.revoke(id, 1500);
    expect(store.activeDelegateFor("service", "aws", "peer:bob", 2000)).toBe(false);
  });

  it("lists active delegations", () => {
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "service",
      scopeValue: "aws",
      expiresAt: 10_000,
      nowMs: 1000,
    });
    expect(store.listActive(5000).length).toBe(1);
  });

  it("activeDelegateePeer resolves via action_type OR service scope", () => {
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "service",
      scopeValue: "aws",
      expiresAt: 9e9,
      nowMs: 1,
    });
    expect(store.activeDelegateePeer("aws.ec2.instance.stop", "aws", 5)).toBe("peer:bob");
    expect(store.activeDelegateePeer("slack.message.post", "slack", 5)).toBeUndefined();
  });
});
