// Content checks for a role pack against what this gateway knows: its defaults fragment, the
// connectors it suggests and the agents it makes visible. Members are checked elsewhere.

import type { RolePackManifest } from "@nimbus-dev/registry-format";
import { normaliseAgentName } from "../catalog/agent-visibility.ts";
import { checkPackFragment } from "../config/pack-settable.ts";
import { builtinSourceEntries } from "../sources/source-kinds.ts";
import { PERSONAL_SOURCE_TYPES, sourceMapFromList } from "../sources/source-mapping.ts";
import { checkPackFleetJobs } from "./pack-job-check.ts";

const BUILTIN_TYPES: ReadonlySet<string> = new Set(builtinSourceEntries().map(([key]) => key));

/** A pack only adds sources: never a built-in type, never a personal inbox or calendar. */
function sourceMapProblems(entries: readonly string[]): string[] {
  const problems: string[] = [];
  for (const type of sourceMapFromList(entries).keys()) {
    if (BUILTIN_TYPES.has(type)) problems.push(`[sources] map names built-in source "${type}"`);
    else if (PERSONAL_SOURCE_TYPES.has(type)) {
      problems.push(`[sources] map names personal source "${type}"`);
    }
  }
  return problems;
}

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
    problems.push(...sourceMapProblems(fragment.lists.get("sources.map") ?? []));
  } else {
    problems.push(...fragment.problems);
  }
  for (const id of m.suggestedConnectors) {
    if (!deps.connectorIds.has(id)) problems.push(`suggested connector "${id}" is not known`);
  }
  return problems;
}
