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
  /** Alternative-auth groups (TEAM_SECRET_ANYOF_GROUPS[service]): each group needs at least ONE key
   *  present instead of all (e.g. Snowflake oauth_token | key_pair_jwt). Omitted → every key is AND-required. */
  readonly anyOfSecretGroupsFor?: (service: string) => readonly (readonly string[])[] | undefined;
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
 * Fail-closed secret guard (I19 D8): validates that `service` has team-injectable secret keys and
 * that every required key is present in the team keyspace for `entry`. Returns the team-scoped vault
 * view on success so the caller can pass it to the spawn/session seam without re-creating it.
 * Throws `TeamToolError` before any spawn occurs if either check fails — a single source of truth
 * that both `invokeTeamTool` and `invokeTeamToolList` delegate to, preventing security drift.
 */
async function assertTeamSecretsPresentAndView(
  deps: {
    vault: NimbusVault;
    requiredSecretKeysFor: (service: string) => readonly string[] | undefined;
    anyOfSecretGroupsFor?: (service: string) => readonly (readonly string[])[] | undefined;
  },
  service: string,
  entry: string,
): Promise<NimbusVault> {
  const requiredKeys = deps.requiredSecretKeysFor(service);
  if (requiredKeys === undefined || requiredKeys.length === 0) {
    throw new TeamToolError(
      "team_service_unsupported",
      `team-vault: service "${service}" has no team-injectable secret keys`,
    );
  }
  const vaultView = createTeamVaultView(deps.vault, entry);
  const anyOfGroups = deps.anyOfSecretGroupsFor?.(service) ?? [];
  const anyOfKeys = new Set(anyOfGroups.flat());
  const missing = (): never => {
    throw new TeamToolError(
      "team_secret_missing",
      `team-vault: entry "${entry}" is missing required secret for ${service}`,
    );
  };
  const isPresent = async (key: string): Promise<boolean> => {
    const value = await vaultView.get(key);
    return value !== null && value !== "";
  };

  // Keys outside any alternative-auth group are each individually required (AND).
  for (const key of requiredKeys) {
    if (anyOfKeys.has(key)) continue;
    if (!(await isPresent(key))) missing();
  }
  // Each alternative-auth group needs at least ONE key present (e.g. Snowflake oauth_token | key_pair_jwt).
  for (const group of anyOfGroups) {
    let satisfied = false;
    for (const key of group) {
      if (await isPresent(key)) {
        satisfied = true;
        break;
      }
    }
    if (!satisfied) missing();
  }
  return vaultView;
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
  // Unknown service, or an OAuth-refresh connector with no static secret keys: not team-invokable.
  const vaultView = await assertTeamSecretsPresentAndView(deps, req.service, req.entry);

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
  /** Alternative-auth groups (TEAM_SECRET_ANYOF_GROUPS[service]): each group needs at least ONE key
   *  present instead of all. Omitted → every key is AND-required. */
  readonly anyOfSecretGroupsFor?: (service: string) => readonly (readonly string[])[] | undefined;
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
  const vaultView = await assertTeamSecretsPresentAndView(deps, req.service, req.entry);

  return deps.openSession({
    service: req.service,
    vaultView,
    sandboxCwd: deps.sandboxCwd,
    listToolId: req.listToolId,
  });
}
