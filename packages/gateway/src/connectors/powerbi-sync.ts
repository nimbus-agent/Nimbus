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
import { mapPowerBiReportToItem } from "./powerbi-dashboard-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "powerbi";
const CURSOR_PREFIX = "nimbus-powerbi1:";

/**
 * Guard against flag-smuggling via the tenant_id before it is interpolated
 * into the AAD token URL (`login.microsoftonline.com/${tenantId}/...`).
 * Tenant ids are GUID-like strings or registered domain slugs; a value that
 * is empty, over-long, `-`-prefixed, or carries control characters is rejected
 * so the caller returns a noop.
 */
function isSafePowerBiTenantId(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.startsWith("-")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if ((value.codePointAt(i) ?? 0x20) < 0x20) {
      return false;
    }
  }
  return true;
}

type PowerBiCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies PowerBiCursorV1);
}

export type PowerBiSyncableOptions = {
  ensurePowerBiMcpRunning: () => Promise<void>;
};

interface PowerBiCreds {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

async function loadCreds(ctx: SyncContext): Promise<PowerBiCreds | null> {
  const tenantId = (await readConnectorSecret(ctx.vault, "powerbi", "tenant_id"))?.trim() ?? "";
  const clientId = (await readConnectorSecret(ctx.vault, "powerbi", "client_id"))?.trim() ?? "";
  const clientSecret =
    (await readConnectorSecret(ctx.vault, "powerbi", "client_secret"))?.trim() ?? "";
  if (
    tenantId === "" ||
    clientId === "" ||
    clientSecret === "" ||
    !isSafePowerBiTenantId(tenantId)
  ) {
    return null;
  }
  return { tenantId, clientId, clientSecret };
}

function parseTokenResponse(parsed: unknown): string | null {
  const root = asRecord(parsed);
  if (root === undefined) return null;
  const token = stringField(root, "access_token");
  return token !== undefined && token !== "" ? token : null;
}

function reportsFromResponse(parsed: unknown): Record<string, unknown>[] {
  const root = asRecord(parsed);
  if (root === undefined) return [];
  const value = Array.isArray(root["value"]) ? root["value"] : [];
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    const r = asRecord(item);
    if (r !== undefined) out.push(r);
  }
  return out;
}

function tablesFromResponse(parsed: unknown): string[] {
  const root = asRecord(parsed);
  if (root === undefined) return [];
  const value = Array.isArray(root["value"]) ? root["value"] : [];
  const out: string[] = [];
  for (const item of value) {
    const r = asRecord(item);
    if (r === undefined) continue;
    const name = stringField(r, "name");
    if (name !== undefined && name !== "") out.push(name);
  }
  return out;
}

export function createPowerBiSyncable(options: PowerBiSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensurePowerBiMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) return syncNoopResult(cursor, t0);

      // Step 1: obtain an AAD access token via client-credentials
      const tokenUrl = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`;
      const tokenBody =
        `grant_type=client_credentials` +
        `&client_id=${encodeURIComponent(creds.clientId)}` +
        `&client_secret=${encodeURIComponent(creds.clientSecret)}` +
        `&scope=${encodeURIComponent("https://analysis.windows.net/powerbi/api/.default")}`;
      const tokenOutcome = await connectorFetch(ctx, SERVICE_ID, tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: tokenBody,
      });
      if (tokenOutcome.kind !== "ok") {
        return tokenOutcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, tokenOutcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, tokenOutcome.bytes, pass1Cursor());
      }
      const accessToken = parseTokenResponse(tokenOutcome.parsed);
      if (accessToken === null) {
        return syncPassCursorParseEmpty(t0, tokenOutcome.bytes, pass1Cursor());
      }

      const authHeader = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      };

      // Step 2: list reports from the Power BI REST API
      const reportsUrl = "https://api.powerbi.com/v1.0/myorg/reports";
      const reportsOutcome = await connectorFetch(ctx, SERVICE_ID, reportsUrl, {
        headers: authHeader,
      });
      if (reportsOutcome.kind !== "ok") {
        return reportsOutcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, reportsOutcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, reportsOutcome.bytes, pass1Cursor());
      }

      const now = Date.now();
      let upserted = 0;
      let totalBytes = tokenOutcome.bytes + reportsOutcome.bytes;

      for (const rawReport of reportsFromResponse(reportsOutcome.parsed)) {
        const datasetId = stringField(rawReport, "datasetId");

        // Step 3 (optional): fetch dataset tables for lineage keys
        let datasetTables: string[] = [];
        if (datasetId !== undefined && datasetId !== "") {
          const tablesUrl = `https://api.powerbi.com/v1.0/myorg/datasets/${datasetId}/tables`;
          const tablesOutcome = await connectorFetch(ctx, SERVICE_ID, tablesUrl, {
            headers: authHeader,
          });
          if (tablesOutcome.kind === "ok") {
            datasetTables = tablesFromResponse(tablesOutcome.parsed);
            totalBytes += tablesOutcome.bytes;
          }
        }

        const mapped = mapPowerBiReportToItem({ ...rawReport, datasetTables }, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), upserted);
    },
  };
}
