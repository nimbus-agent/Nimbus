/**
 * Ubuntu 23.10 and later set `kernel.apparmor_restrict_unprivileged_userns=1`, which stops any
 * program without a `userns`-granting AppArmor profile from setting up a user namespace, and the
 * bubblewrap package ships no such profile. `bwrap` then dies before it starts its child, with
 * `setting up uid map: Permission denied` or `loopback: Failed RTM_NEWADDR`, so nothing sandboxed
 * can run. The profile below covers `/usr/bin/bwrap` and nothing else, and leaves the restriction
 * on for every other program.
 *
 * This module is the one definition of that profile: the `.deb` and the tarball render their
 * scripts from it (`scripts/package-linux-installers.ts`) and `nimbus doctor` prints the same
 * commands. It imports only `node:fs`, so a packaging script can load it.
 */
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";

export const BWRAP_APPARMOR_PROFILE_PATH = "/etc/apparmor.d/nimbus-bwrap";

const PROFILE_PRINTF =
  "printf '%s\\n' 'abi <abi/4.0>,' 'include <tunables/global>' " +
  "'profile nimbus-bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' '}'";

const RESTRICT_SYSCTL_PATH = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const ABI_PATH = "/etc/apparmor.d/abi/4.0";
const EXISTING_BWRAP_PROFILES = [
  "/etc/apparmor.d/bwrap",
  "/etc/apparmor.d/bwrap-userns-restrict",
] as const;

/**
 * The shell block that installs and loads the profile. It does nothing where the restriction does
 * not exist, or where the `userns` rule cannot parse (an older AppArmor would then fail to load
 * the file at every boot), or where a bwrap profile is already installed. It never fails the
 * script around it: a `.deb` must still configure when this step cannot run.
 */
export function bwrapApparmorInstallShell(sudo: boolean): string {
  const as = sudo ? "sudo " : "";
  const path = BWRAP_APPARMOR_PROFILE_PATH;
  return `if [ -e ${RESTRICT_SYSCTL_PATH} ] && [ -x /usr/bin/bwrap ] && [ -e ${ABI_PATH} ] \\
    && ${EXISTING_BWRAP_PROFILES.map((p) => `[ ! -e ${p} ]`).join(" && ")} \\
    && command -v apparmor_parser >/dev/null 2>&1; then
    if ${PROFILE_PRINTF} | ${as}tee ${path} >/dev/null && ${as}apparmor_parser -r ${path}; then
        echo "Installed the AppArmor profile that lets bubblewrap start: ${path}"
    else
        ${as}rm -f ${path} || true
        echo "WARNING: could not load the AppArmor profile for bubblewrap; sandboxed children will not start."
        echo "Run: nimbus doctor"
    fi
fi
`;
}

/** The shell block that unloads and deletes the profile. Absent profile: does nothing. */
export function bwrapApparmorRemoveShell(sudo: boolean): string {
  const as = sudo ? "sudo " : "";
  const path = BWRAP_APPARMOR_PROFILE_PATH;
  return `if [ -e ${path} ]; then
    if command -v apparmor_parser >/dev/null 2>&1; then
        ${as}apparmor_parser -R ${path} || true
    fi
    ${as}rm -f ${path} || true
fi
`;
}

export interface DoctorBwrapRun {
  readonly code: number | null;
  readonly stderr: string;
}

export interface DoctorBwrapDeps {
  readonly platform: string;
  /** The path of the first bwrap found, or null. */
  readonly findBwrap: () => string | null;
  readonly run: (cmd: readonly string[]) => DoctorBwrapRun;
  /** Whether the install block would act here, so the commands doctor prints can help. */
  readonly apparmorFixApplies: (bwrap: string) => boolean;
  readonly findHelper: () => HelperLookup;
  /** The uid and gid the inner `bwrap` of the nested start maps its child to. */
  readonly ids: () => { uid: number; gid: number };
}

/** What the gateway's `resolveHelperPath` would answer here. */
export type HelperLookup =
  | { readonly kind: "found"; readonly path: string }
  /** `NIMBUS_SANDBOX_HELPER_PATH` names nothing. The gateway refuses a network spawn for this. */
  | { readonly kind: "override-missing"; readonly path: string }
  /** Nothing anywhere. The one case where the gateway falls back to the whole internet. */
  | { readonly kind: "missing" };

/** The namespaces the sandbox runner asks for, minus what does not affect whether it can start. */
function startProbeCommand(bwrap: string): string[] {
  return [
    bwrap,
    "--unshare-user",
    "--unshare-net",
    "--new-session",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "/usr/bin/true",
  ];
}

const HELPER_IN_SANDBOX = "/run/nimbus-sandbox/helper";
/** Never connected to: this start carries no connection, and the forwarder dials only for one. */
const UNUSED_SOCKET = "/tmp/nimbus-doctor-start/s";

function libraryBinds(): string[] {
  return [
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
  ];
}

/**
 * The shape of the gateway's per-host start (`buildForwarderArgv`): outer `bwrap`, launcher, forwarder
 * up to its lockdown, inner `bwrap`, a child. The CLI reaches the gateway over IPC only, so this is a
 * copy of the part that decides whether the machine can start it. It carries no connection, so it
 * says nesting works here, not that a given host is reachable.
 */
function nestedStartCommand(
  bwrap: string,
  helper: string,
  ids: { uid: number; gid: number },
): string[] {
  const bwrapBind = bwrap.startsWith("/usr/") ? [] : ["--ro-bind", bwrap, bwrap];
  return [
    bwrap,
    "--unshare-user",
    "--unshare-net",
    "--unshare-pid",
    "--die-with-parent",
    "--uid",
    "0",
    "--gid",
    "0",
    "--cap-add",
    "CAP_NET_BIND_SERVICE",
    "--cap-add",
    "CAP_SETPCAP",
    "--cap-add",
    "CAP_SETFCAP",
    ...libraryBinds(),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...bwrapBind,
    "--ro-bind",
    helper,
    HELPER_IN_SANDBOX,
    HELPER_IN_SANDBOX,
    "--socket",
    UNUSED_SOCKET,
    "--listen",
    "127.0.0.2:443:0",
    "--dns",
    "127.0.0.53",
    "--",
    bwrap,
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--unshare-user",
    "--new-session",
    "--die-with-parent",
    "--share-net",
    "--uid",
    String(ids.uid),
    "--gid",
    String(ids.gid),
    "--cap-drop",
    "ALL",
    ...libraryBinds(),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "/usr/bin/true",
  ];
}

function runFailureText(r: DoctorBwrapRun): string {
  return r.stderr.trim() === "" ? `exit ${String(r.code)}` : r.stderr.trim();
}

/**
 * The per-host half of the sandbox. A missing helper is a warning, since the sandbox still confines
 * and only the network is wider, as documented. A helper that is named or present and cannot work is
 * a failure, because then the gateway refuses every connector that declares a network.
 */
function doctorPrintDeclaredHosts(bwrap: string, deps: DoctorBwrapDeps): number {
  const helper = deps.findHelper();
  if (helper.kind === "missing") {
    console.log(
      "[warn] Sandbox: nimbus-sandbox-helper is missing, so a connector that declares a network reaches the whole internet.",
    );
    return 1;
  }
  const refused = "so a connector that declares a network is refused.";
  if (helper.kind === "override-missing") {
    console.log(
      `[fail] Sandbox: NIMBUS_SANDBOX_HELPER_PATH names ${helper.path}, which does not exist, ${refused}`,
    );
    return 2;
  }
  const check = deps.run([helper.path, "--check"]);
  if (check.code !== 0) {
    console.log(`[fail] Sandbox: ${helper.path} cannot run (${runFailureText(check)}), ${refused}`);
    return 2;
  }
  const start = deps.run(nestedStartCommand(bwrap, helper.path, deps.ids()));
  if (start.code !== 0) {
    console.log(
      `[fail] Sandbox: the network forwarder cannot start here (${runFailureText(start)}), ${refused}`,
    );
    return 2;
  }
  console.log("[ok] Sandbox: declared hosts are enforced.");
  return 0;
}

/**
 * A Linux-only check that bubblewrap can really start a child, and that a child that declares hosts
 * reaches only those. `--version` passes on a machine where it cannot start one, so this runs the
 * namespaces. Returns the exit severity.
 */
export function doctorPrintLinuxSandbox(deps: DoctorBwrapDeps): number {
  if (deps.platform !== "linux") return 0;
  const bwrap = deps.findBwrap();
  if (bwrap === null) {
    console.log(
      "[fail] Sandbox: bubblewrap is not installed, so nothing sandboxed can start. Install the `bubblewrap` package.",
    );
    return 2;
  }
  const r = deps.run(startProbeCommand(bwrap));
  if (r.code === 0) {
    console.log("[ok] Sandbox: bubblewrap can start sandboxed children.");
    return doctorPrintDeclaredHosts(bwrap, deps);
  }
  console.log(
    `[fail] Sandbox: bubblewrap cannot start a sandbox (${runFailureText(r)}), so connectors, extensions and \`nimbus eval\` cannot start.`,
  );
  if (deps.apparmorFixApplies(bwrap)) {
    console.log("  Ubuntu's AppArmor restriction is blocking it. To allow bubblewrap only, run:");
    console.log(`    ${PROFILE_PRINTF} | sudo tee ${BWRAP_APPARMOR_PROFILE_PATH} >/dev/null`);
    console.log(`    sudo apparmor_parser -r ${BWRAP_APPARMOR_PROFILE_PATH}`);
  }
  return 2;
}

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"] as const;
const PROBE_TIMEOUT_MS = 5000;
const HELPER_NAME = "nimbus-sandbox-helper";
const INSTALLED_HELPER = `/usr/lib/nimbus/bin/${HELPER_NAME}`;

export interface DoctorBwrapHost {
  readonly exists: (path: string) => boolean;
  /** The file's text; throws when it cannot be read. */
  readonly read: (path: string) => string;
  /** The binary's path on `PATH`, or null. */
  readonly which: (name: string) => string | null;
  readonly env: (name: string) => string | undefined;
  /** This program's path. Every package puts the CLI and the gateway in one directory. */
  readonly execPath: string;
}

const REAL_HOST: DoctorBwrapHost = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  which: (name) => Bun.which(name),
  env: (name) => process.env[name],
  execPath: process.execPath,
};

/** The same order as the gateway's `resolveHelperPath`, which the CLI may not import. */
function findHelper(host: DoctorBwrapHost): HelperLookup {
  const override = host.env("NIMBUS_SANDBOX_HELPER_PATH");
  if (override !== undefined && override !== "") {
    return host.exists(override)
      ? { kind: "found", path: override }
      : { kind: "override-missing", path: override };
  }
  const beside = posix.join(posix.dirname(host.execPath), HELPER_NAME);
  if (host.exists(beside)) return { kind: "found", path: beside };
  return host.exists(INSTALLED_HELPER)
    ? { kind: "found", path: INSTALLED_HELPER }
    : { kind: "missing" };
}

/** The same conditions as {@link bwrapApparmorInstallShell}: never offer what it would refuse. */
function apparmorFixApplies(bwrap: string, host: DoctorBwrapHost): boolean {
  try {
    return (
      // The profile names this path, so it cannot help a bwrap found anywhere else.
      bwrap === "/usr/bin/bwrap" &&
      host.read(RESTRICT_SYSCTL_PATH).trim() === "1" &&
      host.exists(ABI_PATH) &&
      !EXISTING_BWRAP_PROFILES.some((p) => host.exists(p)) &&
      host.which("apparmor_parser") !== null
    );
  } catch {
    return false;
  }
}

/** Production deps, with the same lookup as the gateway's runner (`platform/sandbox/linux.ts`). */
export function createDoctorBwrapDeps(
  platform: string,
  host: DoctorBwrapHost = REAL_HOST,
): DoctorBwrapDeps {
  return {
    platform,
    findBwrap: () => {
      const override = host.env("NIMBUS_BWRAP_PATH");
      if (override !== undefined && override !== "") return host.exists(override) ? override : null;
      return BWRAP_CANDIDATES.find((p) => host.exists(p)) ?? null;
    },
    run: (cmd) => {
      try {
        const p = Bun.spawnSync({
          cmd: [...cmd],
          stdout: "ignore",
          stderr: "pipe",
          timeout: PROBE_TIMEOUT_MS,
        });
        return { code: p.exitCode, stderr: p.stderr.toString() };
      } catch (err) {
        return { code: null, stderr: err instanceof Error ? err.message : String(err) };
      }
    },
    apparmorFixApplies: (bwrap) => apparmorFixApplies(bwrap, host),
    findHelper: () => findHelper(host),
    ids: () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
  };
}
