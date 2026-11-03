import { parseNetworkEntry, type SandboxPermissions } from "@nimbus-dev/registry-format";
import {
  findProtectedOverlap,
  isSameOrInside,
  pathApiFor,
  pathsOverlap,
} from "../util/path-overlap.ts";
import { normaliseHost } from "./observation/observation-findings.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";

/** What resolving a grant needs from the machine. Injected so tests never touch real Nimbus dirs. */
export type ExtensionRunGrantEnv = {
  readonly platform: NodeJS.Platform;
  /** `[dataDir, configDir, sandboxDir, extensionsDir]` — see `extensionRunGrantProtectedRoots`. */
  readonly protectedRoots: readonly string[];
  /** Read-only paths the runtime adds at spawn; SHOWN in the consent prompt, never stored. */
  readonly runtimeReadPaths: readonly string[];
  realpath(p: string): string;
};

/**
 * The roots no extension run grant may overlap: user MCP's (`[dataDir, configDir, sandboxDir]`)
 * plus the configured extensions dir. On macOS/Linux the extensions dir sits under the data dir, so
 * this adds nothing there; on Windows it is a SIBLING of the data dir
 * (`%LOCALAPPDATA%\Nimbus\extensions`), and without it extension A could be granted read/write over
 * extension B's code. The extension's own install path is unaffected: own reads are dropped before
 * the protected check and own writes are refused as SELF_WRITE first.
 */
export function extensionRunGrantProtectedRoots(
  meshRoots: readonly string[],
  extensionsDir: string | undefined,
): readonly string[] {
  return extensionsDir === undefined ? [...meshRoots] : [...meshRoots, extensionsDir];
}

/**
 * The declared grants after resolution — what a run grant stores (spec § 11 item 7). The install
 * path is NOT here (the extension is never granted its install tree: it runs from a verified
 * per-spawn copy as its working directory), and neither are the runtime's read paths, which the
 * runtime adds fresh at every spawn since they are machine-derived and would make every grant stale
 * on a Bun upgrade.
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
 * The one check a declared path goes through, shared by the resolver and the pre-install preview so
 * the two cannot drift. Returns the canonical path, or `null` for a read of the extension's own
 * install path (dropped: the runtime runs a verified copy from its own working directory, so this
 * read is never needed, and on macOS/Linux the install path sits under the protected data dir, so
 * checking it would refuse a harmless manifest; spec § 11 item 8). Throws the
 * same errors, in the same order, the resolver always did. `install` is the CANONICAL install path;
 * `undefined` skips only the own-read and self-write comparisons.
 */
export function checkDeclaredPath(
  p: string,
  kind: "read" | "write",
  install: string | undefined,
  env: ExtensionRunGrantEnv,
): string | null {
  const c = canonicalPath(p, kind, env);
  if (kind === "read") {
    if (install !== undefined && isSameOrInside(env.platform, c, install)) return null;
  } else if (install !== undefined && pathsOverlap(env.platform, c, install)) {
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_GRANT_SELF_WRITE",
      `write path "${p}" overlaps the extension's own install path "${install}"`,
    );
  }
  assertNotProtected(c, kind, env);
  return c;
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
    const c = checkDeclaredPath(p, "read", install, env);
    if (c !== null) read.push(c);
  }
  const write: string[] = [];
  for (const p of declared.filesystem.write) {
    const c = checkDeclaredPath(p, "write", install, env);
    if (c !== null) write.push(c);
  }
  return {
    network: declaredNetworkEntries(declared.network),
    read: dedupe(read, env.platform),
    write: dedupe(write, env.platform),
  };
}

/**
 * A manifest's declared network as a run grant holds it: each entry lowercased, exact duplicates
 * dropped, manifest order kept. The one rule {@link resolveExtensionRunGrants} applies, exported so
 * `extension audit` reads what the manifest declares in the same form without resolving file grants.
 */
export function declaredNetworkEntries(network: readonly string[]): string[] {
  return dedupe(
    network.map((h) => h.toLowerCase()),
    "linux",
  );
}

/** The canonical stored form; equal grants serialize identically, so a string compare decides. */
export function serializeRunGrants(grants: ResolvedRunGrants): string {
  return JSON.stringify({
    network: [...grants.network],
    read: [...grants.read],
    write: [...grants.write],
  });
}

/**
 * THE subset rule (I43 step 8 and I52), one function for the spawn verifier and the approval's
 * post-prompt re-check so the two cannot drift. `ok` only when the stored file grants equal the
 * re-resolved ones exactly (in their serialised form, so order and spelling count) AND the stored
 * network is a subsequence of the re-resolved network: every entry an exact string member, in the
 * same relative order, none twice. Equal lists are the special case, so every grant written before
 * narrowing existed still passes. The returned grants are the re-resolved files with the STORED
 * network: never a stored path, and never a host the manifest does not declare now, so what a spawn
 * runs under can only be narrower than the manifest, never wider.
 */
export function checkStoredAgainstResolved(
  stored: ResolvedRunGrants,
  resolved: ResolvedRunGrants,
): { ok: true; grants: ResolvedRunGrants } | { ok: false } {
  if (
    JSON.stringify([...stored.read]) !== JSON.stringify([...resolved.read]) ||
    JSON.stringify([...stored.write]) !== JSON.stringify([...resolved.write])
  ) {
    return { ok: false };
  }
  if (new Set(stored.network).size !== stored.network.length) return { ok: false };
  let next = 0;
  for (const entry of stored.network) {
    const at = resolved.network.indexOf(entry, next);
    if (at === -1) return { ok: false };
    next = at + 1;
  }
  return {
    ok: true,
    grants: { network: [...stored.network], read: [...resolved.read], write: [...resolved.write] },
  };
}

/** The form two spellings of one declared entry share: lowercase host, no trailing dot, a port. */
function networkEntryKey(entry: string): string {
  const { host, port } = parseNetworkEntry(entry);
  return `${normaliseHost(host)}:${String(port)}`;
}

/**
 * The network an owner's `--network` asks for, as entries of what the manifest declares: each
 * requested entry names a declared one by its {@link networkEntryKey} (so `api.x.com`,
 * `API.x.com.` and `api.x.com:443` all name the declared `api.x.com`). The result is the matched
 * RAW resolved entries, deduplicated, in manifest order, so it always passes
 * {@link checkStoredAgainstResolved}; an empty request is no network. An entry that names nothing
 * declared is an error: narrowing can only remove.
 */
export function narrowNetwork(
  resolved: ResolvedRunGrants,
  requested: readonly string[],
): string[] | { error: string } {
  const wanted = new Set<string>();
  for (const r of requested) {
    const key = networkEntryKey(r);
    if (!resolved.network.some((d) => networkEntryKey(d) === key)) {
      return { error: `"${r}" is not a network entry this extension declares` };
    }
    wanted.add(key);
  }
  return resolved.network.filter((d) => wanted.has(networkEntryKey(d)));
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((e) => typeof e === "string") ? [...v] : undefined;
}

/**
 * The inverse of {@link serializeRunGrants}, for a reader that only needs the stored grants (the
 * extension sync host's pre-spawn `canConfine` question). `undefined` for anything that is not
 * exactly the stored shape. Not verification: the spawn path re-resolves and compares (I43).
 */
export function parseRunGrants(json: string): ResolvedRunGrants | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const network = stringArray(Reflect.get(raw, "network"));
  const read = stringArray(Reflect.get(raw, "read"));
  const write = stringArray(Reflect.get(raw, "write"));
  if (network === undefined || read === undefined || write === undefined) return undefined;
  return { network, read, write };
}
