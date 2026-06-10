import type { MCPClient } from "@mastra/mcp";
import * as spawners from "../connectors/lazy-mesh/connector-spawns.ts";
import type { MeshSpawnContext } from "../connectors/lazy-mesh/slot.ts";
import { listLazyMeshClientTools } from "../connectors/lazy-mesh/tool-map.ts";
import type { TeamToolSpawnRequest } from "./team-tool-invoke.ts";

type Spawner = (ctx: MeshSpawnContext) => Promise<void>;

/**
 * service → the existing first-party spawner. Reusing the spawners means the team-credentialed
 * instance goes through the SAME env mapping, `extensionProcessEnv` (I1), and `wrapServerSpec`
 * sandbox (I15) as a normal connector — no duplication, no new trust surface. Cloud/observability
 * (phase 3) connectors share one bundle spawner that only starts the server whose creds are present
 * (the team view exposes exactly one service's secrets), so it resolves to the requested service.
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

function spawnerFor(service: string): Spawner {
  // Phase-3 cloud/observability/data connectors (aws, azure, gcp, grafana, sentry, datadog, …)
  // are all started by the bundle spawner, which only launches the credentialed server.
  return SINGLE_SERVICE_SPAWNERS[service] ?? spawners.ensurePhase3BundleMcp;
}

/**
 * The real ephemeral-spawn seam for {@link invokeTeamTool}. Spawns a throwaway connector instance
 * fed by the team-scoped vault view, calls the named tool, and tears the instance down. The team
 * secret only ever lives in the spawned subprocess env + the view's call scope — never returned.
 */
export async function spawnTeamToolAndCall(req: TeamToolSpawnRequest): Promise<unknown> {
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

  await spawnerFor(req.service)(ctx);
  try {
    for (const client of clients.values()) {
      const tools = await listLazyMeshClientTools(client);
      const tool = tools[req.toolId];
      if (tool?.execute !== undefined) {
        return await tool.execute(req.args);
      }
    }
    throw new Error(`team-vault: tool "${req.toolId}" not found for service "${req.service}"`);
  } finally {
    for (const client of clients.values()) {
      await client.disconnect().catch(() => {});
    }
  }
}
