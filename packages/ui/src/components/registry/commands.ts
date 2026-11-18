/**
 * The terminal commands the marketplace tile offers to copy. The desktop never installs or sponsors
 * anything itself (B1 chain C1): it shows the owner the exact CLI command, built only from values the
 * CLI's own rules accept, so a pasted command can never carry text a registry slipped in.
 */

/** A publishable extension id: `/`-separated segments of `[A-Za-z0-9._-]`, at most 128 characters. */
const ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ID_LENGTH = 128;
/** `registry add`'s name rule, or the built-in official registry's reserved name. */
const REGISTRY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_REGISTRY_NAME_LENGTH = 32;

export function isCommandSafeId(id: string): boolean {
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return false;
  return id
    .split("/")
    .every((seg) => ID_SEGMENT_RE.test(seg) && !seg.endsWith(".") && !seg.endsWith(".lock"));
}

export function isCommandSafeRegistry(name: string): boolean {
  return name.length <= MAX_REGISTRY_NAME_LENGTH && REGISTRY_NAME_RE.test(name);
}

function bothSafe(id: string, registry: string): boolean {
  return isCommandSafeId(id) && isCommandSafeRegistry(registry);
}

/** `nimbus extension install <id> --registry <name>`, or `null` when either value fails its rule. */
export function installCommand(id: string, registry: string): string | null {
  return bothSafe(id, registry) ? `nimbus extension install ${id} --registry ${registry}` : null;
}

/** `nimbus extension sponsor <id> --registry <name>`, or `null` under the same rules. */
export function sponsorCommand(id: string, registry: string): string | null {
  return bothSafe(id, registry) ? `nimbus extension sponsor ${id} --registry ${registry}` : null;
}
