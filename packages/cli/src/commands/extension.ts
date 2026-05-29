import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { confirm, isCancel } from "@clack/prompts";

import { decodeBase64, encodeBase64, generateEd25519Keypair, signManifest } from "@nimbus-dev/sdk";

import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
import {
  formatNetworkIsolationLine,
  type SandboxPlatformCapabilities,
} from "./extension-sandbox-format.ts";
import { type InstalledExtensionForTree, renderTree } from "./extension-tree.ts";

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function takeFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

export function stripFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes" || a === "-y" || a === "--json") continue;
    if (a === "--filter" || a === "--publisher-key") {
      i += 1;
      continue;
    }
    out.push(a as string);
  }
  return out;
}

type ExtensionListEntry = {
  id: string;
  version: string;
  enabled?: number;
  needs_reinstall?: boolean;
  disabled_reason?: string;
  publisher?: { id: string; key?: string };
  forwardDeps?: Array<{ id: string; range: string }>;
  reverseDeps?: Array<{ extensionId: string; range: string }>;
};

export interface ExtensionListTableRow {
  id: string;
  version: string;
  enabled: number | boolean;
  publisher?: { id: string; key?: string };
}

export function formatExtensionListTable(
  rows: readonly ExtensionListTableRow[],
  opts: { isTty: boolean; noColor: boolean },
): string {
  const headers = ["ID", "Version", "Publisher", "Status"];
  const data = rows.map((r) => [
    r.id,
    r.version,
    r.publisher !== undefined ? r.publisher.id : "(unverified)",
    (typeof r.enabled === "number" ? r.enabled === 1 : r.enabled) ? "enabled" : "disabled",
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => (row[i] ?? "").length)),
  );
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
  const renderCell = (s: string, w: number, col: number): string => {
    const padded = pad(s, w);
    if (!opts.isTty || opts.noColor) return padded;
    if (col === 2 && s === "(unverified)") return `\x1b[2;33m${padded}\x1b[0m`;
    return padded;
  };
  const lines: string[] = [];
  lines.push(headers.map((h, i) => pad(h, widths[i] ?? 0)).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of data) {
    lines.push(row.map((c, i) => renderCell(c, widths[i] ?? 0, i)).join("  "));
  }
  return `${lines.join("\n")}\n`;
}

export async function runExtensionList(client: IPCClient, args: string[]): Promise<void> {
  const filter = takeFlagValue(args, "--filter");
  const json = hasFlag(args, "--json");
  const tree = hasFlag(args, "--tree");
  const params: Record<string, unknown> = {};
  if (filter !== undefined) params["filter"] = filter;
  const out = await client.call<{ extensions: ExtensionListEntry[] }>("extension.list", params);
  if (json) {
    console.log(JSON.stringify(out, undefined, 2));
    return;
  }
  const rows = out.extensions;
  if (rows.length === 0) {
    console.log("(no extensions installed)");
    return;
  }

  if (tree) {
    const installed: InstalledExtensionForTree[] = [];
    for (const r of rows) {
      try {
        const info = await client.call<{
          extension: { forwardDeps?: Array<{ id: string; range: string }> };
        }>("extension.info", { id: r.id });
        installed.push({
          id: r.id,
          version: r.version,
          forwardDeps: info.extension.forwardDeps ?? [],
        });
      } catch {
        installed.push({ id: r.id, version: r.version, forwardDeps: [] });
      }
    }
    console.log(renderTree(installed));
    return;
  }

  const noColorEnv = process.env["NO_COLOR"];
  const noColor = noColorEnv !== undefined && noColorEnv !== "";
  const isTty = process.stdout.isTTY === true;
  const tableRows: ExtensionListTableRow[] = rows.map((r) => {
    const enabled = r.enabled ?? 1;
    const base: ExtensionListTableRow = { id: r.id, version: r.version, enabled };
    if (r.publisher !== undefined) base.publisher = r.publisher;
    return base;
  });
  const table = formatExtensionListTable(tableRows, { isTty, noColor });
  console.log(table.replace(/\n$/, ""));
  for (const r of rows) {
    if (r.needs_reinstall === true) {
      console.log(`  ${r.id}@${r.version} [needs-reinstall]`);
    }
  }
}

type DiagSnapshotResult = {
  sandbox?: {
    platform_capabilities?: SandboxPlatformCapabilities;
  };
};

export async function fetchSandboxPosture(
  client: IPCClient,
): Promise<SandboxPlatformCapabilities | null> {
  try {
    const snap = await client.call<DiagSnapshotResult>("diag.snapshot", {});
    return snap.sandbox?.platform_capabilities ?? null;
  } catch {
    return null;
  }
}

export function formatExtensionInfoHuman(info: {
  id: string;
  version: string;
  publisher?: { id: string; key: string };
}): string {
  const lines: string[] = [`ID:        ${info.id}`, `Version:   ${info.version}`];
  if (info.publisher !== undefined) {
    const shortKey = `${info.publisher.key.slice(0, 16)}…`;
    lines.push(`Publisher: ${info.publisher.id}`, `  key:     ${shortKey}`);
  } else {
    lines.push(`Publisher: (unverified)`);
  }
  return `${lines.join("\n")}\n`;
}

function printExtensionInfoPublisher(e: ExtensionListEntry): void {
  if (e.publisher !== undefined && typeof e.publisher.key === "string") {
    const shortKey = `${e.publisher.key.slice(0, 16)}…`;
    console.log(`Publisher: ${e.publisher.id}`);
    console.log(`  key:     ${shortKey}`);
  } else {
    console.log("Publisher: (unverified)");
  }
}

function printExtensionInfoDeps(e: ExtensionListEntry): void {
  const fwd = e.forwardDeps ?? [];
  const rev = e.reverseDeps ?? [];
  if (fwd.length === 0 && rev.length === 0) {
    console.log("\nDependencies: (none)");
    return;
  }
  console.log("\nDependencies:");
  if (fwd.length > 0) {
    console.log("  Forward (this extension requires):");
    for (const f of [...fwd].sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`    ${f.id}  ${f.range}`);
    }
  }
  if (rev.length > 0) {
    console.log("  Reverse (required by):");
    for (const r of [...rev].sort((a, b) => a.extensionId.localeCompare(b.extensionId))) {
      console.log(`    ${r.extensionId}  ${r.range}`);
    }
  }
}

export async function runExtensionInfo(
  client: IPCClient,
  rest: string[],
  args: string[],
): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension info <id> [--json]");
  }
  const out = await client.call<{
    extension: ExtensionListEntry;
    message?: string;
  }>("extension.info", { id });
  const sandboxCap = await fetchSandboxPosture(client);
  if (hasFlag(args, "--json")) {
    console.log(
      JSON.stringify(
        { ...out, sandbox: sandboxCap === null ? null : { platform_capabilities: sandboxCap } },
        undefined,
        2,
      ),
    );
    return;
  }
  const e = out.extension;
  console.log(`Extension: ${e.id}`);
  console.log(`Version:   ${e.version}`);
  console.log(`Enabled:   ${e.enabled === 1 ? "yes" : "no"}`);
  printExtensionInfoPublisher(e);
  console.log(formatNetworkIsolationLine(sandboxCap));
  console.log("  See: docs/sandbox.md#platform-asymmetry");
  if (e.needs_reinstall === true && out.message !== undefined) {
    console.log("");
    console.log(out.message);
  }
  if (hasFlag(args, "--deps")) {
    printExtensionInfoDeps(e);
  }
}

export async function runExtensionInstall(
  client: IPCClient,
  args: string[],
  rest: string[],
): Promise<void> {
  const sourceRaw = rest[0]?.trim() ?? "";
  if (sourceRaw === "") {
    throw new Error("Usage: nimbus extension install <path> [--yes]");
  }
  const accept = hasFlag(args, "--yes") || hasFlag(args, "-y");
  if (!accept) {
    if (process.stdout.isTTY !== true) {
      throw new Error(
        "Refusing to install without confirmation in non-TTY mode. Pass --yes to proceed.",
      );
    }
    const ok = await confirm({
      message:
        "Install copies the extension into your Nimbus extensions directory. Only proceed if you trust this code.",
    });
    if (isCancel(ok) || ok !== true) {
      console.log("Cancelled.");
      return;
    }
  }
  const sourcePath = resolve(process.cwd(), sourceRaw);
  const publisherKeyPath = takeFlagValue(args, "--publisher-key");
  const installParams: Record<string, unknown> = { sourcePath };
  if (publisherKeyPath !== undefined && publisherKeyPath !== "") {
    installParams["publisherKeyPath"] = publisherKeyPath;
  }
  const out = await client.call<{
    id: string;
    version: string;
    installPath: string;
  }>("extension.install", installParams);
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runExtensionEnable(client: IPCClient, rest: string[]): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension enable <id>");
  }
  const out = await client.call<{ ok: boolean }>("extension.enable", { id });
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runExtensionDisable(client: IPCClient, rest: string[]): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension disable <id>");
  }
  const out = await client.call<{ ok: boolean }>("extension.disable", { id });
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runExtensionRemove(
  client: IPCClient,
  args: string[],
  rest: string[],
): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension remove <id> [--yes] [--force]");
  }
  const accept = hasFlag(args, "--yes") || hasFlag(args, "-y");
  const force = hasFlag(args, "--force");

  if (force) {
    process.stderr.write(
      "--force: will remove even if other installed extensions depend on this.\n",
    );
  }

  if (!accept) {
    if (process.stdout.isTTY !== true) {
      throw new Error(
        "Refusing to remove without confirmation in non-TTY mode. Pass --yes to proceed.",
      );
    }
    const ok = await confirm({
      message: `Remove extension "${id}" from the registry and delete its files?`,
    });
    if (isCancel(ok) || ok !== true) {
      console.log("Cancelled.");
      return;
    }
  }

  let out: { ok: boolean };
  const payload: { id: string; force?: true } = force ? { id, force: true } : { id };
  try {
    out = await client.call<{ ok: boolean }>("extension.remove", payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("reverse_dep_blocked")) {
      process.stderr.write(`${msg}\nRe-run with --force to override.\n`);
      process.exit(1);
    }
    throw e;
  }
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runExtensionKeygen(args: string[]): Promise<number> {
  const outIdx = args.indexOf("--out");
  const force = args.includes("--force");
  let outPath = join(homedir(), ".nimbus", "publisher-key");
  if (outIdx >= 0 && outIdx + 1 < args.length) {
    const candidate = args[outIdx + 1];
    if (candidate !== undefined) outPath = candidate;
  }
  const { privkey, pubkey } = generateEd25519Keypair();
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    writeFileSync(outPath, `${encodeBase64(privkey)}\n`, {
      flag: force ? "w" : "wx",
      mode: 0o600,
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      process.stderr.write(`refusing to overwrite ${outPath} without --force\n`);
      return 2;
    }
    throw e;
  }
  if (process.platform !== "win32") chmodSync(outPath, 0o600);
  process.stdout.write(`${encodeBase64(pubkey)}\n`);
  return 0;
}

export async function runExtensionSign(args: string[]): Promise<number> {
  const extDir = args[0];
  if (extDir === undefined || extDir.startsWith("--")) {
    process.stderr.write("usage: nimbus extension sign <ext-dir> [--key <path>]\n");
    return 2;
  }
  const keyIdx = args.indexOf("--key");
  let keyPath = join(homedir(), ".nimbus", "publisher-key");
  if (keyIdx >= 0 && keyIdx + 1 < args.length) {
    const candidate = args[keyIdx + 1];
    if (candidate !== undefined) keyPath = candidate;
  }
  let priv: Uint8Array;
  try {
    priv = decodeBase64(readFileSync(keyPath, "utf8").trim());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`could not read key file ${keyPath}: ${msg}\n`);
    return 2;
  }
  if (priv.length !== 32) {
    process.stderr.write(`key file ${keyPath} did not decode to 32 bytes\n`);
    return 2;
  }
  const manifestPath = join(extDir, "nimbus.extension.json");
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`could not read manifest ${manifestPath}: ${msg}\n`);
    return 2;
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  delete parsed["signature"];
  const sig = await signManifest(parsed, priv);
  writeFileSync(manifestPath, JSON.stringify({ ...parsed, signature: sig }, null, 2));
  return 0;
}

export type SyncResult = {
  publishersChecked: number;
  publishersUnchanged: number;
  publishersUpdated: { id: string; reverifyResult: "ok" | "failed"; failedExtensions: string[] }[];
  publishersEvicted: string[];
  failures: { id: string; reason: string }[];
};

export type SyncIpcCaller = (params: Record<string, unknown>) => Promise<SyncResult>;

export interface RunExtensionSyncOpts {
  args: string[];
  caller: SyncIpcCaller;
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
}

function printSyncResultHuman(result: SyncResult, opts: RunExtensionSyncOpts): void {
  opts.writeStdout(`publishers checked: ${String(result.publishersChecked)}\n`);
  opts.writeStdout(`unchanged:          ${String(result.publishersUnchanged)}\n`);
  opts.writeStdout(`updated:            ${String(result.publishersUpdated.length)}\n`);
  opts.writeStdout(`evicted:            ${String(result.publishersEvicted.length)}\n`);
  opts.writeStdout(`failed:             ${String(result.failures.length)}\n`);
  for (const u of result.publishersUpdated) {
    if (u.reverifyResult === "failed") {
      opts.writeStderr(
        `publisher ${u.id} rotated keys; ${String(u.failedExtensions.length)} extension(s) failed re-verify: ${u.failedExtensions.join(", ")}\n`,
      );
    }
  }
  for (const f of result.failures) {
    opts.writeStderr(
      `publisher ${f.id} unreachable (${f.reason}); cached key (if present) remains in use; re-run \`nimbus extension sync\` later, or reinstall affected extensions with \`--publisher-key <path>\` if you have a fresh key locally\n`,
    );
  }
}

function syncResultExitCode(result: SyncResult): number {
  if (result.publishersUpdated.some((u) => u.reverifyResult === "failed")) return 2;
  if (result.publishersChecked > 0 && result.failures.length === result.publishersChecked) return 4;
  return 0;
}

export async function runExtensionSyncWithCaller(opts: RunExtensionSyncOpts): Promise<number> {
  const dryRun = opts.args.includes("--dry-run");
  const json = opts.args.includes("--json");
  let result: SyncResult;
  try {
    result = await opts.caller({ dryRun });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.writeStderr(`${msg}\n`);
    return /air-gap/i.test(msg) ? 3 : 1;
  }
  if (json) {
    opts.writeStdout(`${JSON.stringify(result)}\n`);
  } else {
    printSyncResultHuman(result, opts);
  }
  return syncResultExitCode(result);
}

export async function runExtensionSync(client: IPCClient, args: string[]): Promise<number> {
  return runExtensionSyncWithCaller({
    args,
    caller: async (params) => (await client.call("extension.sync", params)) as SyncResult,
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
  });
}

const EXTENSION_USAGE =
  "Usage: nimbus extension list [--filter needs-reinstall] [--tree] [--json] | info <id> [--deps] [--json] | install <path> [--yes] | enable <id> | disable <id> | remove <id> [--yes] [--force] | sync [--dry-run] [--json] | update [<id>] [--check] [--to <version>] [--json] | downgrade <id> [--json]";

async function runExtensionOffline(sub: string, rest: string[]): Promise<boolean> {
  if (sub === "keygen") {
    const code = await runExtensionKeygen(rest);
    if (code !== 0) process.exit(code);
    return true;
  }
  if (sub === "sign") {
    const code = await runExtensionSign(rest);
    if (code !== 0) process.exit(code);
    return true;
  }
  return false;
}

async function dispatchExtensionWithCode(
  sub: string,
  client: IPCClient,
  args: string[],
): Promise<boolean> {
  const handlers: Record<string, () => Promise<number>> = {
    sync: () => runExtensionSync(client, args),
    update: () => runExtensionUpdate(client, args),
    downgrade: () => runExtensionDowngrade(client, args),
  };
  const handler = handlers[sub];
  if (handler === undefined) return false;
  const code = await handler();
  if (code !== 0) process.exit(code);
  return true;
}

async function dispatchExtensionVoid(
  sub: string,
  client: IPCClient,
  args: string[],
  rest: string[],
): Promise<boolean> {
  switch (sub) {
    case "list":
    case "":
      await runExtensionList(client, args);
      return true;
    case "info":
      await runExtensionInfo(client, rest, args);
      return true;
    case "install":
      await runExtensionInstall(client, args, rest);
      return true;
    case "enable":
      await runExtensionEnable(client, rest);
      return true;
    case "disable":
      await runExtensionDisable(client, rest);
      return true;
    case "remove":
      await runExtensionRemove(client, args, rest);
      return true;
    default:
      return false;
  }
}

export async function runExtension(args: string[]): Promise<void> {
  const sub = args[0]?.trim() ?? "";
  const rest = stripFlags(args.slice(1));

  if (await runExtensionOffline(sub, rest)) {
    return;
  }

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error("Gateway is not running. Start with: nimbus start");
  }

  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    if (await dispatchExtensionVoid(sub, client, args, rest)) {
      return;
    }
    if (await dispatchExtensionWithCode(sub, client, args)) {
      return;
    }
    throw new Error(EXTENSION_USAGE);
  } finally {
    await client.disconnect();
  }
}

export interface AvailableUpdateCli {
  readonly id: string;
  readonly displayName: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly channel: "stable" | "beta";
  readonly publisherStatus: "verified" | "unverified";
  readonly verificationStatus: "verified" | "needs_sync" | "signature_failed";
}

export interface UpdateApplyResultCli {
  readonly applied: boolean;
  readonly reason?: string;
  readonly hint?: string;
  readonly jobId?: string;
}

export type AutoUpdateIpcCaller = (
  method: "extension.checkForUpdates" | "extension.update",
  params: Record<string, unknown>,
) => Promise<unknown>;

export interface RunExtensionUpdateOpts {
  args: string[];
  caller: AutoUpdateIpcCaller;
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
}

function formatUpdateRow(u: AvailableUpdateCli): string {
  return `${u.id}\t${u.fromVersion} → ${u.toVersion}\t[${u.channel}]\t${u.publisherStatus}\t${u.verificationStatus}`;
}

async function listExtensionUpdates(
  opts: RunExtensionUpdateOpts,
  isJson: boolean,
  isCheck: boolean,
): Promise<number> {
  const list = (await opts.caller("extension.checkForUpdates", {
    ...(isCheck ? { force: true } : {}),
  })) as AvailableUpdateCli[];
  if (isJson) {
    opts.writeStdout(`${JSON.stringify(list, undefined, 2)}\n`);
    return 0;
  }
  if (list.length === 0) {
    opts.writeStdout("No updates available.\n");
    return 0;
  }
  for (const u of list) opts.writeStdout(`${formatUpdateRow(u)}\n`);
  return 0;
}

async function applyExtensionUpdate(
  opts: RunExtensionUpdateOpts,
  id: string,
  toVersion: string | undefined,
  isJson: boolean,
): Promise<number> {
  const list = (await opts.caller("extension.checkForUpdates", {})) as AvailableUpdateCli[];
  const entry = list.find((e) => e.id === id);
  if (entry === undefined) {
    opts.writeStderr(
      `no cached update for ${id} — run \`nimbus extension update --check\` first\n`,
    );
    return 1;
  }
  const targetVersion = toVersion ?? entry.toVersion;
  const res = (await opts.caller("extension.update", {
    id,
    toVersion: targetVersion,
  })) as UpdateApplyResultCli;

  if (isJson) {
    opts.writeStdout(`${JSON.stringify(res, undefined, 2)}\n`);
    return res.applied ? 0 : 1;
  }
  if (res.applied) {
    const jobIdPart = res.jobId !== undefined ? ` (jobId=${res.jobId})` : "";
    opts.writeStdout(`updated ${id} to ${targetVersion}${jobIdPart}\n`);
    return 0;
  }
  const hintPart = res.hint !== undefined ? `\n  hint: ${res.hint}` : "";
  opts.writeStderr(`update failed: ${res.reason ?? "unknown"}${hintPart}\n`);
  return 1;
}

export async function runExtensionUpdateWithCaller(opts: RunExtensionUpdateOpts): Promise<number> {
  const args = opts.args;
  const isJson = hasFlag(args, "--json");
  const isCheck = hasFlag(args, "--check");
  const toVersion = takeFlagValue(args, "--to");
  const positional = stripFlags(args).filter((a) => !a.startsWith("--"));
  const id = positional[0];

  if (id === undefined) {
    return listExtensionUpdates(opts, isJson, isCheck);
  }
  return applyExtensionUpdate(opts, id, toVersion, isJson);
}

export async function runExtensionUpdate(client: IPCClient, args: string[]): Promise<number> {
  return runExtensionUpdateWithCaller({
    args: args.slice(1), // drop the "update" subcommand token
    caller: async (method, params) => client.call<unknown>(method, params),
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
  });
}

export interface ExtensionInfoForDowngrade {
  readonly extension?: {
    id: string;
    version: string;
  };
}

export interface RunExtensionDowngradeOpts {
  args: string[];
  caller: AutoUpdateIpcCaller;
  fetchInfo: (id: string) => Promise<ExtensionInfoForDowngrade>;
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
}

export async function runExtensionDowngradeWithCaller(
  opts: RunExtensionDowngradeOpts,
): Promise<number> {
  const args = opts.args;
  const isJson = hasFlag(args, "--json");
  const toVersion = takeFlagValue(args, "--to");
  const positional = stripFlags(args).filter((a) => !a.startsWith("--"));
  const id = positional[0];
  if (id === undefined) {
    opts.writeStderr("usage: nimbus extension downgrade <id> --to <version> [--json]\n");
    return 1;
  }
  if (toVersion === undefined) {
    opts.writeStderr(
      `downgrade requires --to <version> (the cached _prev/<v>/ tag to roll back to)\n`,
    );
    return 1;
  }
  const res = (await opts.caller("extension.update", {
    id,
    toVersion,
  })) as UpdateApplyResultCli;

  if (isJson) {
    opts.writeStdout(`${JSON.stringify(res, undefined, 2)}\n`);
    return res.applied ? 0 : 1;
  }
  if (res.applied) {
    opts.writeStdout(`downgraded ${id} to ${toVersion}\n`);
    return 0;
  }
  const hintPart = res.hint !== undefined ? `\n  hint: ${res.hint}` : "";
  opts.writeStderr(`downgrade failed: ${res.reason ?? "unknown"}${hintPart}\n`);
  return 1;
}

export async function runExtensionDowngrade(client: IPCClient, args: string[]): Promise<number> {
  return runExtensionDowngradeWithCaller({
    args: args.slice(1),
    caller: async (method, params) => client.call<unknown>(method, params),
    fetchInfo: async (id) => client.call<ExtensionInfoForDowngrade>("extension.info", { id }),
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
  });
}
