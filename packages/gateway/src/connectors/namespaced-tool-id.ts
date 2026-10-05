/**
 * Whether a caller-supplied tool id names one of a set of connector tools, in any form a federated
 * session can EXECUTE it under.
 *
 * A team-credentialed session lists its tools through `@mastra/mcp`'s `MCPClient.listTools()`, which
 * keys every tool `<server>_<tool>` (`aws_aws_ec2_instance_stop`), and `withConnectorSession` looks
 * the requested id up in that map verbatim — so the namespaced key is the form that runs there, and
 * the bare id is not found. A check over bare ids alone refuses exactly the ids that cannot run and
 * passes the ones that can. Any `_`-delimited suffix of `toolId` that `isExactly` accepts therefore
 * names that tool, whatever server key precedes it (`github_actions_gha_run_trigger` included).
 *
 * Only a suffix no longer than `longestId` can match, so the scan starts there: its cost is bounded
 * by that length, never by the caller-supplied id's (an unbounded scan of a 200k-underscore id took
 * 14 s). ONE implementation, shared by every federated tool-id refusal (I26), so the matching rule
 * cannot drift between them.
 */
export function matchesBareOrNamespacedToolId(
  toolId: string,
  isExactly: (id: string) => boolean,
  longestId: number,
): boolean {
  if (isExactly(toolId)) return true;
  const from = Math.max(0, toolId.length - longestId - 1);
  for (let i = toolId.indexOf("_", from); i !== -1; i = toolId.indexOf("_", i + 1)) {
    if (isExactly(toolId.slice(i + 1))) return true;
  }
  return false;
}
