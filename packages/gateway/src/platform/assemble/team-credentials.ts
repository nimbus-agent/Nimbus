import type { Database } from "bun:sqlite";
import type { ConnectorsConfig, TeamCredentialConnector } from "../../config/nimbus-toml.ts";
import {
  type CONNECTOR_VAULT_SECRET_KEYS,
  requiredSecretKeysFor as manifestRequiredSecretKeysFor,
  TEAM_SECRET_ANYOF_GROUPS,
} from "../../connectors/connector-secrets-manifest.ts";
import type { ConnectorWriteContext } from "../../connectors/connector-write-transport.ts";
import { resolveTeamListOpenSession } from "../../connectors/warehouse-sync-transport.ts";
import {
  answerLocalOperatorInvoke,
  answerLocalOperatorList,
  type LocalOperatorInvokeCtx,
  type LocalOperatorListCtx,
} from "../../federation/invoke-gate.ts";
import type { buildIdentityBoot } from "../../identity/identity-boot.ts";
import { isOperatorValid } from "../../identity/verifier.ts";
import type { SyncContext } from "../../sync/types.ts";
import {
  drainTeamListSession,
  invokeTeamTool,
  invokeTeamToolList,
} from "../../teamvault/team-tool-invoke.ts";
import { spawnTeamWriteAndCall } from "../../teamvault/team-tool-spawn.ts";
import { TeamVaultStore } from "../../teamvault/team-vault-store.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { processEnvGet } from "../env-access.ts";
import type { PlatformPaths } from "../paths.ts";
import { teamListErrorMessage } from "./federation-boot.ts";

/** Wave 7b/7c — build the team-shared credential contexts (I19 secret-consumption chokepoint).
 *  `credentialFor` reads the per-connector [connectors.<name>] pin (default personal); the
 *  localOperator list/invoke paths route through the principal-polymorphic gate. identityBoot is
 *  built later in assembly, so operator-validity is late-bound through `identityBootRefHolder` and
 *  fails closed until identity has booted (I18: identity-enabled but unbooted is treated as invalid).
 *  Extracted from assemblePlatformServices to keep its cognitive complexity in budget. */
export function buildTeamCredentialContexts(deps: {
  db: Database;
  vault: NimbusVault;
  paths: PlatformPaths;
  connectorsConfig: ConnectorsConfig;
  identityEnabled: boolean;
  identityBootRefHolder: { current: ReturnType<typeof buildIdentityBoot> | undefined };
  /** I22 connector allowlist, read per call: the write transport spawns its own session, outside
   *  the mesh's policy filter, so it checks this itself. */
  isConnectorAllowed: (serviceId: string) => boolean;
}): {
  teamCredentialExtras: Pick<SyncContext, "sandboxCwd" | "credentialFor" | "runTeamList">;
  connectorWriteDeps: ConnectorWriteContext;
} {
  const {
    db,
    vault,
    paths,
    connectorsConfig,
    identityEnabled,
    identityBootRefHolder,
    isConnectorAllowed,
  } = deps;
  // Shared by the list + invoke ctxs (previously duplicated): the late-bound operator-validity guard.
  const identitySpread = identityEnabled
    ? {
        identity: {
          enabled: true,
          isOperatorValid: () => {
            const ref = identityBootRefHolder.current;
            const store = ref?.store;
            const issuer = ref?.issuer;
            if (store === undefined || issuer === undefined) return false; // fail-closed until booted
            return isOperatorValid(store, issuer, Date.now(), ref?.graceSeconds ?? 0);
          },
        },
      }
    : {};

  const localOpListCtx: LocalOperatorListCtx = {
    db,
    store: new TeamVaultStore(db),
    runListTool: (input) =>
      invokeTeamToolList(
        {
          vault,
          sandboxCwd: paths.sandboxDir,
          requiredSecretKeysFor: manifestRequiredSecretKeysFor,
          anyOfSecretGroupsFor: (service: string) =>
            TEAM_SECRET_ANYOF_GROUPS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
          openSession: resolveTeamListOpenSession(
            processEnvGet("NIMBUS_WAREHOUSE_E2E_SINK_DIR"),
            drainTeamListSession,
          ),
        },
        input,
      ),
    ...identitySpread,
  };
  const teamCredentialExtras: Pick<SyncContext, "sandboxCwd" | "credentialFor" | "runTeamList"> = {
    sandboxCwd: paths.sandboxDir,
    credentialFor: (service: string) =>
      connectorsConfig.get(service as TeamCredentialConnector) ?? { credential: "personal" },
    runTeamList: (req) =>
      answerLocalOperatorList(localOpListCtx, req).then((r) => {
        if (r.kind === "error") throw new Error(teamListErrorMessage(r.error, req));
        return [...r.items];
      }),
  };

  // Wave 7c — team-credentialed local WRITE invoke (I19 single-tool variant). Mirrors localOpListCtx
  // but uses invokeTeamTool (single call) + a one-shot session call. The write's tool id is the
  // gateway's own (the write registry's bare MCP name), so it is resolved on the session's server
  // (spawnTeamWriteAndCall) — unlike the federated anchor's runTool, whose peer-named id is matched
  // to the listed key exactly (spawnTeamToolAndCall), because a grant is keyed on that string.
  const localOpInvokeCtx: LocalOperatorInvokeCtx = {
    db,
    store: new TeamVaultStore(db),
    runTool: (input) =>
      invokeTeamTool(
        {
          vault,
          sandboxCwd: paths.sandboxDir,
          requiredSecretKeysFor: manifestRequiredSecretKeysFor,
          anyOfSecretGroupsFor: (service: string) =>
            TEAM_SECRET_ANYOF_GROUPS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
          spawnAndCall: spawnTeamWriteAndCall,
        },
        input,
      ),
    ...identitySpread,
  };

  const connectorWriteDeps: ConnectorWriteContext = {
    vault,
    sandboxCwd: paths.sandboxDir,
    isConnectorAllowed,
    credentialFor: (service: string) =>
      connectorsConfig.get(service as TeamCredentialConnector) ?? { credential: "personal" },
    runTeamInvoke: (req) =>
      answerLocalOperatorInvoke(localOpInvokeCtx, req).then((r) => {
        if (r.kind === "error") {
          throw new Error(`team-vault write (${req.service}/${req.toolId}): ${r.error}`);
        }
        return r.result;
      }),
  };

  return { teamCredentialExtras, connectorWriteDeps };
}
