/**
 * Pure resolver for a user MCP server registration. Runs BEFORE the owner is asked to
 * approve, so the approval prompt shows final values (absolute command, canonical
 * paths, normalised hosts). No OS calls except through the injected `env`.
 */
import path from "node:path";

export type UserMcpRegistrationInput = {
  readonly serviceId: string;
  readonly argv: readonly string[];
  readonly readPaths: readonly string[];
  readonly netHosts: readonly string[];
  readonly modelAccess: boolean;
};

export type UserMcpRegistrationEnv = {
  readonly platform: NodeJS.Platform;
  readonly protectedRoots: readonly string[];
  readonly registeredServiceIds: readonly string[];
  which(cmd: string): string | null;
  realpath(p: string): string;
};

export type ResolvedUserMcpRegistration = {
  readonly serviceId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly readPaths: readonly string[];
  readonly netHosts: readonly string[];
  readonly modelAccess: boolean;
};

export type UserMcpRegistrationErrorCode =
  | "ERR_USER_MCP_ARGV_EMPTY"
  | "ERR_USER_MCP_COMMAND_NOT_FOUND"
  | "ERR_USER_MCP_READ_PATH_RELATIVE"
  | "ERR_USER_MCP_READ_PATH_MISSING"
  | "ERR_USER_MCP_READ_PATH_PROTECTED"
  | "ERR_USER_MCP_NET_HOST_INVALID"
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

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function isSameOrInside(
  api: typeof path.posix,
  platform: NodeJS.Platform,
  a: string,
  b: string,
): boolean {
  // Is `a` the same as, or inside, `b`?
  const norm = (p: string): string => (platform === "win32" ? api.normalize(p).toLowerCase() : p);
  const rel = api.relative(norm(b), norm(a));
  if (rel === "") return true;
  if (api.isAbsolute(rel)) return false; // different drive on win32
  return rel !== ".." && !rel.startsWith(`..${api.sep}`);
}

function checkIdCollision(serviceId: string, existing: readonly string[]): void {
  for (const id of existing) {
    if (id === serviceId || id.startsWith(`${serviceId}_`) || serviceId.startsWith(`${id}_`)) {
      throw new UserMcpRegistrationError(
        "ERR_USER_MCP_ID_COLLISION",
        `Service id "${serviceId}" collides with registered service id "${id}" (one is a prefix of the other at an underscore boundary).`,
      );
    }
  }
}

function resolveCommand(argv0: string, env: UserMcpRegistrationEnv): string {
  const api = pathApi(env.platform);
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

function assertNotProtected(
  candidate: string,
  label: string,
  env: UserMcpRegistrationEnv,
  api: typeof path.posix,
): void {
  for (const root of env.protectedRoots) {
    let canonicalRoot = root;
    try {
      canonicalRoot = env.realpath(root);
    } catch {
      // Root may not exist yet; fall back to the configured spelling.
    }
    for (const r of new Set([root, canonicalRoot])) {
      if (
        isSameOrInside(api, env.platform, candidate, r) ||
        isSameOrInside(api, env.platform, r, candidate)
      ) {
        throw new UserMcpRegistrationError(
          "ERR_USER_MCP_READ_PATH_PROTECTED",
          `${label} "${candidate}" overlaps the protected Nimbus directory "${root}".`,
        );
      }
    }
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
  assertNotProtected(canonical, "Read path", env, api);
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
  const api = pathApi(env.platform);
  const command = resolveCommand(argv0, env);

  const readPaths = input.readPaths.map((p) => resolveReadPath(p, env, api));
  if (env.platform !== "win32") {
    const commandDir = api.dirname(command);
    assertNotProtected(commandDir, "Command directory", env, api);
    readPaths.push(commandDir);
  }
  const netHosts = input.netHosts.map(normaliseNetHost);

  return {
    serviceId: input.serviceId,
    command,
    args,
    readPaths: dedupe(readPaths, (p) => (env.platform === "win32" ? p.toLowerCase() : p)),
    netHosts: dedupe(netHosts),
    modelAccess: input.modelAccess,
  };
}
