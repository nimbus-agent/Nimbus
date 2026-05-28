import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const _LAZY_MESH_DIR = dirname(fileURLToPath(import.meta.url));

// NB: One additional ".." compared to the original lazy-mesh.ts because this
// file lives in connectors/lazy-mesh/ instead of connectors/. Resolves to
// packages/mcp-connectors. A regression here breaks every spawn at runtime.
export const MCP_CONNECTORS_ROOT = join(_LAZY_MESH_DIR, "..", "..", "..", "..", "mcp-connectors");

export function mcpConnectorServerScript(packageDir: string): string {
  return join(MCP_CONNECTORS_ROOT, packageDir, "src", "server.ts");
}

export const LAZY_MESH = {
  googleBundle: "mesh:google-bundle",
  microsoftBundle: "mesh:microsoft-bundle",
  github: "mesh:github",
  gitlab: "mesh:gitlab",
  bitbucket: "mesh:bitbucket",
  slack: "mesh:slack",
  linear: "mesh:linear",
  jira: "mesh:jira",
  notion: "mesh:notion",
  confluence: "mesh:confluence",
  discord: "mesh:discord",
  jenkins: "mesh:jenkins",
  circleci: "mesh:circleci",
  pagerduty: "mesh:pagerduty",
  kubernetes: "mesh:kubernetes",
  obsidian: "mesh:obsidian",
  zoom: "mesh:zoom",
  phase3Bundle: "mesh:phase3-bundle",
} as const;

export const USER_MESH_PREFIX = "mesh:user:";

export function userMcpMeshKey(serviceId: string): string {
  return `${USER_MESH_PREFIX}${serviceId}`;
}
