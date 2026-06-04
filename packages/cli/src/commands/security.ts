import type { IPCClient } from "../ipc-client/index.ts";
import { IPCClient as RealIPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export interface SecurityArgs {
  readonly subcommand: "scan" | "help";
  readonly json: boolean;
  readonly failOnFinding: boolean;
  readonly extended: boolean;
  readonly service?: string;
}

export function parseSecurityArgs(args: string[]): SecurityArgs {
  const sub = args[0];
  if (sub === undefined) {
    throw new Error("Usage: nimbus security <scan|help>");
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    return { subcommand: "help", json: false, failOnFinding: false, extended: false };
  }
  if (sub !== "scan") {
    throw new Error(`Unknown security subcommand: ${sub}. Try: nimbus security help`);
  }
  let json = false;
  let failOnFinding = false;
  let extended = false;
  let service: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--fail-on-finding") failOnFinding = true;
    else if (a === "--extended") extended = true;
    else if (a === "--service") {
      service = args[i + 1];
      i += 1;
    }
  }
  const base = { subcommand: "scan" as const, json, failOnFinding, extended };
  return service === undefined ? base : { ...base, service };
}

export interface FindingBlame {
  readonly commit_sha: string;
  readonly author_name: string | null;
  readonly author_email: string | null;
  readonly author_time_ms: number | null;
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
  readonly fingerprint?: string;
  readonly external_id?: string;
  readonly blame?: FindingBlame | null;
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
  readonly muted_count?: number;
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
  return new Date(ms).toISOString().slice(0, 10);
}

/** Exit 1 when --fail-on-finding is set and at least one (non-muted) finding remains. */
export function decideExitCode(findingsCount: number, failOnFinding: boolean): number {
  return failOnFinding && findingsCount > 0 ? 1 : 0;
}

export function formatScanPretty(result: SecurityScanResult, options: RenderOptions): string {
  const useColor = options.tty && !options.noColor;
  const yellow = (s: string): string => (useColor ? `\x1b[33m${s}\x1b[0m` : s);
  const red = (s: string): string => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
  const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

  const lines: string[] = [];
  lines.push(
    "Nimbus security scan",
    `Scanned ${String(result.items_scanned)} items, ${String(result.findings_count)} findings.`,
  );
  const muted = result.muted_count ?? 0;
  if (muted > 0) {
    lines.push(dim(`${String(muted)} finding(s) muted by [security.allowlist].`));
  }
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
  let gitFindingMissingBlame = false;
  for (const f of result.findings) {
    const date = formatIso(f.modified_at_ms);
    lines.push(
      `  ${f.item_id.padEnd(40)}  ${red(f.pattern_name.padEnd(24))}  ${f.match_redacted.padEnd(14)}  ${date}`,
    );
    if (f.blame != null) {
      const who = f.blame.author_email ?? f.blame.author_name ?? "unknown";
      const when = f.blame.author_time_ms != null ? formatIso(f.blame.author_time_ms) : "?";
      lines.push(dim(`      introduced by ${who} @ ${when} (${f.blame.commit_sha.slice(0, 12)})`));
    } else if (f.type === "code_symbol") {
      gitFindingMissingBlame = true;
    }
    if (f.fingerprint !== undefined) {
      lines.push(
        dim(`      fingerprint: ${f.fingerprint}  (add to [[security.allowlist]] to mute)`),
      );
    }
  }
  lines.push(
    "",
    `${String(result.findings_count)} findings. Review the locations above and rotate credentials if real.`,
  );
  if (gitFindingMissingBlame) {
    lines.push(
      dim("Tip: run `nimbus connector sync filesystem` to populate git-blame attribution."),
    );
  }
  return lines.join("\n");
}

function helpText(): string {
  return [
    "nimbus security — local credential-hygiene scan",
    "",
    "Usage:",
    "  nimbus security scan [options]   Scan already-indexed content for likely secrets",
    "",
    "Options:",
    "  --json                Emit the raw JSON result",
    "  --service <name>      Scan only the named connector's items",
    "  --fail-on-finding     Exit 1 if a non-muted finding remains (for CI)",
    "  --extended            Also run the low-confidence pattern tier",
    "                        WARNING: --extended with --fail-on-finding in CI needs a",
    "                        well-maintained [security.allowlist] to avoid flaky builds.",
    "",
    "Read-only. Never writes content. Connectors at metadata_only depth are skipped",
    "and reported. The full secret value is never emitted in output, logs, or audit.",
  ].join("\n");
}

function streamScan(
  client: IPCClient,
  params: Record<string, unknown>,
  isJson: boolean,
): Promise<SecurityScanResult> {
  return new Promise<SecurityScanResult>((resolve, reject) => {
    let jobId: string | undefined;
    client.onNotification("security.scanProgress", (n: unknown) => {
      const p = n as { jobId: string; scanned: number; total: number };
      if (jobId === undefined || p.jobId !== jobId) return;
      if (!isJson) process.stderr.write(`scanning ${String(p.scanned)}/${String(p.total)}\r`);
    });
    client.onNotification("security.scanDone", (n: unknown) => {
      const p = n as Record<string, unknown>;
      if (jobId === undefined || p["jobId"] !== jobId) return;
      if (!isSecurityScanResult(p)) {
        reject(new Error("Malformed security.scanDone payload"));
        return;
      }
      resolve(p);
    });
    client.onNotification("security.scanError", (n: unknown) => {
      const p = n as { jobId: string; message: string };
      if (jobId === undefined || p.jobId !== jobId) return;
      reject(new Error(p.message));
    });
    client
      .call<{ jobId: string }>("security.scan", params)
      .then((r) => {
        jobId = r.jobId;
      })
      .catch(reject);
  });
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
  const client = new RealIPCClient(state.socketPath);
  await client.connect();
  let result: SecurityScanResult | undefined;
  try {
    const params: Record<string, unknown> = {};
    if (parsed.service !== undefined) params["service"] = parsed.service;
    if (parsed.extended) params["extended"] = true;
    const r = await streamScan(client, params, parsed.json);
    result = r;
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    } else {
      const noColor = process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "";
      const tty = process.stdout.isTTY === true;
      process.stdout.write(`${formatScanPretty(r, { tty, noColor })}\n`);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    await client.disconnect().catch(() => {});
  }
  // Outside the try so the CI exit code is never swallowed by the catch.
  if (result === undefined) return;
  const code = decideExitCode(result.findings_count, parsed.failOnFinding);
  if (code !== 0) process.exit(code);
}
