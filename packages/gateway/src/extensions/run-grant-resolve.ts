/**
 * Pure resolver for an extension RUN grant (extension-runtime design § 4.2, § 4.5). It runs BEFORE
 * the owner is asked, so the `extension.run` prompt shows the final values the grant will store —
 * the service id, canonical paths, normalised hosts — and an unsatisfiable grant never prompts.
 * No OS calls except through the injected `env`.
 *
 * What it deliberately does NOT do: pass the manifest's `permissions` through. A third-party
 * manifest can declare a read of Nimbus's own data directory, and nothing below the sandbox would
 * stop it (`policyFromManifest` copies permissions verbatim). Every declared path is resolved and
 * checked here instead.
 *
 * The Bun runtime's own read paths are NOT part of the grant. They are machine-derived and change
 * with a Bun upgrade, so the runtime adds them fresh at every spawn — the same reasoning that keeps
 * them out of a saved generated tool's signed manifest (I40).
 */
import path from "node:path";

import type { SandboxPermissions } from "./permissions-validator.ts";

/** `ext_` + 1–62 of `[a-z0-9_]`: disjoint from `mcp_` user servers and every first-party id. */
export const EXTENSION_SERVICE_ID_PATTERN = /^ext_[a-z0-9_]{1,62}$/;

export type ExtensionRunGrantErrorCode =
  | "ERR_EXTENSION_SERVICE_ID_EMPTY"
  | "ERR_EXTENSION_SERVICE_ID_COLLISION"
  | "ERR_EXTENSION_GRANT_RELATIVE"
  | "ERR_EXTENSION_GRANT_MISSING"
  | "ERR_EXTENSION_GRANT_PROTECTED"
  | "ERR_EXTENSION_GRANT_SELF_WRITE";

export class ExtensionRunGrantError extends Error {
  readonly code: ExtensionRunGrantErrorCode;
  constructor(code: ExtensionRunGrantErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExtensionRunGrantError";
    this.code = code;
  }
}

export type ExtensionRunGrantEnv = {
  readonly platform: NodeJS.Platform;
  /** Directories no extension may be granted: Nimbus's data, config and sandbox roots. */
  readonly protectedRoots: readonly string[];
  /** Service ids already held by OTHER extensions' grants. */
  readonly otherServiceIds: readonly string[];
  realpath(p: string): string;
};

export type ExtensionRunGrantInput = {
  readonly extensionId: string;
  readonly installPath: string;
  readonly permissions: SandboxPermissions;
  /** The id this extension's existing grant already holds; reused verbatim, never recomputed. */
  readonly existingServiceId?: string;
};

/** The grant's permissions, as stored and as the sandbox will receive them (plus runtime paths). */
export type ResolvedRunGrantPermissions = {
  readonly network: readonly string[];
  readonly filesystem: { readonly read: readonly string[]; readonly write: readonly string[] };
};

export type ResolvedRunGrant = {
  readonly serviceId: string;
  readonly permissions: ResolvedRunGrantPermissions;
};

/**
 * `ext_` + the manifest id lowercased, each run of characters outside `[a-z0-9]` collapsed to one
 * `_`, trimmed of leading/trailing `_`, and cut to 62 characters. Computed once, when a grant is
 * first created, and stored; changing this rule later can therefore never move an existing
 * extension's tools.
 */
export function deriveExtensionServiceId(extensionId: string): string {
  const slug = extensionId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 62)
    .replace(/_+$/, "");
  if (slug === "") {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_SERVICE_ID_EMPTY",
      `extension id ${JSON.stringify(extensionId)} has no characters a service id can use`,
    );
  }
  return `ext_${slug}`;
}

/**
 * Refuses an id that equals, extends, or is extended by (at an `_` boundary) another grant's id —
 * the same rule user-MCP registration applies to `mcp_` ids, for the same reason: the dispatcher
 * maps `<id>.<tool>` to key `<id>_<tool>`, so `ext_a` + tool `b_c` and `ext_a_b` + tool `c` would
 * share a key.
 */
function checkServiceIdCollision(serviceId: string, others: readonly string[]): void {
  for (const id of others) {
    if (id === serviceId || id.startsWith(`${serviceId}_`) || serviceId.startsWith(`${id}_`)) {
      throw new ExtensionRunGrantError(
        "ERR_EXTENSION_SERVICE_ID_COLLISION",
        `service id "${serviceId}" collides with another extension's "${id}" (one is a prefix of the other at an underscore boundary)`,
      );
    }
  }
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Is `a` the same as, or inside, `b`? Case-insensitive on Windows. */
function isSameOrInside(
  api: typeof path.posix,
  platform: NodeJS.Platform,
  a: string,
  b: string,
): boolean {
  const norm = (p: string): string => (platform === "win32" ? api.normalize(p).toLowerCase() : p);
  const rel = api.relative(norm(b), norm(a));
  if (rel === "") return true;
  if (api.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${api.sep}`);
}

function canonicalOrSelf(env: ExtensionRunGrantEnv, p: string): string {
  try {
    return env.realpath(p);
  } catch {
    return p;
  }
}

function assertNotProtected(
  candidate: string,
  label: string,
  env: ExtensionRunGrantEnv,
  api: typeof path.posix,
): void {
  for (const root of env.protectedRoots) {
    for (const r of new Set([root, canonicalOrSelf(env, root)])) {
      if (
        isSameOrInside(api, env.platform, candidate, r) ||
        isSameOrInside(api, env.platform, r, candidate)
      ) {
        throw new ExtensionRunGrantError(
          "ERR_EXTENSION_GRANT_PROTECTED",
          `${label} "${candidate}" overlaps the protected Nimbus directory "${root}"`,
        );
      }
    }
  }
}

function canonicalDeclaredPath(
  p: string,
  label: string,
  env: ExtensionRunGrantEnv,
  api: typeof path.posix,
): string {
  if (!api.isAbsolute(p)) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_GRANT_RELATIVE",
      `${label} must be absolute: "${p}"`,
    );
  }
  try {
    return env.realpath(p);
  } catch {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_GRANT_MISSING",
      `${label} does not exist: "${p}"`,
    );
  }
}

function dedupe(items: readonly string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = platform === "win32" ? it.toLowerCase() : it;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export function resolveExtensionRunGrant(
  input: ExtensionRunGrantInput,
  env: ExtensionRunGrantEnv,
): ResolvedRunGrant {
  const serviceId = input.existingServiceId ?? deriveExtensionServiceId(input.extensionId);
  checkServiceIdCollision(serviceId, env.otherServiceIds);

  const api = pathApi(env.platform);
  const installPath = canonicalOrSelf(env, input.installPath);
  const insideInstall = (p: string): boolean => isSameOrInside(api, env.platform, p, installPath);

  // A declared read inside the extension's own directory is already covered by the install-path
  // grant below; it is dropped rather than checked, since on macOS and Linux the extensions
  // directory itself sits under the protected data dir.
  const read: string[] = [];
  for (const p of input.permissions.filesystem.read) {
    const c = canonicalDeclaredPath(p, "Read path", env, api);
    if (insideInstall(c)) continue;
    assertNotProtected(c, "Read path", env, api);
    read.push(c);
  }

  const write: string[] = [];
  for (const p of input.permissions.filesystem.write) {
    const c = canonicalDeclaredPath(p, "Write path", env, api);
    // An extension may never write its own code: the tree digest would be the extension's to change.
    if (insideInstall(c) || isSameOrInside(api, env.platform, installPath, c)) {
      throw new ExtensionRunGrantError(
        "ERR_EXTENSION_GRANT_SELF_WRITE",
        `Write path "${c}" overlaps the extension's own install directory "${installPath}"`,
      );
    }
    assertNotProtected(c, "Write path", env, api);
    write.push(c);
  }

  return {
    serviceId,
    permissions: {
      network: dedupe(
        input.permissions.network.map((h) => h.toLowerCase()),
        "linux",
      ),
      filesystem: {
        read: dedupe([installPath, ...read], env.platform),
        write: dedupe(write, env.platform),
      },
    },
  };
}
