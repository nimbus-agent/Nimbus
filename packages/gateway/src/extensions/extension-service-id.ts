import {
  deriveExtensionServiceId as deriveServiceId,
  findServiceIdPrefixCollision,
  RegistryError,
} from "@nimbus-dev/registry-format";

import { ExtensionRunGrantError } from "./run-grant-error.ts";

export { EXTENSION_SERVICE_ID_PATTERN } from "@nimbus-dev/registry-format";

/**
 * The run-grant spelling of `@nimbus-dev/registry-format`'s `deriveExtensionServiceId`: the rule is
 * the workspace's, the refusal is `ERR_EXTENSION_SERVICE_ID_INVALID` for run-grant callers.
 */
export function deriveExtensionServiceId(manifestId: string): string {
  try {
    return deriveServiceId(manifestId);
  } catch (e) {
    if (e instanceof RegistryError) {
      throw new ExtensionRunGrantError("ERR_EXTENSION_SERVICE_ID_INVALID", e.detail);
    }
    throw e;
  }
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
