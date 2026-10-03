import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import type { ConnectorToolSession } from "../teamvault/connector-session.ts";
import { withConnectorSession } from "../teamvault/connector-session.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { type SyncUpsertRow, upsertMapped } from "./_lib/paginated-sync.ts";
import { drainPagedList } from "./connector-list-page.ts";

type PersonalDrain = (ctx: SyncContext, service: string, listToolId: string) => Promise<unknown[]>;

const realPersonalDrain: PersonalDrain = (ctx, service, listToolId) =>
  withConnectorSession(
    {
      service,
      vaultView: ctx.scopedVaultView(service),
      sandboxCwd: ctx.sandboxCwd,
    },
    (session) => drainPagedList(session, listToolId),
  );

let personalDrainOverride: PersonalDrain | undefined;

/** TEST-ONLY DI seam (avoids spawning a real subprocess). */
export function __setPersonalDrainForTest(fn: PersonalDrain | undefined): void {
  personalDrainOverride = fn;
}

export async function listConnectorItems(
  ctx: SyncContext,
  service: string,
  listToolId: string,
): Promise<unknown[]> {
  const cfg = ctx.credentialFor(service);
  if (cfg.credential === "team") {
    if (cfg.teamEntry === undefined || cfg.teamEntry === "") {
      throw new Error(`connectors.${service}: credential = "team" requires a team_entry`);
    }
    return ctx.runTeamList({ entry: cfg.teamEntry, service, listToolId });
  }
  return (personalDrainOverride ?? realPersonalDrain)(ctx, service, listToolId);
}

/** One `_list` tool a warehouse/BI syncable drains, and how its rows become index items. */
export interface WarehouseListSource {
  /** The connector's paginated `_list` tool, drained whole by {@link listConnectorItems}. */
  readonly listToolId: string;
  /** Reshape the drained list before mapping; when omitted, each drained item is one row. */
  readonly rows?: (drained: unknown[]) => readonly unknown[];
  /** Map one row to an index item, or null to skip it. */
  readonly map: (row: unknown, mapping: { readonly syncedAt: number }) => SyncUpsertRow | null;
}

/**
 * A warehouse/BI syncable on the unified Wave-7b spawn transport. Each source's `_list` is drained
 * through {@link listConnectorItems} (personal: a service-scoped vault view; team: the I19
 * localOperator gate), one after another and ALL before anything is indexed, so a failed drain
 * indexes nothing; then every row is mapped and upserted, in source order, all stamped with ONE
 * `syncedAt` read after the last drain. Pagination is fully drained in the transport, so the input
 * `cursor` passes through unchanged and `hasMore` is false.
 */
export function createWarehouseListSyncable(
  serviceId: string,
  sources: readonly WarehouseListSource[],
): Syncable {
  return {
    serviceId,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const drained: { readonly source: WarehouseListSource; readonly items: unknown[] }[] = [];
      for (const source of sources) {
        const items = await listConnectorItems(ctx, serviceId, source.listToolId); // NOSONAR S9382: one connector session at a time - each drain spawns the connector (or opens a team session through the gate), so Promise.all would run every list's connector process at once
        drained.push({ source, items });
      }
      const now = Date.now();
      let upserted = 0;
      for (const { source, items } of drained) {
        const rows = source.rows === undefined ? items : source.rows(items);
        upserted += upsertMapped(ctx, rows, (row) => source.map(row, { syncedAt: now }));
      }
      return {
        cursor,
        itemsUpserted: upserted,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}

/** Opens a team-credentialed session and drains its paginated `_list` (production: drainTeamListSession). */
export type TeamListOpenSession = (req: {
  service: string;
  vaultView: NimbusVault;
  sandboxCwd: string;
  listToolId: string;
}) => Promise<unknown[]>;

/**
 * E2E seam (`NIMBUS_WAREHOUSE_E2E_SINK_DIR`, mirroring `NIMBUS_CHATOPS_E2E_SINK_DIR`): instead of
 * spawning a real connector, read paged list fixtures from `<sinkDir>/mock-warehouse.json`
 * (`{ pages: [[...], [...]] }`) and drain them through the SAME {@link drainPagedList} cursor loop
 * the production path uses. The gate still enforces the team-secret presence check before this runs;
 * the sink itself never reads the secret.
 */
export function warehouseSinkOpenSession(sinkDir: string): TeamListOpenSession {
  return (req) => {
    const parsed = JSON.parse(readFileSync(join(sinkDir, "mock-warehouse.json"), "utf8")) as {
      pages: unknown[][];
    };
    const pages = parsed.pages;
    const session: ConnectorToolSession = {
      call: (_toolId, args) => {
        const { cursor } = args as { cursor: string | null };
        const idx = cursor === null ? 0 : Number.parseInt(cursor, 10);
        const nextCursor = idx + 1 < pages.length ? String(idx + 1) : null;
        // An out-of-range idx makes `pages[idx]` undefined → JSON.stringify drops the key →
        // parseMcpListPage defaults `items` to [] (its Array.isArray guard). Safe without a local guard.
        return Promise.resolve({
          content: [{ type: "text", text: JSON.stringify({ items: pages[idx], nextCursor }) }],
        });
      },
    };
    return drainPagedList(session, req.listToolId);
  };
}

/** The e2e sink opener when `NIMBUS_WAREHOUSE_E2E_SINK_DIR` is set, else the production opener. */
export function resolveTeamListOpenSession(
  sinkDir: string | undefined,
  production: TeamListOpenSession,
): TeamListOpenSession {
  return sinkDir === undefined || sinkDir === "" ? production : warehouseSinkOpenSession(sinkDir);
}
