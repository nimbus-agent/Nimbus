import { join } from "node:path";

/**
 * The per-policy working-directory leaf. A fixed character class, so a real policy id can never
 * produce a Windows reserved device name (`CON`, `NUL`, ...), a trailing dot/space, or a path
 * separator; matches `mcpServerKeyForUserConnector`'s mapping for user MCPs.
 */
export function sandboxLeafName(policyId: string): string {
  return policyId.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "_");
}

/** The working directory a sandboxed spawn of `policyId` runs in: `<sandboxRoot>/<leaf>`. */
export function sandboxCwdFor(sandboxRoot: string, policyId: string): string {
  return join(sandboxRoot, sandboxLeafName(policyId));
}
