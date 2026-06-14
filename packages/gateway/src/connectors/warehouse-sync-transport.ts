import type { SyncContext } from "../sync/types.ts";
import { withConnectorSession } from "../teamvault/connector-session.ts";
import { drainPagedList } from "./connector-list-page.ts";
import { createServiceScopedVaultView } from "./service-scoped-vault-view.ts";

type PersonalDrain = (ctx: SyncContext, service: string, listToolId: string) => Promise<unknown[]>;

const realPersonalDrain: PersonalDrain = (ctx, service, listToolId) =>
  withConnectorSession(
    {
      service,
      vaultView: createServiceScopedVaultView(ctx.vault, service),
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
