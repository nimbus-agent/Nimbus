import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapPrefectDeploymentToItem } from "./prefect-deployment-mapping.ts";

const SERVICE_ID = "prefect";
const CURSOR_PREFIX = "nimbus-prefect1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type PrefectCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies PrefectCursorV1);
}

export type PrefectSyncableOptions = {
  ensurePrefectMcpRunning: () => Promise<void>;
};

interface PrefectCreds {
  readonly apiUrl: string;
  readonly apiKey: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<PrefectCreds | null> {
  const apiUrl = (await readConnectorSecret(ctx.vault, "prefect", "api_url"))?.trim() ?? "";
  const apiKey = (await readConnectorSecret(ctx.vault, "prefect", "api_key"))?.trim() ?? "";
  // Both keys are required for spawn/sync to keep wiring uniform — a keyless
  // self-hosted Prefect Server still gets a placeholder api_key.
  if (apiUrl === "" || apiKey === "") {
    return null;
  }
  return { apiUrl: trimTrailingSlash(apiUrl), apiKey };
}

/**
 * Prefect's list endpoints are POST-with-body filters, not GET query-string
 * endpoints. POST `<api_url>/deployments/filter` with `{ limit, offset, sort }`
 * returns a bare JSON array of deployment objects.
 */
function deploymentsFilter(ctx: SyncContext, creds: PrefectCreds, offset: number) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.apiUrl}/deployments/filter`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ limit: PAGE_SIZE, offset, sort: "CREATED_DESC" }),
  });
}

function extractDeployments(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [];
}

function upsertDeployments(
  ctx: SyncContext,
  creds: PrefectCreds,
  deployments: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const d of deployments) {
    const mapped = mapPrefectDeploymentToItem(d, { apiUrl: creds.apiUrl, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createPrefectSyncable(options: PrefectSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensurePrefectMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      // The POST /deployments/filter endpoint returns a bare array with no
      // total count; walk a single forward offset pass per cycle, stopping on
      // a short/empty page or the page cap.
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const offset = page * PAGE_SIZE;
        const outcome = await deploymentsFilter(ctx, creds, offset);
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const deployments = extractDeployments(outcome.parsed);
        totalUpserted += upsertDeployments(ctx, creds, deployments, now);

        if (deployments.length < PAGE_SIZE) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
