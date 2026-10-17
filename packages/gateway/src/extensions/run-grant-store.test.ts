import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  deleteExtensionById,
  insertExtensionRow,
  setExtensionEnabled,
  setExtensionTreeDigest,
} from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  deleteRunGrant,
  type ExtensionRunGrantRow,
  getRunGrant,
  listModelAccessibleExtensionGrants,
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

  test("removing the extension removes its grant explicitly, without the FK cascade", () => {
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
    d.run("PRAGMA foreign_keys = OFF"); // so only the explicit delete can remove the grant
    expect(deleteExtensionById(d, "com.example.a")).toBe("/x");
    expect(getRunGrant(d, "com.example.a")).toBeNull();
  });
});

describe("listModelAccessibleExtensionGrants (the model's extension source)", () => {
  const DIGEST = "a".repeat(64);

  /** An installed, enabled extension whose row digest is DIGEST, plus a grant over it. */
  function modelGrant(
    d: Database,
    id: string,
    over: Partial<ExtensionRunGrantRow> = {},
    row: { enabled?: boolean; digest?: string | null } = {},
  ): void {
    insertExtensionRow(d, {
      id,
      version: "1.0.0",
      install_path: `/x/${id}`,
      manifest_hash: "m",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
    });
    if (row.digest !== null) setExtensionTreeDigest(d, id, row.digest ?? DIGEST);
    if (row.enabled === false) setExtensionEnabled(d, id, false);
    upsertRunGrant(
      d,
      grant({
        extension_id: id,
        service_id: `ext_${id.replaceAll(".", "_")}`,
        tree_digest: DIGEST,
        model_access: 1,
        ...over,
      }),
    );
  }

  test("lists an enabled, current grant with model access", () => {
    const d = db();
    modelGrant(d, "a");
    expect(listModelAccessibleExtensionGrants(d)).toEqual([
      { serviceId: "ext_a", extensionId: "a" },
    ]);
  });

  test("excludes a grant without model access", () => {
    const d = db();
    modelGrant(d, "a", { model_access: 0 });
    expect(listModelAccessibleExtensionGrants(d)).toEqual([]);
  });

  test("excludes a disabled extension", () => {
    const d = db();
    modelGrant(d, "a", {}, { enabled: false });
    expect(listModelAccessibleExtensionGrants(d)).toEqual([]);
  });

  test("excludes a stale grant: another version, another digest, or no row digest", () => {
    const d = db();
    modelGrant(d, "v", { version: "0.9.0" });
    modelGrant(d, "t", {}, { digest: "b".repeat(64) });
    modelGrant(d, "n", {}, { digest: null });
    expect(listModelAccessibleExtensionGrants(d)).toEqual([]);
  });

  test("excludes a stored service id that is not an ext_ id", () => {
    const d = db();
    modelGrant(d, "a", { service_id: "mcp_a" });
    expect(listModelAccessibleExtensionGrants(d)).toEqual([]);
  });

  test("ordered by service id", () => {
    const d = db();
    modelGrant(d, "b");
    modelGrant(d, "a");
    expect(listModelAccessibleExtensionGrants(d).map((g) => g.serviceId)).toEqual([
      "ext_a",
      "ext_b",
    ]);
  });

  test("below V70 it is empty", () => {
    const d = new Database(":memory:");
    open.push(d);
    runIndexedSchemaMigrations(d, 69);
    expect(listModelAccessibleExtensionGrants(d)).toEqual([]);
  });
});
