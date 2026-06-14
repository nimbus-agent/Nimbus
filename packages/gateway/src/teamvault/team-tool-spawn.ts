import { withConnectorSession } from "./connector-session.ts";
import type { TeamToolSpawnRequest } from "./team-tool-invoke.ts";

/**
 * The single-call ephemeral-spawn seam for {@link invokeTeamTool}: spawn the team-credentialed
 * connector, call the named tool once, tear down. The team secret only ever lives in the spawned
 * subprocess env + the view's call scope — never returned.
 */
export async function spawnTeamToolAndCall(req: TeamToolSpawnRequest): Promise<unknown> {
  return withConnectorSession(
    { service: req.service, vaultView: req.vaultView, sandboxCwd: req.sandboxCwd },
    (session) => session.call(req.toolId, req.args),
  );
}
