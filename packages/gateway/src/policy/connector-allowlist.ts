export interface AllowlistPartition {
  readonly permitted: readonly string[];
  readonly blocked: readonly string[];
}

/** Split configured connector ids by the policy allowlist. undefined allow = unrestricted. */
export function partitionByAllowlist(
  configured: readonly string[],
  allow: readonly string[] | undefined,
): AllowlistPartition {
  if (allow === undefined) return { permitted: configured, blocked: [] };
  const permitted: string[] = [];
  const blocked: string[] = [];
  for (const id of configured) (allow.includes(id) ? permitted : blocked).push(id);
  return { permitted, blocked };
}
