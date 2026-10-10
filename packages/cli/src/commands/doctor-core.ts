import { platform } from "node:os";

import type { IPCClient } from "../ipc-client/index.ts";
import { nimbusCommand } from "../lib/demo-hint.ts";
import { gatewayStartCommand } from "../lib/gateway-not-running.ts";
import type { CliPlatformPaths } from "../paths.ts";
import { type FixKeyringDeps, runFixKeyringCommand } from "./doctor-fix-keyring.ts";
import { doctorNotificationsLine, parseNotificationsStatus } from "./notifications-format.ts";

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

// ---------------------------------------------------------------------------
// Per-state remedies (issue #1168, Controller Ruling 16)
//
// The 55-trials-0-failures result belongs to the POLLING-AUGMENTED sequence
// inside doctor-fix-keyring.ts's buildFixScript() — the one that polls
// ownership of org.freedesktop.secrets before touching Secret Service.
// DBUS_SESSION_WRAPPER / SESSION_REQUIRED_HINT below is the PLAIN,
// non-polling sequence handed to users across four states, and per Task 8's
// own record it still loses the D-Bus name-ownership race roughly
// 1-in-40-to-50 on a from-scratch box (no login.keyring yet) — the race is
// closed only where the poll runs. Running `nimbus doctor --fix-keyring`
// first removes that residual risk for the from-scratch case, since it
// creates the keyring deterministically. Nothing here claims the plain
// wrapper is broken — Ruling 16 confirmed it genuinely works, no
// gcr-prompter escalation, no "cannot open display" — only that it carries
// this specific, measured residual risk before a keyring exists.
//
// Each failing state has a different cause, so each gets only the remedy
// that actually addresses it:
//   - not-installed: `--fix-keyring` does not apply — secret-tool itself is
//     missing, so nothing in the fixer can run either.
//   - no-session-bus: `--fix-keyring` does not apply — it spawns its own
//     ephemeral D-Bus session via dbus-run-session, but that session does
//     not persist for the next `nimbus start`, so it cannot fix an ambient
//     "no session bus" condition.
//   - no-collection: exactly what `--fix-keyring` fixes (deterministically,
//     closing the D-Bus name-ownership race and enforcing 0700/0600).
//   - locked: a locked collection implies keyring material already exists on
//     disk — `existingKeyringPath` (doctor-fix-keyring.ts) refuses on an
//     exact `login.keyring`, another `*.keyring` file, or a `default`-alias
//     pointer, not just `login.keyring` by name, so `--fix-keyring` refuses
//     this state every time. The session wrapper is the only route.
//   - no-secret-service: applicability genuinely DEPENDS on on-disk state
//     this probe cannot see — the state is derived purely from a live D-Bus
//     name-ownership query (stateFromDiagnostic() below), which says nothing
//     about what is on disk. If no Secret Service provider is installed at
//     all, `--fix-keyring` cannot help either — its own precheck names
//     gnome-keyring-daemon and reports it missing. If a provider is
//     installed but has never created a collection, `--fix-keyring` would
//     apply — but even then it only prepares on-disk state inside its own
//     ephemeral session; it does not start a provider on the CURRENT
//     session, so the wrapper is still the unconditional next step either
//     way. The printed hint stays wrapper-only: recommending `--fix-keyring`
//     here would frequently be wrong (refuses whenever keyring material
//     already exists) without ever being sufficient by itself.
//   - Every state that needs the wrapper is also told it is not a one-time
//     fix: a fresh D-Bus session that skips its own --unlock fails every
//     `nimbus start`, even after `--fix-keyring` has run once.
// ---------------------------------------------------------------------------

const DBUS_SESSION_WRAPPER =
  "dbus-run-session -- bash -c 'echo \"\" | gnome-keyring-daemon --unlock --components=secrets; nimbus start'";

const SESSION_REQUIRED_HINT =
  `Nimbus needs a D-Bus session with an unlocked keyring for every \`nimbus start\` on headless ` +
  `Linux — not only the first time: ${DBUS_SESSION_WRAPPER}`;

const FIX_KEYRING_HINT =
  "Run: nimbus doctor --fix-keyring — it creates and unlocks a fresh default keyring collection " +
  "deterministically (closing a rare D-Bus name-ownership race) and verifies it with a live " +
  "secret-tool round-trip.";

const VAULT_REPORT: Readonly<Record<DoctorVaultState, { mark: string; text: string }>> = {
  "not-applicable": { mark: "[ok]", text: "OS-native store — no Linux Secret Service check." },
  ok: { mark: "[ok]", text: "Secret Service reachable with an unlocked default keyring." },
  "not-installed": { mark: "[fail]", text: LINUX_SECRET_TOOL_HINT },
  "no-session-bus": {
    mark: "[fail]",
    text: `secret-tool is installed but there is no D-Bus session bus, so the OS keyring is unreachable and every Vault operation fails. ${SESSION_REQUIRED_HINT}`,
  },
  "no-secret-service": {
    mark: "[fail]",
    text: `a D-Bus session bus is present but no Secret Service provider owns ${SECRETS_NAME} — install and run gnome-keyring, KWallet, or KeePassXC with Secret Service enabled inside that session. ${SESSION_REQUIRED_HINT}`,
  },
  "no-collection": {
    mark: "[fail]",
    text: `a Secret Service provider is running over D-Bus but exposes no default keyring collection, so every Vault write fails. ${FIX_KEYRING_HINT}`,
  },
  locked: {
    mark: "[fail]",
    text: `the default Secret Service keyring collection is locked over D-Bus, so every Vault write fails. nimbus doctor --fix-keyring will not help here — it refuses to touch an existing keyring. ${SESSION_REQUIRED_HINT}`,
  },
  unverified: {
    mark: "[warn]",
    text: `a Secret Service provider answered but its keyring state could not be verified — install busctl (systemd) or dbus-send (dbus) for a complete check. ${SESSION_REQUIRED_HINT}`,
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
  if (locked?.code !== 0) {
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

/**
 * `(detail)` when the probe never ran (not-applicable carries the OS name), `[detail]` when a
 * non-ok state has something to say, and nothing at all when the vault is simply healthy.
 */
function vaultLineSuffix(status: DoctorVaultStatus): string {
  if (status.state === "not-applicable") {
    return ` (${status.detail})`;
  }
  if (status.detail.length > 0 && status.state !== "ok") {
    return ` [${status.detail}]`;
  }
  return "";
}

export function formatDoctorVaultLine(status: DoctorVaultStatus): string {
  const report = VAULT_REPORT[status.state];
  return `${report.mark} Vault: ${report.text}${vaultLineSuffix(status)}`;
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
function spawnCapture(
  cmd: readonly string[],
  keepStdout: boolean,
  timeoutMs: number = VAULT_PROBE_TIMEOUT_MS,
): DoctorVaultRun {
  try {
    const p = Bun.spawnSync({
      cmd: [...cmd],
      stdout: keepStdout ? "pipe" : "ignore",
      stderr: "pipe",
      timeout: timeoutMs,
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

/**
 * `timeoutMs` defaults to the short probe timeout used for the read-only
 * Vault health check. `--fix-keyring` (`doctor-fix-keyring.ts`) passes a much
 * longer budget: it spawns a whole `dbus-run-session` + `gnome-keyring-daemon`
 * round trip, not a single D-Bus property read.
 */
export function createDoctorVaultExec(timeoutMs: number = VAULT_PROBE_TIMEOUT_MS): DoctorVaultExec {
  return {
    findSecretTool: () => Bun.which("secret-tool"),
    lookupStderr: (exe, args) => spawnCapture([exe, ...args], false, timeoutMs).stderr,
    hasBinary: (name) => Bun.which(name) !== null,
    runQuery: (cmd) => spawnCapture(cmd, true, timeoutMs),
  };
}

const MIN_BUN_MAJOR = 1;
const MIN_BUN_MINOR = 2;

/**
 * Whether `version` meets the minimum. A version string this cannot parse passes rather than
 * fails. Takes the version as a parameter, rather than reading `Bun.version` itself, so the check
 * is testable on a current runtime — `Bun.version` is a non-configurable property.
 */
export function bunVersionOk(version: string): boolean {
  const m = /^(\d+)\.(\d+)\./.exec(version);
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
  /** DI seam for `--fix-keyring` (headless Linux Secret Service fix, #1168) — see doctor-fix-keyring.ts. */
  readonly fixKeyringDeps: FixKeyringDeps;
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

/** `version` defaults to the running Bun; injectable for the same reason as {@link bunVersionOk}. */
export function doctorPrintBunCheck(version: string = Bun.version): number {
  console.log(`Runtime: Bun ${version}`);
  if (bunVersionOk(version)) {
    console.log("[ok] Bun version meets minimum.");
    return 0;
  }
  console.log(
    `[fail] Nimbus expects Bun >= ${String(MIN_BUN_MAJOR)}.${String(MIN_BUN_MINOR)} (see repository README).`,
  );
  return 2;
}

/** The demo gateway's Vault is an `EphemeralVault` — nothing to probe on disk or over D-Bus. */
const DEMO_VAULT_LINE = "Vault: in-memory (demo root) — the OS credential store is not used";

function doctorPrintVaultCheck(demo: boolean): number {
  if (demo) {
    console.log(DEMO_VAULT_LINE);
    return 0;
  }
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

/** Mirrors `LOW_CONFIDENCE_THRESHOLD` in `gateway/src/db/index-health.ts`. */
export const DOCTOR_LOW_CONFIDENCE_THRESHOLD = 60;

/**
 * Report the index quality score, so a user getting weak answers learns the index is why.
 *
 * Three deliberate silences, each the same rule the embedding check follows one function down —
 * a false verdict is worse than no line:
 *
 *  - **No field at all** → say nothing. A gateway predating `index.health` cannot be asked, and
 *    inventing either a green or a red about it would be a claim we cannot support.
 *  - **`confidence: null`** → say the index is empty, do NOT warn. `doctorPrintIndexFromSnapshot`
 *    already warned about zero items; a second `[warn]` for one condition is noise, and rendering
 *    the null as `0/100` would tell a fresh install its index scores zero out of a hundred.
 *  - **Exactly at the threshold** → OK. The spec says "below 60", so 60 passes.
 */
export function doctorPrintIndexConfidence(health: {
  confidence?: unknown;
  confidenceUnavailableReason?: unknown;
}): number {
  const c = health.confidence;
  if (c === null && health.confidenceUnavailableReason === "empty_index") {
    console.log("[ok] Index confidence: n/a (index is empty — nothing to score yet).");
    return 0;
  }
  if (typeof c !== "number" || !Number.isFinite(c)) return 0;
  const score = Math.max(0, Math.min(100, Math.round(c)));
  if (score < DOCTOR_LOW_CONFIDENCE_THRESHOLD) {
    console.log(
      `[warn] Index confidence: ${String(score)}/100 — weak query results are likely. ` +
        `Run \`nimbus index health\` for the per-connector breakdown.`,
    );
    return 1;
  }
  console.log(`[ok] Index confidence: ${String(score)}/100.`);
  return 0;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** The newest pushed brief's ChatOps skip reason when it was "no notify channels", else undefined. */
function noNotifyChannelsReason(newest: unknown): string | undefined {
  const chatops = asRecord(asRecord(asRecord(newest)?.["delivery"])?.["chatops"]);
  const reason = chatops?.["reason"];
  return chatops?.["outcome"] === "skipped" &&
    typeof reason === "string" &&
    reason.endsWith("has no notify channels")
    ? reason
    : undefined;
}

/**
 * Spec § 4: push enabled but no identity selects nothing — say so rather than stay silent. Also
 * the ChatOps sink (oncall-push PR 2): a configured namespace that cannot post is otherwise
 * visible only in `nimbus oncall pushed --json`. Two checks, because they fail differently:
 * ChatOps not running is known up front (`chatops.posting`), while a namespace with no policy
 * `notify` channels is only learned when a post resolves to zero channels, so it is read off the
 * newest pushed brief's `delivery.chatops`. An unset namespace is the intended "no chat sink"
 * configuration and is never warned about.
 */
export function doctorPrintOncallPush(
  r: { enabled?: unknown; identity?: unknown; chatops?: unknown },
  newest?: unknown,
): number {
  if (r.enabled !== true) return 0;
  let exit = 0;
  if (r.identity === "unresolved") {
    console.log(
      "[warn] On-call push is enabled but your identity is unresolved, so no incident can be selected. " +
        "Set [user] me_person_id in nimbus.toml or `git config user.email`.",
    );
    exit = 1;
  }
  const chatops = asRecord(r.chatops);
  const namespace = typeof chatops?.["namespace"] === "string" ? chatops["namespace"] : undefined;
  if (namespace !== undefined && chatops?.["posting"] === false) {
    console.log(
      `[warn] On-call push names the ChatOps namespace "${namespace}", but ChatOps is not running, ` +
        "so pushed briefs are not posted to its channels. Enable [chatops] in nimbus.toml, or clear " +
        "[oncall.push] chatops_namespace.",
    );
    exit = 1;
  }
  const skipped = noNotifyChannelsReason(newest);
  if (skipped !== undefined) {
    console.log(
      `[warn] The newest pushed brief was not posted to ChatOps: ${skipped}. Add notify channels ` +
        'for that namespace in the org policy ([policy.chatops.channel."<id>"] notify).',
    );
    exit = 1;
  }
  if (exit === 0) {
    console.log(
      namespace === undefined
        ? "[ok] On-call push: enabled."
        : `[ok] On-call push: enabled, posting to ChatOps namespace "${namespace}".`,
    );
  }
  return exit;
}

/**
 * Report the embedding runtime, so a dead semantic search cannot stay silent.
 *
 * The gap this closes: the gateway KNEW the capability was off and never said so. A real gateway
 * logged `embeddings: "unavailable"` across 397 consecutive heartbeats while `nimbus doctor`
 * reported nothing — this file had zero mentions of "embedding". That is the same blind spot
 * #925 closed for the Vault, one subsystem over, and it is why the onnxruntime failure (#1396)
 * went unnoticed for so long.
 *
 * Severity follows the state's own documented lifetime in `embedding-readiness.ts`:
 * `warming` is TRANSIENT so it warns rather than fails (a cold first run would otherwise always
 * look broken), and `disabled` is BY DESIGN so it passes — reporting a deliberate setting as a
 * fault is how a check trains people to ignore it.
 *
 * `reason` is the payload that matters. "unavailable" alone is what the log already said and what
 * nobody could act on.
 */
/** A non-empty string field, or null. An empty string carries no more detail than an absent one. */
function detailField(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** ` (detail)`, or "" — so no message body has to nest a template literal to stay optional. */
function parenSuffix(detail: string | null): string {
  return detail === null ? "" : ` (${detail})`;
}

/** `: detail`, or "" — the same, for the messages that read as a continuation. */
function colonSuffix(detail: string | null): string {
  return detail === null ? "" : `: ${detail}`;
}

/** How long the embedder has been warming, as `"12s"` — null when no finite elapsed time. */
function warmingElapsed(rec: Record<string, unknown>): string | null {
  const ms = rec["elapsedMs"];
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return `${String(Math.max(0, Math.round(ms / 1000)))}s`;
}

export function doctorPrintEmbeddingFromSnapshot(snap: { embedding?: unknown }): number {
  const emb = snap.embedding;
  // A gateway that predates this field says nothing about embeddings. Stay silent rather than
  // invent a verdict about a capability we cannot observe — a false green is worse than no line.
  if (emb === null || typeof emb !== "object") {
    return 0;
  }
  const rec = emb as Record<string, unknown>;
  const state = typeof rec["state"] === "string" ? rec["state"] : "";
  const reason = detailField(rec, "reason");

  switch (state) {
    case "ready":
      console.log(`[ok] Embeddings: ready${parenSuffix(detailField(rec, "model"))}.`);
      return 0;
    case "disabled":
      console.log(
        `[ok] Embeddings: disabled by configuration — semantic search is off by design${parenSuffix(reason)}.`,
      );
      return 0;
    case "warming":
      console.log(
        `[warn] Embeddings: still loading${parenSuffix(warmingElapsed(rec))} — semantic search is not available yet.`,
      );
      return 1;
    case "unavailable":
      console.log(
        `[fail] Embeddings: unavailable — semantic search is disabled for this gateway run${colonSuffix(reason)}`,
      );
      return 2;
    default:
      // An unrecognised state is not evidence of health. Fail loudly rather than pass by default.
      console.log(
        `[fail] Embeddings: unrecognised runtime state ${JSON.stringify(state)} — treat as not working.`,
      );
      return 2;
  }
}

/**
 * Whether sqlite-vec is loaded, and — when it is not — WHY, in one actionable line.
 *
 * This exists because for five weeks nobody had it. sqlite-vec has never loaded on macOS
 * (issue #1029), and the only record of the failure was a `log.debug` call on a logger built at
 * `NIMBUS_LOG_LEVEL ?? "info"` — suppressed by default. The product silently had no vector search,
 * no hybrid ranking and no session-memory recall, and the diagnostic command that exists to answer
 * "why is this not working" said nothing at all.
 *
 * SCOPE: this reports the GATEWAY's own connection — `diag.snapshot` is served from the main realm
 * only. A Worker realm that hits `no-extensions` or `unverified` warns to the gateway log and never
 * appears here, so a green line means the main connection is fine, not that every realm is. Those
 * two messages accordingly point at the log rather than at this command.
 *
 * `[fail]`, not `[warn]`: on the exit-code scale this file already uses, a warn means degraded and
 * a fail means a capability is off. Semantic search being absent is the second, and it is the same
 * severity the sibling "Embeddings: unavailable" line already carries for the other half of the
 * same feature. Silent on a gateway too old to serve the field, for the reason stated on
 * {@link doctorPrintEmbeddingFromSnapshot}: no verdict beats a false green.
 */
export function doctorPrintVectorSearchFromSnapshot(snap: { vectorSearch?: unknown }): number {
  const vec = snap.vectorSearch;
  if (vec === null || typeof vec !== "object") {
    return 0;
  }
  const rec = vec as Record<string, unknown>;
  const sqliteDetail = detailField(rec, "sqliteRuntimeDetail");
  if (rec["loaded"] === true) {
    // On macOS the extension loads only into a full SQLite the PAL installed, and that library can
    // come from more than one place (the bundled copy beside the binary, NIMBUS_SQLITE_PATH, or a
    // Homebrew install). Say WHICH, so a green line can be traced to the library that earned it.
    // Only for `installed`: every other state's detail explains a problem, not a source.
    const source = rec["sqliteRuntimeState"] === "installed" ? sqliteDetail : null;
    console.log(`[ok] Vector search: sqlite-vec loaded${parenSuffix(source)}.`);
    return 0;
  }
  // The upstream package's message names the failure; the PAL's detail names the CAUSE and the
  // remedy on the one platform where there is one. Both, because either alone has been the thing
  // that made this hard to read: the upstream message alone says "loadExtension failed" and
  // explains nothing.
  const why = [detailField(rec, "upstreamError"), sqliteDetail]
    .filter((x) => x !== null)
    .join("; ");
  console.log(
    "[fail] Vector search: sqlite-vec is NOT loaded — semantic search, hybrid ranking and " +
      `session-memory recall are unavailable; keyword search still works${colonSuffix(why === "" ? null : why)}`,
  );
  // Per state, because the remedies are genuinely different and a wrong one wastes the reader's
  // time: `not-found` is the user's to fix, `no-extensions` is ours.
  const runtimeState = rec["sqliteRuntimeState"];
  if (runtimeState === "not-found") {
    console.log(
      "       Fix: `brew install sqlite`, then restart the gateway. (Bun links Apple's system " +
        "SQLite on macOS, which has extension loading compiled out; set NIMBUS_SQLITE_PATH to " +
        "point at a different libsqlite3.dylib.)",
    );
  } else if (runtimeState === "no-extensions") {
    console.log(
      "       Fix: restart the gateway. A database was opened before the SQLite install ran, " +
        "which is a Nimbus bug — please report it with this output.",
    );
  }
  return 2;
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

/**
 * OS notifications (pre-S3 item E): `[info]` when off by the owner's choice, `[warn]` when they
 * should work and do not (see `doctorNotificationsLine`). Tolerant of an older gateway that does not
 * serve `notifications.status` (-32601) — doctor stays quiet rather than failing. Any OTHER RPC
 * failure is a `[warn]`: the check did not complete, and reading that as healthy would be a false
 * all-clear. A malformed response is reported, not thrown, so one bad line cannot hide the rest of
 * the sweep.
 */
export async function doctorPrintNotifications(client: Pick<IPCClient, "call">): Promise<number> {
  let raw: unknown;
  try {
    raw = await client.call<unknown>("notifications.status", {});
  } catch (e) {
    if (isMethodNotFound(e)) return 0;
    console.log(
      `[warn] Notifications: status check failed (${e instanceof Error ? e.message : String(e)}).`,
    );
    return 1;
  }
  try {
    const { line, exit } = doctorNotificationsLine(parseNotificationsStatus(raw));
    console.log(line);
    return exit;
  } catch (e) {
    console.log(`[warn] Notifications: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** JSON-RPC -32601: the gateway does not serve the method (an older binary). */
function isMethodNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === -32601;
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
    embedding?: unknown;
    vectorSearch?: unknown;
  }>("diag.snapshot", {});
  exit = Math.max(exit, doctorPrintIndexFromSnapshot(snap));
  // A second call rather than a field on `diag.snapshot`: the health report is several GROUP BY
  // scans over `item`, and `diag.snapshot` is polled by the desktop. Paying that cost on every
  // poll to serve one line in `doctor` would be the wrong trade. Tolerant of a gateway that does
  // not serve the method at all — an older binary answers -32601 and doctor stays quiet.
  const health = await client
    .call<{ confidence?: unknown; confidenceUnavailableReason?: unknown }>("index.health", {})
    .catch(() => ({}) as { confidence?: unknown; confidenceUnavailableReason?: unknown });
  exit = Math.max(exit, doctorPrintIndexConfidence(health));
  const push = await client
    .call<{ enabled?: unknown; identity?: unknown; chatops?: unknown }>("oncall.pushedList", {
      limit: 1,
    })
    .catch(() => ({}) as { enabled?: unknown; identity?: unknown; chatops?: unknown });
  // The newest brief's `delivery.chatops` is the only place a zero-channel namespace shows up.
  // Fetched only when push is on; an older gateway (or none yet) yields undefined, which is quiet.
  const newest =
    push.enabled === true
      ? await client
          .call<{ brief?: unknown }>("oncall.pushedGet", {})
          .then((g) => g.brief)
          .catch(() => undefined)
      : undefined;
  exit = Math.max(exit, doctorPrintOncallPush(push, newest));
  exit = Math.max(exit, await doctorPrintNotifications(client));
  // Reported BEFORE connector health: a dead embedding runtime disables semantic search for the
  // whole gateway run, which outranks any one connector being unreachable.
  exit = Math.max(exit, doctorPrintEmbeddingFromSnapshot(snap));
  // Immediately after embeddings and before connector health, for the same reason: embeddings and
  // sqlite-vec are the two halves of semantic search, and either one missing disables it for the
  // whole gateway run — which outranks any single connector being unreachable.
  exit = Math.max(exit, doctorPrintVectorSearchFromSnapshot(snap));
  exit = Math.max(exit, doctorPrintHealthFromSnapshot(snap));
  return exit;
}

/** Printed instead of running `--fix-keyring` in the demo root (I41 clause 3). */
export const DEMO_FIX_KEYRING_REFUSAL =
  "Refusing --fix-keyring in the demo: the demo uses an in-memory vault, not the OS keyring. " +
  "Run `nimbus doctor --fix-keyring` without --demo to repair the real keyring.";

export async function runDoctor(args: string[], deps: DoctorCoreDeps): Promise<void> {
  // Resolved FIRST, before any branch: `--fix-keyring` must know whether this is the demo root,
  // and that is decided by the resolved paths' `demo` field — never the env var.
  const paths = deps.getCliPlatformPaths();

  // Strictly opt-in: a plain `nimbus doctor` never touches `fixKeyringDeps` and
  // stays read-only. Only an explicit `--fix-keyring` runs the fixer, and it
  // replaces the normal diagnostic sweep rather than running alongside it.
  if (args.includes("--fix-keyring")) {
    // The fixer acts on the HOST keyring (Linux libsecret/D-Bus), which is not under any demo
    // root: a demo gateway's vault is the in-process EphemeralVault (I41 clause 3), so there is
    // nothing demo-side to repair and everything real to damage. Refused, dry run included, so
    // the demo never even probes the real keyring.
    if (paths.demo === true) {
      console.error(DEMO_FIX_KEYRING_REFUSAL);
      process.exitCode = 1;
      return;
    }
    const dryRun = args.includes("--dry-run");
    const result = runFixKeyringCommand(platform(), deps.fixKeyringDeps, { dryRun });
    for (const line of result.lines) {
      console.log(line);
    }
    process.exitCode = result.exit;
    return;
  }

  let exit = 0;
  exit = Math.max(exit, doctorPrintBunCheck());

  console.log(`Data dir: ${paths.dataDir}`);
  console.log(`Gateway state file: ${deps.gatewayStatePath(paths)}`);

  exit = Math.max(exit, doctorPrintVaultCheck(paths.demo === true));

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
    console.log(
      `[fail] Gateway: not running (no gateway.json — start with: ${gatewayStartCommand(paths.demo === true)}).`,
    );
    exit = Math.max(exit, 2);
  } else {
    console.log(
      `[fail] Gateway: stale state (pid ${String(state.pid)} is not running) — try ${nimbusCommand("stop", paths.demo === true)} or remove the state file.`,
    );
    exit = Math.max(exit, 2);
  }

  process.exitCode = exit;
}
