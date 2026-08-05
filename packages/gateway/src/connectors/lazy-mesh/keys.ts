import { selfSpawn } from "../../platform/runtime-layout.ts";

/**
 * The command+args that run a first-party connector. In a dev tree this is
 * `bun <gateway>/src/index.ts __nimbus-connector <pkg>`; in a compiled binary it is the binary
 * re-executing itself. It is never `bun <path-into-the-source-tree>` — a released binary ships
 * with neither bun nor that tree.
 */
export function connectorSpawn(packageDir: string): { command: string; args: string[] } {
  return selfSpawn("connector", [packageDir]);
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
  mendeley: "mesh:mendeley",
  workday: "mesh:workday",
  confluence: "mesh:confluence",
  discord: "mesh:discord",
  jenkins: "mesh:jenkins",
  circleci: "mesh:circleci",
  pagerduty: "mesh:pagerduty",
  kubernetes: "mesh:kubernetes",
  obsidian: "mesh:obsidian",
  zoom: "mesh:zoom",
  hubspot: "mesh:hubspot",
  miro: "mesh:miro",
  canva: "mesh:canva",
  figma: "mesh:figma",
  salesforce: "mesh:salesforce",
  apple: "mesh:apple",
  phase3Bundle: "mesh:phase3-bundle",
} as const;

export const USER_MESH_PREFIX = "mesh:user:";

export function userMcpMeshKey(serviceId: string): string {
  return `${USER_MESH_PREFIX}${serviceId}`;
}
