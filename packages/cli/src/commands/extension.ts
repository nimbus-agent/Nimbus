import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { confirm, isCancel } from "@clack/prompts";

import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";

import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
import {
  formatNetworkIsolationLine,
  type SandboxPlatformCapabilities,
} from "./extension-sandbox-format.ts";

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
    if (a === "--filter") {
      // skip flag + value
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
};

export async function runExtensionList(client: IPCClient, args: string[]): Promise<void> {
  const filter = takeFlagValue(args, "--filter");
  const json = hasFlag(args, "--json");
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
  for (const r of rows) {
    const suffix = r.needs_reinstall === true ? " [needs-reinstall]" : "";
    const enabled = r.enabled === 0 ? " (disabled)" : "";
    console.log(`${r.id}@${r.version}${enabled}${suffix}`);
  }
}

type DiagSnapshotResult = {
  sandbox?: {
    platform_capabilities?: SandboxPlatformCapabilities;
  };
};

/**
 * Fetch the sandbox posture from `diag.snapshot`. CLI runs in a separate
 * process from the Gateway, so the Gateway-side `SandboxRunner` singleton
 * is reachable only through IPC — the cleanest carrier is the existing
 * `diag.snapshot` payload (T2 PR 1 Task 20). Returns `null` on any error so
 * `extension info` still prints the rest of the row when the diagnostic
 * call fails (e.g. permission denied on the data dir).
 */
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
  console.log(formatNetworkIsolationLine(sandboxCap));
  console.log("  See: docs/sandbox.md#platform-asymmetry");
  if (e.needs_reinstall === true && out.message !== undefined) {
    console.log("");
    console.log(out.message);
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
  const out = await client.call<{
    id: string;
    version: string;
    installPath: string;
  }>("extension.install", { sourcePath });
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
    throw new Error("Usage: nimbus extension remove <id> [--yes]");
  }
  const accept = hasFlag(args, "--yes") || hasFlag(args, "-y");
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
  const out = await client.call<{ ok: boolean }>("extension.remove", { id });
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
  if (existsSync(outPath) && !force) {
    process.stderr.write(`refusing to overwrite ${outPath} without --force\n`);
    return 2;
  }
  const { privkey, pubkey } = generateEd25519Keypair();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${encodeBase64(privkey)}\n`);
  if (process.platform !== "win32") chmodSync(outPath, 0o600);
  process.stdout.write(`${encodeBase64(pubkey)}\n`);
  return 0;
}

export async function runExtension(args: string[]): Promise<void> {
  const sub = args[0]?.trim() ?? "";
  const rest = stripFlags(args.slice(1));

  // Local-only subcommands — no Gateway connection required.
  if (sub === "keygen") {
    const code = await runExtensionKeygen(rest);
    if (code !== 0) process.exit(code);
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
    if (sub === "list" || sub === "") {
      await runExtensionList(client, args);
      return;
    }

    if (sub === "info") {
      await runExtensionInfo(client, rest, args);
      return;
    }

    if (sub === "install") {
      await runExtensionInstall(client, args, rest);
      return;
    }

    if (sub === "enable") {
      await runExtensionEnable(client, rest);
      return;
    }

    if (sub === "disable") {
      await runExtensionDisable(client, rest);
      return;
    }

    if (sub === "remove") {
      await runExtensionRemove(client, args, rest);
      return;
    }

    throw new Error(
      "Usage: nimbus extension list [--filter needs-reinstall] [--json] | info <id> [--json] | install <path> [--yes] | enable <id> | disable <id> | remove <id> [--yes]",
    );
  } finally {
    await client.disconnect();
  }
}
