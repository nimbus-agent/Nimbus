import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { deleteExtensionById, insertExtensionRow } from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  deleteRunGrant,
  type ExtensionRunGrantRow,
  getRunGrant,
  listRunGrants,
  upsertRunGrant,
} from "./run-grant-store.ts";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function db(): Database {
  const d = new Database(":memory:");
  LocalIndex.ensureSchema(d);
  open.push(d);
  return d;
}

function grant(over: Partial<ExtensionRunGrantRow> = {}): ExtensionRunGrantRow {
  return {
    extension_id: "com.example.a",
    service_id: "ext_com_example_a",
    version: "1.0.0",
    tree_digest: "a".repeat(64),
    permissions_json: '{"network":[],"read":[],"write":[]}',
    model_access: 0,
    approved_at: 1,
    ...over,
  };
}

function withExtension(d: Database): void {
  insertExtensionRow(d, {
    id: "com.example.a",
    version: "1.0.0",
    install_path: "/x",
    manifest_hash: "m",
    entry_hash: "e",
    enabled: 1,
    installed_at: 1,
    last_verified_at: 1,
  });
}

describe("run-grant-store", () => {
  test("upsert, get, list, delete round-trip", () => {
    const d = db();
    withExtension(d);
    expect(getRunGrant(d, "com.example.a")).toBeNull();
    upsertRunGrant(d, grant());
    expect(getRunGrant(d, "com.example.a")).toEqual(grant());
    upsertRunGrant(d, grant({ version: "1.1.0", tree_digest: "b".repeat(64), approved_at: 2 }));
    expect(listRunGrants(d)).toEqual([
      grant({ version: "1.1.0", tree_digest: "b".repeat(64), approved_at: 2 }),
    ]);
    expect(deleteRunGrant(d, "com.example.a")).toBe(true);
    expect(deleteRunGrant(d, "com.example.a")).toBe(false);
  });

  test("below V70 reads are empty and a write throws", () => {
    const d = new Database(":memory:");
    open.push(d);
    runIndexedSchemaMigrations(d, 69);
    expect(getRunGrant(d, "x")).toBeNull();
    expect(listRunGrants(d)).toEqual([]);
    expect(deleteRunGrant(d, "x")).toBe(false);
    expect(() => upsertRunGrant(d, grant())).toThrow(/v70/);
  });

  test("removing the extension removes its grant (FKs are OFF on the gateway connection)", () => {
    const d = db();
    insertExtensionRow(d, {
      id: "com.example.a",
      version: "1.0.0",
      install_path: "/x",
      manifest_hash: "m",
      entry_hash: "e",
      enabled: 1,
      installed_at: 1,
      last_verified_at: 1,
    });
    upsertRunGrant(d, grant());
    expect(deleteExtensionById(d, "com.example.a")).toBe("/x");
    expect(getRunGrant(d, "com.example.a")).toBeNull();
  });
});
