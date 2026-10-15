import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  deleteExtensionRunGrant,
  type ExtensionRunGrant,
  getExtensionRunGrant,
  listExtensionRunGrants,
  upsertExtensionRunGrant,
} from "./extension-run-grant-store.ts";

const GRANT: ExtensionRunGrant = {
  extensionId: "a",
  serviceId: "ext_a",
  version: "1.0.0",
  treeDigest: "d",
  permissions: { network: ["h"], filesystem: { read: ["/r"], write: [] } },
  modelAccess: false,
  approvedAt: 5,
};

function db(version: number): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, version);
  return d;
}

function withExtension(d: Database, id: string): void {
  d.run(
    `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
     VALUES (?, '1.0.0', '/x', 'm', 'e', 1, 1, 1)`,
    [id],
  );
}

describe("extension run grant store", () => {
  test("round-trips, upserts in place, lists in id order, and deletes", () => {
    const d = db(69);
    withExtension(d, "a");
    withExtension(d, "b");
    upsertExtensionRunGrant(d, GRANT);
    upsertExtensionRunGrant(d, { ...GRANT, extensionId: "b", serviceId: "ext_b" });
    upsertExtensionRunGrant(d, { ...GRANT, version: "2.0.0", modelAccess: true });
    expect(getExtensionRunGrant(d, "a")).toEqual({ ...GRANT, version: "2.0.0", modelAccess: true });
    expect(listExtensionRunGrants(d).map((g) => g.extensionId)).toEqual(["a", "b"]);
    expect(deleteExtensionRunGrant(d, "a")).toBe(true);
    expect(deleteExtensionRunGrant(d, "a")).toBe(false);
    expect(getExtensionRunGrant(d, "a")).toBeNull();
  });

  test("malformed stored permissions read as EMPTY — less, never more", () => {
    const d = db(69);
    withExtension(d, "a");
    upsertExtensionRunGrant(d, GRANT);
    const empty = { network: [], filesystem: { read: [], write: [] } };
    for (const json of [
      "not json",
      "null",
      '{"network":"h","filesystem":5}',
      '{"network":[1,"h"]}',
    ]) {
      d.run("UPDATE extension_run_grant SET permissions_json = ?", [json]);
      const perms = getExtensionRunGrant(d, "a")?.permissions;
      if (json.includes('"h"]')) {
        expect(perms).toEqual({ ...empty, network: ["h"] });
      } else {
        expect(perms).toEqual(empty);
      }
    }
  });

  test("below V69: reads are empty, delete is a no-op, a write throws", () => {
    const d = db(68);
    expect(getExtensionRunGrant(d, "a")).toBeNull();
    expect(listExtensionRunGrants(d)).toEqual([]);
    expect(deleteExtensionRunGrant(d, "a")).toBe(false);
    expect(() => upsertExtensionRunGrant(d, GRANT)).toThrow(/v69/);
  });
});
