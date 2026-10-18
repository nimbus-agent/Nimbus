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

/**
 * Refuse an id that is safe but not CANONICAL: surrounding whitespace, a backslash, a leading or trailing
 * `/`, or an empty or `.` segment. The installer normalises all of those away, so a non-canonical id
 * would install into the SAME directory as its canonical twin while deriving a different service id —
 * a registry must only ever hold the one spelling. Run after {@link assertSafeExtensionId}.
 */
export function assertCanonicalExtensionId(extensionId: string): void {
  const refuse = (why: string): RegistryError =>
    new RegistryError(
      "ERR_REGISTRY_MANIFEST_INVALID",
      `extension id ${JSON.stringify(extensionId)} is not canonical: ${why}`,
    );
  if (extensionId !== extensionId.trim()) throw refuse("it has surrounding whitespace");
  if (extensionId.includes("\\")) throw refuse("it contains a backslash");
  if (extensionId.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw refuse("it has an empty, '.' or '..' path segment");
  }
}

const PUBLISHABLE_ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Refuse a canonical id whose characters a published registry cannot carry. Publish-only: the
 * installer still accepts any safe id, so nothing already installed moves. Each `/` segment becomes a
 * git branch component (`publish/<id>/<version>`), a directory on every client OS and a path GitHub
 * Pages serves and a client resolves with `new URL(rel, base)`, so a segment must start with a letter
 * or digit (Jekyll drops a leading `_` or `.`), hold only `[A-Za-z0-9._-]` (`:` and `*` break git and
 * Windows, `#`, `?` and `%` break URL resolution), and not end in `.` or `.lock` (git refuses both).
 * Run after {@link assertCanonicalExtensionId}.
 */
export function assertPublishableExtensionId(extensionId: string): void {
  for (const seg of extensionId.split("/")) {
    let why: string | undefined;
    if (!PUBLISHABLE_ID_SEGMENT_RE.test(seg)) {
      why = "must start with a letter or digit and hold only letters, digits, '.', '_' and '-'";
    } else if (seg.endsWith(".")) {
      why = "must not end in '.'";
    } else if (seg.endsWith(".lock")) {
      why = "must not end in '.lock'";
    }
    if (why !== undefined) {
      throw new RegistryError(
        "ERR_REGISTRY_MANIFEST_INVALID",
        `extension id ${JSON.stringify(extensionId)} cannot be published: segment ${JSON.stringify(seg)} ${why}`,
      );
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
