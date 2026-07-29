import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

import type { IPCClient } from "../ipc-client/index.ts";
import type { CliPlatformPaths } from "../paths.ts";

const LINUX_SECRET_TOOL_HINT =
  "secret-tool not found. Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) to use the OS vault on Linux.";

// ---------------------------------------------------------------------------
// Linux Vault health (issue #925)
//
// `Bun.which("secret-tool") !== null` is a PATH check, not a health check.
// libsecret is only a client: it reaches a Secret Service provider over the
// D-Bus session bus, and that provider must expose an unlocked default
// collection before one credential can be stored. On a headless box the binary
// is present and every Vault operation still fails, so doctor must probe the
// service, not the binary.
//
// Measured on ubuntu:24.04 — `secret-tool lookup <absent>` exits 1 with empty
// stderr, and `secret-tool search --all <absent>` exits 0, in the working state
// AND in both broken-collection states. Only the Secret Service itself
// separates them, hence the D-Bus reads below.
// ---------------------------------------------------------------------------

export type DoctorVaultState =
  | "not-applicable"
  | "ok"
  | "not-installed"
  | "no-session-bus"
  | "no-secret-service"
  | "no-collection"
  | "locked"
  | "unverified";

export interface DoctorVaultRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DoctorVaultExec {
  readonly findSecretTool: () => string | null;
  /** Runs `secret-tool` and returns stderr only — stdout is discarded so a looked-up secret cannot leak. */
  readonly lookupStderr: (exe: string, args: readonly string[]) => string;
  readonly hasBinary: (name: string) => boolean;
  readonly runQuery: (cmd: readonly string[]) => DoctorVaultRun;
}

export interface DoctorVaultStatus {
  readonly state: DoctorVaultState;
  readonly exit: number;
  readonly detail: string;
}

/**
 * Attributes for the read-only probe lookup. `application` is deliberately not
 * `nimbus`, so the lookup cannot match a real credential and cannot create,
 * modify or leave behind anything.
 */
export const DOCTOR_VAULT_PROBE_ATTRS: readonly string[] = [
  "application",
  "nimbus-vault-probe",
  "nimbus-key",
  "__nimbus_secret_service_probe__",
];

const SECRETS_NAME = "org.freedesktop.secrets";
const SECRETS_PATH = "/org/freedesktop/secrets";
const SERVICE_IFACE = "org.freedesktop.Secret.Service";
const COLLECTION_IFACE = "org.freedesktop.Secret.Collection";
const VAULT_PROBE_TIMEOUT_MS = 5_000;

const NO_BUS_PATTERN = /autolaunch|DBUS_SESSION_BUS_ADDRESS/i;
const NO_PROVIDER_PATTERN = /not provided by|ServiceUnknown/i;
const OBJECT_PATH_PATTERN = /(?:^|\s)(?:object path|o)\s+"([^"]*)"/m;
const BOOL_PATTERN = /(?:^|\s)(?:boolean|b)\s+(true|false)\b/m;

const VAULT_UNLOCK_HINT =
  "On a headless machine start Nimbus inside a session, e.g. dbus-run-session -- bash -c 'echo \"\" | gnome-keyring-daemon --unlock --components=secrets; nimbus start'.";

const VAULT_REPORT: Readonly<Record<DoctorVaultState, { mark: string; text: string }>> = {
  "not-applicable": { mark: "[ok]", text: "OS-native store — no Linux Secret Service check." },
  ok: { mark: "[ok]", text: "Secret Service reachable with an unlocked default keyring." },
  "not-installed": { mark: "[fail]", text: LINUX_SECRET_TOOL_HINT },
  "no-session-bus": {
    mark: "[fail]",
    text: `secret-tool is installed but there is no D-Bus session bus, so the OS keyring is unreachable and every Vault operation fails. ${VAULT_UNLOCK_HINT}`,
  },
  "no-secret-service": {
    mark: "[fail]",
    text: `a D-Bus session bus is present but no Secret Service provider owns ${SECRETS_NAME} — install and run gnome-keyring, KWallet, or KeePassXC with Secret Service enabled. ${VAULT_UNLOCK_HINT}`,
  },
  "no-collection": {
    mark: "[fail]",
    text: `a Secret Service provider is running over D-Bus but exposes no default keyring collection, so every Vault write fails. ${VAULT_UNLOCK_HINT}`,
  },
  locked: {
    mark: "[fail]",
    text: `the default Secret Service keyring collection is locked over D-Bus, so every Vault write fails. ${VAULT_UNLOCK_HINT}`,
  },
  unverified: {
    mark: "[warn]",
    text: `a Secret Service provider answered but its keyring state could not be verified — install busctl (systemd) or dbus-send (dbus) for a complete check. ${VAULT_UNLOCK_HINT}`,
  },
};

const VAULT_EXIT_BY_MARK: Readonly<Record<string, number>> = {
  "[ok]": 0,
  "[warn]": 1,
  "[fail]": 2,
};

function secretServiceCommands(kind: "default-collection" | "locked", path: string): string[][] {
  const dest = `--dest=${SECRETS_NAME}`;
  if (kind === "default-collection") {
    return [
      [
        "busctl",
        "--user",
        "call",
        SECRETS_NAME,
        SECRETS_PATH,
        SERVICE_IFACE,
        "ReadAlias",
        "s",
        "default",
      ],
      [
        "dbus-send",
        "--session",
        "--print-reply",
        dest,
        SECRETS_PATH,
        `${SERVICE_IFACE}.ReadAlias`,
        "string:default",
      ],
    ];
  }
  return [
    ["busctl", "--user", "get-property", SECRETS_NAME, path, COLLECTION_IFACE, "Locked"],
    [
      "dbus-send",
      "--session",
      "--print-reply",
      dest,
      path,
      "org.freedesktop.DBus.Properties.Get",
      `string:${COLLECTION_IFACE}`,
      "string:Locked",
    ],
  ];
}

function askSecretService(
  exec: DoctorVaultExec,
  kind: "default-collection" | "locked",
  path: string,
): DoctorVaultRun | null {
  for (const cmd of secretServiceCommands(kind, path)) {
    const bin = cmd[0];
    if (bin !== undefined && exec.hasBinary(bin)) {
      return exec.runQuery(cmd);
    }
  }
  return null;
}

function stateFromDiagnostic(text: string): DoctorVaultState | null {
  if (NO_BUS_PATTERN.test(text)) return "no-session-bus";
  if (NO_PROVIDER_PATTERN.test(text)) return "no-secret-service";
  return null;
}

function collectionState(exec: DoctorVaultExec): { state: DoctorVaultState; detail: string } {
  const alias = askSecretService(exec, "default-collection", SECRETS_PATH);
  if (alias === null) {
    return { state: "unverified", detail: "no busctl or dbus-send available" };
  }
  if (alias.code !== 0) {
    return {
      state: stateFromDiagnostic(alias.stderr) ?? "unverified",
      detail: alias.stderr.trim(),
    };
  }
  const path = OBJECT_PATH_PATTERN.exec(alias.stdout)?.[1];
  if (path === undefined) {
    return { state: "unverified", detail: alias.stdout.trim() };
  }
  if (path === "/") {
    return { state: "no-collection", detail: `${SECRETS_NAME} has no default collection` };
  }
  const locked = askSecretService(exec, "locked", path);
  if (locked === null || locked.code !== 0) {
    return { state: "unverified", detail: locked?.stderr.trim() ?? "" };
  }
  const flag = BOOL_PATTERN.exec(locked.stdout)?.[1];
  if (flag === undefined) {
    return { state: "unverified", detail: locked.stdout.trim() };
  }
  return flag === "true" ? { state: "locked", detail: path } : { state: "ok", detail: path };
}

export function doctorVaultStatus(
  os: string,
  exec: DoctorVaultExec = createDoctorVaultExec(),
): DoctorVaultStatus {
  const toStatus = (state: DoctorVaultState, detail: string): DoctorVaultStatus => ({
    state,
    detail,
    exit: VAULT_EXIT_BY_MARK[VAULT_REPORT[state].mark] ?? 2,
  });
  if (os !== "linux") {
    return toStatus("not-applicable", os);
  }
  const exe = exec.findSecretTool();
  if (exe === null) {
    return toStatus("not-installed", "");
  }
  const stderr = exec.lookupStderr(exe, ["lookup", ...DOCTOR_VAULT_PROBE_ATTRS]).trim();
  const early = stateFromDiagnostic(stderr);
  if (early !== null) {
    return toStatus(early, stderr);
  }
  const { state, detail } = collectionState(exec);
  return toStatus(state, detail);
}

export function formatDoctorVaultLine(status: DoctorVaultStatus): string {
  const report = VAULT_REPORT[status.state];
  const suffix =
    status.state === "not-applicable"
      ? ` (${status.detail})`
      : status.detail.length > 0 && status.state !== "ok"
        ? ` [${status.detail}]`
        : "";
  return `${report.mark} Vault: ${report.text}${suffix}`;
}

export function doctorVaultLine(
  os: string,
  exec: DoctorVaultExec = createDoctorVaultExec(),
): string {
  return formatDoctorVaultLine(doctorVaultStatus(os, exec));
}

/**
 * `keepStdout: false` leaves stdout unpiped entirely — used for the secret-tool
 * lookup so a matched secret has nowhere to go.
 */
function spawnCapture(cmd: readonly string[], keepStdout: boolean): DoctorVaultRun {
  try {
    const p = Bun.spawnSync({
      cmd: [...cmd],
      stdout: keepStdout ? "pipe" : "ignore",
      stderr: "pipe",
      timeout: VAULT_PROBE_TIMEOUT_MS,
    });
    // stdout is undefined whenever it was not piped, so this is "" by construction.
    return {
      code: p.exitCode,
      stdout: p.stdout?.toString() ?? "",
      stderr: p.stderr.toString(),
    };
  } catch (err) {
    return { code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

function createDoctorVaultExec(): DoctorVaultExec {
  return {
    findSecretTool: () => Bun.which("secret-tool"),
    lookupStderr: (exe, args) => spawnCapture([exe, ...args], false).stderr,
    hasBinary: (name) => Bun.which(name) !== null,
    runQuery: (cmd) => spawnCapture(cmd, true),
  };
}

const MIN_BUN_MAJOR = 1;
const MIN_BUN_MINOR = 2;

function bunVersionOk(): boolean {
  const m = /^(\d+)\.(\d+)\./.exec(Bun.version);
  if (m === null) {
    return true;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > MIN_BUN_MAJOR || (major === MIN_BUN_MAJOR && minor >= MIN_BUN_MINOR);
}

type ConnectorHealthRow = {
  connectorId?: unknown;
  state?: unknown;
};

export interface DoctorGatewayState {
  readonly socketPath: string;
  readonly pid: number;
}

export interface DoctorCoreDeps {
  readonly getCliPlatformPaths: () => CliPlatformPaths;
  readonly readGatewayState: (paths: CliPlatformPaths) => Promise<DoctorGatewayState | undefined>;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly gatewayStatePath: (paths: CliPlatformPaths) => string;
  readonly makeClient: (socketPath: string) => IPCClient;
}

export function worstHealthSeverity(rows: ConnectorHealthRow[]): "ok" | "warn" | "fail" {
  let worst: "ok" | "warn" | "fail" = "ok";
  for (const r of rows) {
    const st = typeof r.state === "string" ? r.state : "";
    if (st === "unauthenticated" || st === "error") {
      worst = "fail";
    } else if (st === "degraded" || st === "rate_limited") {
      if (worst === "ok") {
        worst = "warn";
      }
    }
  }
  return worst;
}

export function healthStateMark(st: string): string {
  if (st === "healthy" || st === "paused") {
    return "[ok]";
  }
  if (st === "unauthenticated" || st === "error") {
    return "[fail]";
  }
  return "[warn]";
}

function doctorPrintBunCheck(): number {
  console.log(`Runtime: Bun ${Bun.version}`);
  if (bunVersionOk()) {
    console.log("[ok] Bun version meets minimum.");
    return 0;
  }
  console.log(
    `[fail] Nimbus expects Bun >= ${String(MIN_BUN_MAJOR)}.${String(MIN_BUN_MINOR)} (see repository README).`,
  );
  return 2;
}

function doctorPrintVaultCheck(): number {
  // One probe per run: the Secret Service reads shell out, so never re-probe
  // just to render the line.
  const status = doctorVaultStatus(platform());
  console.log(formatDoctorVaultLine(status));
  return status.exit;
}

export function doctorPrintConfigValidation(val: {
  ok: boolean;
  errors: string[];
  warnings: string[];
}): number {
  let exit = 0;
  if (val.warnings.length > 0) {
    for (const w of val.warnings) {
      console.log(`[warn] Config: ${w}`);
    }
    exit = 1;
  }
  if (!val.ok) {
    for (const e of val.errors) {
      console.log(`[fail] Config: ${e}`);
    }
    return 2;
  }
  if (val.errors.length === 0 && val.warnings.length === 0) {
    console.log("[ok] Config: valid.");
  }
  return exit;
}

export function doctorPrintIndexFromSnapshot(snap: { index?: { totalItems?: unknown } }): number {
  const total = snap.index?.totalItems;
  const nItems =
    typeof total === "number" && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (nItems === 0) {
    console.log("[warn] Index: zero items — run connector sync after auth.");
    return 1;
  }
  console.log(`[ok] Index: ${String(nItems)} items.`);
  return 0;
}

export function doctorPrintHealthFromSnapshot(snap: { connectorHealth?: unknown }): number {
  const healthRaw = snap.connectorHealth;
  const health: ConnectorHealthRow[] = Array.isArray(healthRaw)
    ? (healthRaw as ConnectorHealthRow[])
    : [];
  if (health.length === 0) {
    console.log("[warn] Connectors: none registered.");
    return 1;
  }
  console.log("Connector health:");
  for (const h of health) {
    const id = typeof h.connectorId === "string" ? h.connectorId : "?";
    const st = typeof h.state === "string" ? h.state : "?";
    const mark = healthStateMark(st);
    console.log(`  ${mark} ${id}: ${st}`);
  }
  const sev = worstHealthSeverity(health);
  return sev === "ok" ? 0 : 1;
}

async function doctorRunGatewayRpcs(client: IPCClient): Promise<number> {
  const ping = await client.call<{ uptime?: number }>("gateway.ping", {});
  const uptime = typeof ping.uptime === "number" && Number.isFinite(ping.uptime) ? ping.uptime : 0;
  console.log(`[ok] Gateway: IPC OK (uptime ~${String(Math.round(uptime / 1000))}s).`);

  const val = await client.call<{ ok: boolean; errors: string[]; warnings: string[] }>(
    "config.validate",
    {},
  );
  let exit = doctorPrintConfigValidation(val);

  const snap = await client.call<{
    index?: { totalItems?: unknown };
    connectorHealth?: unknown;
  }>("diag.snapshot", {});
  exit = Math.max(exit, doctorPrintIndexFromSnapshot(snap));
  exit = Math.max(exit, doctorPrintHealthFromSnapshot(snap));
  return exit;
}

export async function runDoctor(_args: string[], deps: DoctorCoreDeps): Promise<void> {
  const paths = deps.getCliPlatformPaths();
  let exit = 0;
  exit = Math.max(exit, doctorPrintBunCheck());

  console.log(`Data dir: ${paths.dataDir}`);
  console.log(`Gateway state file: ${deps.gatewayStatePath(paths)}`);

  exit = Math.max(exit, doctorPrintVaultCheck());

  const voiceCfg = loadVoiceConfigFromDir(paths.configDir);
  const voiceLines = doctorVoiceLines(voiceCfg, {
    which: (n) => Bun.which(n),
    platform: platform() as "win32" | "darwin" | "linux",
  });
  for (const line of voiceLines) {
    console.log(line);
    if (line.startsWith("[fail]")) exit = Math.max(exit, 2);
    else if (line.startsWith("[warn]")) exit = Math.max(exit, 1);
  }

  const state = await deps.readGatewayState(paths);
  if (state !== undefined && deps.isProcessAlive(state.pid)) {
    const client = deps.makeClient(state.socketPath);
    try {
      await client.connect();
      exit = Math.max(exit, await doctorRunGatewayRpcs(client));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[fail] Gateway: IPC failed — ${msg}`);
      exit = Math.max(exit, 2);
    } finally {
      await client.disconnect().catch(() => {});
    }
  } else if (state === undefined) {
    console.log("[fail] Gateway: not running (no gateway.json — start with: nimbus start).");
    exit = Math.max(exit, 2);
  } else {
    console.log(
      `[fail] Gateway: stale state (pid ${String(state.pid)} is not running) — try nimbus stop or remove the state file.`,
    );
    exit = Math.max(exit, 2);
  }

  process.exitCode = exit;
}

export type DoctorVoiceConfig = {
  enabled: boolean;
  whisperPath: string;
  piperPath: string;
  piperModel: string;
};

export type DoctorEnv = {
  which: (name: string) => string | null;
  platform: "win32" | "darwin" | "linux";
};

function doctorPiperLines(cfg: DoctorVoiceConfig, env: DoctorEnv): string[] {
  if (cfg.piperPath === "" && cfg.piperModel === "") return [];
  const lines: string[] = [];
  const hasAbsPath = cfg.piperPath.includes("/") || cfg.piperPath.includes("\\");
  const piperBinOk = cfg.piperPath !== "" && (hasAbsPath || env.which(cfg.piperPath) !== null);
  if (!piperBinOk) {
    lines.push(`[warn] Voice: piper_path is set but the binary was not found: ${cfg.piperPath}`);
  }
  if (cfg.piperModel === "") {
    lines.push(
      "[warn] Voice: piper_path is set but piper_model is empty — Piper TTS will not run.",
    );
  }
  return lines;
}

export function doctorVoiceLines(cfg: DoctorVoiceConfig, env: DoctorEnv): string[] {
  if (!cfg.enabled) return [];
  const lines: string[] = [];

  const whisperOk =
    cfg.whisperPath !== "" || env.which("whisper-cli") !== null || env.which("main") !== null;
  lines.push(
    whisperOk
      ? "[ok] Voice: whisper-cli is available."
      : "[warn] Voice: whisper-cli not found on PATH and voice.whisper_path is unset — STT will not work.",
  );

  const ffmpegOk = env.which("ffmpeg") !== null;
  lines.push(
    ffmpegOk
      ? "[ok] Voice: ffmpeg is on PATH."
      : "[warn] Voice: ffmpeg not found on PATH — wake word detection requires ffmpeg for audio capture.",
  );

  if (env.platform === "darwin") {
    lines.push("[ok] Voice: macOS `say` is always available.");
  } else if (env.platform === "win32") {
    lines.push("[ok] Voice: Windows SAPI via PowerShell is always available.");
  } else {
    const espeakOk = env.which("espeak-ng") !== null;
    const spdSayOk = env.which("spd-say") !== null;
    if (espeakOk) {
      lines.push("[ok] Voice: Linux TTS via espeak-ng.");
    } else if (spdSayOk) {
      lines.push("[ok] Voice: Linux TTS via spd-say (espeak-ng preferred).");
    } else {
      lines.push(
        "[warn] Voice: neither espeak-ng nor spd-say found on PATH — install one to enable TTS on Linux.",
      );
    }
  }

  lines.push(...doctorPiperLines(cfg, env));
  return lines;
}

function applyVoiceKey(out: Partial<DoctorVoiceConfig>, key: string, val: string): void {
  if (key === "enabled") out.enabled = val === "true";
  else if (key === "whisper_path") out.whisperPath = val;
  else if (key === "piper_path") out.piperPath = val;
  else if (key === "piper_model") out.piperModel = val;
}

function parseVoiceTomlLines(lines: string[]): Partial<DoctorVoiceConfig> {
  let inVoice = false;
  const out: Partial<DoctorVoiceConfig> = {};
  for (const line of lines) {
    const hashIdx = line.indexOf("#");
    const trimmed = (hashIdx >= 0 ? line.slice(0, hashIdx) : line).trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inVoice = trimmed === "[voice]";
      continue;
    }
    if (!inVoice) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const valRaw = trimmed.slice(eq + 1).trim();
    const val = valRaw.startsWith('"') && valRaw.endsWith('"') ? valRaw.slice(1, -1) : valRaw;
    applyVoiceKey(out, key, val);
  }
  return out;
}

function loadVoiceConfigFromDir(configDir: string): DoctorVoiceConfig {
  const tomlPath = join(configDir, "nimbus.toml");
  const defaults: DoctorVoiceConfig = {
    enabled: false,
    whisperPath: "",
    piperPath: "",
    piperModel: "",
  };
  if (!existsSync(tomlPath)) return defaults;
  try {
    const src = readFileSync(tomlPath, "utf8");
    return { ...defaults, ...parseVoiceTomlLines(src.split(/\r?\n/)) };
  } catch {
    return defaults;
  }
}
