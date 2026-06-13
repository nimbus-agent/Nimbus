import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapMonteCarloIncidentToItem } from "./monte-carlo-dq-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "montecarlo";
const CURSOR_PREFIX = "nimbus-montecarlo1:";

const GRAPHQL_URL = "https://api.getmontecarlo.com/graphql";

/** Minimal GraphQL query listing incidents with their monitored table, status, severity, firstSeenAt. */
const GET_INCIDENTS_QUERY = `
  query NimbusGetIncidents {
    getIncidents(first: 200) {
      edges {
        node {
          incidentId
          status
          severity
          firstSeenAt
          monitoredTable
        }
      }
    }
  }
`.trim();

type MonteCarloCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies MonteCarloCursorV1);
}

export type MonteCarloSyncableOptions = {
  ensureMonteCarloMcpRunning: () => Promise<void>;
};

interface MonteCarloCreds {
  readonly apiId: string;
  readonly apiToken: string;
}

async function loadCreds(ctx: SyncContext): Promise<MonteCarloCreds | null> {
  const apiId = (await readConnectorSecret(ctx.vault, "montecarlo", "api_id"))?.trim() ?? "";
  const apiToken = (await readConnectorSecret(ctx.vault, "montecarlo", "api_token"))?.trim() ?? "";
  if (apiId === "" || apiToken === "") return null;
  return { apiId, apiToken };
}

function incidentsFromResponse(parsed: unknown): Record<string, unknown>[] {
  const root = asRecord(parsed);
  if (root === undefined) return [];
  const data = asRecord(root["data"]);
  if (data === undefined) return [];
  const getIncidents = asRecord(data["getIncidents"]);
  if (getIncidents === undefined) return [];
  const edges = Array.isArray(getIncidents["edges"]) ? getIncidents["edges"] : [];
  const out: Record<string, unknown>[] = [];
  for (const edge of edges) {
    const e = asRecord(edge);
    if (e === undefined) continue;
    const node = asRecord(e["node"]);
    if (node !== undefined) out.push(node);
  }
  return out;
}

export function createMonteCarloSyncable(options: MonteCarloSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMonteCarloMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) return syncNoopResult(cursor, t0);

      const outcome = await connectorFetch(ctx, SERVICE_ID, GRAPHQL_URL, {
        method: "POST",
        headers: {
          "x-mcd-id": creds.apiId,
          "x-mcd-token": creds.apiToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query: GET_INCIDENTS_QUERY }),
      });

      if (outcome.kind !== "ok") {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, outcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, outcome.bytes, pass1Cursor());
      }

      const now = Date.now();
      let upserted = 0;
      for (const rawIncident of incidentsFromResponse(outcome.parsed)) {
        const mapped = mapMonteCarloIncidentToItem(rawIncident, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }
      return syncPassCursorSuccess(t0, outcome.bytes, pass1Cursor(), upserted);
    },
  };
}
