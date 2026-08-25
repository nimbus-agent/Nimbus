import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncContext } from "../sync/types.ts";
import type { ConnectorToolSession } from "../teamvault/connector-session.ts";
import { withConnectorSession } from "../teamvault/connector-session.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
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
