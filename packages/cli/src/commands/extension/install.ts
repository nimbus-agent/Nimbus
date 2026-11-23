import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { IPCClient } from "../../ipc-client/index.ts";
import { registerConsentFor } from "../../lib/interactive-ipc-handlers.ts";
import { readLine } from "../../lib/read-line.ts";
import { createIpcClient, INTERACTIVE_RPC_TIMEOUT_MS } from "../../lib/rpc-timeouts.ts";
import { stripControl } from "../captures-format.ts";
import { runConnector } from "../connector.ts";
import {
  type PostInstallIo,
  runConnectFix,
  runPostInstallWalk,
} from "../extension-post-install.ts";
import {
  parseRequirementStatuses,
  type RequirementStatusView,
} from "../extension-requirements-format.ts";
import { runExtensionApprove } from "./approve.ts";
import { runExtensionCredential } from "./credential.ts";
import { hasFlag, takeFlagValue } from "./flags.ts";
import { printNeeds } from "./info.ts";

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
export async function walkAfterInstall(
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

/** The flags a registry install refuses, checked before the consent handler is registered. */
function assertRegistryInstallFlags(args: string[]): void {
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
}

/** The `registry.install` params from the flags that name the registry, version and key. */
function registryInstallParams(args: string[], id: string): Record<string, unknown> {
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
  return params;
}

/** `nimbus extension install <id>`: resolve, verify and install from a registry (never `--yes`). */
async function runExtensionInstallFromRegistry(
  client: IPCClient,
  args: string[],
  id: string,
  walk: InstallWalkDeps | undefined,
): Promise<void> {
  assertRegistryInstallFlags(args);
  registerConsentFor(client, { kind: "prompt" });
  const params = registryInstallParams(args, id);
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
    const commands = toApprove.map((i) => `nimbus extension approve ${i}`).join(" && ");
    console.log(`Nothing runs until you approve it: ${commands}`);
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
