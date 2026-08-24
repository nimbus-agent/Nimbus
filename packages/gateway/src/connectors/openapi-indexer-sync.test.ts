import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
  testConnectorSyncNoop,
} from "./connector-sync-test-helpers.ts";
import { DEFAULT_OPENAPI_CONFIG } from "./openapi-indexer-config.ts";
import { createOpenapiIndexerSyncable } from "./openapi-indexer-sync.ts";

const FIX = join(import.meta.dir, "..", "..", "test", "fixtures", "openapi");

testConnectorSyncNoop(
  "no-op when no roots configured",
  () => createOpenapiIndexerSyncable({ roots: [], config: DEFAULT_OPENAPI_CONFIG }),
  EMPTY_NIMBUS_VAULT,
);

test("indexes endpoints from a Petstore 3.0 spec under a configured root", async () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-sync-"));
  copyFileSync(join(FIX, "petstore-3.0.yaml"), join(root, "openapi.yaml"));
  const sync = createOpenapiIndexerSyncable({
    roots: [
      {
        path: root,
        gitAware: false,
        codeIndex: false,
        dependencyGraph: false,
        exclude: [],
      },
    ],
    config: DEFAULT_OPENAPI_CONFIG,
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "openapi"), null);
  expect(r.itemsUpserted).toBe(2);
  const items = db
    .query("SELECT title, type, service FROM item WHERE service = 'openapi' ORDER BY title")
    .all() as Array<{ title: string; type: string; service: string }>;
  expect(items).toHaveLength(2);
  for (const it of items) {
    expect(it.type).toBe("api_endpoint");
  }
  const shadow = db
    .query("SELECT method, path FROM api_endpoint ORDER BY method, path")
    .all() as Array<{ method: string; path: string }>;
  expect(shadow).toEqual([
    { method: "DELETE", path: "/pets/{id}" },
    { method: "GET", path: "/pets" },
  ]);
});

test("re-running with no file changes upserts zero items", async () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-sync-delta-"));
  copyFileSync(join(FIX, "petstore-3.0.yaml"), join(root, "openapi.yaml"));
  const sync = createOpenapiIndexerSyncable({
    roots: [{ path: root, gitAware: false, codeIndex: false, dependencyGraph: false, exclude: [] }],
    config: DEFAULT_OPENAPI_CONFIG,
  });
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "openapi");
  const first = await sync.sync(ctx, null);
  expect(first.itemsUpserted).toBe(2);
  const second = await sync.sync(ctx, first.cursor);
  expect(second.itemsUpserted).toBe(0);
  expect(second.itemsDeleted).toBe(0);
});

test("malformed and oversize specs are skipped without aborting the sync", async () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-sync-bad-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "good"), { recursive: true });
  mkdirSync(join(root, "broken"), { recursive: true });
  mkdirSync(join(root, "junk"), { recursive: true });
  mkdirSync(join(root, "broken-ref"), { recursive: true });
  copyFileSync(join(FIX, "petstore-3.0.yaml"), join(root, "good", "openapi.yaml"));
  copyFileSync(join(FIX, "bad-yaml.yaml"), join(root, "broken", "openapi.yaml"));
  copyFileSync(join(FIX, "not-a-spec.yaml"), join(root, "junk", "openapi.yaml"));
  copyFileSync(join(FIX, "unresolvable-ref.yaml"), join(root, "broken-ref", "openapi.yaml"));
  const sync = createOpenapiIndexerSyncable({
    roots: [{ path: root, gitAware: false, codeIndex: false, dependencyGraph: false, exclude: [] }],
    config: { ...DEFAULT_OPENAPI_CONFIG, maxSpecBytes: 10 * 1024 * 1024 },
  });
  const db = createMemoryIndexDb();
  const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "openapi"), null);
  expect(r.itemsUpserted).toBe(3);
});

test("removing an endpoint from a re-parsed spec deletes it; unchanged specs preserve their endpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-sync-sticky-"));
  copyFileSync(join(FIX, "petstore-3.0.yaml"), join(root, "openapi.yaml"));
  copyFileSync(join(FIX, "petstore-3.1.yaml"), join(root, "swagger.yaml"));
  const sync = createOpenapiIndexerSyncable({
    roots: [{ path: root, gitAware: false, codeIndex: false, dependencyGraph: false, exclude: [] }],
    config: DEFAULT_OPENAPI_CONFIG,
  });
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "openapi");
  const first = await sync.sync(ctx, null);
  expect(first.itemsUpserted).toBe(3);

  writeFileSync(
    join(root, "openapi.yaml"),
    `openapi: 3.0.0
info: { title: Petstore API, version: 1.0.0 }
paths:
  /pets:
    get:
      operationId: listPets
      responses: { "200": { description: ok } }
`,
  );
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(root, "openapi.yaml"), future, future);

  const second = await sync.sync(ctx, first.cursor);
  expect(second.itemsDeleted).toBe(1);
  const remaining = db.query("SELECT method FROM api_endpoint ORDER BY method").all() as Array<{
    method: string;
  }>;
  expect(remaining.map((r) => r.method).sort((a, b) => a.localeCompare(b))).toEqual(["GET", "GET"]);
});

test("uses enclosing-directory name when spec lives one level under the root", async () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-sync-svc-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "services", "payments-api"), { recursive: true });
  copyFileSync(
    join(FIX, "petstore-3.0.yaml"),
    join(root, "services", "payments-api", "openapi.yaml"),
  );
  const sync = createOpenapiIndexerSyncable({
    roots: [{ path: root, gitAware: false, codeIndex: false, dependencyGraph: false, exclude: [] }],
    config: DEFAULT_OPENAPI_CONFIG,
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "openapi"), null);
  const services = db.query("SELECT DISTINCT service_name FROM api_endpoint").all() as Array<{
    service_name: string;
  }>;
  expect(services.map((s) => s.service_name)).toEqual(["payments-api"]);
});

test("syncing emits graph_relation edges from api_endpoint to its service", async () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-sync-graph-"));
  copyFileSync(join(FIX, "petstore-3.0.yaml"), join(root, "openapi.yaml"));
  const sync = createOpenapiIndexerSyncable({
    roots: [{ path: root, gitAware: false, codeIndex: false, dependencyGraph: false, exclude: [] }],
    config: DEFAULT_OPENAPI_CONFIG,
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "openapi"), null);
  const rels = db
    .query(
      `SELECT type FROM graph_relation
       WHERE from_id IN (SELECT id FROM graph_entity WHERE type = 'api_endpoint')
         AND to_id IN (SELECT id FROM graph_entity WHERE type = 'service')`,
    )
    .all() as Array<{ type: string }>;
  expect(rels.length).toBeGreaterThanOrEqual(2);
  expect(rels.every((r) => r.type === "targets")).toBe(true);
});

test("skipped-by-size count is exposed via getLastSyncStats()", async () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-sync-stats-"));
  copyFileSync(join(FIX, "petstore-3.0.yaml"), join(root, "openapi.yaml"));
  const sync = createOpenapiIndexerSyncable({
    roots: [{ path: root, gitAware: false, codeIndex: false, dependencyGraph: false, exclude: [] }],
    config: { ...DEFAULT_OPENAPI_CONFIG, maxSpecBytes: 8 },
  });
  const db = createMemoryIndexDb();
  await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "openapi"), null);
  const stats = sync.getLastSyncStats();
  expect(stats.skippedTooLarge).toBe(1);
});
