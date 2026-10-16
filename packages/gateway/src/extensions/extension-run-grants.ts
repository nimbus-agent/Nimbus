import {
  findProtectedOverlap,
  isSameOrInside,
  pathApiFor,
  pathsOverlap,
} from "../util/path-overlap.ts";
import type { SandboxPermissions } from "./permissions-validator.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";

/** What resolving a grant needs from the machine. Injected so tests never touch real Nimbus dirs. */
export type ExtensionRunGrantEnv = {
  readonly platform: NodeJS.Platform;
  /** `[dataDir, configDir, sandboxDir]` — `LazyConnectorMesh.userMcpProtectedRoots()`. */
  readonly protectedRoots: readonly string[];
  /** Read-only paths the runtime adds at spawn; SHOWN in the consent prompt, never stored. */
  readonly runtimeReadPaths: readonly string[];
  realpath(p: string): string;
};

/**
 * The declared grants after resolution — what a run grant stores (spec § 11 item 7). The install
 * path and the runtime's read paths are NOT here: the runtime adds them fresh at every spawn, since
 * the runtime paths are machine-derived and would make every grant stale on a Bun upgrade.
 */
export type ResolvedRunGrants = {
  readonly network: readonly string[];
  readonly read: readonly string[];
  readonly write: readonly string[];
};

function dedupe(items: readonly string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = platform === "win32" ? it.toLowerCase() : it;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function canonicalPath(p: string, kind: "read" | "write", env: ExtensionRunGrantEnv): string {
  if (!pathApiFor(env.platform).isAbsolute(p)) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_GRANT_PATH_RELATIVE",
      `${kind} path must be absolute: "${p}"`,
    );
  }
  try {
    return env.realpath(p);
  } catch {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_GRANT_PATH_MISSING",
      `${kind} path does not exist: "${p}"`,
    );
  }
}

function assertNotProtected(p: string, kind: "read" | "write", env: ExtensionRunGrantEnv): void {
  const root = findProtectedOverlap(p, env.protectedRoots, env.platform, (x) => env.realpath(x));
  if (root !== undefined) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_GRANT_PROTECTED",
      `${kind} path "${p}" overlaps the protected Nimbus directory "${root}"`,
    );
  }
}

/**
 * Resolves an extension's DECLARED permissions into the grants a run approval stores, refusing —
 * before any prompt — anything unsatisfiable: a relative or missing path, any overlap with a
 * protected Nimbus directory, and any write that overlaps the extension's own install path (an
 * extension may never write its own code, or its tree digest would be its own to change).
 */
export function resolveExtensionRunGrants(
  declared: SandboxPermissions,
  installPath: string,
  env: ExtensionRunGrantEnv,
): ResolvedRunGrants {
  let install: string;
  try {
    install = env.realpath(installPath);
  } catch {
    // Fail closed: the self-write and own-read checks compare CANONICAL paths, so comparing against
    // the raw spelling could let a self-write through. A real install path always realpaths.
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_GRANT_PATH_MISSING",
      `install path does not exist: "${installPath}"`,
    );
  }
  const read: string[] = [];
  for (const p of declared.filesystem.read) {
    const c = canonicalPath(p, "read", env);
    // The runtime grants the install path at spawn anyway — and on macOS/Linux it sits under the
    // protected data dir, so checking it would refuse a harmless manifest (spec § 11 item 8).
    if (isSameOrInside(env.platform, c, install)) continue;
    assertNotProtected(c, "read", env);
    read.push(c);
  }
  const write: string[] = [];
  for (const p of declared.filesystem.write) {
    const c = canonicalPath(p, "write", env);
    if (pathsOverlap(env.platform, c, install)) {
      throw new ExtensionRunGrantError(
        "ERR_EXTENSION_GRANT_SELF_WRITE",
        `write path "${p}" overlaps the extension's own install path "${installPath}"`,
      );
    }
    assertNotProtected(c, "write", env);
    write.push(c);
  }
  return {
    network: dedupe(
      declared.network.map((h) => h.toLowerCase()),
      "linux",
    ),
    read: dedupe(read, env.platform),
    write: dedupe(write, env.platform),
  };
}

/** The canonical stored form; equal grants serialize identically, so a string compare decides. */
export function serializeRunGrants(grants: ResolvedRunGrants): string {
  return JSON.stringify({
    network: [...grants.network],
    read: [...grants.read],
    write: [...grants.write],
  });
}
