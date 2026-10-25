import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CliExit } from "../lib/cli-exit.ts";
import { gatewayNotRunningMessage } from "../lib/gateway-not-running.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerConsentPromptHandler } from "../lib/interactive-ipc-handlers.ts";
import { BATCH_RPC_TIMEOUT_MS, createIpcClient } from "../lib/rpc-timeouts.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { type CliPlatformPaths, getCliPlatformPaths } from "../paths.ts";

/** The gateway's own cap on a local pack file; checked here too so a huge file is never read. */
const MAX_PACK_FILE_BYTES = 131_072;

const PACK_USAGE = [
  "Usage: nimbus pack <subcommand>",
  "  nimbus pack list [--json]",
  "  nimbus pack show <id> | --file <path> [--json]",
  "  nimbus pack install <id> | --file <path>",
  "  nimbus pack remove <id>",
].join("\n");

// Structural result types of the gateway's `pack.*` methods. Declared here, never imported:
// the CLI reaches the gateway over IPC only.
interface InstalledPackRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: "bundled" | "file";
  readonly updateAvailable: boolean;
  readonly bundledVersion?: string;
  readonly versionUnknown?: boolean;
  /** Optional: an older gateway omits it. */
  readonly roles?: readonly string[];
  /** Optional: an older gateway omits it. */
  readonly suggestedConnectors?: readonly string[];
}
interface AvailablePackRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** Optional: an older gateway omits it. */
  readonly roles?: readonly string[];
  /** Optional: an older gateway omits it. */
  readonly suggestedConnectors?: readonly string[];
  /** Optional: an older gateway omits it. */
  readonly visibleAgents?: readonly string[];
}
interface SkippedPackRow {
  readonly packId: string;
  readonly reason: string;
}
interface PackListResult {
  readonly profile: string;
  readonly installed: readonly InstalledPackRow[];
  readonly available: readonly AvailablePackRow[];
  readonly skipped: readonly SkippedPackRow[];
  readonly listError?: string;
}
interface PackShowResult {
  readonly prompt: string;
  readonly mode: "install" | "update" | "repair" | "already_installed";
  readonly installed?: {
    readonly version: string;
    readonly source: string;
    readonly installedAt: string;
    readonly digest: string;
  };
}
interface PackInstallResult {
  readonly outcome: "installed" | "updated" | "repaired" | "already_installed";
  readonly id: string;
  readonly version: string;
  readonly snapshotVersion: number | null;
}
interface PackRemoveResult {
  readonly removed: boolean;
  readonly snapshotVersion: number | null;
}

export interface PackIo {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readFile(path: string): string;
  statSize(path: string): number;
  out(s: string): void;
  err(s: string): void;
}

type PackCall = <T>(method: string, params: unknown) => Promise<T>;

/** Gateway-sourced text: control characters dropped, but line breaks kept (the prompt is multi-line). */
function clean(s: string): string {
  return s
    .split("\n")
    .map((line) => stripControlChars(line))
    .join("\n");
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The positional id: the first argument that is not a flag or a flag's value. */
function positionalId(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--file") {
      i++;
      continue;
    }
    if (!a.startsWith("-")) return a.trim() === "" ? undefined : a.trim();
  }
  return undefined;
}

type Target =
  | { readonly kind: "id"; readonly params: { id: string } }
  | { readonly kind: "file"; readonly params: { fileText: string; filePath: string } }
  | { readonly kind: "error"; readonly message: string };

function resolveTarget(args: readonly string[], io: PackIo): Target | undefined {
  if (args.includes("--file")) {
    const raw = flagValue(args, "--file");
    if (raw === undefined || raw.startsWith("-")) return undefined;
    const filePath = resolve(raw);
    const size = io.statSize(filePath);
    if (size > MAX_PACK_FILE_BYTES) {
      return {
        kind: "error",
        message: `Pack file is ${String(size)} bytes; the limit is ${String(MAX_PACK_FILE_BYTES)} bytes.`,
      };
    }
    return { kind: "file", params: { fileText: io.readFile(filePath), filePath } };
  }
  const id = positionalId(args);
  return id === undefined ? undefined : { kind: "id", params: { id } };
}

function installedLine(p: InstalledPackRow, skippedReason: string | undefined): string {
  const version = p.versionUnknown === true ? "version unknown" : p.version;
  let update = "";
  if (p.updateAvailable) {
    const target = p.bundledVersion === undefined ? "" : `: ${clean(p.bundledVersion)}`;
    update = `  [update available${target}]`;
  }
  const skipped = skippedReason === undefined ? "" : `  (skipped: ${clean(skippedReason)})`;
  return `  ${clean(p.id)}  ${clean(p.name)}  ${clean(version)}  (${clean(p.source)})${update}${skipped}`;
}

function listLines(r: PackListResult): string[] {
  const lines = [`Profile: ${clean(r.profile)}`, "", "Installed:"];
  if (r.listError !== undefined) {
    lines.push(`  (could not read the installed list: ${clean(r.listError)})`);
  } else if (r.installed.length === 0) {
    lines.push("  (none)");
  }
  const reasons = new Map(r.skipped.map((s) => [s.packId, s.reason]));
  for (const p of r.installed) lines.push(installedLine(p, reasons.get(p.id)));
  lines.push("", "Available:");
  if (r.available.length === 0) lines.push("  (none)");
  for (const p of r.available) {
    lines.push(`  ${clean(p.id)}  ${clean(p.name)}  ${clean(p.version)}  ${clean(p.description)}`);
  }
  if (r.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const s of r.skipped) lines.push(`  ${clean(s.packId)}: ${clean(s.reason)}`);
  }
  // Only when nothing is installed and the list was read: an upgraded install with no pack is told
  // once, here, that packs exist. Never when the installed list could not be read.
  if (r.listError === undefined && r.installed.length === 0 && r.available.length > 0) {
    const offers = r.available.map((p) => `${clean(p.id)} (${clean(p.name)})`).join(", ");
    lines.push("", `Tip: nimbus pack install <id> sets Nimbus up for a role: ${offers}.`);
  }
  return lines;
}

async function doList(args: string[], io: PackIo, call: PackCall): Promise<number> {
  const r = await call<PackListResult>("pack.list", {});
  if (args.includes("--json")) {
    io.out(`${JSON.stringify(r, undefined, 2)}\n`);
    return 0;
  }
  io.out(`${listLines(r).join("\n")}\n`);
  return 0;
}

async function doShow(args: string[], io: PackIo, call: PackCall): Promise<number> {
  const target = resolveTarget(args, io);
  if (target === undefined) {
    io.err(`${PACK_USAGE}\n`);
    return 2;
  }
  if (target.kind === "error") {
    io.err(`${clean(target.message)}\n`);
    return 1;
  }
  const r = await call<PackShowResult>("pack.show", target.params);
  if (args.includes("--json")) {
    io.out(`${JSON.stringify(r, undefined, 2)}\n`);
    return 0;
  }
  io.out(`${clean(r.prompt)}\n`);
  if (r.installed !== undefined) {
    io.out(
      `Installed: version ${clean(r.installed.version)}, source ${clean(r.installed.source)}, installed at ${clean(r.installed.installedAt)}\n`,
    );
  }
  return 0;
}

const OUTCOME_TEXT: Record<PackInstallResult["outcome"], string> = {
  installed: "installed",
  updated: "updated",
  repaired: "repaired",
  already_installed: "already installed",
};

async function doInstall(args: string[], io: PackIo, call: PackCall): Promise<number> {
  if (args.includes("--yes") || args.includes("-y")) {
    io.err(
      "nimbus pack install has no --yes: installing a pack must be answered by a person at a terminal.\n",
    );
    return 1;
  }
  if (!io.stdinIsTty || !io.stdoutIsTty) {
    io.err(
      "Refusing to install a pack in non-TTY mode: the approval must be answered at a terminal.\n",
    );
    return 1;
  }
  const target = resolveTarget(args, io);
  if (target === undefined) {
    io.err(`${PACK_USAGE}\n`);
    return 2;
  }
  if (target.kind === "error") {
    io.err(`${clean(target.message)}\n`);
    return 1;
  }
  const r = await call<PackInstallResult>("pack.install", target.params);
  io.out(
    `${clean(r.id)} ${clean(r.version)}: ${OUTCOME_TEXT[r.outcome] ?? clean(String(r.outcome))}.\n`,
  );
  return 0;
}

async function doRemove(args: string[], io: PackIo, call: PackCall): Promise<number> {
  const id = positionalId(args);
  if (id === undefined) {
    io.err(`${PACK_USAGE}\n`);
    return 2;
  }
  const r = await call<PackRemoveResult>("pack.remove", { id });
  io.out(r.removed ? `${clean(id)}: removed.\n` : `${clean(id)}: not installed.\n`);
  return 0;
}

/** Testable core: returns the process exit code and never touches the real terminal or gateway. */
export async function runPackWith(args: string[], io: PackIo, call: PackCall): Promise<number> {
  const sub = args[0] ?? "";
  const rest = args.slice(1);
  try {
    switch (sub) {
      case "list":
        return await doList(rest, io, call);
      case "show":
        return await doShow(rest, io, call);
      case "install":
        return await doInstall(rest, io, call);
      case "remove":
        return await doRemove(rest, io, call);
      default:
        io.err(`${PACK_USAGE}\n`);
        return 2;
    }
  } catch (e) {
    io.err(`${clean(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

const REAL_IO: PackIo = {
  stdinIsTty: process.stdin.isTTY === true,
  stdoutIsTty: process.stdout.isTTY === true,
  readFile: (path) => readFileSync(path, "utf8"),
  statSize: (path) => statSync(path).size,
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/**
 * Run `fn` against the running gateway on a client whose consent handler is the DIRECT terminal
 * prompt, never an environment-selected script handler, so nothing but a person at this terminal
 * can answer a `pack.install` approval (`withGatewayIpc` binds the script handler first).
 */
export async function withPackClient<T>(
  fn: (call: PackCall) => Promise<T>,
  paths: CliPlatformPaths = getCliPlatformPaths(),
): Promise<T> {
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error(gatewayNotRunningMessage(paths.demo === true));
  }
  const client = createIpcClient(state.socketPath, BATCH_RPC_TIMEOUT_MS);
  await client.connect();
  try {
    // Read-only verbs raise no prompt, so the handler is inert there.
    registerConsentPromptHandler(client);
    return await fn((method, params) => client.call(method, params));
  } finally {
    await client.disconnect();
  }
}

/** `nimbus pack install <id>` in-process (used by `nimbus init`); returns its exit code. */
export function installPackInteractive(id: string, paths?: CliPlatformPaths): Promise<number> {
  return withPackClient((call) => runPackWith(["install", id], REAL_IO, call), paths);
}

export async function runPack(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  if (!["list", "show", "install", "remove"].includes(sub)) {
    REAL_IO.err(`${PACK_USAGE}
`);
    throw new CliExit(2);
  }
  const code = await withPackClient((call) => runPackWith(args, REAL_IO, call));
  if (code !== 0) throw new CliExit(code);
}
