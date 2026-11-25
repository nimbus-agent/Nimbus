import type { SyncContext } from "../sync/types.ts";
import { DAG_RUN_WINDOW_MS } from "./_lib/dag-run.ts";
import type { FetchOutcome } from "./_lib/fetch-outcome.ts";
import { upsertMapped } from "./_lib/paginated-sync.ts";
import { mapDagsterRunToItem } from "./dagster-run-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * Dagster runs created in the last {@link DAG_RUN_WINDOW_MS} as `dagster:job_run` items (metadata only: ids,
 * status, times, failed STEP KEYS, the tag KEYS that say how it began). Best effort; the caller catches what
 * this throws. The query follows the documented GraphQL schema (`runsOrError`, `Runs`, `RunsFilter`,
 * `Run.stepStats`), not a live deployment's.
 */
export const DAGSTER_RUN_PAGE = 50;
export const DAGSTER_RUN_MAX_PAGES = 5;

export const RUNS_QUERY = `
query NimbusRuns($limit: Int, $cursor: String, $after: Float) {
  runsOrError(filter: { createdAfter: $after }, limit: $limit, cursor: $cursor) {
    __typename
    ... on Runs {
      results {
        runId
        jobName
        status
        startTime
        endTime
        creationTime
        repositoryOrigin { repositoryName repositoryLocationName }
        tags { key }
        stepStats { stepKey status }
      }
    }
  }
}
`;

export type DagsterGql = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<FetchOutcome>;

/** `data.runsOrError.results`, or `[]` for any other typename (an error union member degrades). */
export function runResults(parsed: unknown): unknown[] {
  const r = asRecord(asRecord(parsed)?.["runsOrError"]);
  const results = r?.["results"];
  return r?.["__typename"] === "Runs" && Array.isArray(results) ? results : [];
}

export async function syncDagsterRuns(
  ctx: SyncContext,
  gql: DagsterGql,
  baseUrl: string,
  now: number,
): Promise<{ upserted: number; bytes: number }> {
  const after = (now - DAG_RUN_WINDOW_MS) / 1000;
  let cursor: string | null = null;
  let upserted = 0;
  let bytes = 0;
  for (let page = 0; page < DAGSTER_RUN_MAX_PAGES; page += 1) {
    const out = await gql(RUNS_QUERY, { limit: DAGSTER_RUN_PAGE, cursor, after });
    bytes += out.bytes;
    if (out.kind !== "ok") break;
    const results = runResults(out.parsed);
    upserted += upsertMapped(ctx, results, (raw) =>
      mapDagsterRunToItem(raw, { baseUrl, syncedAt: now }),
    );
    const last = asRecord(results.at(-1));
    cursor = last === undefined ? null : (stringField(last, "runId") ?? null);
    if (results.length < DAGSTER_RUN_PAGE || cursor === null) break;
  }
  return { upserted, bytes };
}
