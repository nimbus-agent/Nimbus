import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { NamespaceStore } from "./namespace-store.ts";

let db: Database;
let store: NamespaceStore;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  store = new NamespaceStore(db);
});
afterEach(() => db.close());

test("publish creates a namespace with declared filters", () => {
  store.publish("project:zurich", [
    { kind: "service", value: "github" },
    { kind: "type", value: "pull_request" },
  ]);
  const ns = store.getByName("project:zurich");
  expect(ns?.name).toBe("project:zurich");
  expect(ns?.filters).toEqual([
    { kind: "service", value: "github" },
    { kind: "type", value: "pull_request" },
  ]);
});

test("grant + getGrant returns an active grant; revoke makes it inactive", () => {
  store.publish("project:zurich", [{ kind: "type", value: "pull_request" }]);
  store.grant("project:zurich", "peerA", "viewer", false);
  const g = store.getActiveGrant("project:zurich", "peerA");
  expect(g?.role).toBe("viewer");
  expect(g?.standingConsent).toBe(false);

  store.revoke("project:zurich", "peerA");
  expect(store.getActiveGrant("project:zurich", "peerA")).toBeUndefined();
});

test("getActiveGrant returns undefined for an unknown peer or namespace", () => {
  expect(store.getActiveGrant("nope", "peerA")).toBeUndefined();
});

test("declaredTypes returns only the 'type' filters", () => {
  store.publish("p", [
    { kind: "service", value: "github" },
    { kind: "type", value: "pull_request" },
    { kind: "type", value: "issue" },
  ]);
  expect(store.declaredTypes("p").sort()).toEqual(["issue", "pull_request"]);
  expect(store.declaredServices("p")).toEqual(["github"]);
});

test("re-publish replaces the filter set idempotently (upsert)", () => {
  store.publish("p", [{ kind: "type", value: "pull_request" }]);
  store.publish("p", [{ kind: "type", value: "issue" }]);
  expect(store.declaredTypes("p")).toEqual(["issue"]);
});

test("grant with standing consent round-trips standingConsent=true", () => {
  store.publish("project:zurich", [{ kind: "type", value: "pull_request" }]);
  store.grant("project:zurich", "peerA", "owner", true);
  const g = store.getActiveGrant("project:zurich", "peerA");
  expect(g?.standingConsent).toBe(true);
  expect(g?.role).toBe("owner");
});

test("publish with an empty filter set yields a namespace with no declared types/services", () => {
  store.publish("empty", []);
  expect(store.getByName("empty")?.filters).toEqual([]);
  expect(store.declaredTypes("empty")).toEqual([]);
  expect(store.declaredServices("empty")).toEqual([]);
});
