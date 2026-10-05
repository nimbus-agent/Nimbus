import { withConnectorSession } from "./connector-session.ts";
import type { TeamToolSpawnRequest } from "./team-tool-invoke.ts";

/**
 * The FEDERATED anchor's single-call ephemeral-spawn seam for {@link invokeTeamTool}
 * (`teamVault.runTool` in platform/assemble.ts): spawn the team-credentialed connector, call the tool
 * a PEER named, tear down. The team secret only ever lives in the spawned subprocess env + the view's
 * call scope — never returned.
 *
 * The peer's id is called by the exact key the session lists it under (`session.callListed`), never
 * resolved from a bare tool name. The owner's grant, its revocation and the quorum rule all match
 * that id as a string, so the string a peer names must be the ONE key that runs: resolving would let
 * a grant made for `snowflake_list` run the tool listed as `snowflake_snowflake_list`, and would
 * make a bare write id the I26 predicate does not classify runnable where only its listed key was.
 * A peer therefore names `<server>_<tool>` (`stripe_stripe_search`), exactly as before.
 */
export async function spawnTeamToolAndCall(req: TeamToolSpawnRequest): Promise<unknown> {
  return withConnectorSession(
    { service: req.service, vaultView: req.vaultView, sandboxCwd: req.sandboxCwd },
    (session) => session.callListed(req.toolId, req.args),
  );
}

/**
 * The LOCAL team write's single-call seam (`localOpInvokeCtx` in platform/assemble.ts): the owner's
 * HITL-approved connector write, run with a team credential. Its tool id is the gateway's own — the
 * write registry's bare MCP name (`snowflake_tag_set`) — so it is resolved on the session's server
 * (`session.call`), the way a real session lists it (`snowflake_snowflake_tag_set`). Nothing here is
 * granted per tool id: the approval upstream is per ACTION (I2/I3), so a second spelling of the tool
 * carries no authorization of its own.
 */
export async function spawnTeamWriteAndCall(req: TeamToolSpawnRequest): Promise<unknown> {
  return withConnectorSession(
    { service: req.service, vaultView: req.vaultView, sandboxCwd: req.sandboxCwd },
    (session) => session.call(req.toolId, req.args),
  );
}
