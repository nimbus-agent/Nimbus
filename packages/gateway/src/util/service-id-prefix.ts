/**
 * The first existing service id that equals `candidate`, or extends it or is extended by it at an
 * `_` boundary. MCP tool keys are `<serviceId>_<tool>`, so two such ids produce keys nobody can split
 * back apart (`ext_a` + `b_tool` vs `ext_a_b` + `tool`).
 */
export function findServiceIdPrefixCollision(
  candidate: string,
  existing: readonly string[],
): string | undefined {
  return existing.find(
    (id) => id === candidate || id.startsWith(`${candidate}_`) || candidate.startsWith(`${id}_`),
  );
}
