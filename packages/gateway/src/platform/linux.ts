import { resolveSecretToolExecutable } from "../vault/linux.ts";
import { assemblePlatformServices } from "./assemble.ts";
import { PlatformInitError } from "./errors.ts";
import { createLinuxPaths } from "./paths.ts";
import type { PlatformServices } from "./types.ts";

const SECRET_TOOL_INSTALL_HINT =
  "secret-tool not found. Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) to use Nimbus on Linux.";

/**
 * Outcome of the Linux Vault preflight.
 *
 * `secret-tool` being on PATH says nothing about whether the Vault works:
 * libsecret is only a *client*. It reaches a Secret Service provider over the
 * D-Bus session bus, and that provider must expose an unlocked default
 * collection before a single credential can be written. On a headless box —
 * server, container, SSH session, WSL — none of that is guaranteed, so a PATH
 * check reports a healthy Vault on a machine where every Vault write fails.
 */
export type LinuxVaultState =
  /** A default collection exists and is unlocked; Vault writes will succeed. */
  | "ok"
  /** The `secret-tool` binary is absent. */
  | "not-installed"
  /** No D-Bus session bus, so libsecret cannot reach a provider at all. */
  | "no-session-bus"
  /** A session bus exists but nothing owns `org.freedesktop.secrets`. */
  | "no-secret-service"
  /** A provider is running but has no default collection: writes fail. */
  | "no-collection"
  /** A default collection exists but is locked: writes fail without a prompt. */
  | "locked"
  /** Provider reachable, but its collection state could not be determined. */
  | "unverified";

export interface LinuxVaultProbe {
  readonly state: LinuxVaultState;
  /** Underlying diagnostic: stderr and D-Bus paths only, never secret material. */
  readonly detail: string;
}

export interface LinuxProbeCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LinuxVaultProbeExec {
  readonly resolveSecretTool: () => string | null;
  /**
   * Runs `secret-tool` with the given arguments. Implementations MUST discard
   * stdout: the return type has no stdout field precisely so that a looked-up
   * secret has nowhere to leak into a log line or an error message.
   */
  readonly probeSecretTool: (
    exe: string,
    args: readonly string[],
  ) => { code: number | null; stderr: string };
  readonly which: (name: string) => string | null;
  readonly query: (cmd: readonly string[]) => LinuxProbeCommandResult;
  readonly hasInteractiveDisplay: () => boolean;
}

/**
 * Attributes for the read-only probe lookup. `application` is deliberately NOT
 * `nimbus` (the value `LinuxSecretToolVault` writes), so the lookup is
 * structurally guaranteed to miss: it can never read back a real credential, and
 * a lookup neither creates, modifies nor leaves anything behind.
 */
export const LINUX_VAULT_PROBE_ATTRS: readonly string[] = [
  "application",
  "nimbus-vault-probe",
  "nimbus-key",
  "__nimbus_secret_service_probe__",
];

const SECRETS_BUS_NAME = "org.freedesktop.secrets";
const SECRETS_SERVICE_PATH = "/org/freedesktop/secrets";
const SECRETS_SERVICE_IFACE = "org.freedesktop.Secret.Service";
const SECRETS_COLLECTION_IFACE = "org.freedesktop.Secret.Collection";
const NULL_OBJECT_PATH = "/";
const PROBE_TIMEOUT_MS = 5_000;

/** `secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY` and friends. */
const NO_SESSION_BUS_RE = /autolaunch|DBUS_SESSION_BUS_ADDRESS/i;
/** Matches `The name org.freedesktop.secrets was not provided by ... .service files`. */
const NO_PROVIDER_RE = /not provided by|ServiceUnknown/i;
const OBJECT_PATH_RE = /(?:^|\s)(?:object path|o)\s+"([^"]*)"/m;
const BOOLEAN_RE = /(?:^|\s)(?:boolean|b)\s+(true|false)\b/m;

function readAliasCommands(): readonly (readonly string[])[] {
  return [
    [
      "busctl",
      "--user",
      "call",
      SECRETS_BUS_NAME,
      SECRETS_SERVICE_PATH,
      SECRETS_SERVICE_IFACE,
      "ReadAlias",
      "s",
      "default",
    ],
    [
      "dbus-send",
      "--session",
      "--print-reply",
      `--dest=${SECRETS_BUS_NAME}`,
      SECRETS_SERVICE_PATH,
      `${SECRETS_SERVICE_IFACE}.ReadAlias`,
      "string:default",
    ],
  ];
}

function collectionLockedCommands(objectPath: string): readonly (readonly string[])[] {
  return [
    [
      "busctl",
      "--user",
      "get-property",
      SECRETS_BUS_NAME,
      objectPath,
      SECRETS_COLLECTION_IFACE,
      "Locked",
    ],
    [
      "dbus-send",
      "--session",
      "--print-reply",
      `--dest=${SECRETS_BUS_NAME}`,
      objectPath,
      "org.freedesktop.DBus.Properties.Get",
      `string:${SECRETS_COLLECTION_IFACE}`,
      "string:Locked",
    ],
  ];
}

function runFirstAvailable(
  exec: LinuxVaultProbeExec,
  candidates: readonly (readonly string[])[],
): LinuxProbeCommandResult | null {
  for (const cmd of candidates) {
    const bin = cmd[0];
    if (bin !== undefined && exec.which(bin) !== null) {
      return exec.query(cmd);
    }
  }
  return null;
}

function stateFromDiagnostic(text: string): LinuxVaultState | null {
  if (NO_SESSION_BUS_RE.test(text)) {
    return "no-session-bus";
  }
  if (NO_PROVIDER_RE.test(text)) {
    return "no-secret-service";
  }
  return null;
}

/** Resolves the default collection's object path, or a terminal probe result. */
function defaultCollectionPath(exec: LinuxVaultProbeExec): LinuxVaultProbe | string {
  const alias = runFirstAvailable(exec, readAliasCommands());
  if (alias === null) {
    return {
      state: "unverified",
      detail: "neither busctl nor dbus-send is installed, so the keyring state is unknown",
    };
  }
  if (alias.code !== 0) {
    const err = alias.stderr.trim();
    return { state: stateFromDiagnostic(err) ?? "unverified", detail: err };
  }
  const parsed = OBJECT_PATH_RE.exec(alias.stdout);
  if (parsed?.[1] === undefined) {
    return { state: "unverified", detail: `unparseable ReadAlias reply: ${alias.stdout.trim()}` };
  }
  return parsed[1];
}

/**
 * Functionally probes the Linux Vault backend. Strictly read-only: one
 * `secret-tool lookup` for a key that cannot exist, plus at most two D-Bus
 * property reads.
 */
export function probeLinuxVault(
  exec: LinuxVaultProbeExec = createDefaultProbeExec(),
): LinuxVaultProbe {
  const exe = exec.resolveSecretTool();
  if (exe === null) {
    return { state: "not-installed", detail: "" };
  }

  const lookup = exec.probeSecretTool(exe, ["lookup", ...LINUX_VAULT_PROBE_ATTRS]);
  const lookupErr = lookup.stderr.trim();
  const fromStderr = stateFromDiagnostic(lookupErr);
  if (fromStderr !== null) {
    return { state: fromStderr, detail: lookupErr };
  }

  // A clean miss means the provider answered — but a miss looks *identical*
  // whether the default collection is present, absent or locked (measured: exit
  // 1, empty stderr in all three). Only the Secret Service can tell them apart.
  const collection = defaultCollectionPath(exec);
  if (typeof collection !== "string") {
    return collection;
  }
  if (collection === NULL_OBJECT_PATH) {
    return { state: "no-collection", detail: `${SECRETS_BUS_NAME} has no default collection` };
  }

  const locked = runFirstAvailable(exec, collectionLockedCommands(collection));
  if (locked?.code !== 0) {
    return { state: "unverified", detail: locked?.stderr.trim() ?? "" };
  }
  const flag = BOOLEAN_RE.exec(locked.stdout);
  if (flag?.[1] === undefined) {
    return { state: "unverified", detail: `unparseable Locked reply: ${locked.stdout.trim()}` };
  }
  return flag[1] === "true"
    ? { state: "locked", detail: collection }
    : { state: "ok", detail: collection };
}

const FATAL_LINUX_VAULT_STATES: ReadonlySet<LinuxVaultState> = new Set<LinuxVaultState>([
  "not-installed",
  "no-session-bus",
  "no-secret-service",
  "no-collection",
]);

/**
 * A locked-but-present collection is fatal only when nothing can raise an unlock
 * prompt. With a display libsecret prompts and the write succeeds; headless it
 * fails with "Cannot create an item in a locked collection".
 */
export function isFatalLinuxVaultState(
  state: LinuxVaultState,
  hasInteractiveDisplay: boolean,
): boolean {
  if (FATAL_LINUX_VAULT_STATES.has(state)) {
    return true;
  }
  return state === "locked" && !hasInteractiveDisplay;
}

const HEADLESS_REMEDY = [
  "Nimbus keeps credentials in the OS keyring through libsecret, which needs BOTH a",
  "D-Bus session bus AND an unlocked Secret Service keyring — installing secret-tool",
  "alone is not enough. On a headless machine, start Nimbus inside a session:",
  "  dbus-run-session -- bash -c 'echo \"\" | gnome-keyring-daemon --unlock --components=secrets; nimbus start'",
].join("\n");

const STATE_HEADLINES: Readonly<Record<LinuxVaultState, string>> = {
  ok: "Linux Vault backend is available.",
  "not-installed": SECRET_TOOL_INSTALL_HINT,
  "no-session-bus":
    "secret-tool is installed but there is no D-Bus session bus, so the OS keyring is unreachable and every Vault operation fails.",
  "no-secret-service":
    "A D-Bus session bus is present but no Secret Service provider owns org.freedesktop.secrets. Install and run one (gnome-keyring, KWallet, or KeePassXC with Secret Service enabled).",
  "no-collection":
    "A Secret Service provider is running but exposes no default keyring collection, so every Vault write fails.",
  locked:
    "The default Secret Service keyring collection is locked and nothing can prompt to unlock it, so every Vault write fails.",
  unverified:
    "A Secret Service provider answered but its keyring state could not be verified. Install systemd's busctl or dbus's dbus-send for a complete check.",
};

export function describeLinuxVaultState(state: LinuxVaultState, detail: string): string {
  const parts = [STATE_HEADLINES[state]];
  if (state !== "ok" && state !== "not-installed") {
    parts.push(HEADLESS_REMEDY);
  }
  if (detail.length > 0) {
    parts.push(`Diagnostic: ${detail}`);
  }
  return parts.join("\n");
}

function createDefaultProbeExec(): LinuxVaultProbeExec {
  return {
    resolveSecretTool: () =>
      process.env["NIMBUS_LINUX_VAULT_PROBE_STRICT_PATH"] === "1"
        ? Bun.which("secret-tool")
        : resolveSecretToolExecutable(),
    probeSecretTool: (exe, args) => {
      try {
        const p = Bun.spawnSync({
          cmd: [exe, ...args],
          // "ignore", not "pipe": a looked-up secret must have nowhere to go.
          stdout: "ignore",
          stderr: "pipe",
          timeout: PROBE_TIMEOUT_MS,
        });
        return { code: p.exitCode, stderr: p.stderr.toString() };
      } catch (err) {
        return { code: null, stderr: err instanceof Error ? err.message : String(err) };
      }
    },
    which: (name) => Bun.which(name),
    query: (cmd) => {
      try {
        const p = Bun.spawnSync({
          cmd: [...cmd],
          stdout: "pipe",
          stderr: "pipe",
          timeout: PROBE_TIMEOUT_MS,
        });
        return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
      } catch (err) {
        return { code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
      }
    },
    hasInteractiveDisplay: () =>
      (process.env["DISPLAY"] ?? "") !== "" || (process.env["WAYLAND_DISPLAY"] ?? "") !== "",
  };
}

export function assertLinuxSecretToolAvailable(
  exec: LinuxVaultProbeExec = createDefaultProbeExec(),
): void {
  const probe = probeLinuxVault(exec);
  if (isFatalLinuxVaultState(probe.state, exec.hasInteractiveDisplay())) {
    throw new PlatformInitError(describeLinuxVaultState(probe.state, probe.detail));
  }
  if (probe.state !== "ok") {
    // Runs before the gateway logger exists (this is a preflight for
    // assemblePlatformServices), so stderr is the only channel available.
    process.stderr.write(`[gateway] ${describeLinuxVaultState(probe.state, probe.detail)}\n`);
  }
}

export async function create(): Promise<PlatformServices> {
  assertLinuxSecretToolAvailable();
  const paths = createLinuxPaths();
  return assemblePlatformServices(paths);
}
