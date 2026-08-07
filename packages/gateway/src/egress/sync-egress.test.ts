// packages/gateway/src/egress/sync-egress.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBlameIndexSyncable } from "../connectors/blame-index-sync.ts";
import { createFilesystemV2Syncable } from "../connectors/filesystem-v2-sync.ts";
import { createObsidianSyncable } from "../connectors/obsidian-sync.ts";
import { createOpenapiIndexerSyncable } from "../connectors/openapi-indexer-sync.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { listEgress, verifyEgressChain } from "./egress-verify.ts";
import { LOCAL_ONLY_SYNC_SERVICES, recordSyncEgress } from "./sync-egress.ts";

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

describe("LOCAL_ONLY_SYNC_SERVICES", () => {
  test("is exactly the four local-only indexers — no more, no fewer", () => {
    // Pinned so a rename or a fifth local-only indexer is a deliberate edit here, not a silent
    // resumption of the over-count this set exists to prevent (see the doc comment).
    expect(new Set(LOCAL_ONLY_SYNC_SERVICES)).toEqual(
      new Set(["filesystem", "blame", "openapi", "obsidian"]),
    );
  });

  test("each real local-only syncable's OWN serviceId is a member — not just a matching string literal", () => {
    // Constructs the REAL syncables (the exact factories platform/assemble.ts registers on the
    // scheduler) and reads their own `.serviceId` — so a rename inside any of the four connector
    // files (which would silently reopen the over-count this set exists to close) fails this test
    // rather than staying invisible behind a hand-copied string.
    expect(LOCAL_ONLY_SYNC_SERVICES.has(createFilesystemV2Syncable({ roots: [] }).serviceId)).toBe(
      true,
    );
    expect(LOCAL_ONLY_SYNC_SERVICES.has(createBlameIndexSyncable({ roots: [] }).serviceId)).toBe(
      true,
    );
    expect(
      LOCAL_ONLY_SYNC_SERVICES.has(createOpenapiIndexerSyncable({ roots: [] }).serviceId),
    ).toBe(true);
    expect(LOCAL_ONLY_SYNC_SERVICES.has(createObsidianSyncable({ roots: [] }).serviceId)).toBe(
      true,
    );
  });

  test("recordSyncEgress is a no-op for every local-only destination — no row, not even a blocked one", () => {
    for (const destination of LOCAL_ONLY_SYNC_SERVICES) {
      const out = recordSyncEgress(db, { destination, method: "sync.run", now: 1_000 });
      expect(out).toBeUndefined();
    }
    expect(listEgress(db, {})).toHaveLength(0);
  });

  test("a real cloud destination (e.g. github) is NOT excluded — the filter is narrow, not a kill switch", () => {
    recordSyncEgress(db, { destination: "github", method: "sync.run", now: 1_000 });
    expect(listEgress(db, {})).toHaveLength(1);
  });
});
