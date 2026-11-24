import { clampSyncTitle } from "../sync/pass-cursor-sync-result.ts";
import { trimTrailingSlash } from "./_lib/field-helpers.ts";
import { normalizeDataModelKey } from "./data-model-key.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

/**
 * dbt Cloud test results as `data_quality_test` items (the Data Incident Brief's data lane, owner ruling
 * OR-S4-DATA-INPUTS). METADATA ONLY: a test's status, failure COUNT, timing and the identifiers of the run, the
 * job and the tested models. The mapper reads NONE of `message` (it can echo row values), `compiled_code`,
 * `adapter_response`, `relation_name` of a result or any failing rows, so it cannot store them.
 *
 * Why `data_quality_test` and not a new type: the type already carries `monitoredDataModelKeys`, which the
 * graph populator turns into `data_quality_test --monitors--> data_model` edges in the SAME key space Monte
 * Carlo and Bigeye use, and no registration site needs a new row. It cannot become an incident trigger (the
 * trigger sources name their services), so a dbt row is never a record of its own.
 */
export type DbtTestMappedRow = MappedRow<"dbt", "data_quality_test">;

/** Only these results are indexed: a pass or a skip carries no incident signal and would be most of the volume. */
export const INDEXED_TEST_STATUSES: readonly string[] = ["fail", "warn", "error"];

export interface DbtTestRun {
  readonly runId: number;
  readonly jobId: number | null;
  readonly projectId: number | null;
  readonly finishedAtMs: number;
}

export interface DbtTestMappingContext {
  readonly apiBase: string;
  readonly accountId: number;
  readonly run: DbtTestRun;
  /** What the run's manifest says about each test, by test `unique_id` (empty without a manifest). */
  readonly nodes: ReadonlyMap<string, DbtTestNode>;
  readonly syncedAt: number;
}

export interface DbtTestNode {
  readonly name: string | null;
  /** Normalised warehouse keys of the models, seeds, snapshots and sources the test depends on. */
  readonly modelKeys: readonly string[];
}

const MAX_KEYS_PER_TEST = 5;
const MODEL_RESOURCES: ReadonlySet<string> = new Set(["model", "seed", "snapshot", "source"]);

function relationKey(node: Record<string, unknown>): string | null {
  const database = stringField(node, "database");
  const schema = stringField(node, "schema");
  const object =
    stringField(node, "alias") ?? stringField(node, "identifier") ?? stringField(node, "name");
  if (database === undefined || schema === undefined || object === undefined) {
    return stringField(node, "relation_name") === undefined
      ? null
      : normalizeDataModelKey(stringField(node, "relation_name") ?? "");
  }
  return normalizeDataModelKey(`${database}.${schema}.${object}`);
}

/**
 * The tested models of each wanted test, from `manifest.json` (`nodes` and `sources`: their
 * `depends_on.nodes` and the relation each parent builds). Names and identifiers only.
 */
export function indexDbtManifest(
  manifest: unknown,
  wanted: ReadonlySet<string>,
): Map<string, DbtTestNode> {
  const out = new Map<string, DbtTestNode>();
  const root = asRecord(manifest);
  const nodes = asRecord(root?.["nodes"]);
  const sources = asRecord(root?.["sources"]);
  if (nodes === undefined) {
    return out;
  }
  for (const uid of wanted) {
    const test = asRecord(nodes[uid]);
    if (test === undefined) {
      continue;
    }
    const parents = asRecord(test["depends_on"])?.["nodes"];
    const keys = new Set<string>();
    for (const parentId of Array.isArray(parents) ? parents : []) {
      if (typeof parentId !== "string") {
        continue;
      }
      const parent = asRecord(nodes[parentId]) ?? asRecord(sources?.[parentId]);
      const resource = parent === undefined ? undefined : stringField(parent, "resource_type");
      if (parent === undefined || (resource !== undefined && !MODEL_RESOURCES.has(resource))) {
        continue;
      }
      const key = relationKey(parent);
      if (key !== null) {
        keys.add(key);
      }
    }
    out.set(uid, {
      name: stringField(test, "name") ?? null,
      modelKeys: [...keys].sort().slice(0, MAX_KEYS_PER_TEST),
    });
  }
  return out;
}

/** `test.<project>.<name>.<hash>` to `<name>`; the fallback when no manifest named the test. */
function nameFromUniqueId(uniqueId: string): string {
  const parts = uniqueId.split(".");
  return parts.length >= 3 ? (parts[2] ?? uniqueId) : uniqueId;
}

export function runUrl(apiBase: string, accountId: number, run: DbtTestRun): string {
  const base = trimTrailingSlash(apiBase);
  return run.projectId === null
    ? `${base}/deploy/${String(accountId)}`
    : `${base}/deploy/${String(accountId)}/projects/${String(run.projectId)}/runs/${String(run.runId)}`;
}

/** One `run_results.json` entry to an item, or null for a non-test node, a pass or skip, or a malformed one. */
export function mapDbtTestResultToItem(
  raw: unknown,
  ctx: DbtTestMappingContext,
): DbtTestMappedRow | null {
  const result = asRecord(raw);
  const uniqueId = result === undefined ? undefined : stringField(result, "unique_id");
  const status = result === undefined ? undefined : stringField(result, "status");
  if (
    result === undefined ||
    uniqueId === undefined ||
    !uniqueId.startsWith("test.") ||
    status === undefined ||
    !INDEXED_TEST_STATUSES.includes(status)
  ) {
    return null;
  }
  const node = ctx.nodes.get(uniqueId);
  const testName = node?.name ?? nameFromUniqueId(uniqueId);
  const failures = numberField(result, "failures") ?? null;
  const executionTime = numberField(result, "execution_time") ?? null;
  const url = runUrl(ctx.apiBase, ctx.accountId, ctx.run);
  const { runId, jobId, projectId, finishedAtMs } = ctx.run;
  return {
    service: "dbt",
    type: "data_quality_test",
    externalId: `${String(ctx.accountId)}:${String(runId)}:${uniqueId}`,
    title: clampSyncTitle(`dbt test ${testName} - ${status}`),
    bodyPreview: clampSyncTitle(
      `${testName}: ${status}${failures === null ? "" : `, ${String(failures)} failing`} (run ${String(runId)})`,
    ),
    url,
    canonicalUrl: url,
    modifiedAt: finishedAtMs,
    metadata: {
      monitoredDataModelKeys: node?.modelKeys ?? [],
      test_unique_id: uniqueId,
      test_name: testName,
      status,
      failures,
      execution_time_s: executionTime,
      run_id: runId,
      job_id: jobId,
      project_id: projectId,
      account_id: ctx.accountId,
      finished_at: finishedAtMs,
    },
    syncedAt: ctx.syncedAt,
  };
}
