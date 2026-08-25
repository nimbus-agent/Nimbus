import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import {
  type BodyRow,
  deleteItemByPrimaryKey,
  type UpsertSyncDeps,
  upsertIndexedItemForSync,
} from "./item-store.ts";

/** The `api_endpoint` row a connector has parsed out of an OpenAPI spec. */
export interface ApiEndpointRow {
  readonly id: string;
  readonly serviceName: string;
  readonly path: string;
  readonly method: string;
  readonly operationId: string | null;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly specPath: string;
  readonly specVersion: string;
  readonly mtimeMs: number;
}

/** One endpoint: the indexed item it becomes, plus its `api_endpoint` row. */
export interface ApiEndpointWrite {
  readonly item: BodyRow;
  readonly endpoint: ApiEndpointRow;
}

function upsertApiEndpointRow(db: Database, ep: ApiEndpointRow, syncedAt: number): void {
  dbRun(
    db,
    `INSERT INTO api_endpoint (
      id, service_name, path, method, operation_id, tags_json, deprecated, spec_file, spec_version, last_modified, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      service_name = excluded.service_name,
      path = excluded.path,
      method = excluded.method,
      operation_id = excluded.operation_id,
      tags_json = excluded.tags_json,
      deprecated = excluded.deprecated,
      spec_file = excluded.spec_file,
      spec_version = excluded.spec_version,
      last_modified = excluded.last_modified`,
    [
      ep.id,
      ep.serviceName,
      ep.path,
      ep.method,
      ep.operationId,
      JSON.stringify(ep.tags),
      ep.deprecated ? 1 : 0,
      ep.specPath,
      ep.specVersion,
      ep.mtimeMs,
      syncedAt,
    ],
  );
}

function deleteEndpointsAbsentFromSpec(
  db: Database,
  specPath: string,
  keepIds: ReadonlySet<string>,
): number {
  const existing = db
    .query("SELECT id FROM api_endpoint WHERE spec_file = ?")
    .all(specPath) as Array<{ id: string }>;
  let deleted = 0;
  for (const row of existing) {
    if (keepIds.has(row.id)) {
      continue;
    }
    deleteItemByPrimaryKey(db, row.id);
    dbRun(db, "DELETE FROM api_endpoint WHERE id = ?", [row.id]);
    deleted++;
  }
  return deleted;
}

/**
 * Writes one spec's endpoints and prunes the departed ones, in a SINGLE transaction — the same
 * batching argument as `writeObsidianVault`: a per-endpoint capability would autocommit each write
 * and a partial sync would leave `api_endpoint` disagreeing with `item`.
 */
export function writeApiEndpointsForSpec(
  deps: UpsertSyncDeps,
  input: {
    readonly specPath: string;
    readonly endpoints: readonly ApiEndpointWrite[];
    readonly keepIds: ReadonlySet<string>;
    readonly syncedAt: number;
  },
): { upserted: number; deleted: number } {
  let upserted = 0;
  let deleted = 0;
  deps.db.transaction(() => {
    for (const write of input.endpoints) {
      upsertIndexedItemForSync(deps, write.item);
      upsertApiEndpointRow(deps.db, write.endpoint, input.syncedAt);
      upserted++;
    }
    deleted = deleteEndpointsAbsentFromSpec(deps.db, input.specPath, input.keepIds);
  })();
  return { upserted, deleted };
}
