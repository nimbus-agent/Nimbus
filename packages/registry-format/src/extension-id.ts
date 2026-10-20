/**
 * The pure rules over an extension id: what an id may be, and the `ext_` service id it maps to.
 * Shared by the gateway (install, run grants), the registry index parser and the publishing CLI,
 * so an id the CLI accepts is one the gateway can install and run.
 */
import { RegistryError } from "./errors.ts";

export const MAX_EXTENSION_ID_LENGTH = 128;

export function assertSafeExtensionId(extensionId: string): void {
  if (extensionId.trim() === "" || extensionId.includes("\0")) {
    throw new Error("invalid extension id");
  }
  if (extensionId.length > MAX_EXTENSION_ID_LENGTH) {
    throw new Error(
      `extension id too long (max ${String(MAX_EXTENSION_ID_LENGTH)} chars, got ${String(extensionId.length)})`,
    );
  }
  const normalized = extensionId.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) {
    throw new Error("invalid extension id");
  }
  for (const p of parts) {
    if (p === "..") {
      throw new Error("invalid extension id");
    }
  }
}

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
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_INVALID",
      `extension id "${manifestId}" does not yield a service id of 1-62 characters after "ext_"`,
    );
  }
  return id;
}

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
