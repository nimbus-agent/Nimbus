import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { type DagsterFlatJob, mapDagsterJobToItem } from "./dagster-job-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "dagster";
const CURSOR_PREFIX = "nimbus-dagster1:";
// The repositories query returns every repo + its jobs in one response (not
// cursor-paginated), so a single forward pass per cycle is enough. The cap is a
// defensive bound on a pathologically large catalog — mirrors sibling page caps.
const MAX_JOBS = 2000;

type DagsterCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies DagsterCursorV1);
}

const JOBS_QUERY = `
query NimbusJobs {
  repositoriesOrError {
    __typename
    ... on RepositoryConnection {
      nodes {
        name
        location { name }
        pipelines { id name description isJob tags { key value } }
      }
    }
    ... on PythonError { message }
  }
}
`;

export type DagsterSyncableOptions = {
  ensureDagsterMcpRunning: () => Promise<void>;
};

interface DagsterCreds {
  readonly baseUrl: string;
  readonly apiToken: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<DagsterCreds | null> {
  const baseUrl = (await ctx.getSecret("base_url"))?.trim() ?? "";
  const apiToken = (await ctx.getSecret("api_token"))?.trim() ?? "";
  // Both keys are required for spawn/sync to keep wiring uniform — a keyless
  // self-hosted OSS Dagster still gets a placeholder api_token.
  if (baseUrl === "" || apiToken === "") {
    return null;
  }
  return { baseUrl: trimTrailingSlash(baseUrl), apiToken };
}

/**
 * POST the GraphQL query. Mirrors Wiz's GraphQL handling: an HTTP 200 carrying a
 * top-level `errors` array is NOT success — it is downgraded to a parse_error so
 * the caller degrades gracefully (cursor preserved, no throw).
 */
async function dagsterGraphql(ctx: SyncContext, creds: DagsterCreds): Promise<FetchOutcome> {
  const outcome = await connectorFetch(ctx, SERVICE_ID, `${creds.baseUrl}/graphql`, {
    method: "POST",
    headers: {
      "Dagster-Cloud-Api-Token": creds.apiToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: JOBS_QUERY }),
  });
  if (outcome.kind !== "ok") {
    return outcome;
  }
  const envelope = outcome.parsed as { data?: unknown; errors?: unknown };
  if (envelope.errors !== undefined) {
    ctx.logger.warn({ serviceId: SERVICE_ID, errors: envelope.errors }, "dagster graphql errors");
    return { kind: "parse_error", bytes: outcome.bytes };
  }
  return { kind: "ok", parsed: envelope.data ?? {}, bytes: outcome.bytes };
}

/**
 * Flatten `data.repositoriesOrError.nodes[].pipelines[]` into per-job entries,
 * each carrying its repository + location. A `PythonError` typename (or a
 * missing connection) yields an empty list so the caller degrades gracefully.
 */
/**
 * Flatten one repository node's `pipelines[]` into `out`, returning `true` once
 * the `MAX_JOBS` cap is reached so the caller can stop walking repositories.
 */
function flattenRepoPipelines(node: unknown, out: DagsterFlatJob[]): boolean {
  const repo = asRecord(node);
  if (repo === undefined) {
    return false;
  }
  const repository = stringField(repo, "name") ?? "";
  const locationRow = asRecord(repo["location"]);
  const location = locationRow === undefined ? null : (stringField(locationRow, "name") ?? null);
  const pipelines = repo["pipelines"];
  if (!Array.isArray(pipelines)) {
    return false;
  }
  for (const p of pipelines) {
    const raw = asRecord(p);
    if (raw === undefined) {
      continue;
    }
    const name = stringField(raw, "name");
    if (name === undefined || name === "") {
      continue;
    }
    out.push({ name, repository, location, raw });
    if (out.length >= MAX_JOBS) {
      return true;
    }
  }
  return false;
}

export function flattenJobs(parsed: unknown): DagsterFlatJob[] {
  const root = asRecord(parsed) ?? {};
  const repos = asRecord(root["repositoriesOrError"]) ?? {};
  if (repos["__typename"] === "PythonError") {
    return [];
  }
  const nodes = repos["nodes"];
  if (!Array.isArray(nodes)) {
    return [];
  }
  const out: DagsterFlatJob[] = [];
  for (const node of nodes) {
    if (flattenRepoPipelines(node, out)) {
      break;
    }
  }
  return out;
}

export function createDagsterSyncable(options: DagsterSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureDagsterMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      // The repositories query returns the full repo+job catalog in one
      // response — a single forward pass per cycle. A GraphQL-level error
      // (PythonError typename or a top-level `errors` array → parse_error) or an
      // HTTP error degrades gracefully with the cursor preserved.
      const outcome = await dagsterGraphql(ctx, creds);
      const totalBytes = outcome.bytes;
      if (outcome.kind === "http_error") {
        return syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor());
      }
      if (outcome.kind === "parse_error") {
        return syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      for (const job of flattenJobs(outcome.parsed)) {
        const mapped = mapDagsterJobToItem(job, { baseUrl: creds.baseUrl, syncedAt: now });
        if (mapped === null) {
          continue;
        }
        upsertIndexedItemForSync(ctx, mapped);
        totalUpserted += 1;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
