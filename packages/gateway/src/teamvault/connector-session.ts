import type { MCPClient } from "@mastra/mcp";
import * as spawners from "../connectors/lazy-mesh/connector-spawns.ts";
import type { MeshSpawnContext } from "../connectors/lazy-mesh/slot.ts";
import { type LazyMeshToolMap, listLazyMeshClientTools } from "../connectors/lazy-mesh/tool-map.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export interface ConnectorSessionRequest {
  readonly service: string;
  readonly vaultView: NimbusVault;
  readonly sandboxCwd: string;
}

export interface ConnectorToolSession {
  call(toolId: string, args: unknown): Promise<unknown>;
}

type Spawner = (ctx: MeshSpawnContext) => Promise<void>;

/**
 * service → the existing first-party spawner. Reusing the spawners means the team-credentialed
 * instance goes through the SAME env mapping, `extensionProcessEnv` (I1), and `wrapServerSpec`
 * sandbox (I15) as a normal connector — no duplication, no new trust surface.
 */
const SINGLE_SERVICE_SPAWNERS: Readonly<Record<string, Spawner>> = {
  github: spawners.ensureGithubMcp,
  gitlab: spawners.ensureGitlabMcp,
  bitbucket: spawners.ensureBitbucketMcp,
  slack: spawners.ensureSlackMcp,
  linear: spawners.ensureLinearMcp,
  jira: spawners.ensureJiraMcp,
  confluence: spawners.ensureConfluenceMcp,
  notion: spawners.ensureNotionMcp,
  discord: spawners.ensureDiscordMcp,
  jenkins: spawners.ensureJenkinsMcp,
  circleci: spawners.ensureCircleciMcp,
  pagerduty: spawners.ensurePagerdutyMcp,
  kubernetes: spawners.ensureKubernetesMcp,
  zoom: spawners.ensureZoomMcp,
  hubspot: spawners.ensureHubspotMcp,
  miro: spawners.ensureMiroMcp,
  canva: spawners.ensureCanvaMcp,
  figma: spawners.ensureFigmaMcp,
  salesforce: spawners.ensureSalesforceMcp,
};

export function spawnerFor(service: string): Spawner {
  // Phase-3 cloud/observability/data connectors (aws, azure, gcp, grafana, sentry, datadog, …)
  // are all started by the bundle spawner, which only launches the credentialed server.
  return SINGLE_SERVICE_SPAWNERS[service] ?? spawners.ensurePhase3BundleMcp;
}

interface SessionClient {
  listTools(): Promise<LazyMeshToolMap>;
  disconnect(): Promise<void>;
}

type SessionSpawn = (
  req: ConnectorSessionRequest,
) => Promise<SessionClient | undefined> | SessionClient | undefined;

let spawnOverride: SessionSpawn | undefined;

/** TEST-ONLY DI seam. Pass `undefined` to restore the real mesh spawn. */
export function __setSessionSpawnerForTest(fn: SessionSpawn | undefined): void {
  spawnOverride = fn;
}

/**
 * Assemble a throwaway {@link MeshSpawnContext}, run `resolveSpawner(service)(ctx)` to register
 * exactly one client, and wrap it as a {@link SessionClient}. `resolveSpawner` defaults to the
 * real per-service spawner table; it is injectable so the deterministic client-assembly logic is
 * unit-testable without launching a sandboxed subprocess.
 */
export async function realSpawn(
  req: ConnectorSessionRequest,
  resolveSpawner: (service: string) => Spawner = spawnerFor,
): Promise<SessionClient | undefined> {
  const clients = new Map<string, MCPClient>();
  const ctx: MeshSpawnContext = {
    vault: req.vaultView,
    sandboxCwd: req.sandboxCwd,
    clearLazyIdle: () => {},
    getLazyClient: (key) => clients.get(key),
    setLazyClient: (key, client) => {
      clients.set(key, client);
    },
    bumpToolsEpoch: () => {},
    scheduleLazyDisconnect: () => {},
  };
  await resolveSpawner(req.service)(ctx);
  // Each spawner registers exactly one client via setLazyClient (see connector-spawns.ts), so first is the only entry.
  const client = [...clients.values()][0];
  if (client === undefined) return undefined;
  return {
    listTools: () => listLazyMeshClientTools(client),
    disconnect: () =>
      client
        .disconnect()
        .then(() => {})
        .catch(() => {}),
  };
}

/**
 * Spawn a connector ONCE, execute `body` with a session that can make N calls, then disconnect.
 * D9 primitive: Windows process spawns are expensive — one spawn per sync cycle, N paginated calls.
 */
export async function withConnectorSession<T>(
  req: ConnectorSessionRequest,
  body: (session: ConnectorToolSession) => Promise<T>,
): Promise<T> {
  const spawn = spawnOverride ?? realSpawn;
  const client = await spawn(req);
  if (client === undefined) {
    throw new Error(`connector-session: no server spawned for service "${req.service}"`);
  }
  try {
    const tools = await client.listTools();
    const session: ConnectorToolSession = {
      call(toolId, args) {
        const tool = tools[toolId];
        if (tool?.execute === undefined) {
          return Promise.reject(
            new Error(`connector-session: tool "${toolId}" not found for service "${req.service}"`),
          );
        }
        return tool.execute(args);
      },
    };
    return await body(session);
  } finally {
    await client.disconnect();
  }
}
