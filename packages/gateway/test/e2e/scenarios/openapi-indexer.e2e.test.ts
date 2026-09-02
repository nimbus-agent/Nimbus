import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorServiceId } from "../../../src/connectors/connector-catalog.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { DEFAULT_OPENAPI_CONFIG } from "../../../src/connectors/openapi-indexer-config.ts";
import { createOpenapiIndexerSyncable } from "../../../src/connectors/openapi-indexer-sync.ts";

const FIX = join(import.meta.dir, "..", "..", "fixtures", "openapi");

test("e2e: two specs in two services produce queryable api_endpoint rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-e2e-"));
  try {
    copyFileSync(join(FIX, "petstore-3.0.yaml"), join(root, "openapi.yaml"));
    const subDir = join(root, "services", "payments-api");
    mkdirSync(subDir, { recursive: true });
    copyFileSync(join(FIX, "petstore-3.1.yaml"), join(subDir, "openapi.yaml"));

    const sync = createOpenapiIndexerSyncable({
      roots: [
        {
          path: root,
          gitAware: false,
          codeIndex: false,
          dependencyGraph: false,
          mediaIndex: false,
          exclude: [],
        },
      ],
      config: DEFAULT_OPENAPI_CONFIG,
    });
    const db = createMemoryIndexDb();
    const r = await sync.sync(
      syncTestContext(db, EMPTY_NIMBUS_VAULT, sync.serviceId as ConnectorServiceId),
      null,
    );
    expect(r.itemsUpserted).toBe(3);

    const byType = db.query("SELECT COUNT(*) AS n FROM item WHERE type = 'api_endpoint'").get() as {
      n: number;
    };
    expect(byType.n).toBe(3);

    const services = db
      .query("SELECT DISTINCT service_name FROM api_endpoint ORDER BY service_name")
      .all() as Array<{ service_name: string }>;
    expect(services).toHaveLength(2);
    expect(services.some((s) => s.service_name === "payments-api")).toBe(true);

    const ftsHits = db
      .query(
        "SELECT COUNT(*) AS n FROM item WHERE rowid IN (SELECT rowid FROM item_fts WHERE item_fts MATCH ?)",
      )
      .get("pets") as { n: number };
    expect(ftsHits.n).toBeGreaterThanOrEqual(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
