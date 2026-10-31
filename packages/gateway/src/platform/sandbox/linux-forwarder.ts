/**
 * The Linux per-host network path: everything `linux.ts` needs to start a child behind the
 * forwarder, and the only place that builds the outer `bwrap`'s argv.
 *
 *   wrapper (startForwardHost) <- unix socket -> outer bwrap -> launcher -> inner bwrap -> child
 *                                                                  \-> forwarder
 *
 * The outer view is a security boundary. The forwarder runs as the owner's uid, and a read-only bind
 * does not stop `connect` on a unix socket, so anything this view shows it can reach: the gateway's
 * own socket, whose `vault.get` has no consent gate, among them. So it binds a fixed short list plus
 * the paths the inner `bwrap` binds, which the child could reach anyway, and {@link
 * forwarderPathRefusal} refuses a policy that would widen it.
 */

import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { isIpv4Literal } from "./net-address-rules.ts";
import {
  connectTcp,
  type ForwardEntry,
  type NetSocketHandlers,
  type NetSocketLike,
  planForwardEntries,
  RESOLVER_ADDRESS,
  resolveOnHost,
  startForwardHost,
} from "./net-forward-host.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

const HELPER_NAME = "nimbus-sandbox-helper";
const INSTALLED_HELPER = `/usr/lib/nimbus/bin/${HELPER_NAME}`;

/**
 * Where the outer view shows the helper. Fixed, so a helper in `~/.local/bin` or on an AppImage mount
 * resolves without binding that directory. Only this one file under `/run` is bound, never `/run`.
 */
export const HELPER_IN_SANDBOX = "/run/nimbus-sandbox/helper";

const SOCKET_NAME = "s";
const HOSTS_NAME = "hosts";
const RESOLV_NAME = "resolv.conf";
const DIR_PREFIX = "nf-";
/** What `mkdtemp` makes of {@link DIR_PREFIX}: six characters are added. */
const DIR_TEMPLATE = `${DIR_PREFIX}XXXXXX`;
/** `sizeof(sockaddr_un.sun_path)` less its terminator. Over this the helper exits 2. */
const MAX_SOCKET_PATH_BYTES = 107;

const KEPT_CAPABILITIES = ["CAP_NET_BIND_SERVICE", "CAP_SETPCAP", "CAP_SETFCAP"] as const;
const ALIAS_CAPABILITY = "CAP_NET_ADMIN";

const OUTER_BASE_BINDS = ["/usr", "/etc"] as const;
/** The root's program and library directories. On a merged-usr host each is a symlink into `/usr`. */
const ROOT_DIRS = ["/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32"] as const;
const MAX_LINK_HOPS = 8;

const LOCALHOST_ADDRESS = "127.0.0.1";
const HOSTS_PATH = "/etc/hosts";
const RESOLV_PATH = "/etc/resolv.conf";

/** A name that can go in `/etc/hosts`: nothing that could end the line or start a new field. */
const HOSTS_NAME_RE = /^[a-z0-9_](?:[a-z0-9._-]{0,251}[a-z0-9_-])?$/;

const START_PROBE_TIMEOUT_MS = 10_000;
const START_PROBE_HOST = "nimbus-start-probe.invalid";
const START_PROBE_PORT = 443;
const START_PROBE_REPLY = new Uint8Array([0x4b]); // "K", which `--connect-probe` waits for
/** Never dialed: the probe's `connect` answers by itself. Passes the first-party address rule. */
const START_PROBE_ANSWER = "1.1.1.1";

export type HelperLookup = (path: string) => boolean;

/**
 * Which helper binary this install uses. An override that names nothing is null rather than falling
 * through, so a typo cannot silently pick a different binary.
 */
export function resolveHelperPath(
  execPath: string,
  env: Readonly<Record<string, string | undefined>>,
  exists: HelperLookup,
): string | null {
  const override = env["NIMBUS_SANDBOX_HELPER_PATH"];
  if (override !== undefined && override !== "") return exists(override) ? override : null;
  const beside = posix.join(posix.dirname(execPath), HELPER_NAME);
  if (exists(beside)) return beside;
  return exists(INSTALLED_HELPER) ? INSTALLED_HELPER : null;
}

export type RootLookup = {
  readlink(path: string): string | null;
  exists(path: string): boolean;
};

const HOST_ROOT: RootLookup = { readlink: readlinkOrNull, exists: existsSync };

/**
 * The flags that give a sandbox the host's `/bin`, `/sbin` and `/lib*`. A link into `/usr` stays a
 * link, since `/usr` is bound; any other directory is bound as it is. Without `/bin`, `/bin/sh` was
 * not found, and `gcloud` and `az` are shell scripts. `/lib` is always asked for, as it always was:
 * a machine with none cannot run a dynamic program, and should say so.
 */
export function rootDirFlags(lookup: RootLookup = HOST_ROOT): string[] {
  const flags: string[] = [];
  for (const path of ROOT_DIRS) {
    const link = lookup.readlink(path);
    if (link !== null && posix.resolve("/", link).startsWith("/usr/")) {
      flags.push("--symlink", link, path);
    } else if (link !== null || path === "/lib" || lookup.exists(path)) {
      flags.push("--ro-bind", path, path);
    }
  }
  return flags;
}

function hostsName(name: string): string {
  if (!HOSTS_NAME_RE.test(name)) {
    throw new Error("a network entry's name cannot be written to the sandbox's /etc/hosts");
  }
  return name;
}

/**
 * The generated `/etc/hosts`. Exact names only: a pool slot's name is the stub resolver's to assign,
 * and an IP literal has no name to map. Each name also appears with a trailing dot, since a URL can
 * keep `jenkins.corp.` where the grant dropped it.
 *
 * `localhost` maps to the address the planner gave an entry that names it. Otherwise it maps to
 * `127.0.0.1`, as on any machine, so a child can `listen` on it. That widens nothing: this namespace
 * is empty, so the only things there are the child's own and the entries it declared.
 */
export function renderHostsFile(entries: readonly ForwardEntry[]): string {
  const namesByAddress = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.host === null || isIpv4Literal(entry.host)) continue;
    const name = hostsName(entry.host);
    const names = namesByAddress.get(entry.loopbackIp) ?? [];
    if (!names.includes(name)) names.push(name, `${name}.`);
    namesByAddress.set(entry.loopbackIp, names);
  }
  const lines = [...namesByAddress].map(([address, names]) => `${address} ${names.join(" ")}\n`);
  if (!entries.some((entry) => entry.host === "localhost")) {
    lines.unshift(`${LOCALHOST_ADDRESS} localhost localhost.\n`);
  }
  return lines.join("");
}

export function renderResolvConf(): string {
  return `nameserver ${RESOLVER_ADDRESS}\n`;
}

function readlinkOrNull(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function isBoundInBothViews(path: string): boolean {
  return path.startsWith("/etc/") || path.startsWith("/usr/");
}

/**
 * The path to bind the generated resolver file at, so that `/etc/resolv.conf` reaches it inside.
 *
 * `bwrap` cannot mount over a symlink whose target does not exist in the new root, and on Ubuntu the
 * target is under `/run`, which is not bound. So this follows the link as the sandbox will: by its
 * text, stopping at the first target outside the trees both views bind. `realpath` is wrong here in
 * two ways: it throws on a dangling link (systemd-resolved stopped), and it turns `/var/run/x` into
 * `/run/x`, which `/etc/resolv.conf` would not reach inside, since `/var` is not bound either.
 */
export function resolvConfTarget(
  readlink: (path: string) => string | null = readlinkOrNull,
): string {
  let path = RESOLV_PATH;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const link = readlink(path);
    if (link === null) return path;
    path = posix.resolve(posix.dirname(path), link);
    if (!isBoundInBothViews(path)) return path;
  }
  throw new Error(`${RESOLV_PATH} has too many symlinks to follow`);
}

/** The inner `bwrap`'s own bind for that file, when `/etc` and `/usr` do not already carry it. */
export function innerResolvBind(target: string): string[] {
  return isBoundInBothViews(target) ? [] : ["--ro-bind", target, target];
}

function trimmed(path: string): string {
  const normal = posix.normalize(path);
  return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal;
}

function isAtOrAbove(path: string, other: string): boolean {
  if (path === "/" || path === other) return true;
  return other.startsWith(`${path}/`);
}

function spellingsOf(path: string, realpath: (p: string) => string): string[] {
  const literal = trimmed(path);
  try {
    return [literal, trimmed(realpath(path))];
  } catch {
    return [literal];
  }
}

export type ForwarderPathContext = {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  uid?: number;
  realpath?: (path: string) => string;
};

/**
 * Why this policy cannot run behind the forwarder because of what the outer view would show, or null.
 *
 * - A policy path or cwd at or above `/run`, `/var/run` or the runtime directory is refused: those
 *   hold every session's sockets, and nothing legitimate needs them whole.
 * - A cwd at or above `$HOME` is refused: nothing the owner typed sets a cwd.
 * - A POLICY path at or above `$HOME` is the owner's grant and is kept. The outer view then shows the
 *   forwarder that tree, sockets included, which the child under the same policy could already reach,
 *   so it gains nothing the policy did not grant.
 */
export function forwarderPathRefusal(
  policy: SandboxPolicy,
  context: ForwarderPathContext = {},
): string | null {
  const env = context.env ?? process.env;
  const realpath = context.realpath ?? realpathSync;
  const uid = context.uid ?? process.getuid?.() ?? 0;
  const homes = spellingsOf(context.home ?? env["HOME"] ?? homedir(), realpath);
  const runtimeDir = env["XDG_RUNTIME_DIR"];
  const sockets = [
    "/run",
    "/var/run",
    `/run/user/${String(uid)}`,
    ...(runtimeDir === undefined || runtimeDir === "" ? [] : [runtimeDir]),
  ].flatMap((path) => spellingsOf(path, realpath));

  const { read, write } = policy.permissions.filesystem;
  for (const path of [...read, ...write, ...(context.cwd === undefined ? [] : [context.cwd])]) {
    const hit = spellingsOf(path, realpath).find((s) => sockets.some((o) => isAtOrAbove(s, o)));
    if (hit !== undefined) {
      return `a sandbox path at or above the runtime directory cannot run behind the network forwarder: ${path}`;
    }
  }
  if (context.cwd !== undefined) {
    const above = spellingsOf(context.cwd, realpath).some((s) =>
      homes.some((home) => isAtOrAbove(s, home)),
    );
    if (above)
      return `a working directory at or above $HOME cannot run behind the network forwarder: ${context.cwd}`;
  }
  return null;
}

export type ForwarderArgvOpts = {
  cwd: string;
  helperPath: string;
  socketDir: string;
  hostsFile: string;
  /** The generated resolver file. Bound at {@link ForwarderArgvOpts.resolvConfTarget}. */
  resolvFile: string;
  resolvConfTarget: string;
  entries: readonly ForwardEntry[];
  /** The whole inner command: its `bwrap` first, then that `bwrap`'s flags and the child. */
  innerArgv: readonly string[];
  /** Overrides for {@link forwarderPathRefusal}, for tests. */
  pathContext?: Omit<ForwarderPathContext, "cwd">;
  /** Overrides for {@link rootDirFlags}, for tests. */
  rootLookup?: RootLookup;
};

type InnerBind = { flag: string; path: string };

/** Each bind the inner `bwrap` asks for, in order. Its flags end at `--seccomp`, its last. */
function innerBinds(innerArgv: readonly string[]): InnerBind[] {
  const binds: InnerBind[] = [];
  const end = innerArgv.indexOf("--seccomp");
  const last = end < 0 ? innerArgv.length : end;
  for (let i = 1; i < last; i += 1) {
    const flag = innerArgv[i];
    const path = innerArgv[i + 1];
    if ((flag === "--bind" || flag === "--ro-bind") && path !== undefined) {
      binds.push({ flag, path });
      i += 2;
    }
  }
  return binds;
}

function isIpAlias(entry: ForwardEntry): boolean {
  return entry.host !== null && isIpv4Literal(entry.host) && !entry.host.startsWith("127.");
}

function capabilityFlags(entries: readonly ForwardEntry[]): string[] {
  const caps: string[] = [...KEPT_CAPABILITIES];
  if (entries.some(isIpAlias)) caps.push(ALIAS_CAPABILITY);
  return caps.flatMap((cap) => ["--cap-add", cap]);
}

function helperFlags(entries: readonly ForwardEntry[]): string[] {
  const flags: string[] = [];
  const aliases = new Set(entries.filter(isIpAlias).map((e) => e.loopbackIp));
  for (const alias of aliases) flags.push("--alias", alias);
  const taken = new Set(entries.map((e) => `${e.loopbackIp}:${String(e.port)}`));
  entries.forEach((entry, index) => {
    flags.push("--listen", `${entry.loopbackIp}:${String(entry.port)}:${String(index)}`);
    // A client can take `localhost` to mean 127.0.0.1 with no lookup, as Bun's fetch does, so the
    // entry listens there as well. It is the same entry, with the same check.
    const usual = `${LOCALHOST_ADDRESS}:${String(entry.port)}`;
    if (entry.host === "localhost" && !taken.has(usual)) {
      flags.push("--listen", `${usual}:${String(index)}`);
    }
  });
  flags.push("--dns", RESOLVER_ADDRESS);
  return flags;
}

function mirroredBinds(opts: ForwarderArgvOpts): string[] {
  // These reach the inner `bwrap` from what this view adds below, and not from the host.
  const provided = new Set<string>([
    ...OUTER_BASE_BINDS,
    ...ROOT_DIRS,
    HELPER_IN_SANDBOX,
    opts.resolvConfTarget,
  ]);
  const out: string[] = [];
  for (const { flag, path } of innerBinds(opts.innerArgv)) {
    if (!provided.has(path)) out.push(flag, path, path);
  }
  return out;
}

function bwrapBind(bwrap: string | undefined): string[] {
  return bwrap === undefined || bwrap.startsWith("/usr/") ? [] : ["--ro-bind", bwrap, bwrap];
}

/**
 * The outer `bwrap`'s argv: the namespaces, the view, the helper and its flags, then the inner
 * command. This is the only per-host path into a sandbox, and it throws on a policy
 * {@link forwarderPathRefusal} refuses, so no caller can build a wider view.
 */
export function buildForwarderArgv(policy: SandboxPolicy, opts: ForwarderArgvOpts): string[] {
  const refusal = forwarderPathRefusal(policy, { ...opts.pathContext, cwd: opts.cwd });
  if (refusal !== null) throw new Error(refusal);
  return [
    "--unshare-user",
    "--unshare-net",
    "--unshare-pid",
    "--die-with-parent",
    "--uid",
    "0",
    "--gid",
    "0",
    ...capabilityFlags(opts.entries),
    ...OUTER_BASE_BINDS.flatMap((path) => ["--ro-bind", path, path]),
    ...rootDirFlags(opts.rootLookup),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...bwrapBind(opts.innerArgv[0]),
    ...mirroredBinds(opts),
    // Last, so that no bind above can cover them.
    "--ro-bind",
    opts.hostsFile,
    HOSTS_PATH,
    "--ro-bind",
    opts.resolvFile,
    opts.resolvConfTarget,
    "--ro-bind",
    opts.helperPath,
    HELPER_IN_SANDBOX,
    "--ro-bind",
    opts.socketDir,
    opts.socketDir,
    "--chdir",
    "/",
    HELPER_IN_SANDBOX,
    "--socket",
    posix.join(opts.socketDir, SOCKET_NAME),
    ...helperFlags(opts.entries),
    "--",
    ...opts.innerArgv,
  ];
}

function isInside(dir: string, parent: string): boolean {
  const p = trimmed(parent);
  return dir === p || dir.startsWith(p === "/" ? "/" : `${p}/`);
}

/** `mkdtemp` makes the directory 0700. A runtime directory can exist and still refuse a new one. */
function mkdtempOrNull(prefix: string): string | null {
  try {
    return mkdtempSync(prefix);
  } catch {
    return null;
  }
}

/**
 * A private directory for the socket and the generated files. The socket path must fit
 * `sockaddr_un`, and the directory must not sit inside a path the inner `bwrap` binds, or the child
 * would see the socket.
 */
export function createForwarderDir(
  boundPaths: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  realpath: (path: string) => string = realpathSync,
): string {
  const candidates = [env["XDG_RUNTIME_DIR"], env["TMPDIR"], "/tmp"];
  const bound = boundPaths.flatMap((path) => spellingsOf(path, realpath));
  let tried = "";
  for (const candidate of candidates) {
    if (candidate === undefined || !candidate.startsWith("/")) continue;
    const base = trimmed(candidate);
    const longest = posix.join(base, DIR_TEMPLATE, SOCKET_NAME);
    const usable =
      Buffer.byteLength(longest) <= MAX_SOCKET_PATH_BYTES &&
      existsSync(base) &&
      !spellingsOf(base, realpath).some((form) =>
        bound.some((path) => isInside(posix.join(form, DIR_TEMPLATE), path)),
      );
    tried = `${tried} ${base}`;
    if (usable) {
      const made = mkdtempOrNull(posix.join(base, DIR_PREFIX));
      if (made !== null) return made;
    }
  }
  throw new ForwarderSocketPathError(tried.trim());
}

export class ForwarderSocketPathError extends Error {
  constructor(tried: string) {
    super(
      `no directory can hold the network forwarder's socket in ${String(MAX_SOCKET_PATH_BYTES)} bytes, outside the sandbox's own paths (tried: ${tried})`,
    );
    this.name = "ForwarderSocketPathError";
  }
}

export type ForwarderSession = {
  argv: string[];
  /** Removes the directory and stops the host. Safe to call more than once. */
  close(): void;
};

export type ForwarderSessionOpts = {
  policy: SandboxPolicy;
  cwd: string;
  helperPath: string;
  entries: readonly ForwardEntry[];
  innerArgv: readonly string[];
  resolvConfTarget: string;
  log?: (line: string) => void;
  resolve?: (host: string) => Promise<string[]>;
  connect?: (ip: string, port: number) => Promise<NetSocketLike>;
};

function stderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Writes the files, starts the host and builds the argv. Everything it made is gone if any step
 * throws. The host keeps the process's event loop only through its socket, so the caller must close
 * this when the child exits and must not wait for a pending dial.
 */
export function openForwarderSession(opts: ForwarderSessionOpts): ForwarderSession {
  // First, so that a policy this view refuses says why, and not that no directory could hold a socket.
  const refusal = forwarderPathRefusal(opts.policy, { cwd: opts.cwd });
  if (refusal !== null) throw new Error(refusal);
  const { read, write } = opts.policy.permissions.filesystem;
  const dir = createForwarderDir([...read, ...write, opts.cwd]);
  let host: { close(): void } | null = null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    process.removeListener("exit", close);
    host?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const hostsFile = posix.join(dir, HOSTS_NAME);
    const resolvFile = posix.join(dir, RESOLV_NAME);
    writeFileSync(hostsFile, renderHostsFile(opts.entries), { mode: 0o644 });
    writeFileSync(resolvFile, renderResolvConf(), { mode: 0o644 });
    const argv = buildForwarderArgv(opts.policy, {
      cwd: opts.cwd,
      helperPath: opts.helperPath,
      socketDir: dir,
      hostsFile,
      resolvFile,
      resolvConfTarget: opts.resolvConfTarget,
      entries: opts.entries,
      innerArgv: opts.innerArgv,
    });
    host = startForwardHost({
      socketPath: posix.join(dir, SOCKET_NAME),
      entries: opts.entries,
      wildcards: opts.policy.firstPartyWildcardHosts ?? [],
      resolve: opts.resolve ?? resolveOnHost,
      connect: opts.connect ?? connectTcp,
      log: opts.log ?? stderrLine,
    });
    // `process.exit` runs this; a signal the wrapper handles reaches it through `process.exit` too.
    process.once("exit", close);
    return { argv, close };
  } catch (e) {
    close();
    throw e;
  }
}

/** Answers the probe's one request with the reply it waits for, with no network at all. */
async function startProbeConnect(): Promise<NetSocketLike> {
  let handlers: NetSocketHandlers | null = null;
  return {
    write(data) {
      handlers?.data(START_PROBE_REPLY);
      return data.length;
    },
    shutdownWrite: () => undefined,
    close: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    setHandlers(next) {
      handlers = next;
    },
  };
}

export type StartProbeOpts = {
  bwrapPath: string;
  helperPath: string;
  seccompPath: string;
  /** The same inner flags a real spawn gets, for the probe's policy and cwd. */
  buildInnerFlags: (policy: SandboxPolicy, cwd: string) => string[];
  timeoutMs?: number;
  /** Where the probe's working directory goes. Overridden in a test. */
  tempRoot?: string;
};

export type StartProbeResult = {
  /** Null when the start worked, else why not. */
  failure: string | null;
  /** The start did not finish. Says nothing about the machine beyond this moment, so ask again. */
  timedOut: boolean;
};

const failedStart = (failure: string): StartProbeResult => ({ failure, timedOut: false });

function waitForStart(child: ChildProcess, timeoutMs: number): Promise<StartProbeResult> {
  return new Promise((resolve) => {
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ failure: `it did not finish within ${String(timeoutMs)} ms`, timedOut: true });
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve(failedStart(e.message));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ failure: null, timedOut: false });
        return;
      }
      const how = signal === null ? `exit ${String(code)}` : `signal ${signal}`;
      const said = stderr.trim();
      resolve(failedStart(said === "" ? how : `${how}: ${said}`));
    });
  });
}

/**
 * One real start of the whole path: outer `bwrap`, launcher, forwarder, inner `bwrap` under the real
 * seccomp filter, and a child that sends a byte through the forwarder to a real forward host and gets
 * the answer. So a dead forwarder fails here, as well as one that failed its lockdown. Bounded: a
 * start that hangs is killed and reported. Never rejects: a failure of any step is a refusal, and a
 * rejection here would fail the gateway's boot.
 */
export async function runForwarderStartProbe(opts: StartProbeOpts): Promise<StartProbeResult> {
  const policy: SandboxPolicy = {
    id: "forwarder-start-probe",
    permissions: {
      network: [`${START_PROBE_HOST}:${String(START_PROBE_PORT)}`],
      filesystem: { read: [], write: [] },
    },
    firstPartyPolicy: true,
  };
  let session: ForwarderSession | null = null;
  let cwd: string | null = null;
  try {
    cwd = mkdtempSync(posix.join(opts.tempRoot ?? "/tmp", "nimbus-forwarder-probe-"));
    const entries = planForwardEntries(policy);
    const address = entries[0]?.loopbackIp ?? "";
    const target = resolvConfTarget();
    session = openForwarderSession({
      policy,
      cwd,
      helperPath: opts.helperPath,
      entries,
      resolvConfTarget: target,
      innerArgv: [
        opts.bwrapPath,
        ...opts.buildInnerFlags(policy, cwd),
        ...innerResolvBind(target),
        "--ro-bind",
        HELPER_IN_SANDBOX,
        HELPER_IN_SANDBOX,
        "--seccomp",
        "3",
        HELPER_IN_SANDBOX,
        "--connect-probe",
        `${address}:${String(START_PROBE_PORT)}`,
      ],
      resolve: () => Promise.resolve([START_PROBE_ANSWER]),
      connect: startProbeConnect,
      log: () => undefined,
    });
    const fd = openSync(opts.seccompPath, "r");
    try {
      const stdio: StdioOptions = ["ignore", "ignore", "pipe", fd];
      // windows-console-ok: Linux-only module.
      const child = spawn(opts.bwrapPath, session.argv, { env: {}, stdio });
      return await waitForStart(child, opts.timeoutMs ?? START_PROBE_TIMEOUT_MS);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return failedStart(e instanceof Error ? e.message : String(e));
  } finally {
    session?.close();
    if (cwd !== null) rmSync(cwd, { recursive: true, force: true });
  }
}
