import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createTeamVaultView } from "./team-vault-view.ts";

/** The request handed to the (injected) ephemeral-spawn seam: spawn `service` with the team-scoped
 *  vault view, call `toolId(args)`, drain. The secret values are read by the spawner from `vaultView`
 *  and injected into the subprocess env — they never enter `invokeTeamTool`'s scope. */
export interface TeamToolSpawnRequest {
  readonly service: string;
  readonly toolId: string;
  readonly args: unknown;
  readonly vaultView: NimbusVault;
  readonly sandboxCwd: string;
}

export interface InvokeTeamToolDeps {
  readonly vault: NimbusVault;
  readonly sandboxCwd: string;
  /** Required vault secret keys for a service (CONNECTOR_VAULT_SECRET_KEYS[service]); undefined → unknown service. */
  readonly requiredSecretKeysFor: (service: string) => readonly string[] | undefined;
  /** Spawns an ephemeral team-credentialed connector and calls the tool. Heavy I/O lives here so the
   *  fail-closed secret logic above stays unit-testable. */
  readonly spawnAndCall: (req: TeamToolSpawnRequest) => Promise<unknown>;
}

export interface TeamToolRequest {
  readonly entry: string;
  readonly service: string;
  readonly toolId: string;
  readonly args: unknown;
}

export class TeamToolError extends Error {
  readonly code: "team_service_unsupported" | "team_secret_missing";
  constructor(code: "team_service_unsupported" | "team_secret_missing", message: string) {
    super(message);
    this.name = "TeamToolError";
    this.code = code;
  }
}

/**
 * I19 — run a connector tool using a TEAM credential. The secret is read from the team keyspace
 * (`teamvault.<entry>.<key>`) by the spawner via a read-only vault view and injected into the
 * connector subprocess env. It is NEVER read into this function's scope, returned, or logged — only
 * the tool result is returned. Fails CLOSED: an unknown/OAuth-only service or a missing team secret
 * aborts the invoke (D8 — never fall through to the operator's own local credential).
 */
export async function invokeTeamTool(
  deps: InvokeTeamToolDeps,
  req: TeamToolRequest,
): Promise<unknown> {
  const requiredKeys = deps.requiredSecretKeysFor(req.service);
  if (requiredKeys === undefined || requiredKeys.length === 0) {
    // Unknown service, or an OAuth-refresh connector with no static secret keys: not team-invokable.
    throw new TeamToolError(
      "team_service_unsupported",
      `team-vault: service "${req.service}" has no team-injectable secret keys`,
    );
  }

  const vaultView = createTeamVaultView(deps.vault, req.entry);

  // Fail closed: every required secret must be present in the team keyspace before we spawn.
  for (const key of requiredKeys) {
    const present = await vaultView.get(key);
    if (present === null || present === "") {
      throw new TeamToolError(
        "team_secret_missing",
        `team-vault: entry "${req.entry}" is missing required secret for ${req.service}`,
      );
    }
  }

  return deps.spawnAndCall({
    service: req.service,
    toolId: req.toolId,
    args: req.args,
    vaultView,
    sandboxCwd: deps.sandboxCwd,
  });
}
