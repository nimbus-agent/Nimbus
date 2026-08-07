// packages/gateway/src/egress/sync-egress.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { listEgress, verifyEgressChain } from "./egress-verify.ts";
import { recordSyncEgress } from "./sync-egress.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

describe("recordSyncEgress", () => {
  test("appends one authorized, not_required `sync` row destined at the service id", () => {
    const out = recordSyncEgress(db, { destination: "github", method: "sync.run", now: 1_000 });
    expect(out).toBeUndefined();
    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "sync",
      destination: "github",
      method: "sync.run",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    });
    expect(rows[0]?.sourceId).toBeNull();
  });

  test("destination is the caller-supplied SERVICE id, never a raw URL — this function does no derivation", () => {
    recordSyncEgress(db, { destination: "jenkins", method: "items.fetch", now: 2_000 });
    const rows = listEgress(db, {});
    expect(rows[0]?.destination).toBe("jenkins");
  });

  test("two appends chain correctly (BLAKE3, I10-verifiable)", () => {
    recordSyncEgress(db, { destination: "github", method: "sync.run", now: 1_000 });
    recordSyncEgress(db, { destination: "gitlab", method: "items.fetch", now: 2_000 });
    const result = verifyEgressChain(db);
    expect(result.ok).toBe(true);
    expect(listEgress(db, {})).toHaveLength(2);
  });

  test("a throwing appendEgressEntry (e.g. a closed db) propagates rather than swallowing", () => {
    db.close();
    expect(() =>
      recordSyncEgress(db, { destination: "github", method: "sync.run", now: 1 }),
    ).toThrow();
  });
});
