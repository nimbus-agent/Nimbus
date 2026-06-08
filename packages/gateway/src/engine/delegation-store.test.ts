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

  // L38 branch: nowMs omitted → falls through to Date.now() fallback
  it("create uses Date.now() when nowMs is not provided", () => {
    const before = Date.now();
    const id = store.create({
      delegatePeer: "peer:carol",
      scopeKind: "action_type",
      scopeValue: "deploy.run",
      expiresAt: before + 60_000,
      // intentionally omit nowMs to exercise the `?? Date.now()` branch
    });
    const after = Date.now();
    // The delegation must be active (created at a real wall-clock time within [before, after])
    expect(store.activeDelegateFor("action_type", "deploy.run", "peer:carol", before)).toBe(true);
    // listActive must surface exactly this entry
    const active = store.listActive(before);
    const match = active.find((d) => d.delegationId === id);
    expect(match).toBeDefined();
    expect(match?.createdAt).toBeGreaterThanOrEqual(before);
    expect(match?.createdAt).toBeLessThanOrEqual(after);
  });

  // L50 branch: nowMs omitted → default parameter Date.now() used for revoked_at
  it("revoke without explicit nowMs still marks the delegation as inactive", () => {
    const id = store.create({
      delegatePeer: "peer:dave",
      scopeKind: "service",
      scopeValue: "gcp",
      expiresAt: 9e9,
      nowMs: 1,
    });
    // Call revoke with no second argument to exercise the `nowMs = Date.now()` default
    store.revoke(id);
    // After revocation the delegation must be inactive regardless of query time
    expect(store.activeDelegateFor("service", "gcp", "peer:dave", 5)).toBe(false);
  });
});
