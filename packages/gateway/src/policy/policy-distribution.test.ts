import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { servePolicy } from "./policy-distribution.ts";
import { PolicyStore } from "./policy-store.ts";

function db36(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  return db;
}

describe("servePolicy (anchor side)", () => {
  test("returns the persisted {toml, sig} for a known policy", () => {
    const db = db36();
    const store = new PolicyStore(db);
    store.persist({
      toml: 'org="acme"\n',
      sig: "S1",
      org: "acme",
      version: 1,
      source: "anchor",
      fetchedAt: 1,
    });
    expect(servePolicy(store)).toEqual({ toml: 'org="acme"\n', sig: "S1" });
  });
  test("returns null when the anchor has no policy", () => {
    expect(servePolicy(new PolicyStore(db36()))).toBeNull();
  });
});
