// Content checks for a role pack against what this gateway knows: its defaults fragment, the
// connectors it suggests and the agents it makes visible. Members are checked elsewhere.

import type { RolePackManifest } from "@nimbus-dev/registry-format";
import { normaliseAgentName } from "../catalog/agent-visibility.ts";
import { checkPackFragment } from "../config/pack-settable.ts";
import { checkPackFleetJobs } from "./pack-job-check.ts";

export function validatePackContent(
  m: RolePackManifest,
  deps: { readonly connectorIds: ReadonlySet<string>; readonly agentNames: ReadonlySet<string> },
): readonly string[] {
  const problems: string[] = [];
  const fragment = checkPackFragment(m.defaults, checkPackFleetJobs);
  if (fragment.ok) {
    for (const name of fragment.lists.get("agents.visible") ?? []) {
      if (!deps.agentNames.has(normaliseAgentName(name))) {
        problems.push(`[agents] visible names unknown agent "${name}"`);
      }
    }
  } else {
    problems.push(...fragment.problems);
  }
  for (const id of m.suggestedConnectors) {
    if (!deps.connectorIds.has(id)) problems.push(`suggested connector "${id}" is not known`);
  }
  return problems;
}
