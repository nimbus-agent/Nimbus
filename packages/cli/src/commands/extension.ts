import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import { publicKeyFromSeed, publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import type { IPCClient } from "../ipc-client/index.ts";
import {
  decodeBase64,
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "../lib/extension-signing.ts";
import { gatewayNotRunningMessage } from "../lib/gateway-not-running.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import {
  registerConsentFor,
  registerConsentPromptHandler,
} from "../lib/interactive-ipc-handlers.ts";
import { createIpcClient, INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import {
  assertPipedSecretCanBeApproved,
  defaultSecretInputIo,
  readSecretValue,
  type SecretInputIo,
} from "../lib/secret-input.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { stripControl } from "./captures-format.ts";
import { runExtensionKey } from "./extension-key.ts";
import { runExtensionPublish } from "./extension-publish.ts";
import { runExtensionInfoRemote, runExtensionSearch } from "./extension-registry-cmds.ts";
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
    if (a === "--yes" || a === "-y" || a === "--json" || a === "--model" || a === "--remote") {
      continue;
    }
    if (
      a === "--filter" ||
      a === "--publisher-key" ||
      a === "--registry" ||
      a === "--version" ||
      a === "--channel" ||
      a === "--to" ||
      a === "--accept-publisher-key"
    ) {
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
  signature_disabled?: boolean;
  disabled_reason?: string;
  publisher?: { id: string; key?: string };
  forwardDeps?: Array<{ id: string; range: string }>;
  reverseDeps?: Array<{ extensionId: string; range: string }>;
  runState?: string;
  runGrant?: { serviceId: string; approvedAt: number; modelAccess: boolean } | null;
  source_registry?: string | null;
  /** I48: revocations and takedowns the run grant has not acknowledged. */
  blockedBy?: TrustBlockView[];
};

export type TrustBlockView = {
  statementId: string;
  kind: string;
  issuer: string;
  registry: string | null;
  reason: string;
  issuedAt: string;
};

function blockIssuerPhrase(b: TrustBlockView): string {
  if (b.issuer === "registry") {
    return `the maintainer of registry "${stripControl(b.registry ?? "?")}"`;
  }
  return b.issuer === "nimbus" ? "Nimbus" : "its publisher";
}

/**
 * `nimbus extension info`'s lines for each block (I48). Every value came from a signed statement a
 * third party wrote, so control characters are stripped before it reaches the terminal.
 */
export function formatBlockLines(id: string, blocks: readonly TrustBlockView[]): string[] {
  if (blocks.length === 0) return [];
  const lines = blocks.map((b) => {
    const what = b.kind === "key.revoke" ? "publisher key revoked" : "taken down";
    const by = blockIssuerPhrase(b);
    return `Blocked:   ${what} by ${by} on ${stripControl(b.issuedAt)}: ${stripControl(b.reason)}`;
  });
  lines.push(
    `           It does not run. To run it anyway: nimbus extension approve ${stripControl(id)}`,
  );
  return lines;
}

export interface ExtensionListTableRow {
  id: string;
  version: string;
  enabled: number | boolean;
  publisher?: { id: string; key?: string };
  /**
   * The gateway hard-disabled this extension because its Ed25519 manifest signature did not
   * verify at startup (I16). Deliberately NOT derived from `publisher === undefined`: that is
   * the `(unverified)` badge, which means "declares no publisher" — the normal state of every
   * unsigned extension, and a different fact entirely.
   */
  signatureDisabled?: boolean;
  runState?: string;
  /** The registry the extension was installed from; absent for a local-path install. */
  sourceRegistry?: string;
}

/** One definition, read by the renderer and by the colour rule below. */
const SIGNATURE_DISABLED_STATUS = "disabled (signature)";

export function formatExtensionListTable(
  rows: readonly ExtensionListTableRow[],
  opts: { isTty: boolean; noColor: boolean },
): string {
  const showRun = rows.some((r) => r.runState !== undefined);
  const showSource = rows.some((r) => r.sourceRegistry !== undefined);
  const headers = ["ID", "Version", "Publisher", "Status"];
  if (showRun) headers.push("Run");
  if (showSource) headers.push("Source");
  const data = rows.map((r) => {
    const isEnabled = typeof r.enabled === "number" ? r.enabled === 1 : r.enabled;
    let status: string;
    if (isEnabled) {
      status = "enabled";
    } else {
      status = r.signatureDisabled === true ? SIGNATURE_DISABLED_STATUS : "disabled";
    }
    const cells = [
      r.id,
      r.version,
      r.publisher === undefined ? "(unverified)" : r.publisher.id,
      status,
    ];
    if (showRun) cells.push(r.runState ?? "-");
    if (showSource) cells.push(r.sourceRegistry === undefined ? "-" : `from ${r.sourceRegistry}`);
    return cells;
  });
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => (row[i] ?? "").length)),
  );
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
  const renderCell = (s: string, w: number, col: number): string => {
    const padded = pad(s, w);
    if (!opts.isTty || opts.noColor) return padded;
    if (col === 2 && s === "(unverified)") return `\x1b[2;33m${padded}\x1b[0m`;
    // Bold red, one step louder than `(unverified)`'s dim yellow: an unsigned extension is a
    // normal state, a FAILED signature check is an integrity failure the user should look at.
    if (col === 3 && s === SIGNATURE_DISABLED_STATUS) return `\x1b[1;31m${padded}\x1b[0m`;
    return padded;
  };
  const lines: string[] = [];
  lines.push(
    headers.map((h, i) => pad(h, widths[i] ?? 0)).join("  "),
    widths.map((w) => "-".repeat(w)).join("  "),
  );
  for (const row of data) {
    lines.push(row.map((c, i) => renderCell(c, widths[i] ?? 0, i)).join("  "));
  }
  return `${lines.join("\n")}\n`;
}

/** `nimbus extension info`'s run line: the run state, and the grant behind it when there is one. */
export function formatRunLine(e: Pick<ExtensionListEntry, "runState" | "runGrant">): string | null {
  if (e.runState === undefined) return null;
  if (e.runGrant === undefined || e.runGrant === null) return e.runState;
  const at = new Date(e.runGrant.approvedAt).toISOString();
  const model = e.runGrant.modelAccess ? "yes" : "no";
  return `${e.runState} (${e.runGrant.serviceId}, approved ${at}, model: ${model})`;
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
    // Independent read-only lookups over the one connection, so they are issued together and
    // collected in row order; one that fails still degrades only its own row to a leaf.
    const installed: InstalledExtensionForTree[] = await Promise.all(
      rows.map(async (r) => {
        try {
          const info = await client.call<{
            extension: { forwardDeps?: Array<{ id: string; range: string }> };
          }>("extension.info", { id: r.id });
          return { id: r.id, version: r.version, forwardDeps: info.extension.forwardDeps ?? [] };
        } catch {
          return { id: r.id, version: r.version, forwardDeps: [] };
        }
      }),
    );
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
    if (r.signature_disabled === true) base.signatureDisabled = true;
    if (r.runState !== undefined) base.runState = r.runState;
    if (typeof r.source_registry === "string") base.sourceRegistry = r.source_registry;
    return base;
  });
  const table = formatExtensionListTable(tableRows, { isTty, noColor });
  console.log(table.replace(/\n$/, ""));
  for (const r of rows) {
    if (r.needs_reinstall === true) {
      console.log(`  ${r.id}@${r.version} [needs-reinstall]`);
    } else if (r.signature_disabled === true) {
      // The machine-readable reason only; the remediation prose has one home (the gateway's
      // `signatureDisableMessage`) and `nimbus extension info <id>` is where it is printed.
      console.log(`  ${r.id}@${r.version} [signature: ${r.disabled_reason ?? "unknown"}]`);
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
  if (info.publisher === undefined) {
    lines.push(`Publisher: (unverified)`);
  } else {
    const shortKey = `${info.publisher.key.slice(0, 16)}…`;
    lines.push(`Publisher: ${info.publisher.id}`, `  key:     ${shortKey}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `no` alone cannot tell an owner-disabled extension from one the startup Ed25519 check
 * hard-disabled (I16), so the reason rides on the same line when the gateway supplies one.
 */
export function formatEnabledLine(e: {
  enabled?: number;
  signature_disabled?: boolean;
  disabled_reason?: string;
}): string {
  if (e.enabled === 1) return "yes";
  if (e.signature_disabled !== true) return "no";
  return `no  (signature verification failed: ${e.disabled_reason ?? "unknown"})`;
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
  const registry = takeFlagValue(args, "--registry");
  if (registry !== undefined || hasFlag(args, "--remote")) {
    const code = await runExtensionInfoRemote(id, registry, hasFlag(args, "--json"), {
      client,
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
    });
    if (code !== 0) process.exit(code);
    return;
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
  console.log(`Enabled:   ${formatEnabledLine(e)}`);
  const runLine = formatRunLine(e);
  if (runLine !== null) console.log(`Run:       ${runLine}`);
  for (const line of formatBlockLines(e.id, e.blockedBy ?? [])) console.log(line);
  printExtensionInfoPublisher(e);
  console.log(formatNetworkIsolationLine(sandboxCap));
  console.log("  See: docs/sandbox.md#platform-asymmetry");
  // Any reason the gateway attached — pre-T2 or signature (I16) — is printed verbatim. The
  // condition used to name `needs_reinstall` specifically, which is why a signature failure
  // reached this far and then dropped its own explanation on the floor.
  if (out.message !== undefined) {
    console.log("");
    console.log(out.message);
  }
  if (hasFlag(args, "--deps")) {
    printExtensionInfoDeps(e);
  }
}

/** An argument that can only be a filesystem path, never an extension id. */
function looksLikePath(arg: string): boolean {
  return (
    arg.includes("\\") ||
    /^[A-Za-z]:/.test(arg) ||
    arg.startsWith(".") ||
    arg.startsWith("~") ||
    arg.startsWith("/")
  );
}

const INSTALL_USAGE =
  "Usage: nimbus extension install <path | id> [--registry <name>] [--version <v>] [--channel beta] [--accept-publisher-key <fingerprint>] [--publisher-key <path>] [--yes]";

/** `nimbus extension install <id>`: resolve, verify and install from a registry (never `--yes`). */
async function runExtensionInstallFromRegistry(
  client: IPCClient,
  args: string[],
  id: string,
): Promise<void> {
  if (hasFlag(args, "--yes") || hasFlag(args, "-y")) {
    throw new Error(
      "--yes is not accepted for a registry install: it is always confirmed by the owner's approval prompt (answered interactively, or by NIMBUS_SCRIPT_CONSENT_SOURCE for scripted use)",
    );
  }
  if (hasFlag(args, "--publisher-key")) {
    throw new Error("--publisher-key applies to a local install only; the registry names the key");
  }
  const channel = takeFlagValue(args, "--channel");
  if (channel !== undefined && channel !== "stable" && channel !== "beta") {
    throw new Error("--channel must be stable or beta");
  }
  registerConsentFor(client, { kind: "prompt" });
  const params: Record<string, unknown> = { id };
  for (const [flag, key] of [
    ["--registry", "registry"],
    ["--version", "version"],
    ["--channel", "channel"],
    ["--accept-publisher-key", "acceptPublisherKey"],
  ] as const) {
    const v = takeFlagValue(args, flag);
    if (v !== undefined) params[key] = v;
  }
  const out = await client.call<{
    id: string;
    version: string;
    sourceRegistry: string;
    rootFingerprint?: string;
    publisher?: { id: string; fingerprint: string };
    installPath: string;
  }>("registry.install", params);
  const who =
    out.publisher === undefined
      ? ""
      : `, publisher ${out.publisher.id} (${out.publisher.fingerprint})`;
  const root = out.rootFingerprint === undefined ? "" : ` (root ${out.rootFingerprint})`;
  console.log(
    `installed ${out.id}@${out.version} from registry ${out.sourceRegistry}${root}${who}`,
  );
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runExtensionInstall(
  client: IPCClient,
  args: string[],
  rest: string[],
): Promise<void> {
  const sourceRaw = rest[0]?.trim() ?? "";
  if (sourceRaw === "") {
    throw new Error(INSTALL_USAGE);
  }
  if (!existsSync(resolve(process.cwd(), sourceRaw))) {
    if (looksLikePath(sourceRaw)) {
      throw new Error(`no such file or directory: ${sourceRaw}`);
    }
    await runExtensionInstallFromRegistry(client, args, sourceRaw);
    return;
  }
  for (const flag of ["--registry", "--version", "--channel", "--accept-publisher-key"]) {
    if (hasFlag(args, flag)) {
      throw new Error(`${flag} applies to a registry install; ${sourceRaw} is an existing path`);
    }
  }
  const accept = hasFlag(args, "--yes") || hasFlag(args, "-y");
  if (!accept && process.stdout.isTTY !== true) {
    throw new Error(
      "Refusing to install without confirmation in non-TTY mode. Pass --yes to proceed.",
    );
  }
  // The approval is the GATEWAY's HITL prompt (Non-Negotiable 2), raised over the resolved plan —
  // every package the install adds, the claimed publisher and the declared permissions — before
  // anything is copied. This command only decides how this connection answers it: interactively,
  // or, with --yes, by approving on the owner's behalf and echoing what was approved to stderr.
  registerConsentFor(client, accept ? { kind: "auto", sourceLabel: "--yes" } : { kind: "prompt" });
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

/**
 * `nimbus extension rehash <id>` — adopt the files now under an installed extension as trusted, by
 * recording their digest. The gateway asks the owner exactly as it does for an install, and
 * refuses outright when the manifest or entry no longer match their install-time hashes.
 */
export async function runExtensionRehash(
  client: IPCClient,
  args: string[],
  rest: string[],
): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension rehash <id> [--yes]");
  }
  const accept = hasFlag(args, "--yes") || hasFlag(args, "-y");
  if (!accept && process.stdout.isTTY !== true) {
    throw new Error(
      "Refusing to rehash without confirmation in non-TTY mode. Pass --yes to proceed.",
    );
  }
  registerConsentFor(client, accept ? { kind: "auto", sourceLabel: "--yes" } : { kind: "prompt" });
  const out = await client.call<{ id: string; treeDigest: string; changed: boolean }>(
    "extension.rehash",
    { id },
  );
  console.log(
    out.changed
      ? `${out.id}: adopted tree digest ${out.treeDigest}`
      : `${out.id}: unchanged (tree digest ${out.treeDigest})`,
  );
}

/**
 * `nimbus extension approve <id> [--model]` — approve an installed extension to RUN with the grants the
 * gateway resolves from its manifest. The gateway asks under `extension.run`. A terminal is
 * required and there is no `--yes`: this consents to running third-party code unattended, which is
 * not something to approve from a script. The gateway spawns an approved extension on first use,
 * re-verifying it first.
 */
export async function runExtensionApprove(
  client: IPCClient,
  args: string[],
  rest: string[],
): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension approve <id> [--model]");
  }
  if (hasFlag(args, "--yes") || hasFlag(args, "-y")) {
    throw new Error(
      "nimbus extension approve has no --yes: approving an extension to run must be answered by a person at a terminal.",
    );
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error(
      "Refusing to approve running an extension in non-TTY mode: the approval must be answered at a terminal.",
    );
  }
  // The prompt handler DIRECTLY, not `registerConsentFor({ kind: "prompt" })`: that one answers
  // from `NIMBUS_SCRIPT_CONSENT_SOURCE` when it is set, which would let an environment variable
  // approve running third-party code at a terminal — exactly what having no --yes rules out.
  registerConsentPromptHandler(client);
  // Every approval states the whole grant: without --model, model access is turned off.
  const modelAccess = hasFlag(args, "--model");
  const out = await client.call<{
    id: string;
    serviceId: string;
    treeDigest: string;
    changed: boolean;
    modelAccess?: boolean;
    syncServiceId?: string;
  }>("extension.approveRun", { id, modelAccess });
  const model = `model access: ${out.modelAccess === true ? "on" : "off"}`;
  console.log(
    out.changed
      ? `${out.id}: approved to run as ${out.serviceId} (tree digest ${out.treeDigest}; ${model}). It starts on first use: \`nimbus connector tools ${out.serviceId}\`.`
      : `${out.id}: already approved for this code and these grants (${out.serviceId}; ${model}).`,
  );
  if (out.syncServiceId !== undefined) {
    const paused = await pausedSyncLine(client, out.id, out.syncServiceId);
    if (paused !== undefined) console.log(paused);
  }
}

/**
 * The line to add when the sync an approval registered came up paused (e.g. no sandbox helper), or
 * `undefined` when it did not. Best-effort: the approval already succeeded, so a failed status read
 * adds nothing rather than failing the command.
 */
async function pausedSyncLine(
  client: IPCClient,
  extensionId: string,
  syncServiceId: string,
): Promise<string | undefined> {
  let rows: unknown;
  try {
    rows = await client.call<unknown>("connector.listStatus", { serviceId: syncServiceId });
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  const row: unknown = rows.find(
    (r: unknown) =>
      typeof r === "object" &&
      r !== null &&
      (r as Record<string, unknown>)["serviceId"] === syncServiceId,
  );
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as Record<string, unknown>;
  if (r["status"] !== "paused" && r["healthState"] !== "paused") return undefined;
  const reason =
    typeof r["lastError"] === "string" && r["lastError"] !== ""
      ? `: ${stripControl(r["lastError"])}`
      : "";
  return `${extensionId}: approved, but sync is paused${reason}. Run \`nimbus connector status ${syncServiceId}\` for details.`;
}

/** `nimbus extension revoke <id>` — withdraw a run approval. Not gated: it only narrows. */
export async function runExtensionRevoke(client: IPCClient, rest: string[]): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension revoke <id>");
  }
  const out = await client.call<{ id: string; revoked: boolean }>("extension.revokeRun", { id });
  console.log(out.revoked ? `${out.id}: run approval revoked` : `${out.id}: had no run approval`);
}

const CREDENTIAL_USAGE = "Usage: nimbus extension credential set <id> <name> | status <id>";

/** Where `credential set` reads the secret from, and how its connection answers the gateway's prompt. */
export interface CredentialCliIo extends SecretInputIo {
  registerConsent(client: IPCClient): void;
}

function defaultCredentialIo(): CredentialCliIo {
  return {
    ...defaultSecretInputIo(),
    registerConsent: (client) => registerConsentFor(client, { kind: "prompt" }),
  };
}

/**
 * `nimbus extension credential set <id> <name>` — store a credential an approved extension declares.
 * The value is read from a hidden prompt, or from stdin when stdin is not a terminal, and NEVER from
 * argv (where it would land in shell history and the process list). The gateway resolves the Vault
 * key from the extension's run approval and asks the owner once, under `vault.set`.
 */
async function runExtensionCredentialSet(
  client: IPCClient,
  rest: string[],
  io: CredentialCliIo,
): Promise<void> {
  const [id, name, extra] = rest;
  if (id === undefined || id.trim() === "" || name === undefined || name.trim() === "") {
    throw new Error(CREDENTIAL_USAGE);
  }
  if (extra !== undefined) {
    throw new Error(
      "nimbus extension credential set never takes the value as an argument: it is read from a hidden prompt, or from stdin when stdin is not a terminal.",
    );
  }
  assertPipedSecretCanBeApproved(io);
  const value = await readSecretValue(io, name);
  io.registerConsent(client);
  const out = await client.call<{ name: string; set: boolean }>("extension.credentialSet", {
    id: id.trim(),
    name: name.trim(),
    value,
  });
  console.log(
    `${id.trim()}: ${out.name} stored. It takes effect the next time the extension starts (it was stopped if it was running).`,
  );
}

async function runExtensionCredentialStatus(client: IPCClient, rest: string[]): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "" || rest.length > 1) {
    throw new Error(CREDENTIAL_USAGE);
  }
  const out = await client.call<{ credentials: Array<{ name: string; set: boolean }> }>(
    "extension.credentialStatus",
    { id },
  );
  if (out.credentials.length === 0) {
    console.log(`${id}: declares no credentials`);
    return;
  }
  for (const c of out.credentials) {
    console.log(`${c.name}: ${c.set ? "set" : "not set"}`);
  }
}

/** `nimbus extension credential set <id> <name> | status <id>` (`rest` excludes `credential`). */
export async function runExtensionCredential(
  client: IPCClient,
  rest: string[],
  io: CredentialCliIo = defaultCredentialIo(),
): Promise<void> {
  const [action, ...tail] = rest;
  if (action === "set") return runExtensionCredentialSet(client, tail, io);
  if (action === "status") return runExtensionCredentialStatus(client, tail);
  throw new Error(CREDENTIAL_USAGE);
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

/**
 * `nimbus extension keygen`. All of the work is synchronous; `Promise.try` keeps the contract an
 * `async` function had — the body still runs at call time, and a filesystem error REJECTS rather
 * than throwing at the caller.
 */
export function runExtensionKeygen(args: string[]): Promise<number> {
  return Promise.try(() => writePublisherKeypair(args));
}

function writePublisherKeypair(args: string[]): number {
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

/**
 * Reconcile the manifest's `publisher` with the signing key before signing. A manifest that names a
 * publisher id but no key gets the signing key's public half (what scaffold leaves for you to fill
 * in); a manifest whose key differs from the signing key is refused rather than silently re-keyed.
 * Returns the refusal message, or undefined when signing may proceed. No `publisher` changes nothing.
 */
function applySigningPublisherKey(
  manifest: Record<string, unknown>,
  priv: Uint8Array,
): string | undefined {
  const publisher = manifest["publisher"];
  if (publisher === null || typeof publisher !== "object" || Array.isArray(publisher)) {
    return undefined;
  }
  const entry = publisher as Record<string, unknown>;
  const signingKey = encodeBase64(publicKeyFromSeed(priv));
  if (entry["key"] === undefined) {
    manifest["publisher"] = { ...entry, key: signingKey };
    return undefined;
  }
  if (entry["key"] === signingKey) return undefined;
  const manifestKey = typeof entry["key"] === "string" ? entry["key"] : "";
  return (
    "manifest publisher.key does not match the signing key; refusing to re-key it. " +
    `manifest key fingerprint: ${manifestKey === "" ? "(not a string)" : publisherKeyFingerprint(manifestKey)}, ` +
    `signing key fingerprint: ${publisherKeyFingerprint(signingKey)}`
  );
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
  const keyRefusal = applySigningPublisherKey(parsed, priv);
  if (keyRefusal !== undefined) {
    process.stderr.write(`${keyRefusal}\n`);
    return 2;
  }
  const sig = await signManifest(parsed, priv);
  writeFileSync(manifestPath, JSON.stringify({ ...parsed, signature: sig }, null, 2));
  return 0;
}

const EXTENSION_USAGE =
  "Usage: nimbus extension list [--filter needs-reinstall] [--tree] [--json] | info <id> [--deps] [--registry <name> | --remote] [--json] | search <query> [--json] | install <path | id> [--registry <name>] [--version <v>] [--channel beta] [--accept-publisher-key <fingerprint>] [--publisher-key <path>] [--yes] | rehash <id> [--yes] | approve <id> [--model] | revoke <id> | credential set <id> <name> | credential status <id> | enable <id> | disable <id> | remove <id> [--yes] [--force] | update [<id>] [--check] [--to <version>] [--accept-publisher-key <fingerprint>] [--json] | downgrade <id> [--json] | publish <dir> --registry-repo <owner/repo> [--clone <path>] [--channel stable|beta] [--statement <file>]... [--no-pr] | key rotate --from <old key file> --to <new key file> --publisher <id> [--out <file>] [--force] | key revoke --key <key file> --publisher <id> --reason <text> [--out <file>] [--force]";

/**
 * Subcommands that need no gateway. `publish` and `key` get the RAW args: `stripFlags` drops
 * `--channel` and its value, which would silently publish a beta as stable, and a `--reason` text.
 */
async function runExtensionOffline(sub: string, args: string[]): Promise<boolean> {
  if (sub === "publish") {
    const code = await runExtensionPublish(args.slice(1));
    if (code !== 0) process.exit(code);
    return true;
  }
  if (sub === "key") {
    const code = await runExtensionKey(args.slice(1));
    if (code !== 0) process.exit(code);
    return true;
  }
  const rest = stripFlags(args.slice(1));
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
    search: async () =>
      runExtensionSearch(stripFlags(args.slice(1)).join(" "), hasFlag(args, "--json"), {
        client,
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
      }),
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
    case "rehash":
      await runExtensionRehash(client, args, rest);
      return true;
    case "approve":
      await runExtensionApprove(client, args, rest);
      return true;
    case "revoke":
      await runExtensionRevoke(client, rest);
      return true;
    case "credential":
      await runExtensionCredential(client, rest);
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

/**
 * `install`, `rehash`, `approve`, `update` and `downgrade` block on the owner's HITL prompt, so
 * they get the human-bound budget rather than the 30s default that would time out while the owner
 * is still reading the prompt. `update --check` only reads, so it keeps the default.
 */
/**
 * ONE apply/read-only decision for `update` (`rest` excludes the `update` token): it applies only
 * with an id and without `--check`. No id lists updates and `--check` never applies.
 */
export function extensionUpdateApplies(rest: string[]): boolean {
  const id = stripFlags(rest).find((a) => !a.startsWith("--"));
  return id !== undefined && !hasFlag(rest, "--check");
}

export function rpcTimeoutForExtensionSub(sub: string, rest: string[]): number | undefined {
  if (sub === "install" || sub === "rehash" || sub === "approve" || sub === "downgrade") {
    return INTERACTIVE_RPC_TIMEOUT_MS;
  }
  // Registry lookups fetch and verify every index; the 30s default is the fetch timeout itself.
  if (
    sub === "search" ||
    (sub === "info" && (hasFlag(rest, "--remote") || hasFlag(rest, "--registry")))
  ) {
    return INTERACTIVE_RPC_TIMEOUT_MS;
  }
  if (sub === "update" && extensionUpdateApplies(rest)) {
    return INTERACTIVE_RPC_TIMEOUT_MS;
  }
  // `credential set` waits on the owner's vault.set prompt.
  if (sub === "credential" && rest[0] === "set") {
    return INTERACTIVE_RPC_TIMEOUT_MS;
  }
  return undefined;
}

export async function runExtension(args: string[]): Promise<void> {
  const sub = args[0]?.trim() ?? "";
  if (await runExtensionOffline(sub, args)) {
    return;
  }
  const rest = stripFlags(args.slice(1));

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error(gatewayNotRunningMessage(paths.demo === true));
  }

  const client = createIpcClient(state.socketPath, rpcTimeoutForExtensionSub(sub, args.slice(1)));
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
  readonly verificationStatus: "verified" | "signature_failed" | "publisher_key_conflict";
  /** The registry the extension was installed from — the only one its updates come from. */
  readonly sourceRegistry: string;
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
  const keyChanged =
    u.verificationStatus === "publisher_key_conflict" ? "\tpublisher key changed" : "";
  return `${u.id}\t${u.fromVersion} → ${u.toVersion}\t[${u.channel}]\tfrom ${u.sourceRegistry}\t${u.publisherStatus}\t${u.verificationStatus}${keyChanged}`;
}

async function listExtensionUpdates(
  opts: RunExtensionUpdateOpts,
  isJson: boolean,
  isCheck: boolean,
  onlyId?: string,
): Promise<number> {
  const all = (await opts.caller("extension.checkForUpdates", {
    ...(isCheck ? { force: true } : {}),
  })) as AvailableUpdateCli[];
  const list = onlyId === undefined ? all : all.filter((u) => u.id === onlyId);
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
  acceptPublisherKey?: string,
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
    ...(acceptPublisherKey === undefined ? {} : { acceptPublisherKey }),
  })) as UpdateApplyResultCli;

  if (isJson) {
    opts.writeStdout(`${JSON.stringify(res, undefined, 2)}\n`);
    return res.applied ? 0 : 1;
  }
  if (res.applied) {
    const jobIdPart = res.jobId === undefined ? "" : ` (jobId=${res.jobId})`;
    opts.writeStdout(`updated ${id} to ${targetVersion}${jobIdPart}\n`);
    return 0;
  }
  const hintPart = res.hint === undefined ? "" : `\n  hint: ${res.hint}`;
  opts.writeStderr(`update failed: ${res.reason ?? "unknown"}${hintPart}\n`);
  return 1;
}

export async function runExtensionUpdateWithCaller(opts: RunExtensionUpdateOpts): Promise<number> {
  const args = opts.args;
  const isJson = hasFlag(args, "--json");
  const applies = extensionUpdateApplies(args);
  const isCheck = !applies;
  const toVersion = takeFlagValue(args, "--to");
  const id = stripFlags(args).find((a) => !a.startsWith("--"));

  if (id === undefined || !applies) {
    // No id, or `--check`, is strictly read-only: it never reaches `extension.update`.
    return listExtensionUpdates(opts, isJson, isCheck, id);
  }
  return applyExtensionUpdate(
    opts,
    id,
    toVersion,
    isJson,
    takeFlagValue(args, "--accept-publisher-key"),
  );
}

export async function runExtensionUpdate(client: IPCClient, args: string[]): Promise<number> {
  // The gateway raises the owner's HITL prompt (`extension.update`) over this connection; `--check`
  // only reads, so it never prompts and registers nothing.
  if (extensionUpdateApplies(args.slice(1))) {
    registerConsentFor(client, { kind: "prompt" });
  }
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
  const id = stripFlags(args).find((a) => !a.startsWith("--"));
  if (id === undefined) {
    opts.writeStderr("usage: nimbus extension downgrade <id> --to <version> [--json]\n");
    return 1;
  }
  if (toVersion === undefined) {
    opts.writeStderr(
      `downgrade requires --to <version> (a previous version kept under extension-versions/<slug>/prev/<version>/)\n`,
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
  const hintPart = res.hint === undefined ? "" : `\n  hint: ${res.hint}`;
  opts.writeStderr(`downgrade failed: ${res.reason ?? "unknown"}${hintPart}\n`);
  return 1;
}

export async function runExtensionDowngrade(client: IPCClient, args: string[]): Promise<number> {
  registerConsentFor(client, { kind: "prompt" });
  return runExtensionDowngradeWithCaller({
    args: args.slice(1),
    caller: async (method, params) => client.call<unknown>(method, params),
    fetchInfo: async (id) => client.call<ExtensionInfoForDowngrade>("extension.info", { id }),
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
  });
}
