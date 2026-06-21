// packages/gateway/src/connectors/connector-write-transport.ts
import { withConnectorSession } from "../teamvault/connector-session.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createServiceScopedVaultView } from "./service-scoped-vault-view.ts";

export interface ConnectorWriteContext {
  readonly vault: NimbusVault;
  readonly sandboxCwd: string;
  /** Per-connector credential selection from [connectors.<name>]; defaults to personal. */
  readonly credentialFor: (service: string) => {
    credential: "personal" | "team";
    teamEntry?: string;
  };
  /** Gate-routed localOperator team invoke (I19); returns the tool result or throws. */
  readonly runTeamInvoke: (req: {
    entry: string;
    service: string;
    toolId: string;
    args: unknown;
  }) => Promise<unknown>;
}

type PersonalInvoke = (
  ctx: ConnectorWriteContext,
  service: string,
  writeToolId: string,
  args: unknown,
) => Promise<unknown>;

const realPersonalInvoke: PersonalInvoke = (ctx, service, writeToolId, args) =>
  withConnectorSession(
    {
      service,
      vaultView: createServiceScopedVaultView(ctx.vault, service),
      sandboxCwd: ctx.sandboxCwd,
    },
    (session) => session.call(writeToolId, args),
  );

let personalInvokeOverride: PersonalInvoke | undefined;

/** TEST-ONLY DI seam (avoids spawning a real subprocess). */
export function __setPersonalInvokeForTest(fn: PersonalInvoke | undefined): void {
  personalInvokeOverride = fn;
}

/**
 * Run a connector write tool with the connector's configured credential. Mirrors
 * {@link listConnectorItems}: personal → spawn once with a service-scoped vault view and call the
 * write tool; team → the I19 localOperator invoke gate. The HITL (I2) check is upstream in the
 * executor — this transport is reached only after `gate()` returns "proceed".
 */
export async function invokeConnectorWrite(
  ctx: ConnectorWriteContext,
  req: { service: string; writeToolId: string; args: unknown },
): Promise<unknown> {
  const cfg = ctx.credentialFor(req.service);
  if (cfg.credential === "team") {
    if (cfg.teamEntry === undefined || cfg.teamEntry === "") {
      throw new Error(`connectors.${req.service}: credential = "team" requires a team_entry`);
    }
    return ctx.runTeamInvoke({
      entry: cfg.teamEntry,
      service: req.service,
      toolId: req.writeToolId,
      args: req.args,
    });
  }
  return (personalInvokeOverride ?? realPersonalInvoke)(
    ctx,
    req.service,
    req.writeToolId,
    req.args,
  );
}
