import { findServiceIdPrefixCollision } from "../util/service-id-prefix.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";

/** Disjoint from user MCP's `mcp_` and from every first-party connector id. */
export const EXTENSION_SERVICE_ID_PATTERN = /^ext_[a-z0-9_]{1,62}$/;

/**
 * `ext_<slug>`, the slug being the manifest id lowercased with everything outside `[a-z0-9]` mapped
 * to `_`. Computed ONCE, when the first grant is created, and stored: never recomputed, so a later
 * change to this rule cannot move an existing extension's tools.
 */
export function deriveExtensionServiceId(manifestId: string): string {
  const id = `ext_${manifestId.toLowerCase().replaceAll(/[^a-z0-9]/g, "_")}`;
  if (!EXTENSION_SERVICE_ID_PATTERN.test(id)) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_SERVICE_ID_INVALID",
      `extension id "${manifestId}" does not yield a service id of 1-62 characters after "ext_"`,
    );
  }
  return id;
}

export function assertExtensionServiceIdFree(serviceId: string, existing: readonly string[]): void {
  const hit = findServiceIdPrefixCollision(serviceId, existing);
  if (hit !== undefined) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_SERVICE_ID_COLLISION",
      `service id "${serviceId}" collides with "${hit}", already granted to another extension (one is a prefix of the other at an underscore boundary)`,
    );
  }
}
