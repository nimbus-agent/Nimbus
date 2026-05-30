import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export interface SecurityArgs {
  readonly subcommand: "scan" | "help";
  readonly json: boolean;
}

export function parseSecurityArgs(args: string[]): SecurityArgs {
  const sub = args[0];
  if (sub === undefined) {
    throw new Error("Usage: nimbus security <scan|help>");
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    return { subcommand: "help", json: false };
  }
  if (sub !== "scan") {
    throw new Error(`Unknown security subcommand: ${sub}. Try: nimbus security help`);
  }
  let json = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--json") json = true;
  }
  return { subcommand: "scan", json };
}

interface SecurityFinding {
  readonly item_id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly pattern_name: string;
  readonly pattern_category: "api_key" | "private_key" | "token";
  readonly match_redacted: string;
  readonly match_offset: number;
  readonly context_snippet: string;
  readonly modified_at_ms: number;
  readonly url: string | null;
}

interface SkippedConnector {
  readonly service: string;
  readonly depth: "metadata_only";
}

export interface SecurityScanResult {
  readonly scanned_at_ms: number;
  readonly items_scanned: number;
  readonly items_skipped_depth: number;
  readonly findings_count: number;
  readonly findings: readonly SecurityFinding[];
  readonly skipped_connectors: readonly SkippedConnector[];
}

function isSecurityScanResult(value: unknown): value is SecurityScanResult {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["scanned_at_ms"] === "number" &&
    typeof v["items_scanned"] === "number" &&
    typeof v["items_skipped_depth"] === "number" &&
    typeof v["findings_count"] === "number" &&
    Array.isArray(v["findings"]) &&
    Array.isArray(v["skipped_connectors"])
  );
}

export interface RenderOptions {
  readonly tty: boolean;
  readonly noColor: boolean;
}

function formatIso(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

export function formatScanPretty(result: SecurityScanResult, options: RenderOptions): string {
  const useColor = options.tty && !options.noColor;
  const yellow = (s: string): string => (useColor ? `\x1b[33m${s}\x1b[0m` : s);
  const red = (s: string): string => (useColor ? `\x1b[31m${s}\x1b[0m` : s);

  const lines: string[] = [];
  lines.push(
    "Nimbus security scan",
    `Scanned ${String(result.items_scanned)} items, ${String(result.findings_count)} findings.`,
  );
  if (result.items_skipped_depth > 0) {
    const skipped = result.skipped_connectors.map((s) => s.service).join(", ");
    lines.push(
      yellow(
        `Skipped ${String(result.items_skipped_depth)} items from connectors at metadata_only depth: ${skipped}.`,
      ),
    );
  }
  lines.push("");

  if (result.findings_count === 0) {
    lines.push("0 findings. Index appears clean for the v1 pattern set.");
    return lines.join("\n");
  }

  lines.push("Findings:");
  for (const f of result.findings) {
    const date = formatIso(f.modified_at_ms);
    lines.push(
      `  ${f.item_id.padEnd(40)}  ${red(f.pattern_name.padEnd(24))}  ${f.match_redacted.padEnd(14)}  ${date}`,
    );
  }
  lines.push(
    "",
    `${String(result.findings_count)} findings. Review the locations above and rotate credentials if real.`,
  );
  return lines.join("\n");
}

function helpText(): string {
  return [
    "nimbus security — local credential-hygiene scan",
    "",
    "Usage:",
    "  nimbus security scan [--json]   Scan already-indexed content for likely secrets",
    "",
    "Read-only. Never writes content. Connectors at metadata_only depth are skipped",
    "and reported. The full secret value is never emitted in output, logs, or audit.",
  ].join("\n");
}

export async function runSecurity(args: string[]): Promise<void> {
  let parsed: SecurityArgs;
  try {
    parsed = parseSecurityArgs(args);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  if (parsed.subcommand === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    const r = await client.call<unknown>("security.scan", {});
    if (!isSecurityScanResult(r)) {
      process.stderr.write("Malformed security.scan response\n");
      process.exit(2);
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return;
    }
    const noColor = process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "";
    const tty = process.stdout.isTTY === true;
    process.stdout.write(`${formatScanPretty(r, { tty, noColor })}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    await client.disconnect().catch(() => {});
  }
}
