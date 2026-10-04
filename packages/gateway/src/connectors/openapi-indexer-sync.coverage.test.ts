/**
 * OpenAPI indexer paths the main suite does not reach: an operation with no `operationId`, a
 * syncable built WITHOUT an explicit config (every other test passes one, so the default was never
 * exercised), a cursor that is not the indexer's own `{"tip": <ms>}` JSON, and a spec file that
 * disappears after discovery listed it but before it was read.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createOpenapiIndexerSyncable } from "./openapi-indexer-sync.ts";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Inventory" },
  paths: {
    "/items": {
      get: { tags: ["stock", "read"] },
      post: { operationId: "createItem", tags: ["stock"] },
    },
  },
};

let root: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openapi-sync-cov-"));
  writeFileSync(join(root, "openapi.json"), JSON.stringify(SPEC));
  db = createMemoryIndexDb();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function rootCfg(path: string): NimbusFilesystemRootToml {
  return {
    path,
    gitAware: false,
    codeIndex: false,
    dependencyGraph: false,
    mediaIndex: false,
    exclude: [],
  };
}

describe("openapi-indexer-sync — operations without an operationId", () => {
  test("with no config passed, the default applies and an id-less operation previews its tags", async () => {
    // No `config` option — the syncable must fall back to DEFAULT_OPENAPI_CONFIG.
    const syncable = createOpenapiIndexerSyncable({ roots: [rootCfg(root)] });

    const res = await syncable.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "openapi"), null);

    expect(res.itemsUpserted).toBe(2);
    const items = db
      .query(
        "SELECT title, body_preview, metadata FROM item WHERE service = 'openapi' ORDER BY title",
      )
      .all() as { title: string; body_preview: string; metadata: string }[];
    expect(items.map((i) => [i.title, i.body_preview])).toEqual([
      ["GET /items", "stock read"],
      ["POST /items", "createItem stock"],
    ]);
    const getMeta = JSON.parse(items[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(getMeta["operation_id"]).toBeNull();
    expect(getMeta["tags"]).toEqual(["stock", "read"]);

    const endpoints = db
      .query("SELECT method, operation_id FROM api_endpoint ORDER BY method")
      .all() as { method: string; operation_id: string | null }[];
    expect(endpoints).toEqual([
      { method: "GET", operation_id: null },
      { method: "POST", operation_id: "createItem" },
    ]);
  });
});

describe("openapi-indexer-sync — foreign cursors", () => {
  test("a non-JSON cursor, or one whose tip is not a number, re-reads every spec from scratch", async () => {
    const syncable = createOpenapiIndexerSyncable({ roots: [rootCfg(root)] });
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "openapi");
    const first = await syncable.sync(ctx, null);
    expect(first.itemsUpserted).toBe(2);

    // Control: the indexer's own cursor skips the unchanged spec.
    const resumed = await syncable.sync(ctx, first.cursor);
    expect(resumed.itemsUpserted).toBe(0);

    for (const foreign of ["not-json{", '{"tip":"yesterday"}', "[]"]) {
      const res = await syncable.sync(ctx, foreign);
      expect(res.itemsUpserted).toBe(2);
      expect(res.cursor).toBe(first.cursor);
    }
  });
});

describe("openapi-indexer-sync — a spec that vanishes between discovery and read", () => {
  test("is skipped without failing the sync, while the spec read before it is still indexed", async () => {
    // `root` already holds openapi.json (2 operations); add a second, distinguishable spec.
    mkdirSync(join(root, "b"));
    writeFileSync(
      join(root, "b", "swagger.json"),
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Orders" },
        paths: { "/orders": { get: {} } },
      }),
    );
    const specs = [join(root, "openapi.json"), join(root, "b", "swagger.json")];
    const base = syncTestContext(db, EMPTY_NIMBUS_VAULT, "openapi");
    const written: string[] = [];
    // Discovery lists BOTH specs before either is read. Writing the first one's endpoints is the
    // only hook between those two moments, so the not-yet-read spec is deleted right there.
    const ctx: SyncContext = {
      ...base,
      writeApiEndpointsForSpec: (input) => {
        written.push(input.specPath);
        for (const p of specs) {
          if (p !== input.specPath) rmSync(p, { force: true });
        }
        return base.writeApiEndpointsForSpec(input);
      },
    };

    const res = await createOpenapiIndexerSyncable({ roots: [rootCfg(root)] }).sync(ctx, null);

    // readdir order is filesystem-dependent, so which spec survives is read back, not assumed.
    expect(written).toHaveLength(1);
    const survivor = written[0] ?? "";
    expect(specs).toContain(survivor);
    const survivorEndpoints = survivor === specs[0] ? 2 : 1;
    expect(res.itemsUpserted).toBe(survivorEndpoints);
    const specFiles = (
      db.query("SELECT DISTINCT spec_file FROM api_endpoint").all() as { spec_file: string }[]
    ).map((r) => r.spec_file);
    expect(specFiles).toEqual([survivor]);
    expect(JSON.parse(res.cursor ?? "{}")).toEqual({ tip: statSync(survivor).mtimeMs });
  });
});
