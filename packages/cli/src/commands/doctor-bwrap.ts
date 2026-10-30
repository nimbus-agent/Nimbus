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
  readonly apparmorFixApplies: () => boolean;
}

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

/**
 * A Linux-only check that bubblewrap can really start a child. `--version` passes on a machine
 * where it cannot, so this runs the namespaces. Returns the exit severity.
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
    return 0;
  }
  const why = r.stderr.trim() === "" ? `exit ${String(r.code)}` : r.stderr.trim();
  console.log(
    `[fail] Sandbox: bubblewrap cannot start a sandbox (${why}), so connectors, extensions and \`nimbus eval\` cannot start.`,
  );
  if (deps.apparmorFixApplies()) {
    console.log("  Ubuntu's AppArmor restriction is blocking it. To allow bubblewrap only, run:");
    console.log(`    ${PROFILE_PRINTF} | sudo tee ${BWRAP_APPARMOR_PROFILE_PATH} >/dev/null`);
    console.log(`    sudo apparmor_parser -r ${BWRAP_APPARMOR_PROFILE_PATH}`);
  }
  return 2;
}

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"] as const;
const PROBE_TIMEOUT_MS = 5000;

export interface DoctorBwrapHost {
  readonly exists: (path: string) => boolean;
  /** The file's text; throws when it cannot be read. */
  readonly read: (path: string) => string;
  /** The binary's path on `PATH`, or null. */
  readonly which: (name: string) => string | null;
  readonly env: (name: string) => string | undefined;
}

const REAL_HOST: DoctorBwrapHost = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  which: (name) => Bun.which(name),
  env: (name) => process.env[name],
};

/** The same conditions as {@link bwrapApparmorInstallShell}: never offer what it would refuse. */
function apparmorFixApplies(host: DoctorBwrapHost): boolean {
  try {
    return (
      host.read(RESTRICT_SYSCTL_PATH).trim() === "1" &&
      host.exists("/usr/bin/bwrap") &&
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
    apparmorFixApplies: () => apparmorFixApplies(host),
  };
}
