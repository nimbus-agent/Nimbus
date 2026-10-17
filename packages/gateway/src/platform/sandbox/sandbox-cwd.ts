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

/**
 * The directory under the sandbox root that holds every extension's per-spawn stages. No policy id
 * in use maps to this leaf name (`ext.<id>` → `ext_…`, `user.<id>` → `user_…`, first-party
 * connector ids, `toolgen-probe`), so no spawn is ever handed it, or an ancestor of a stage, as a
 * working directory.
 */
export const EXTENSION_STAGE_DIR_NAME = "ext-stage";

/**
 * Where one extension's per-spawn stages live: `<sandboxRoot>/ext-stage/<serviceId leaf>`. Owned by
 * the gateway and never granted to the extension: each spawn's working directory is a fresh
 * `<uuid>` directory INSIDE it (invariant I43, `extensions/extension-stage.ts`).
 */
export function extensionStageRootFor(sandboxRoot: string, serviceId: string): string {
  return join(sandboxRoot, EXTENSION_STAGE_DIR_NAME, sandboxLeafName(serviceId));
}
