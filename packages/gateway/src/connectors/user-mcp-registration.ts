/**
 * Pure resolver for a user MCP server registration. Runs BEFORE the owner is asked to
 * approve, so the approval prompt shows final values (absolute command, canonical
 * paths, normalised hosts). No OS calls except through the injected `env`.
 */

import type path from "node:path";
import { findServiceIdPrefixCollision } from "@nimbus-dev/registry-format";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { findProtectedOverlap, pathApiFor } from "../util/path-overlap.ts";
import {
  MAX_WRITE_DIRS,
  type WriteDirDeps,
  writeDirRefusal,
  writeDirsOverlap,
} from "./write-dir-rules.ts";

export type UserMcpRegistrationInput = {
  readonly serviceId: string;
  readonly argv: readonly string[];
  readonly readPaths: readonly string[];
  readonly netHosts: readonly string[];
  readonly modelAccess: boolean;
  /** Directories the server may write beneath (`--write`); absent means none. */
  readonly writePaths?: readonly string[];
};

export type UserMcpRegistrationEnv = {
  readonly platform: NodeJS.Platform;
  readonly protectedRoots: readonly string[];
  readonly registeredServiceIds: readonly string[];
  which(cmd: string): string | null;
  realpath(p: string): string;
  /**
   * The facts the write-directory rule reads. A registration that names a write directory with
   * no `writeDir` here is refused: the rule is never skipped.
   */
  readonly writeDir?: WriteDirDeps;
  /** Every OTHER registered server's write directories (for the reverse rule); absent is none. */
  readonly registeredWriteDirs?: readonly string[];
};

export type ResolvedUserMcpRegistration = {
  readonly serviceId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly readPaths: readonly string[];
  readonly netHosts: readonly string[];
  readonly modelAccess: boolean;
  /** Canonical, de-duplicated and sorted; empty when the registration names none. */
  readonly writePaths: readonly string[];
};

export type UserMcpRegistrationErrorCode =
  | "ERR_USER_MCP_ARGV_EMPTY"
  | "ERR_USER_MCP_COMMAND_NOT_FOUND"
  | "ERR_USER_MCP_READ_PATH_RELATIVE"
  | "ERR_USER_MCP_READ_PATH_MISSING"
  | "ERR_USER_MCP_READ_PATH_PROTECTED"
  | "ERR_USER_MCP_NET_HOST_INVALID"
  | "ERR_USER_MCP_WRITE_PATH_REFUSED"
  | "ERR_USER_MCP_ID_COLLISION";

export class UserMcpRegistrationError extends Error {
  readonly code: UserMcpRegistrationErrorCode;
  constructor(code: UserMcpRegistrationErrorCode, message: string) {
    super(message);
    this.name = "UserMcpRegistrationError";
    this.code = code;
  }
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// IPv6 literals are NOT accepted in this slice (stated bound).
const HOST_RE = new RegExp(String.raw`^${LABEL}(?:\.${LABEL})*(?::(\d{1,5}))?$`);

function checkIdCollision(serviceId: string, existing: readonly string[]): void {
  const id = findServiceIdPrefixCollision(serviceId, existing);
  if (id !== undefined) {
    throw new UserMcpRegistrationError(
      "ERR_USER_MCP_ID_COLLISION",
      `Service id "${serviceId}" collides with registered service id "${id}" (one is a prefix of the other at an underscore boundary).`,
    );
  }
}

function resolveCommand(argv0: string, env: UserMcpRegistrationEnv): string {
  const api = pathApiFor(env.platform);
  const notFound = (): UserMcpRegistrationError =>
    new UserMcpRegistrationError(
      "ERR_USER_MCP_COMMAND_NOT_FOUND",
      `Command not found: "${argv0}".`,
    );
  if (api.isAbsolute(argv0)) {
    try {
      return env.realpath(argv0);
    } catch {
      if (env.platform === "win32" && api.extname(argv0) === "") {
        try {
          return env.realpath(`${argv0}.exe`);
        } catch {
          throw notFound();
        }
      }
      throw notFound();
    }
  }
  const found = env.which(argv0);
  if (found === null) throw notFound();
  try {
    return env.realpath(found);
  } catch {
    throw notFound();
  }
}

function assertNotProtected(candidate: string, label: string, env: UserMcpRegistrationEnv): void {
  const root = findProtectedOverlap(candidate, env.protectedRoots, env.platform, (p) =>
    env.realpath(p),
  );
  if (root !== undefined) {
    throw new UserMcpRegistrationError(
      "ERR_USER_MCP_READ_PATH_PROTECTED",
      `${label} "${candidate}" overlaps the protected Nimbus directory "${root}".`,
    );
  }
}

function resolveReadPath(p: string, env: UserMcpRegistrationEnv, api: typeof path.posix): string {
  if (!api.isAbsolute(p)) {
    throw new UserMcpRegistrationError(
      "ERR_USER_MCP_READ_PATH_RELATIVE",
      `Read path must be absolute: "${p}".`,
    );
  }
  let canonical: string;
  try {
    canonical = env.realpath(p);
  } catch {
    throw new UserMcpRegistrationError(
      "ERR_USER_MCP_READ_PATH_MISSING",
      `Read path does not exist: "${p}".`,
    );
  }
  assertNotProtected(canonical, "Read path", env);
  return canonical;
}

function normaliseNetHost(raw: string): string {
  const host = raw.toLowerCase().trim();
  const m = HOST_RE.exec(host);
  const invalid = (): UserMcpRegistrationError =>
    new UserMcpRegistrationError(
      "ERR_USER_MCP_NET_HOST_INVALID",
      `Invalid network host "${raw}": expected host or host:port (1-65535), no scheme, path or wildcard; IPv6 literals are not supported.`,
    );
  if (m === null) throw invalid();
  const port = m[1];
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) throw invalid();
  }
  return host;
}

function dedupe(items: readonly string[], key: (s: string) => string = (s) => s): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/** Fixed sentences of the write-directory refusals this resolver adds to `writeDirRefusal`'s. */
export const USER_MCP_WRITE_REFUSALS = Object.freeze({
  tooMany: `at most ${String(MAX_WRITE_DIRS)} write directories may be given`,
  overlap: "two of the write directories overlap; give each once, and none inside another",
  ownCode:
    "the server's own command or one of its file arguments is inside the write directory; a server may not write the code it is started from",
  otherWriteDir:
    "the server's command or one of its file arguments is inside another server's write directory",
  unavailable: "write directories cannot be checked on this gateway",
});

function writeRefused(reason: string): UserMcpRegistrationError {
  return new UserMcpRegistrationError(
    "ERR_USER_MCP_WRITE_PATH_REFUSED",
    `Write directory refused: ${reason}.`,
  );
}

/** The command's directory and every absolute argument: the code this registration starts from. */
function ownCodePaths(command: string, args: readonly string[], api: typeof path.posix): string[] {
  return [api.dirname(command), ...args.filter((a) => api.isAbsolute(a))];
}

/**
 * The write directories of a registration, canonical, in a fixed order, or a thrown refusal. Each
 * passes `writeDirRefusal` (the rule a spawn applies again); none overlaps another; none holds or
 * sits inside this server's own code. The reverse rule runs even with no write directory: a server
 * whose code lies inside ANOTHER server's write directory is refused, so the order of two
 * registrations cannot defeat the check.
 */
function resolveWritePaths(
  input: UserMcpRegistrationInput,
  env: UserMcpRegistrationEnv,
  command: string,
  args: readonly string[],
  api: typeof path.posix,
): string[] {
  const own = ownCodePaths(command, args, api);
  // Each code path is compared by its spelling AND by its real target (`findProtectedOverlap`
  // does both), so a link argument that points into a write directory is seen as inside it.
  const touchesCode = (dir: string): boolean =>
    findProtectedOverlap(dir, own, env.platform, (p) => env.realpath(p)) !== undefined;
  for (const other of env.registeredWriteDirs ?? []) {
    if (touchesCode(other)) throw writeRefused(USER_MCP_WRITE_REFUSALS.otherWriteDir);
  }
  const raw = input.writePaths ?? [];
  if (raw.length === 0) return [];
  if (raw.length > MAX_WRITE_DIRS) throw writeRefused(USER_MCP_WRITE_REFUSALS.tooMany);
  if (env.writeDir === undefined) throw writeRefused(USER_MCP_WRITE_REFUSALS.unavailable);
  const out: string[] = [];
  for (const p of raw) {
    const checked = writeDirRefusal(p, "register", env.writeDir);
    if (!checked.ok) throw writeRefused(checked.reason);
    if (out.some((seen) => writeDirsOverlap(seen, checked.path, env.platform))) {
      throw writeRefused(USER_MCP_WRITE_REFUSALS.overlap);
    }
    if (touchesCode(checked.path)) throw writeRefused(USER_MCP_WRITE_REFUSALS.ownCode);
    out.push(checked.path);
  }
  return out.sort(codeUnitCompare);
}

export function resolveUserMcpRegistration(
  input: UserMcpRegistrationInput,
  env: UserMcpRegistrationEnv,
): ResolvedUserMcpRegistration {
  const [argv0, ...args] = input.argv;
  if (argv0 === undefined || argv0 === "") {
    throw new UserMcpRegistrationError(
      "ERR_USER_MCP_ARGV_EMPTY",
      "No command given: argv is empty.",
    );
  }
  checkIdCollision(input.serviceId, env.registeredServiceIds);
  const api = pathApiFor(env.platform);
  const command = resolveCommand(argv0, env);

  const readPaths = input.readPaths.map((p) => resolveReadPath(p, env, api));
  if (env.platform !== "win32") {
    const commandDir = api.dirname(command);
    assertNotProtected(commandDir, "Command directory", env);
    readPaths.push(commandDir);
  }
  const netHosts = input.netHosts.map(normaliseNetHost);
  const writePaths = resolveWritePaths(input, env, command, args, api);

  return {
    serviceId: input.serviceId,
    command,
    args,
    readPaths: dedupe(readPaths, (p) => (env.platform === "win32" ? p.toLowerCase() : p)),
    netHosts: dedupe(netHosts),
    modelAccess: input.modelAccess,
    writePaths,
  };
}
