import { drainPagedList } from "../connectors/connector-list-page.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { withConnectorSession } from "./connector-session.ts";
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

// ---------------------------------------------------------------------------
// Paginated list drain over a single team-credentialed session (Wave 7b / D9)
// ---------------------------------------------------------------------------

export interface TeamToolListRequest {
  readonly entry: string;
  readonly service: string;
  readonly listToolId: string;
}

export interface InvokeTeamToolListDeps {
  readonly vault: NimbusVault;
  readonly sandboxCwd: string;
  /** Required vault secret keys for a service; undefined → unknown/unsupported service. */
  readonly requiredSecretKeysFor: (service: string) => readonly string[] | undefined;
  /**
   * Open a connector session and drain the paginated list tool. The production implementation
   * (drainTeamListSession) wraps withConnectorSession + drainPagedList (D9: one spawn, N pages).
   * Injected for unit-testability so the fail-closed secret logic stays synchronous and fast.
   */
  readonly openSession: (req: {
    service: string;
    vaultView: NimbusVault;
    sandboxCwd: string;
    listToolId: string;
  }) => Promise<unknown[]>;
}

/**
 * Production `openSession` implementation: spawns the connector ONCE (D9), drains all pages of
 * `listToolId`, and disconnects. The team-scoped vault view (`vaultView`) is consumed only inside
 * the spawned subprocess env — it never leaves `withConnectorSession`'s scope.
 */
export function drainTeamListSession(req: {
  service: string;
  vaultView: NimbusVault;
  sandboxCwd: string;
  listToolId: string;
}): Promise<unknown[]> {
  return withConnectorSession(
    { service: req.service, vaultView: req.vaultView, sandboxCwd: req.sandboxCwd },
    (session) => drainPagedList(session, req.listToolId),
  );
}

/**
 * I19 — drain a paginated team-credentialed list tool. Applies the SAME fail-closed secret check
 * as `invokeTeamTool` (unknown service or missing secret → throw TeamToolError before any spawn).
 * The secret is consumed inside `deps.openSession`; it never enters this function's scope.
 */
export async function invokeTeamToolList(
  deps: InvokeTeamToolListDeps,
  req: TeamToolListRequest,
): Promise<unknown[]> {
  const requiredKeys = deps.requiredSecretKeysFor(req.service);
  if (requiredKeys === undefined || requiredKeys.length === 0) {
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

  return deps.openSession({
    service: req.service,
    vaultView,
    sandboxCwd: deps.sandboxCwd,
    listToolId: req.listToolId,
  });
}
