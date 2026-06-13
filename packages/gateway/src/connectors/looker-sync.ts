import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapLookerDashboardToItem, mapLookerViewToItem } from "./looker-content-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "looker";
const CURSOR_PREFIX = "nimbus-looker1:";

/**
 * Guard against flag-smuggling via the Looker base URL before it is used
 * in fetch calls. Mirrors isSafeTableauUrl for URL-style credentials.
 * The URL must parse successfully and have a non-empty hostname.
 */
function isSafeLookerUrl(value: string): boolean {
  if (value === "") return false;
  try {
    const u = new URL(value);
    return u.hostname !== "";
  } catch {
    return false;
  }
}

type LookerCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies LookerCursorV1);
}

export type LookerSyncableOptions = {
  ensureLookerMcpRunning: () => Promise<void>;
};

interface LookerCreds {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

async function loadCreds(ctx: SyncContext): Promise<LookerCreds | null> {
  const baseUrl = (await readConnectorSecret(ctx.vault, "looker", "base_url"))?.trim() ?? "";
  const clientId = (await readConnectorSecret(ctx.vault, "looker", "client_id"))?.trim() ?? "";
  const clientSecret =
    (await readConnectorSecret(ctx.vault, "looker", "client_secret"))?.trim() ?? "";
  if (baseUrl === "" || clientId === "" || clientSecret === "" || !isSafeLookerUrl(baseUrl)) {
    return null;
  }
  return { baseUrl, clientId, clientSecret };
}

function parseLoginResponse(parsed: unknown): string | null {
  const root = asRecord(parsed);
  if (root === undefined) return null;
  const token = stringField(root, "access_token");
  return token !== undefined && token !== "" ? token : null;
}

function dashboardsFromResponse(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of parsed) {
    const r = asRecord(item);
    if (r !== undefined) out.push(r);
  }
  return out;
}

function viewsFromModelsResponse(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) return [];
  const out: Record<string, unknown>[] = [];
  for (const modelItem of parsed) {
    const model = asRecord(modelItem);
    if (model === undefined) continue;
    const modelName = stringField(model, "name");
    if (modelName === undefined || modelName === "") continue;
    const explores = Array.isArray(model["explores"]) ? model["explores"] : [];
    for (const exploreItem of explores) {
      const explore = asRecord(exploreItem);
      if (explore === undefined) continue;
      const views = Array.isArray(explore["views"]) ? explore["views"] : [];
      for (const viewItem of views) {
        const view = asRecord(viewItem);
        if (view === undefined) continue;
        out.push({ ...view, model: modelName });
      }
    }
  }
  return out;
}

export function createLookerSyncable(options: LookerSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureLookerMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) return syncNoopResult(cursor, t0);

      // Step 1: authenticate to get a short-lived access token
      const loginUrl = `${creds.baseUrl}/api/4.0/login`;
      const loginOutcome = await connectorFetch(ctx, SERVICE_ID, loginUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: `client_id=${encodeURIComponent(creds.clientId)}&client_secret=${encodeURIComponent(creds.clientSecret)}`,
      });
      if (loginOutcome.kind !== "ok") {
        return loginOutcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, loginOutcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, loginOutcome.bytes, pass1Cursor());
      }
      const accessToken = parseLoginResponse(loginOutcome.parsed);
      if (accessToken === null) {
        return syncPassCursorParseEmpty(t0, loginOutcome.bytes, pass1Cursor());
      }

      const authHeader = { Authorization: `token ${accessToken}`, Accept: "application/json" };

      // Step 2a: list dashboards
      const dashboardsUrl = `${creds.baseUrl}/api/4.0/dashboards`;
      const dashboardsOutcome = await connectorFetch(ctx, SERVICE_ID, dashboardsUrl, {
        headers: authHeader,
      });
      if (dashboardsOutcome.kind !== "ok") {
        return dashboardsOutcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, dashboardsOutcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, dashboardsOutcome.bytes, pass1Cursor());
      }

      // Step 2b: list LookML models (for views with sql_table_name → lineage edges)
      const modelsUrl = `${creds.baseUrl}/api/4.0/lookml_models`;
      const modelsOutcome = await connectorFetch(ctx, SERVICE_ID, modelsUrl, {
        headers: authHeader,
      });
      if (modelsOutcome.kind !== "ok") {
        return modelsOutcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, modelsOutcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, modelsOutcome.bytes, pass1Cursor());
      }

      const now = Date.now();
      let upserted = 0;

      for (const rawDashboard of dashboardsFromResponse(dashboardsOutcome.parsed)) {
        const mapped = mapLookerDashboardToItem(rawDashboard, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }

      for (const rawView of viewsFromModelsResponse(modelsOutcome.parsed)) {
        const mapped = mapLookerViewToItem(rawView, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(
        t0,
        dashboardsOutcome.bytes + modelsOutcome.bytes,
        pass1Cursor(),
        upserted,
      );
    },
  };
}
