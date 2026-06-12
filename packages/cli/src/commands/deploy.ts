import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { runDeployAnnotate } from "./deploy-annotate.ts";

export type DeployPreflightMode = "warn" | "block" | "off";

export type DeployPreflightArgs = {
  readonly service: string;
  readonly targetRef: string;
  readonly mode: DeployPreflightMode;
  readonly json: boolean;
};

const MODES: ReadonlySet<DeployPreflightMode> = new Set(["warn", "block", "off"]);

const PREFLIGHT_USAGE =
  "Usage: nimbus deploy preflight --service <id> --target-ref <ref> [--mode warn|block|off] [--json]";

function requireNonEmpty(flag: string, raw: string | undefined): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${flag} requires a non-empty value`);
  }
  return raw.trim();
}

function parseModeValue(raw: string | undefined): DeployPreflightMode {
  if (typeof raw !== "string" || !MODES.has(raw as DeployPreflightMode)) {
    throw new Error("--mode must be one of: warn, block, off");
  }
  return raw as DeployPreflightMode;
}

export function parseDeployPreflightArgs(args: readonly string[]): DeployPreflightArgs {
  let service: string | undefined;
  let targetRef: string | undefined;
  let mode: DeployPreflightMode = "warn";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--service") {
      service = requireNonEmpty("--service", args[i + 1]);
      i += 1;
    } else if (a === "--target-ref") {
      targetRef = requireNonEmpty("--target-ref", args[i + 1]);
      i += 1;
    } else if (a === "--mode") {
      mode = parseModeValue(args[i + 1]);
      i += 1;
    } else if (a === "--json") {
      json = true;
    }
  }
  if (service === undefined || targetRef === undefined) {
    throw new Error(PREFLIGHT_USAGE);
  }
  return { service, targetRef, mode, json };
}

type Finding = { id: string; title: string; url: string | null };
type CheckShape = {
  count: number;
  findings: readonly Finding[];
  gap: string | null;
};
type Envelope = {
  service: string;
  target_ref: string;
  verdict: "ok" | "warn";
  computed_at: string;
  checks: Record<string, CheckShape>;
};

function isEnvelope(x: unknown): x is Envelope {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["service"] === "string" &&
    typeof o["target_ref"] === "string" &&
    (o["verdict"] === "ok" || o["verdict"] === "warn") &&
    typeof o["checks"] === "object" &&
    o["checks"] !== null
  );
}

export function shouldUseColor(noColor: string | undefined, isTty: boolean | undefined): boolean {
  if (noColor !== undefined && noColor !== "") return false;
  return isTty === true;
}

export function formatVerdictTag(verdict: Envelope["verdict"], useColor: boolean): string {
  if (verdict === "ok") return useColor ? "\x1b[32m[ok]\x1b[0m" : "[ok]";
  return useColor ? "\x1b[33m[warn]\x1b[0m" : "[warn]";
}

export function formatGapTag(gap: string | null, useColor: boolean): string {
  if (gap === null) return "";
  return useColor ? `\x1b[2m[${gap}]\x1b[0m` : `[${gap}]`;
}

const PREFLIGHT_CHECK_LABELS: Record<string, string> = {
  active_p1_incidents: "Active P1 incidents",
  failing_ci_runs: "Failing CI runs",
  merge_conflicts: "Open PR merge conflicts",
};

const PREFLIGHT_CHECK_KEYS = ["active_p1_incidents", "failing_ci_runs", "merge_conflicts"] as const;

function formatCheckLines(key: string, m: CheckShape, useColor: boolean): string[] {
  const label = PREFLIGHT_CHECK_LABELS[key];
  if (label === undefined) return [];
  const lines = [
    `  ${label.padEnd(28)} ${String(m.count).padStart(4)}  ${formatGapTag(m.gap, useColor)}`,
  ];
  for (const f of m.findings.slice(0, 3)) {
    const urlPart = f.url ? `  ${f.url}` : "";
    lines.push(`      • ${f.title}${urlPart}`);
  }
  return lines;
}

function formatPretty(env: Envelope, useColor: boolean): string {
  const lines: string[] = [
    `Deploy preflight — ${env.service} @ ${env.target_ref}  ${formatVerdictTag(env.verdict, useColor)}`,
    "",
  ];
  for (const key of PREFLIGHT_CHECK_KEYS) {
    const m = env.checks[key];
    if (m === undefined) continue;
    lines.push(...formatCheckLines(key, m, useColor));
  }
  return lines.join("\n");
}

async function runDeployPreflight(args: readonly string[]): Promise<void> {
  let parsed: DeployPreflightArgs;
  try {
    parsed = parseDeployPreflightArgs(args);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(2);
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    const result = await client.call<unknown>("deploy.preflight", {
      service: parsed.service,
      target_ref: parsed.targetRef,
    });
    if (!isEnvelope(result)) {
      process.stderr.write("deploy.preflight returned a malformed envelope\n");
      process.exit(2);
    }
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${formatPretty(result, shouldUseColor(process.env["NO_COLOR"], process.stdout.isTTY))}\n`,
      );
    }
    if (parsed.mode === "block" && result.verdict === "warn") {
      process.exit(1);
    }
    // warn (default) and off → exit 0 regardless of verdict
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

export async function runDeployCli(args: readonly string[]): Promise<void> {
  if (args[0] === "annotate") {
    const exitCode = await runDeployAnnotate(args.slice(1));
    process.exit(exitCode);
  }
  if (args[0] !== "preflight") {
    process.stderr.write(
      "Usage: nimbus deploy preflight --service <id> --target-ref <ref>\n" +
        "       nimbus deploy annotate  --service <id> --sha <sha> --target-ref <ref> --env <env> --status <s> --started-at <ms>\n",
    );
    process.exit(1);
  }
  await runDeployPreflight(args.slice(1));
}
