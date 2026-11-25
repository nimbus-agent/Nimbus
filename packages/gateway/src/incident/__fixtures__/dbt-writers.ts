import type { Database } from "bun:sqlite";

import { mapDbtTestResultToItem } from "../../connectors/dbt-test-mapping.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import type { ServiceIdentityResolver } from "../../metrics/service-identity.ts";

/** One dbt test result written through the REAL mapper (never hand-built metadata). Returns the item id. */
export function writeDbtTest(
  db: Database,
  resolver: ServiceIdentityResolver,
  over: {
    readonly uniqueId: string;
    readonly status: "fail" | "warn" | "error" | "pass";
    readonly modelKeys: readonly string[];
    readonly finishedAtMs: number;
    readonly failures?: number;
    readonly runId?: number;
  },
): string {
  const mapped = mapDbtTestResultToItem(
    { unique_id: over.uniqueId, status: over.status, failures: over.failures ?? 1 },
    {
      apiBase: "https://cloud.getdbt.com",
      accountId: 1,
      run: {
        runId: over.runId ?? 7,
        jobId: 3,
        projectId: 5,
        finishedAtMs: over.finishedAtMs,
      },
      nodes: new Map([
        [over.uniqueId, { name: over.uniqueId.split(".")[2] ?? null, modelKeys: over.modelKeys }],
      ]),
      syncedAt: over.finishedAtMs,
    },
  );
  if (mapped === null) throw new Error("fixture: the mapper refused the dbt test result");
  upsertIndexedItem(db, mapped, resolver);
  return `dbt:${mapped.externalId}`;
}
