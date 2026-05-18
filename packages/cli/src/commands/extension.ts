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
  publisher?: { id: string; key?: string };
};

export interface ExtensionListTableRow {
  id: string;
  version: string;
  enabled: number | boolean;
  publisher?: { id: string; key?: string };
}

/**
 * Pure formatter for the tabular `nimbus extension list` output (T2 PR 2 Task 15).
 *
 * Columns: ID | Version | Publisher | Status. Rows without a publisher render
 * "(unverified)" — when the output is a TTY and NO_COLOR is unset, that token
 * is wrapped in ANSI dim-yellow so it stands out without becoming noisy. Manual
 * padding is used so the CLI gains no new dependency.
 */
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
  const noColorEnv = process.env["NO_COLOR"];
  const noColor = noColorEnv !== undefined && noColorEnv !== "";
  const isTty = process.stdout.isTTY === true;
  const tableRows: ExtensionListTableRow[] = rows.map((r) => {
    const enabled = r.enabled === undefined ? 1 : r.enabled;
    const base: ExtensionListTableRow = { id: r.id, version: r.version, enabled };
    if (r.publisher !== undefined) base.publisher = r.publisher;
    return base;
  });
  const table = formatExtensionListTable(tableRows, { isTty, noColor });
  // The formatter terminates with a trailing newline; console.log adds another,
  // but routing through console.log keeps the output reachable by stdout
  // capture in tests and respects existing CLI conventions.
  console.log(table.replace(/\n$/, ""));
  // Preserve the per-row needs-reinstall annotations as a secondary line so
  // existing scripts that grep for "[needs-reinstall]" still work.
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

/**
 * Pure formatter for the Publisher section of `nimbus extension info` human
 * output (T2 PR 2 Task 17). For signed extensions the publisher id + a
 * 16-character truncated key with an ellipsis are shown; for unsigned
 * extensions the section renders `Publisher: (unverified)`. The `--json`
 * path bypasses this formatter so external tooling sees the full key.
 */
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
  // T2 PR 2 Task 17 — Publisher section. Signed extensions display the
  // publisher id + a truncated key; unsigned extensions show (unverified).
  // The full key is only emitted via the `--json` branch above.
  if (e.publisher !== undefined && typeof e.publisher.key === "string") {
    const shortKey = `${e.publisher.key.slice(0, 16)}…`;
    console.log(`Publisher: ${e.publisher.id}`);
    console.log(`  key:     ${shortKey}`);
  } else {
    console.log("Publisher: (unverified)");
  }
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
  // T2 PR 2 Task 16 — optional `--publisher-key <path>` flag forwarded as
  // params.publisherKeyPath. The Gateway side (automation-rpc.ts) reads this
  // field and routes it into `installExtensionFromLocalDirectory`.
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
  const { privkey, pubkey } = generateEd25519Keypair();
  mkdirSync(dirname(outPath), { recursive: true });
  // Atomic create-or-fail to close the TOCTOU window between `existsSync` and
  // `writeFileSync` — an attacker who can plant a symlink at `outPath` between
  // those two calls would otherwise have the privkey clobber an arbitrary
  // file the user can write. `wx` = O_CREAT|O_EXCL; falls through to EEXIST
  // when the file already exists, even if it's a symlink. With `--force` we
  // truncate via `w` (still atomic; no separate stat).
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
  // chmod is a no-op on the file we just created with mode=0o600 on POSIX
  // umasks; explicit chmod keeps the 0o600 invariant if umask stripped bits.
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

/**
 * Pure-logic core of `nimbus extension sync` — exposed for unit testing.
 * Returns the exit code; caller decides whether to `process.exit` or return.
 *
 * Exit codes (per T2 PR 2 Task 14 spec):
 *  - 0: ok (nothing changed, or rotations succeeded)
 *  - 2: at least one rotation caused re-verify failure
 *  - 3: air-gap is enforced
 *  - 4: every checked publisher failed transiently (registry unreachable)
 */
export async function runExtensionSyncWithCaller(opts: RunExtensionSyncOpts): Promise<number> {
  const dryRun = opts.args.includes("--dry-run");
  const json = opts.args.includes("--json");
  let result: SyncResult;
  try {
    result = await opts.caller({ dryRun });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/air-gap/i.test(msg)) {
      opts.writeStderr(`${msg}\n`);
      return 3;
    }
    opts.writeStderr(`${msg}\n`);
    return 1;
  }
  if (json) {
    opts.writeStdout(`${JSON.stringify(result)}\n`);
  } else {
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
    // Sync-context framing (plan-review #2b) — DO NOT say "re-run the install".
    for (const f of result.failures) {
      opts.writeStderr(
        `publisher ${f.id} unreachable (${f.reason}); cached key (if present) remains in use; re-run \`nimbus extension sync\` later, or reinstall affected extensions with \`--publisher-key <path>\` if you have a fresh key locally\n`,
      );
    }
  }
  if (result.publishersUpdated.some((u) => u.reverifyResult === "failed")) return 2;
  if (result.publishersChecked > 0 && result.failures.length === result.publishersChecked) return 4;
  return 0;
}

/**
 * `nimbus extension sync` adapter — wires the testable core to the real IPC
 * client and the process streams.
 */
export async function runExtensionSync(client: IPCClient, args: string[]): Promise<number> {
  return runExtensionSyncWithCaller({
    args,
    caller: async (params) => (await client.call("extension.sync", params)) as SyncResult,
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
  });
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

  if (sub === "sign") {
    const code = await runExtensionSign(rest);
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

    if (sub === "sync") {
      const code = await runExtensionSync(client, args);
      if (code !== 0) process.exit(code);
      return;
    }

    throw new Error(
      "Usage: nimbus extension list [--filter needs-reinstall] [--json] | info <id> [--json] | install <path> [--yes] | enable <id> | disable <id> | remove <id> [--yes] | sync [--dry-run] [--json]",
    );
  } finally {
    await client.disconnect();
  }
}
