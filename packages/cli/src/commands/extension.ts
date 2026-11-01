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
import { openHttpsUrl } from "../lib/open-url.ts";
import { readLine } from "../lib/read-line.ts";
import { createIpcClient, INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import {
  assertPipedSecretCanBeApproved,
  defaultSecretInputIo,
  readSecretValue,
  type SecretInputIo,
} from "../lib/secret-input.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import {
  signatureLabel,
  type VerifiedPublisherCli,
  verifiedPublisherCell,
  verifiedPublisherLine,
} from "../lib/verified-publisher-text.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { NIMBUS_VERSION } from "../version.ts";
import { stripControl } from "./captures-format.ts";
import { runConnector } from "./connector.ts";
import { runExtensionKey } from "./extension-key.ts";
import { type PostInstallIo, runConnectFix, runPostInstallWalk } from "./extension-post-install.ts";
import { runExtensionPublish } from "./extension-publish.ts";
import {
  accessLines,
  evidenceLines,
  runExtensionInfoRemote,
  runExtensionSearch,
} from "./extension-registry-cmds.ts";
import { runExtensionReport } from "./extension-report.ts";
import {
  parseRequirementStatuses,
  type RequirementStatusView,
  requirementLines,
} from "./extension-requirements-format.ts";
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
    if (
      a === "--yes" ||
      a === "-y" ||
      a === "--json" ||
      a === "--model" ||
      a === "--remote" ||
      a === "--clean-deps"
    ) {
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
  /** V79: a starter pack has no code and never runs; absent from an older gateway. */
  kind?: "extension" | "starter-pack";
  /** Reach on this machine and the predicted file outcome; absent from an older gateway. */
  access?: unknown;
  /** A local install's own tested / history / checked lines; absent from an older gateway. */
  evidence?: unknown;
  /** The registry a registry-sourced install came from, whose index holds its evidence. */
  evidenceIn?: unknown;
  enabled?: number;
  needs_reinstall?: boolean;
  signature_disabled?: boolean;
  disabled_reason?: string;
  publisher?: { id: string; key?: string };
  forwardDeps?: Array<{ id: string; range: string }>;
  reverseDeps?: Array<{ extensionId: string; range: string }>;
  runState?: string;
  requires?: unknown;
  runGrant?: { serviceId: string; approvedAt: number; modelAccess: boolean } | null;
  source_registry?: string | null;
  /** I48: revocations and takedowns the run grant has not acknowledged. */
  blockedBy?: TrustBlockView[];
  /** R6: Nimbus verified the publisher and vouches for the key that verified this copy. */
  verifiedPublisher?: VerifiedPublisherCli | null;
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
export function formatBlockLines(
  id: string,
  blocks: readonly TrustBlockView[],
  kind?: string,
): string[] {
  if (blocks.length === 0) return [];
  const lines = blocks.map((b) => {
    const what = b.kind === "key.revoke" ? "publisher key revoked" : "taken down";
    const by = blockIssuerPhrase(b);
    return `Blocked:   ${what} by ${by} on ${stripControl(b.issuedAt)}: ${stripControl(b.reason)}`;
  });
  // A starter pack has no code, and `approve` refuses one: never suggest it.
  if (kind === "starter-pack") return lines;
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
   * the `(unsigned)` badge, which means "declares no publisher" — the normal state of every
   * unsigned extension, and a different fact entirely.
   */
  signatureDisabled?: boolean;
  runState?: string;
  /** The registry the extension was installed from; absent for a local-path install. */
  sourceRegistry?: string;
  /** R6: marked after the publisher id when Nimbus verified the publisher. */
  verifiedPublisher?: VerifiedPublisherCli | null;
}

/** One definition, read by the renderer and by the colour rule below. */
const SIGNATURE_DISABLED_STATUS = "disabled (signature)";

/** The Publisher cell: the id, with `✓ @handle` when Nimbus verified it (R6); `(unsigned)` without one. */
function publisherCell(r: ExtensionListTableRow): string {
  if (r.publisher === undefined) return "(unsigned)";
  const mark = verifiedPublisherCell(r.verifiedPublisher);
  return mark === "-" ? r.publisher.id : `${r.publisher.id} ${mark}`;
}

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
    const cells = [r.id, r.version, publisherCell(r), status];
    if (showRun) cells.push(r.runState === undefined ? "-" : runStateLabel(r.runState));
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
    if (col === 2 && s === "(unsigned)") return `\x1b[2;33m${padded}\x1b[0m`;
    // Bold red, one step louder than `(unsigned)`'s dim yellow: an unsigned extension is a
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

/** How a run state reads to the owner: a starter pack has no code, so it never runs. */
export function runStateLabel(state: string): string {
  return state === "pack" ? "pack (no code)" : state;
}

/** `nimbus extension info`'s run line: the run state, and the grant behind it when there is one. */
export function formatRunLine(e: Pick<ExtensionListEntry, "runState" | "runGrant">): string | null {
  if (e.runState === undefined) return null;
  if (e.runGrant === undefined || e.runGrant === null) return runStateLabel(e.runState);
  const at = new Date(e.runGrant.approvedAt).toISOString();
  const model = e.runGrant.modelAccess ? "yes" : "no";
  return `${runStateLabel(e.runState)} (${e.runGrant.serviceId}, approved ${at}, model: ${model})`;
}

export async function runExtensionList(client: IPCClient, args: string[]): Promise<void> {
  const filter = takeFlagValue(args, "--filter");
  const json = hasFlag(args, "--json");
  const tree = hasFlag(args, "--tree");
  const params: Record<string, unknown> = {};
  if (filter !== undefined) params["filter"] = filter;
  if (json) params["includeRequires"] = true;
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
    if (r.verifiedPublisher != null) base.verifiedPublisher = r.verifiedPublisher;
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
    lines.push(`Publisher: (unsigned)`);
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
    console.log(`  ${verifiedPublisherLine(e.verifiedPublisher)}`);
  } else {
    console.log("Publisher: (unsigned)");
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

/**
 * An installed extension has no index on hand and `info` starts no registry read, so a
 * registry-sourced one names where to look; a local one prints the gateway's own three lines.
 */
function installedEvidenceLines(e: ExtensionListEntry): string[] {
  if (typeof e.evidenceIn === "string") {
    return [
      `Tested, history, checks: read from ${stripControlChars(e.evidenceIn)}: nimbus extension info ${stripControlChars(e.id)} --registry ${stripControlChars(e.evidenceIn)}`,
    ];
  }
  return evidenceLines(e.evidence);
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
  }>("extension.info", { id, includeRequires: true });
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
  for (const line of formatBlockLines(e.id, e.blockedBy ?? [], e.kind)) console.log(line);
  printExtensionInfoPublisher(e);
  for (const line of accessLines(e.access)) console.log(line);
  for (const line of installedEvidenceLines(e)) console.log(line);
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
  const requires = parseRequirementStatuses(e.requires);
  if (requires.length > 0) {
    console.log("Requires:");
    for (const line of requirementLines(requires)) console.log(line);
  }
}

/** The `Needs:` block of an install result: nothing when no connector is required. */
function printNeeds(raw: unknown): void {
  const needs = parseRequirementStatuses(raw);
  if (needs.length === 0) return;
  console.log("Needs:");
  for (const line of requirementLines(needs)) console.log(line);
}

/**
 * What the post-install walk needs from `runExtension`. Without it an install never walks, so a
 * caller that passes no socket gets exactly the printed commands.
 */
export interface InstallWalkDeps {
  /** The gateway socket; every walk action opens its OWN client on it. */
  readonly socketPath: string;
  readonly makeClient?: (socketPath: string, requestTimeoutMs: number) => IPCClient;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly connectorAuth?: (id: string) => Promise<void>;
}

/**
 * Runs `fn` on a NEW client and disconnects it after. The install's client is never reused: its
 * `consent.request` handler (the `--yes` auto-approver included) cannot be removed, and handlers
 * accumulate, so only a fresh client is guaranteed to carry exactly the one prompt handler the
 * command registers.
 */
async function withFreshClient(
  deps: InstallWalkDeps,
  fn: (client: IPCClient) => Promise<void>,
): Promise<void> {
  const make = deps.makeClient ?? createIpcClient;
  const client = make(deps.socketPath, INTERACTIVE_RPC_TIMEOUT_MS);
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.disconnect();
  }
}

/** `log` writes one line; absent, the walk writes to the console. */
function postInstallIo(
  args: string[],
  deps: InstallWalkDeps,
  log: (line: string) => void = (line) => console.log(line),
): PostInstallIo {
  const approve = (id: string): Promise<void> =>
    withFreshClient(deps, (c) => runExtensionApprove(c, [], [id]));
  return {
    attended:
      !hasFlag(args, "--yes") &&
      !hasFlag(args, "-y") &&
      process.stdin.isTTY === true &&
      process.stdout.isTTY === true,
    confirm: deps.confirm ?? (async (q) => /^y(es)?$/i.test(await readLine(q))),
    approve,
    connect: (req, alreadyApproved) =>
      runConnectFix(req, alreadyApproved, {
        connectorAuth: deps.connectorAuth ?? ((id) => runConnector(["auth", id])),
        approve,
        credentialSet: (ext, name) =>
          withFreshClient(deps, (c) => runExtensionCredential(c, ["set", ext, name])),
        log,
      }),
    log,
  };
}

/**
 * The walk after an install. It never fails the install: anything it throws is only logged.
 * `log` writes one line (the caller's stdout writer, when it has one); absent, the console.
 */
async function walkAfterInstall(
  args: string[],
  deps: InstallWalkDeps | undefined,
  toApprove: readonly string[],
  requirements: readonly RequirementStatusView[],
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  if (deps === undefined) return;
  try {
    await runPostInstallWalk(postInstallIo(args, deps, log), toApprove, requirements);
  } catch (e) {
    log(`(stopped walking through the install: ${stripControl(String(e))})`);
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

/**
 * Prints the promote copy and returns true when the install only kept a package already installed
 * as a dependency (`promoted: true`). Nothing was fetched, copied or approved then, so the caller
 * prints no approve line and no Needs block, and runs no post-install walk.
 */
function printedPromotion(out: { id: string; promoted?: boolean }): boolean {
  if (out.promoted !== true) return false;
  console.log(
    `${stripControl(out.id)} is already installed (it came in as a dependency); it is now kept even if what needed it is removed.`,
  );
  console.log(JSON.stringify(out, undefined, 2));
  return true;
}

const INSTALL_USAGE =
  "Usage: nimbus extension install <path | id> [--registry <name>] [--version <v>] [--channel beta] [--accept-publisher-key <fingerprint>] [--publisher-key <path>] [--yes]";

/** `nimbus extension install <id>`: resolve, verify and install from a registry (never `--yes`). */
async function runExtensionInstallFromRegistry(
  client: IPCClient,
  args: string[],
  id: string,
  walk: InstallWalkDeps | undefined,
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
    kind?: string;
    dependencies?: { id: string; version: string; registry: string; kind?: string }[];
    connectorRequirements?: unknown;
    promoted?: boolean;
  }>("registry.install", params);
  if (printedPromotion(out)) return;
  const who =
    out.publisher === undefined
      ? ""
      : `, publisher ${out.publisher.id} (${out.publisher.fingerprint})`;
  const root = out.rootFingerprint === undefined ? "" : ` (root ${out.rootFingerprint})`;
  const deps = out.dependencies ?? [];
  const rootIsPack = out.kind === "starter-pack";
  if (rootIsPack) {
    console.log(`Installed starter pack ${stripControl(out.id)}@${stripControl(out.version)}.`);
    if (deps.length > 0) console.log(`Added ${deps.length} package(s) it needs.`);
  } else {
    console.log(
      `installed ${out.id}@${out.version} from registry ${out.sourceRegistry}${root}${who}`,
    );
  }
  for (const d of deps) {
    console.log(`  + ${d.id}@${d.version} from registry ${d.registry} (installed as a dependency)`);
  }
  // A pack has no code and cannot be approved to run: only code packages are offered for approval.
  // An older gateway sends no kind; that is an extension, as before.
  const toApprove = [
    ...deps.filter((d) => d.kind !== "starter-pack").map((d) => d.id),
    ...(rootIsPack ? [] : [out.id]),
  ];
  if (toApprove.length > 0) {
    console.log(
      `Nothing runs until you approve it: ${toApprove.map((i) => `nimbus extension approve ${i}`).join(" && ")}`,
    );
  }
  printNeeds(out.connectorRequirements);
  console.log(JSON.stringify(out, undefined, 2));
  await walkAfterInstall(
    args,
    walk,
    toApprove,
    parseRequirementStatuses(out.connectorRequirements),
  );
}

export async function runExtensionInstall(
  client: IPCClient,
  args: string[],
  rest: string[],
  walk?: InstallWalkDeps,
): Promise<void> {
  const sourceRaw = rest[0]?.trim() ?? "";
  if (sourceRaw === "") {
    throw new Error(INSTALL_USAGE);
  }
  if (!existsSync(resolve(process.cwd(), sourceRaw))) {
    if (looksLikePath(sourceRaw)) {
      throw new Error(`no such file or directory: ${sourceRaw}`);
    }
    await runExtensionInstallFromRegistry(client, args, sourceRaw, walk);
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
    kind?: string;
    connectorRequirements?: unknown;
    promoted?: boolean;
  }>("extension.install", installParams);
  if (printedPromotion(out)) return;
  printNeeds(out.connectorRequirements);
  console.log(JSON.stringify(out, undefined, 2));
  // A pack has no code and cannot be approved to run; its connector requirements are still offered.
  await walkAfterInstall(
    args,
    walk,
    out.kind === "starter-pack" ? [] : [out.id],
    parseRequirementStatuses(out.connectorRequirements),
  );
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

/** The removal's one prompt beyond the confirmation: the offer to remove orphaned members. */
export type ExtensionRemoveIo = {
  readonly confirm: (question: string) => Promise<boolean>;
};

/** The offer's question goes to stderr: stdout carries the removal's JSON result. */
const defaultRemoveIo: ExtensionRemoveIo = {
  confirm: async (q) => /^y(es)?$/i.test(await readLine(q, undefined, process.stderr)),
};

type ExtensionRemoveResult = { ok: boolean; orphanedDependencies?: unknown };

/** An older gateway returns no `orphanedDependencies`; anything not a string list reads as none. */
function orphansOf(out: ExtensionRemoveResult): string[] {
  const raw = out.orphanedDependencies;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

export async function runExtensionRemove(
  client: IPCClient,
  args: string[],
  rest: string[],
  io: ExtensionRemoveIo = defaultRemoveIo,
): Promise<void> {
  const id = rest[0]?.trim() ?? "";
  if (id === "") {
    throw new Error("Usage: nimbus extension remove <id> [--yes] [--force] [--clean-deps]");
  }
  const accept = hasFlag(args, "--yes") || hasFlag(args, "-y");
  const force = hasFlag(args, "--force");
  const cleanDeps = hasFlag(args, "--clean-deps");

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

  let out: ExtensionRemoveResult;
  const payload: { id: string; force?: true } = force ? { id, force: true } : { id };
  try {
    out = await client.call<ExtensionRemoveResult>("extension.remove", payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("reverse_dep_blocked")) {
      process.stderr.write(`${msg}\nRe-run with --force to override.\n`);
      process.exit(1);
    }
    throw e;
  }
  console.log(JSON.stringify(out, undefined, 2));
  await handleOrphanedDependencies(client, id, orphansOf(out), {
    cleanDeps,
    attended: !accept && process.stdin.isTTY === true && process.stdout.isTTY === true,
    io,
  });
}

/**
 * After a removal: the members installed only for `id` are removed with `--clean-deps`, offered at
 * an attended terminal, and otherwise only named. Each goes through its own `extension.remove`, in
 * the gateway's order (dependents first), with no second confirmation and no further offer; one
 * that fails is reported and the rest still go, and the command then exits 1. Every line here goes
 * to stderr, so stdout stays the removal's JSON result.
 */
async function handleOrphanedDependencies(
  client: IPCClient,
  id: string,
  orphans: readonly string[],
  opts: { cleanDeps: boolean; attended: boolean; io: ExtensionRemoveIo },
): Promise<void> {
  if (orphans.length === 0) return;
  const safeId = stripControl(id);
  const list = orphans.map((o) => stripControl(o)).join(", ");
  const say = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  if (!opts.cleanDeps) {
    const question = `Also remove ${orphans.length} package(s) installed only for ${safeId}: ${list}? [y/N] `;
    if (!opts.attended || !(await opts.io.confirm(question))) {
      // Not `--clean-deps`: `id` is already gone, so naming it again fails, and nothing offers
      // these packages later. Name the removals that work now, dependents first.
      const commands = orphans
        .map((o) => `nimbus extension remove ${stripControl(o)}`)
        .join(" && ");
      say(`Kept ${list}, installed only for ${safeId}; remove them with: ${commands}`);
      return;
    }
  }
  let failed = 0;
  for (const orphan of orphans) {
    try {
      await client.call<ExtensionRemoveResult>("extension.remove", { id: orphan });
      say(`Removed ${stripControl(orphan)}.`);
    } catch (e) {
      failed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      say(`Could not remove ${stripControl(orphan)}: ${stripControl(msg)}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
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
  "Usage: nimbus extension list [--filter needs-reinstall] [--tree] [--json] | info <id> [--deps] [--registry <name> | --remote] [--json] | search <query> [--json] | install <path | id> [--registry <name>] [--version <v>] [--channel beta] [--accept-publisher-key <fingerprint>] [--publisher-key <path>] [--yes] | rehash <id> [--yes] | approve <id> [--model] | revoke <id> | credential set <id> <name> | credential status <id> | enable <id> | disable <id> | remove <id> [--yes] [--force] [--clean-deps] | update [<id>] [--check] [--to <version>] [--accept-publisher-key <fingerprint>] [--json] | downgrade <id> [--json] | report <id> | publish <dir> --registry-repo <owner/repo> [--clone <path>] [--channel stable|beta] [--statement <file>]... [--no-pr] | key rotate --from <old key file> --to <new key file> --publisher <id> [--out <file>] [--force] | key revoke --key <key file> --publisher <id> --reason <text> [--out <file>] [--force]";

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
  socketPath?: string,
): Promise<boolean> {
  const handlers: Record<string, () => Promise<number>> = {
    search: async () =>
      runExtensionSearch(stripFlags(args.slice(1)).join(" "), hasFlag(args, "--json"), {
        client,
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
      }),
    update: () =>
      runExtensionUpdate(client, args, socketPath === undefined ? undefined : { socketPath }),
    report: () =>
      runExtensionReport(args.slice(1), {
        client,
        isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
        confirm: async (q) => /^y(es)?$/i.test(await readLine(q)),
        openUrl: (u) => openHttpsUrl(u),
        log: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
        nimbusVersion: NIMBUS_VERSION,
        osFamily: process.platform,
      }),
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
  socketPath: string,
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
      await runExtensionInstall(client, args, rest, { socketPath });
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
    if (await dispatchExtensionVoid(sub, client, args, rest, state.socketPath)) {
      return;
    }
    if (await dispatchExtensionWithCode(sub, client, args, state.socketPath)) {
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
  /** Whether the signature verified (NOT a verified publisher); rendered from `verificationStatus`. */
  readonly publisherStatus: "verified" | "unverified";
  readonly verificationStatus: "verified" | "signature_failed" | "publisher_key_conflict";
  /** The registry the extension was installed from — the only one its updates come from. */
  readonly sourceRegistry: string;
  /** R6, computed by the gateway when it served the list. Absent from an older gateway. */
  readonly verifiedPublisher?: VerifiedPublisherCli | null;
  /** The dependencies the update would install. Absent from an older gateway, or when not planned. */
  readonly addedPackages?: readonly { readonly id: string }[];
  /** Why the update does not fit, one line each. Absent from an older gateway. */
  readonly conflicts?: readonly { readonly reason?: string }[];
  /**
   * How the new version's registry-signed score compares with the installed one's, as the gateway
   * worded it. The CLI prints `text` and computes nothing; `--json` carries the whole object.
   * Absent from an older gateway.
   */
  readonly qualityChange?: { readonly text?: unknown };
}

export interface UpdateApplyResultCli {
  readonly applied: boolean;
  readonly reason?: string;
  readonly hint?: string;
  /** A failed update or downgrade whose rollback itself failed: what it left behind. Absent from an older gateway. */
  readonly detail?: string;
  readonly jobId?: string;
  /** The packages an applied update installed. Absent from an older gateway. */
  readonly addedPackages?: readonly {
    readonly id: string;
    readonly version: string;
    readonly registry: string | null;
    readonly kind?: string;
  }[];
  readonly connectorRequirements?: unknown;
  /** An applied update: the root had a run grant, now stale. */
  readonly grantDropped?: boolean;
  /** An applied update that made the root a starter pack (it cannot be approved). */
  readonly rootKind?: string;
  /**
   * An applied downgrade, or an update whose new version dropped a dependency: dependency-installed
   * packages left needed by nothing, dependents first.
   */
  readonly orphanedDependencies?: readonly string[];
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
  /** The post-install walk's wiring. Without it an update never walks (the commands are printed). */
  walk?: InstallWalkDeps;
}

/**
 * One update per line. The status column is about the SIGNATURE (`signature verified` /
 * `signature failed`), or `publisher key changed` when the key conflict stopped the check; a
 * verified publisher is a separate `✓ @handle` column. `--json` keeps the raw fields.
 */
function formatUpdateRow(u: AvailableUpdateCli): string {
  const status =
    u.verificationStatus === "publisher_key_conflict"
      ? "publisher key changed"
      : signatureLabel(u.verificationStatus);
  const mark = verifiedPublisherCell(u.verifiedPublisher);
  const verified = mark === "-" ? "" : `\t${mark}`;
  const added = (u.addedPackages ?? []).map((p) => stripControl(p.id));
  const adds = added.length === 0 ? "" : `\tadds ${added.join(", ")}`;
  const conflicts = (u.conflicts ?? [])
    .map((c) => `\tconflict: ${stripControl(c.reason ?? "conflict")}`)
    .join("");
  const quality =
    typeof u.qualityChange?.text === "string" ? `\t${stripControl(u.qualityChange.text)}` : "";
  return `${u.id}\t${u.fromVersion} → ${u.toVersion}\t[${u.channel}]\tfrom ${u.sourceRegistry}\t${status}${verified}${adds}${quality}${conflicts}`;
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
    await reportAddedPackages(opts, res, id);
    // What the new version no longer declares, when nothing else needs it.
    reportKeptDependencies(opts.writeStderr, res, id);
    return 0;
  }
  // A hint may hold several lines (`update_conflicts` is one per conflict): each gets its own.
  const hintPart = (res.hint ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => `\n  hint: ${line}`)
    .join("");
  opts.writeStderr(`update failed: ${res.reason ?? "unknown"}${hintPart}${detailPart(res)}\n`);
  return 1;
}

/** The `detail:` line of a failed update or downgrade (a rollback that left something behind); `""` without one. */
function detailPart(res: UpdateApplyResultCli): string {
  return res.detail === undefined || res.detail === ""
    ? ""
    : `\n  detail: ${stripControl(res.detail)}`;
}

/**
 * What an applied update added: the `+` lines, the approve hint for the added CODE packages (a
 * starter-pack member has no code and is never offered), `Needs:`, then the attended walk.
 */
async function reportAddedPackages(
  opts: RunExtensionUpdateOpts,
  res: UpdateApplyResultCli,
  id: string,
): Promise<void> {
  const added = res.addedPackages ?? [];
  const lines: string[] = added.map(
    (d) =>
      `  + ${stripControl(d.id)}@${stripControl(d.version)} from registry ${stripControl(d.registry ?? "unknown")} (installed as a dependency)`,
  );
  const toApprove = added.filter((d) => d.kind !== "starter-pack").map((d) => stripControl(d.id));
  // The root's approval went stale with the update; a root that is now a pack cannot be approved.
  if (res.grantDropped === true && res.rootKind !== "starter-pack") {
    toApprove.push(stripControl(id));
  }
  if (toApprove.length > 0) {
    const cmds = toApprove.map((i) => `nimbus extension approve ${i}`).join(" && ");
    lines.push(`Nothing runs until you approve it: ${cmds}`);
  }
  const needs = parseRequirementStatuses(res.connectorRequirements);
  if (needs.length > 0) lines.push("Needs:", ...requirementLines(needs));
  if (lines.length > 0) opts.writeStdout(`${lines.join("\n")}\n`);
  if (toApprove.length > 0 || needs.length > 0) {
    await walkAfterInstall(opts.args, opts.walk, toApprove, needs, (line) =>
      opts.writeStdout(`${line}\n`),
    );
  }
}

/**
 * The `Kept …` line for the dependency-installed packages an applied update or downgrade left
 * needed by nothing (dependents first, so the commands run in order). None ⇒ nothing printed.
 */
function reportKeptDependencies(
  writeStderr: (s: string) => void,
  res: UpdateApplyResultCli,
  id: string,
): void {
  const kept = (res.orphanedDependencies ?? []).map(stripControl);
  if (kept.length === 0) return;
  const removals = kept.map((k) => `nimbus extension remove ${k}`).join(" && ");
  writeStderr(
    `Kept ${kept.join(", ")}, no longer needed by ${stripControl(id)}; remove them with: ${removals}\n`,
  );
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

export async function runExtensionUpdate(
  client: IPCClient,
  args: string[],
  walk?: InstallWalkDeps,
): Promise<number> {
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
    ...(walk === undefined ? {} : { walk }),
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
    reportKeptDependencies(opts.writeStderr, res, id);
    return 0;
  }
  const hintPart = res.hint === undefined ? "" : `\n  hint: ${res.hint}`;
  opts.writeStderr(`downgrade failed: ${res.reason ?? "unknown"}${hintPart}${detailPart(res)}\n`);
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
