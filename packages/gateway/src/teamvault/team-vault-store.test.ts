import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { TeamVaultStore } from "./team-vault-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  return db;
}

describe("TeamVaultStore", () => {
  let db: Database;
  let store: TeamVaultStore;
  beforeEach(() => {
    db = freshDb();
    store = new TeamVaultStore(db);
  });

  it("creates an entry and lists it", () => {
    store.createEntry("prod-aws", "aws", "owner", 1000);
    expect(store.listEntries().map((e) => e.entry)).toContain("prod-aws");
  });

  it("grants then checkGrant returns true for the exact (entry,peer,tool)", () => {
    store.createEntry("prod-aws", "aws", "owner", 1000);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1000);
    expect(store.checkGrant("prod-aws", "peer:abc", "aws.ec2.instance.stop")).toBe(true);
    expect(store.checkGrant("prod-aws", "peer:abc", "aws.lambda.invoke")).toBe(false);
    expect(store.checkGrant("prod-aws", "peer:other", "aws.ec2.instance.stop")).toBe(false);
  });

  it("revoke makes checkGrant return false immediately (live-checked)", () => {
    store.createEntry("prod-aws", "aws", "owner", 1000);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1000);
    store.revoke("prod-aws", "peer:abc", "aws.ec2.instance.stop", 2000);
    expect(store.checkGrant("prod-aws", "peer:abc", "aws.ec2.instance.stop")).toBe(false);
  });

  it("re-grant after revoke re-activates (revoked_at cleared)", () => {
    store.createEntry("prod-aws", "aws", "owner", 1000);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1000);
    store.revoke("prod-aws", "peer:abc", "aws.ec2.instance.stop", 2000);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 3000);
    expect(store.checkGrant("prod-aws", "peer:abc", "aws.ec2.instance.stop")).toBe(true);
  });

  it("getEntry returns the bound service (drives which connector keys to inject)", () => {
    store.createEntry("prod-aws", "aws", "owner", 1000);
    expect(store.getEntry("prod-aws")?.service).toBe("aws");
    expect(store.getEntry("missing")).toBeUndefined();
  });
});
